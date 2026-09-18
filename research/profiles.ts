import type { FeatureState } from "./types";

export type InputProfile = "minimal" | "technical" | "path" | "cross" | "full";

export function projectState(state: FeatureState, profile: InputProfile) {
  const base = {
    symbol: state.symbol,
    kind: state.kind,
    ts: state.ts,
    intervalMs: state.intervalMs,
    horizonBars: state.horizonBars,
    price: state.price,
    spreadBps: state.spreadBps,
    directionThresholdBps: state.directionThresholdBps,
  };
  const funding = {
    fundingBps: state.fundingBps,
    lastFundingBps: state.lastFundingBps,
    barsSinceFunding: state.barsSinceFunding,
  };
  if (profile === "minimal") {
    return { ...base, returnsBps: state.returnsBps };
  }
  if (profile === "technical") {
    return {
      ...base,
      returnsBps: state.returnsBps,
      realizedVolBps: state.realizedVolBps,
      rangeBps: state.rangeBps,
      volumeRatio20: state.volumeRatio20,
      trendBps20: state.trendBps20,
      ...(state.kind === "perp" ? funding : {}),
    };
  }
  if (profile === "path") {
    return {
      ...base,
      returnsBps: state.returnsBps,
      realizedVolBps: state.realizedVolBps,
      rangeBps: state.rangeBps,
      volumeRatio20: state.volumeRatio20,
      trendBps20: state.trendBps20,
      recentReturnsBps: state.recentReturnsBps,
      ...(state.kind === "perp" ? funding : {}),
    };
  }
  if (profile === "cross") {
    return {
      ...base,
      returnsBps: state.returnsBps,
      realizedVolBps: state.realizedVolBps,
      rangeBps: state.rangeBps,
      volumeRatio20: state.volumeRatio20,
      trendBps20: state.trendBps20,
      recentReturnsBps: state.recentReturnsBps,
      ...(state.kind === "perp" ? funding : {}),
      marketContext: state.marketContext,
    };
  }
  return state;
}
