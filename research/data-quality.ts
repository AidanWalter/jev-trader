import type { MarketBar } from "./types";

export interface DataQualityOptions {
  requireRegularInterval?: boolean;
  intervalToleranceMs?: number;
  allowZeroVolume?: boolean;
}

export interface DataQualityReport {
  bars: number;
  firstTs: number;
  lastTs: number;
  intervalMs: number;
  irregularIntervals: number;
  maxGapMs: number;
  zeroVolumeBars: number;
}

function median(xs: number[]) {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

export function inspectMarketBars(
  bars: MarketBar[],
  options: DataQualityOptions = {},
): DataQualityReport {
  if (bars.length < 3) throw new Error("market data needs at least 3 bars");

  const diffs: number[] = [];
  let zeroVolumeBars = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    const values = [b.open, b.high, b.low, b.close];
    if (!Number.isFinite(b.ts)) throw new Error("non-finite timestamp at bar " + i);
    if (!values.every((x) => Number.isFinite(x) && x > 0)) throw new Error("invalid OHLC value at bar " + i);
    if (b.high < Math.max(b.open, b.close, b.low)) throw new Error("high is below another OHLC value at bar " + i);
    if (b.low > Math.min(b.open, b.close, b.high)) throw new Error("low is above another OHLC value at bar " + i);
    if (!Number.isFinite(b.volume) || b.volume < 0) throw new Error("invalid volume at bar " + i);
    if (b.volume === 0) zeroVolumeBars++;
    if (i > 0) {
      const d = b.ts - bars[i - 1]!.ts;
      if (!(d > 0)) throw new Error("timestamps are not strictly increasing at bar " + i);
      diffs.push(d);
    }
  }

  if (!options.allowZeroVolume && zeroVolumeBars === bars.length) {
    throw new Error("all market bars have zero volume");
  }

  const intervalMs = median(diffs);
  if (!(intervalMs > 0)) throw new Error("could not infer a positive market interval");
  const tolerance = Math.max(0, options.intervalToleranceMs ?? 1);
  let irregularIntervals = 0;
  let maxGapMs = 0;
  for (const d of diffs) {
    maxGapMs = Math.max(maxGapMs, d);
    if (Math.abs(d - intervalMs) > tolerance) irregularIntervals++;
  }

  if (options.requireRegularInterval && irregularIntervals > 0) {
    throw new Error(
      "market data contains " + irregularIntervals +
      " irregular intervals; expected " + intervalMs + " ms, largest gap " + maxGapMs + " ms"
    );
  }

  return {
    bars: bars.length,
    firstTs: bars[0]!.ts,
    lastTs: bars.at(-1)!.ts,
    intervalMs,
    irregularIntervals,
    maxGapMs,
    zeroVolumeBars,
  };
}

export function assertResearchDataQuality(bars: MarketBar[]) {
  const kind = bars[0]?.kind;
  return inspectMarketBars(bars, {
    requireRegularInterval: kind === "spot" || kind === "perp",
    intervalToleranceMs: 1,
    allowZeroVolume: false,
  });
}
