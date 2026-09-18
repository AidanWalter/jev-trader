import { experimental_evaluate } from "ai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import type { Direction, FeatureState, JevSignal, Magnitude, SignalEvaluator } from "./types";

export const SIGNAL_VERSION = "replay-signal-v1";

const QUESTIONS = {
  direction: {
    type: "choice",
    instructions: {
      question: "Over the next horizonBars, which state is most likely: meaningfully higher, roughly flat, or meaningfully lower?",
      goal: "Forecast price direction from information available at this timestamp only. Return probabilities, not trading advice. The downstream policy handles position sizing, fees, and risk.",
      inputs: "returnsBps, realizedVolBps, trendBps20, recentReturnsBps, rangeBps and volumeRatio20 summarize recent market state. spreadBps is the current execution friction estimate.",
    },
    criteria: {
      long: "Price ends the horizon meaningfully above the current price.",
      flat: "Price stays close enough to current price that directional edge is weak.",
      short: "Price ends the horizon meaningfully below the current price.",
    },
  },
  magnitude: {
    type: "choice",
    instructions: {
      question: "How large is the absolute price move over the next horizonBars most likely to be?",
      goal: "Estimate move magnitude independently of direction.",
      inputs: "Use realizedVolBps, recentReturnsBps, rangeBps, volumeRatio20 and the current spread as scale references.",
    },
    criteria: {
      tiny: "Absolute move is around the spread or smaller.",
      small: "Move is noticeable but modest relative to recent volatility.",
      medium: "Move is substantial relative to recent volatility.",
      large: "Move is a large tail move relative to recent conditions.",
    },
  },
  adverse: {
    type: "boolean",
    instructions: {
      question: "Is execution at the next bar especially likely to be adversely selected or immediately move against a fresh directional position?",
      goal: "Estimate P(true) from current volatility, range, recent path and volume conditions.",
      inputs: "High realized volatility, abrupt recent movement, wide ranges and abnormal volume can increase adverse-selection risk.",
    },
  },
} as const;

export class JevReplayEvaluator implements SignalEvaluator {
  readonly name: string;
  private model;

  constructor(modelId = process.env.JEV_MODEL_ID ?? "jev-latest") {
    this.name = modelId;
    this.model = typeSafeAi.evaluationModel(modelId);
  }

  async evaluate(state: FeatureState): Promise<JevSignal> {
    const t0 = performance.now();
    const r = await experimental_evaluate({ model: this.model, state: state as any, questions: QUESTIONS, maxRetries: 0 });
    const d = r.answers.direction;
    const m = r.answers.magnitude;
    const a = r.answers.adverse;
    if (d?.type !== "choice") throw new Error("direction answer missing or invalid");
    if (m?.type !== "choice") throw new Error("magnitude answer missing or invalid");

    const dp = d.probabilities ?? { long: 0, flat: 0, short: 0, [d.choice]: 1 };
    const mp = m.probabilities ?? { tiny: 0, small: 0, medium: 0, large: 0, [m.choice]: 1 };
    return {
      version: SIGNAL_VERSION,
      model: this.name,
      direction: {
        choice: d.choice as Direction,
        probabilities: {
          long: dp.long ?? 0,
          flat: dp.flat ?? 0,
          short: dp.short ?? 0,
        },
      },
      magnitude: {
        choice: m.choice as Magnitude,
        probabilities: {
          tiny: mp.tiny ?? 0,
          small: mp.small ?? 0,
          medium: mp.medium ?? 0,
          large: mp.large ?? 0,
        },
      },
      adverseSelection: a?.type === "boolean" ? a.probability : 0.5,
      latencyMs: performance.now() - t0,
      inputTokens: r.usage?.inputTokens ?? 0,
    };
  }
}

export class MockReplayEvaluator implements SignalEvaluator {
  readonly name = "mock-replay-v1";

  async evaluate(state: FeatureState): Promise<JevSignal> {
    const momentum = state.returnsBps.r12 / Math.max(5, state.realizedVolBps.v12);
    const trend = state.trendBps20 / Math.max(5, state.realizedVolBps.v48);
    const raw = Math.max(-3, Math.min(3, momentum + trend));
    const longRaw = Math.exp(raw);
    const shortRaw = Math.exp(-raw);
    const flatRaw = Math.exp(-Math.abs(raw) * 0.6 + 0.3);
    const z = longRaw + shortRaw + flatRaw;
    const long = longRaw / z, short = shortRaw / z, flat = flatRaw / z;
    const volScale = state.realizedVolBps.v12 / Math.max(1, state.spreadBps);
    const large = Math.min(0.6, volScale / 30);
    const medium = Math.min(0.6 - large / 2, volScale / 20);
    const tiny = Math.max(0.05, 1 / (1 + volScale));
    const small = Math.max(0.05, 1 - tiny - medium - large);
    const mz = tiny + small + medium + large;

    return {
      version: SIGNAL_VERSION,
      model: this.name,
      direction: {
        choice: long >= short && long >= flat ? "long" : short >= flat ? "short" : "flat",
        probabilities: { long, flat, short },
      },
      magnitude: {
        choice: large >= medium && large >= small && large >= tiny ? "large" : medium >= small && medium >= tiny ? "medium" : small >= tiny ? "small" : "tiny",
        probabilities: { tiny: tiny / mz, small: small / mz, medium: medium / mz, large: large / mz },
      },
      adverseSelection: Math.min(0.95, 0.15 + state.rangeBps / Math.max(20, state.realizedVolBps.v48 * 8)),
      latencyMs: 0,
      inputTokens: 0,
    };
  }
}
