import type { FeatureState, JevSignal, SignalEvaluator } from "./types";

export interface CalibrationPoint {
  rawExpectedBps: number;
  realizedReturnBps: number;
}

export interface CalibrationBlock {
  xMin: number;
  xMax: number;
  xMean: number;
  expectedReturnBps: number;
  count: number;
}

export interface IsotonicCalibration {
  version: "isotonic-return-calibration-v1";
  id: string;
  points: number;
  quantileBins: number;
  shrinkage: number;
  blocks: CalibrationBlock[];
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

export function expectedMagnitudeMultiple(signal: JevSignal) {
  const p = signal.magnitude.probabilities;
  return p.tiny * 0.5 + p.small * 1.5 + p.medium * 3 + p.large * 6;
}

export function rawExpectedMoveBps(signal: JevSignal, state: FeatureState) {
  const edge = signal.direction.probabilities.long - signal.direction.probabilities.short;
  return (
    state.directionThresholdBps *
    expectedMagnitudeMultiple(signal) *
    edge *
    (1 - signal.adverseSelection)
  );
}

function hashModel(input: unknown) {
  const h = new Bun.CryptoHasher("sha256");
  h.update(JSON.stringify(input));
  return h.digest("hex").slice(0, 20);
}

export function fitIsotonicCalibration(
  points: CalibrationPoint[],
  quantileBins = 31,
  shrinkage = 100,
): IsotonicCalibration {
  const clean = points
    .filter((p) => Number.isFinite(p.rawExpectedBps) && Number.isFinite(p.realizedReturnBps))
    .sort((a, b) => a.rawExpectedBps - b.rawExpectedBps);
  if (clean.length < 100) throw new Error("calibration needs at least 100 clean training points");

  const bins = Math.max(5, Math.min(Math.floor(clean.length / 20), Math.floor(quantileBins)));
  const rawBlocks: CalibrationBlock[] = [];
  for (let b = 0; b < bins; b++) {
    const start = Math.floor(clean.length * b / bins);
    const end = Math.floor(clean.length * (b + 1) / bins);
    const xs = clean.slice(start, Math.max(start + 1, end));
    if (!xs.length) continue;
    const count = xs.length;
    const xMean = xs.reduce((s, p) => s + p.rawExpectedBps, 0) / count;
    const yMean = xs.reduce((s, p) => s + p.realizedReturnBps, 0) / count;
    const shrunk = yMean * count / (count + Math.max(0, shrinkage));
    rawBlocks.push({
      xMin: xs[0]!.rawExpectedBps,
      xMax: xs.at(-1)!.rawExpectedBps,
      xMean,
      expectedReturnBps: shrunk,
      count,
    });
  }

  // Pool adjacent violators to enforce a monotone mapping from Jev's raw
  // signed expected-move score to realized forward return.
  const pooled: CalibrationBlock[] = [];
  for (const block of rawBlocks) {
    pooled.push({ ...block });
    while (
      pooled.length >= 2 &&
      pooled[pooled.length - 2]!.expectedReturnBps >
        pooled[pooled.length - 1]!.expectedReturnBps
    ) {
      const b = pooled.pop()!;
      const a = pooled.pop()!;
      const count = a.count + b.count;
      pooled.push({
        xMin: a.xMin,
        xMax: b.xMax,
        xMean: (a.xMean * a.count + b.xMean * b.count) / count,
        expectedReturnBps:
          (a.expectedReturnBps * a.count + b.expectedReturnBps * b.count) / count,
        count,
      });
    }
  }

  const base = {
    version: "isotonic-return-calibration-v1" as const,
    points: clean.length,
    quantileBins: bins,
    shrinkage,
    blocks: pooled,
  };
  return { ...base, id: hashModel(base) };
}

export function predictCalibratedReturnBps(model: IsotonicCalibration, rawExpectedBps: number) {
  if (!model.blocks.length) return 0;
  if (rawExpectedBps <= model.blocks[0]!.xMean) return model.blocks[0]!.expectedReturnBps;
  if (rawExpectedBps >= model.blocks.at(-1)!.xMean) return model.blocks.at(-1)!.expectedReturnBps;

  for (let i = 1; i < model.blocks.length; i++) {
    const left = model.blocks[i - 1]!;
    const right = model.blocks[i]!;
    if (rawExpectedBps <= right.xMean) {
      const span = Math.max(1e-9, right.xMean - left.xMean);
      const t = clamp((rawExpectedBps - left.xMean) / span, 0, 1);
      return left.expectedReturnBps * (1 - t) + right.expectedReturnBps * t;
    }
  }
  return model.blocks.at(-1)!.expectedReturnBps;
}

export function calibrateSignal(
  signal: JevSignal,
  state: FeatureState,
  model: IsotonicCalibration,
): JevSignal {
  const raw = rawExpectedMoveBps(signal, state);
  const mu = predictCalibratedReturnBps(model, raw);
  const flat = 0.02;
  const directionalMass = 1 - flat;
  const maxEdge = directionalMass;
  // Encode the calibrated expected move back into the existing policy's
  // expected-move formula by using the "large" magnitude bucket (6x).
  const edge = clamp(mu / Math.max(1e-9, 6 * state.directionThresholdBps), -maxEdge, maxEdge);
  const long = (directionalMass + edge) / 2;
  const short = (directionalMass - edge) / 2;
  const directionChoice =
    long >= short && long >= flat ? "long" :
    short >= long && short >= flat ? "short" : "flat";

  return {
    ...signal,
    version: signal.version + "+cal-" + model.id,
    model: signal.model + "+cal-" + model.id,
    direction: {
      choice: directionChoice,
      probabilities: { long, flat, short },
    },
    magnitude: {
      choice: "large",
      probabilities: { tiny: 0, small: 0, medium: 0, large: 1 },
    },
    adverseSelection: 0,
  };
}

export class CalibratedEvaluator implements SignalEvaluator {
  readonly name: string;
  constructor(
    private inner: SignalEvaluator,
    readonly model: IsotonicCalibration,
  ) {
    this.name = "calibrated:" + inner.name + ":" + model.id;
  }

  async evaluate(state: FeatureState): Promise<JevSignal> {
    const raw = await this.inner.evaluate(state);
    return calibrateSignal(raw, state, this.model);
  }
}
