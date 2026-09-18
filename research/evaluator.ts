import { experimental_evaluate } from "ai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { projectState, type InputProfile } from "./profiles";
import type { Direction, FeatureState, JevSignal, Magnitude, SignalEvaluator } from "./types";

export const SIGNAL_VERSION = "replay-signal-v4";

const QUESTIONS = {
  direction: {
    type: "choice",
    instructions: {
      question: "Over the next horizonBars, which state is most likely: higher by more than directionThresholdBps, within plus/minus directionThresholdBps, or lower by more than directionThresholdBps?",
      goal: "Forecast price direction from information available at this timestamp only. Return probabilities, not trading advice. The downstream policy handles position sizing, fees, and risk.",
      inputs: "Use only fields present in the supplied state. spreadBps is the current execution-friction estimate. For perpetuals, funding contains realized funding information known at this timestamp; use it only as market context, since this question forecasts price direction rather than total carry-adjusted return.",
    },
    criteria: {
      long: "Future close is more than directionThresholdBps above the current price.",
      flat: "Absolute future close return is at most directionThresholdBps.",
      short: "Future close is more than directionThresholdBps below the current price.",
    },
  },
  magnitude: {
    type: "choice",
    instructions: {
      question: "How large is the absolute close-to-close move over the next horizonBars, measured against directionThresholdBps?",
      goal: "Estimate move magnitude independently of direction.",
      inputs: "Use only fields present in the supplied state and treat spreadBps as a scale reference.",
    },
    criteria: {
      tiny: "Absolute move is at most directionThresholdBps.",
      small: "Absolute move is above 1x and at most 2x directionThresholdBps.",
      medium: "Absolute move is above 2x and at most 4x directionThresholdBps.",
      large: "Absolute move is above 4x directionThresholdBps.",
    },
  },
  adverse: {
    type: "boolean",
    instructions: {
      question: "Is execution at the next bar especially likely to be adversely selected or immediately move against a fresh directional position?",
      goal: "Return P(true), using only information available at the timestamp.",
      inputs: "Use only fields present in the supplied state. Fast movement, wide ranges, abnormal volume and high volatility can increase adverse-selection risk when those fields are available.",
    },
  },
} as const;

function normalizeChoice<T extends string>(choice: string, probabilities: Record<string, number> | undefined, labels: readonly T[]) {
  const out = {} as Record<T, number>;
  let total = 0;
  for (const label of labels) {
    const p = probabilities?.[label] ?? (choice === label ? 1 : 0);
    out[label] = Number.isFinite(p) && p >= 0 ? p : 0;
    total += out[label];
  }
  if (total <= 0) {
    const each = 1 / labels.length;
    for (const label of labels) out[label] = each;
  } else {
    for (const label of labels) out[label] /= total;
  }
  return out;
}

export class JevReplayEvaluator implements SignalEvaluator {
  readonly name: string;
  private model;

  constructor(
    modelId = process.env.JEV_MODEL_ID ?? "jev-latest",
    readonly profile: InputProfile = "full",
  ) {
    this.name = `${modelId}:${SIGNAL_VERSION}:${profile}`;
    this.model = typeSafeAi.evaluationModel(modelId);
  }

  async evaluate(state: FeatureState): Promise<JevSignal> {
    const t0 = performance.now();
    const modelState = projectState(state, this.profile);

    let r: Awaited<ReturnType<typeof experimental_evaluate>>;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        r = await experimental_evaluate({
          model: this.model,
          state: modelState as any,
          questions: QUESTIONS,
          maxRetries: 2,
        });
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        const retryableChoiceMismatch =
          message.includes("did not select a highest-probability option");
        if (!retryableChoiceMismatch || attempt === 2) throw error;
        await Bun.sleep(50 * (attempt + 1));
      }
    }
    if (lastError) throw lastError;
    const d = r!.answers.direction;
    const m = r.answers.magnitude;
    const a = r.answers.adverse;
    if (d?.type !== "choice") throw new Error("direction answer missing or invalid");
    if (m?.type !== "choice") throw new Error("magnitude answer missing or invalid");

    const dp = normalizeChoice(d.choice, d.probabilities, ["long", "flat", "short"] as const);
    const mp = normalizeChoice(m.choice, m.probabilities, ["tiny", "small", "medium", "large"] as const);
    return {
      version: SIGNAL_VERSION,
      model: this.name,
      direction: { choice: d.choice as Direction, probabilities: dp },
      magnitude: { choice: m.choice as Magnitude, probabilities: mp },
      adverseSelection: a?.type === "boolean" ? Math.max(0, Math.min(1, a.probability)) : 0.5,
      latencyMs: performance.now() - t0,
      inputTokens: r.usage?.inputTokens ?? 0,
    };
  }
}

