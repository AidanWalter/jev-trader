import { buildFeatureState } from "./features";
import type { FeatureConfig, FeatureState, MarketBar } from "./types";

export interface PortfolioFeatureSeries {
  symbol: string;
  bars: MarketBar[];
}

const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const stdev = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};

export function buildPortfolioFeatureStates(
  series: PortfolioFeatureSeries[],
  index: number,
  config: FeatureConfig,
) {
  const raw: FeatureState[] = [];
  for (const s of series) {
    const state = buildFeatureState(s.bars, index, config);
    if (state) raw.push(state);
  }
  if (!raw.length) return new Map<string, FeatureState>();

  const r1 = raw.map((x) => x.returnsBps.r1);
  const r12 = raw.map((x) => x.returnsBps.r12);
  const meanR1 = mean(r1);
  const meanR12 = mean(r12);
  const dispersionR12 = stdev(r12);
  const sortedR12 = [...raw].sort((a, b) => a.returnsBps.r12 - b.returnsBps.r12);
  const rankBySymbol = new Map<string, number>();
  for (let i = 0; i < sortedR12.length; i++) {
    const pct = sortedR12.length <= 1 ? 0.5 : i / (sortedR12.length - 1);
    rankBySymbol.set(sortedR12[i]!.symbol, pct);
  }

  const breadthR1PositivePct = raw.filter((x) => x.returnsBps.r1 > 0).length / raw.length * 100;
  const breadthR12PositivePct = raw.filter((x) => x.returnsBps.r12 > 0).length / raw.length * 100;

  const out = new Map<string, FeatureState>();
  for (const state of raw) {
    out.set(state.symbol, {
      ...state,
      marketContext: {
        universeSize: raw.length,
        breadthR1PositivePct: Number(breadthR1PositivePct.toFixed(2)),
        breadthR12PositivePct: Number(breadthR12PositivePct.toFixed(2)),
        meanR1Bps: Number(meanR1.toFixed(3)),
        meanR12Bps: Number(meanR12.toFixed(3)),
        dispersionR12Bps: Number(dispersionR12.toFixed(3)),
        relativeR1Bps: Number((state.returnsBps.r1 - meanR1).toFixed(3)),
        relativeR12Bps: Number((state.returnsBps.r12 - meanR12).toFixed(3)),
        relativeTrendBps20: Number((state.trendBps20 - mean(raw.map((x) => x.trendBps20))).toFixed(3)),
        rankR12Pct: Number(((rankBySymbol.get(state.symbol) ?? 0.5) * 100).toFixed(2)),
      },
    });
  }
  return out;
}
