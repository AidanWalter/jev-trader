import type { JevSignal, PolicyAction, PolicyConfig } from "./types";

export const defaultPolicyConfig: PolicyConfig = {
  minDirectionalEdge: 0.12,
  minDirectionalConfidence: 0.48,
  flatExitProbability: 0.58,
  maxAdverseSelection: 0.72,
  maxTargetExposure: 1,
  minExposureChange: 0.12,
  sizeScoreThresholds: [0.10, 0.22, 0.38],
};

const magnitudeWeight = (signal: JevSignal) => {
  const p = signal.magnitude.probabilities;
  return p.tiny * 0.10 + p.small * 0.35 + p.medium * 0.65 + p.large;
};

export function choosePolicyAction(
  signal: JevSignal,
  currentExposure: number,
  config: PolicyConfig = defaultPolicyConfig,
): PolicyAction {
  const p = signal.direction.probabilities;
  const edge = p.long - p.short;
  const directionalConfidence = Math.max(p.long, p.short);

  if (p.flat >= config.flatExitProbability) {
    if (Math.abs(currentExposure) < config.minExposureChange) {
      return { kind: "hold", targetExposure: currentExposure, score: 0, reason: "flat already" };
    }
    return { kind: "target", targetExposure: 0, score: p.flat, reason: "high flat probability" };
  }

  if (signal.adverseSelection > config.maxAdverseSelection) {
    return { kind: "hold", targetExposure: currentExposure, score: 0, reason: "adverse-selection gate" };
  }

  if (Math.abs(edge) < config.minDirectionalEdge || directionalConfidence < config.minDirectionalConfidence) {
    return { kind: "hold", targetExposure: currentExposure, score: Math.abs(edge), reason: "directional edge too small" };
  }

  const score = Math.abs(edge) * magnitudeWeight(signal) * (1 - signal.adverseSelection);
  const [a, b, c] = config.sizeScoreThresholds;
  const level = score < a ? 0.25 : score < b ? 0.50 : score < c ? 0.75 : 1;
  const target = Math.sign(edge) * level * config.maxTargetExposure;

  if (Math.abs(target - currentExposure) < config.minExposureChange) {
    return { kind: "hold", targetExposure: currentExposure, score, reason: "target change too small" };
  }

  return { kind: "target", targetExposure: target, score, reason: "probability-weighted target" };
}