function mockMagnitude(state: FeatureState) {
  const volScale = state.realizedVolBps.v12 / Math.max(1, state.directionThresholdBps);
  const large = Math.min(0.6, volScale / 30);
  const medium = Math.min(0.6 - large / 2, volScale / 20);
  const tiny = Math.max(0.05, 1 / (1 + volScale));
  const small = Math.max(0.05, 1 - tiny - medium - large);
  const z = tiny + small + medium + large;
  return { tiny: tiny / z, small: small / z, medium: medium / z, large: large / z };
}

export class MockReplayEvaluator implements SignalEvaluator {
  readonly name = "mock-replay-v2";

  async evaluate(state: FeatureState): Promise<JevSignal> {
    const momentum = state.returnsBps.r12 / Math.max(5, state.realizedVolBps.v12);
    const trend = state.trendBps20 / Math.max(5, state.realizedVolBps.v48);
    const raw = Math.max(-3, Math.min(3, momentum + trend));
    const longRaw = Math.exp(raw);
    const shortRaw = Math.exp(-raw);
    const flatRaw = Math.exp(-Math.abs(raw) * 0.6 + 0.3);
    const z = longRaw + shortRaw + flatRaw;
    const long = longRaw / z, short = shortRaw / z, flat = flatRaw / z;
    const magnitude = mockMagnitude(state);

    return {
      version: SIGNAL_VERSION,
      model: this.name,
      direction: {
        choice: long >= short && long >= flat ? "long" : short >= flat ? "short" : "flat",
        probabilities: { long, flat, short },
      },
      magnitude: {
        choice: magnitude.large >= magnitude.medium && magnitude.large >= magnitude.small && magnitude.large >= magnitude.tiny ? "large"
          : magnitude.medium >= magnitude.small && magnitude.medium >= magnitude.tiny ? "medium"
          : magnitude.small >= magnitude.tiny ? "small" : "tiny",
        probabilities: magnitude,
      },
      adverseSelection: Math.min(0.95, 0.15 + state.rangeBps / Math.max(20, state.realizedVolBps.v48 * 8)),
      latencyMs: 0,
      inputTokens: 0,
    };
  }
}

export class MomentumReplayEvaluator implements SignalEvaluator {
  readonly name = "baseline-momentum-v1";

  async evaluate(state: FeatureState): Promise<JevSignal> {
    const scaled = Math.max(-4, Math.min(4, state.returnsBps.r12 / Math.max(4, state.realizedVolBps.v12)));
    const long = 1 / (1 + Math.exp(-scaled));
    const short = 1 - long;
    const flat = Math.max(0.05, 0.45 - Math.min(0.4, Math.abs(scaled) * 0.12));
    const z = long + short + flat;
    const p = { long: long / z, flat: flat / z, short: short / z };
    const magnitude = mockMagnitude(state);
    return {
      version: SIGNAL_VERSION,
      model: this.name,
      direction: { choice: p.long >= p.short ? "long" : "short", probabilities: p },
      magnitude: {
        choice: magnitude.large >= magnitude.medium && magnitude.large >= magnitude.small && magnitude.large >= magnitude.tiny ? "large"
          : magnitude.medium >= magnitude.small && magnitude.medium >= magnitude.tiny ? "medium"
          : magnitude.small >= magnitude.tiny ? "small" : "tiny",
        probabilities: magnitude,
      },
      adverseSelection: 0.35,
      latencyMs: 0,
      inputTokens: 0,
    };
  }
}

export class RandomReplayEvaluator implements SignalEvaluator {
  readonly name = "baseline-random-v1";

  async evaluate(state: FeatureState): Promise<JevSignal> {
    let h = 2166136261;
    const text = state.symbol + ":" + state.ts;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const u = (h >>> 0) / 0xffffffff;
    const v = ((Math.imul(h ^ 0x9e3779b9, 2246822519) >>> 0) / 0xffffffff);
    const long = 0.15 + 0.7 * u;
    const flat = 0.1 + 0.25 * v;
    const short = Math.max(0.01, 1 - long - flat);
    const z = long + flat + short;
    const p = { long: long / z, flat: flat / z, short: short / z };
    return {
      version: SIGNAL_VERSION,
      model: this.name,
      direction: { choice: p.long >= p.short && p.long >= p.flat ? "long" : p.short >= p.flat ? "short" : "flat", probabilities: p },
      magnitude: { choice: "small", probabilities: { tiny: 0.2, small: 0.5, medium: 0.25, large: 0.05 } },
      adverseSelection: 0.35,
      latencyMs: 0,
      inputTokens: 0,
    };
  }
}

export function createReplayEvaluator(name: string, profile: InputProfile = "full"): SignalEvaluator {
  if (name === "jev") return new JevReplayEvaluator(undefined, profile);
  if (name === "mock") return new MockReplayEvaluator();
  if (name === "momentum") return new MomentumReplayEvaluator();
  if (name === "random") return new RandomReplayEvaluator();
  throw new Error("unknown evaluator: " + name);
}
