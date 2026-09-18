import type { FeatureState } from "./types";

export type InputProfile = "minimal" | "technical" | "path" | "full";

export function projectState(state: FeatureState, profile: InputProfile) {
  const base = {
    symbol: state.symbol,
    kind: state.kind,
    ts: state.ts,
    intervalMs: state.intervalMs,
    horizonBars: state.horizonBars,
    price: state.price,
    spreadBps: state.spreadBps,
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
    };
  }
  return state;
}
