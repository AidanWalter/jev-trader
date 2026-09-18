import type { FeatureConfig, FeatureState, MarketBar } from "./types";

export const defaultFeatureConfig: FeatureConfig = {
  horizonBars: 12,
  minHistoryBars: 50,
  spreadBpsFallback: 5,
  recentPoints: 24,
};

const bps = (x: number) => x * 10_000;
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const stdev = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};
const ret = (bars: MarketBar[], i: number, lag: number) => {
  const prev = bars[i - lag];
  const cur = bars[i];
  if (!prev || !cur || prev.close <= 0) return 0;
  return bps(cur.close / prev.close - 1);
};
const logReturns = (bars: MarketBar[], end: number, n: number) => {
  const out: number[] = [];
  const start = Math.max(1, end - n + 1);
  for (let i = start; i <= end; i++) {
    const a = bars[i - 1];
    const b = bars[i];
    if (a && b && a.close > 0 && b.close > 0) out.push(bps(Math.log(b.close / a.close)));
  }
  return out;
};

export function inferIntervalMs(bars: MarketBar[], index: number) {
  const xs: number[] = [];
  const start = Math.max(1, index - 20);
  for (let i = start; i <= index; i++) {
    const a = bars[i - 1], b = bars[i];
    if (a && b && b.ts > a.ts) xs.push(b.ts - a.ts);
  }
  xs.sort((a, b) => a - b);
  return xs.length ? xs[Math.floor(xs.length / 2)]! : 0;
}

export function buildFeatureState(
  bars: MarketBar[],
  index: number,
  config: FeatureConfig = defaultFeatureConfig,
): FeatureState | null {
  const cur = bars[index];
  if (!cur || index < config.minHistoryBars) return null;
  const recentVolume = bars.slice(Math.max(0, index - 20), index).map((x) => x.volume).filter((x) => x > 0);
  const avgVolume = mean(recentVolume);
  const sma20 = mean(bars.slice(Math.max(0, index - 19), index + 1).map((x) => x.close));
  const recentReturnsBps: number[] = [];
  const start = Math.max(1, index - config.recentPoints + 1);
  for (let i = start; i <= index; i++) recentReturnsBps.push(Number(ret(bars, i, 1).toFixed(3)));

  return {
    symbol: cur.symbol,
    kind: cur.kind,
    ts: cur.ts,
    intervalMs: inferIntervalMs(bars, index),
    horizonBars: config.horizonBars,
    price: cur.close,
    spreadBps: cur.spreadBps ?? config.spreadBpsFallback,
    returnsBps: {
      r1: Number(ret(bars, index, 1).toFixed(3)),
      r3: Number(ret(bars, index, 3).toFixed(3)),
      r12: Number(ret(bars, index, 12).toFixed(3)),
      r48: Number(ret(bars, index, 48).toFixed(3)),
    },
    realizedVolBps: {
      v12: Number(stdev(logReturns(bars, index, 12)).toFixed(3)),
      v48: Number(stdev(logReturns(bars, index, 48)).toFixed(3)),
    },
    rangeBps: Number(bps((cur.high - cur.low) / cur.close).toFixed(3)),
    volumeRatio20: avgVolume > 0 ? Number((cur.volume / avgVolume).toFixed(3)) : 1,
    trendBps20: sma20 > 0 ? Number(bps(cur.close / sma20 - 1).toFixed(3)) : 0,
    recentReturnsBps,
  };
}
