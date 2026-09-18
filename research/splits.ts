import type { MarketBar } from "./types";

export interface ChronologicalSplit {
  train: MarketBar[];
  validation: MarketBar[];
  test: MarketBar[];
}

export interface SplitFractions {
  train: number;
  validation: number;
  test: number;
}

export function chronologicalSplit(
  bars: MarketBar[],
  fractions: SplitFractions = { train: 0.6, validation: 0.2, test: 0.2 },
): ChronologicalSplit {
  const total = fractions.train + fractions.validation + fractions.test;
  if (Math.abs(total - 1) > 1e-9) throw new Error("split fractions must sum to 1");
  if (bars.length < 10) throw new Error("not enough bars to split");

  const trainEnd = Math.floor(bars.length * fractions.train);
  const validationEnd = trainEnd + Math.floor(bars.length * fractions.validation);
  return {
    train: bars.slice(0, trainEnd),
    validation: bars.slice(trainEnd, validationEnd),
    test: bars.slice(validationEnd),
  };
}

export interface WalkForwardFold {
  index: number;
  train: MarketBar[];
  validation: MarketBar[];
}

export function walkForwardSplits(
  bars: MarketBar[],
  trainBars: number,
  validationBars: number,
  stepBars = validationBars,
): WalkForwardFold[] {
  if (trainBars <= 0 || validationBars <= 0 || stepBars <= 0) throw new Error("walk-forward sizes must be positive");
  const out: WalkForwardFold[] = [];
  let index = 0;
  for (let start = 0; start + trainBars + validationBars <= bars.length; start += stepBars) {
    out.push({
      index: index++,
      train: bars.slice(start, start + trainBars),
      validation: bars.slice(start + trainBars, start + trainBars + validationBars),
    });
  }
  return out;
}
