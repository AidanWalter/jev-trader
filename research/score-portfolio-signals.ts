import { CachedEvaluator, JsonlSignalCache } from "./cache";
import { createReplayEvaluator } from "./evaluator";
import { defaultFeatureConfig } from "./features";
import { buildPortfolioFeatureStates } from "./portfolio-features";
import type { InputProfile } from "./profiles";
import { chronologicalRanges, chronologicalSplit } from "./splits";
import type { Direction } from "./types";
import { alignUniverse, loadUniverse } from "./universe";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const prefix = "--" + name + "=";
  const hit = args.find((x) => x.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
};
const manifest = args.find((x) => !x.startsWith("--"));
if (!manifest) {
  console.error("usage: bun run research/score-portfolio-signals.ts universe.json --profile=path --horizon=8 --split=validation --cache=data/cache.jsonl");
  process.exit(1);
}

const modelName = flag("model", "jev")!;
const profile = flag("profile", "path") as InputProfile;
const horizonBars = Math.max(1, Number(flag("horizon", "12")));
const decisionEveryBars = Math.max(1, Number(flag("decision-every", "8")));
const splitName = flag("split", "validation")!;
const allowTest = flag("allow-test", "false") === "true";
const feeBps = Number(flag("fee-bps", "4"));
const slippageBps = Number(flag("slippage-bps", "1"));
const spreadBps = Number(flag("spread-bps", "4"));
const directionThresholdBpsFloor = Number(flag("direction-threshold-bps-floor", "1"));
const directionThresholdFixedCostBps = Number(flag(
  "direction-threshold-fixed-cost-bps",
  String(2 * feeBps + 2 * slippageBps),
));

const assets = alignUniverse(loadUniverse(manifest));
const bars = assets[0]!.bars;
const ranges = chronologicalRanges(bars);
const split = chronologicalSplit(bars);

let range: { start: number; end: number };
if (splitName === "train") range = ranges.train;
else if (splitName === "validation") range = ranges.validation;
else if (splitName === "dev") range = { start: ranges.train.start, end: ranges.validation.end };
else if (splitName === "test") {
  if (!allowTest) throw new Error("sealed test requested; pass --allow-test=true only after apparatus freeze");
  range = ranges.test;
} else throw new Error("unknown --split=" + splitName);

const raw = createReplayEvaluator(modelName, profile);
const cache = new JsonlSignalCache(flag("cache", "data/portfolio-pilot-cache.jsonl")!);
const evaluator = new CachedEvaluator(raw, cache, 0);
const cfg = {
  ...defaultFeatureConfig,
  horizonBars,
  directionThresholdBpsFloor,
  directionThresholdFixedCostBps,
};

type Bin = {
  n: number;
  correct: number;
  confidence: number;
  calledBps: number;
  netBps: number;
  nonFlat: number;
};
const bins: Bin[] = Array.from({ length: 10 }, () => ({
  n: 0, correct: 0, confidence: 0, calledBps: 0, netBps: 0, nonFlat: 0,
}));

const series = assets.map((a) => ({ symbol: a.spec.symbol, bars: a.bars }));
const directions: Direction[] = ["long", "flat", "short"];
let n = 0;
let correct = 0;
let calledBps = 0;
let calledNetBps = 0;
let nonFlat = 0;
let brier = 0;

for (let i = Math.max(cfg.minHistoryBars, range.start); i + horizonBars < range.end; i += decisionEveryBars) {
  const states = buildPortfolioFeatureStates(series, i, cfg);
  for (const asset of assets) {
    const state = states.get(asset.spec.symbol);
    if (!state) continue;
    const future = asset.bars[i + horizonBars]!;
    const retBps = (future.close / state.price - 1) * 10_000;
    const truth: Direction =
      retBps > state.directionThresholdBps ? "long" :
      retBps < -state.directionThresholdBps ? "short" : "flat";
    const signal = await evaluator.evaluate(state);
    const choice = signal.direction.choice;
    const conf = Math.max(...directions.map((d) => signal.direction.probabilities[d]));
    const bin = bins[Math.min(9, Math.floor(conf * 10))]!;

    const called = choice === "long" ? retBps : choice === "short" ? -retBps : 0;
    const roundTripCostBps =
      state.spreadBps + 2 * feeBps + 2 * slippageBps;
    const net = choice === "flat" ? 0 : called - roundTripCostBps;

    n++;
    if (choice === truth) correct++;
    calledBps += called;
    calledNetBps += net;
    if (choice !== "flat") nonFlat++;

    for (const d of directions) {
      const y = d === truth ? 1 : 0;
      const p = signal.direction.probabilities[d];
      brier += (p - y) ** 2;
    }

    bin.n++;
    bin.confidence += conf;
    bin.correct += choice === truth ? 1 : 0;
    bin.calledBps += called;
    bin.netBps += net;
    if (choice !== "flat") bin.nonFlat++;
  }
}

if (!n) throw new Error("no cached signal states scored");

console.log(
  "portfolio signals · split " + splitName +
  " · profile " + profile +
  " · horizon " + horizonBars +
  " · every " + decisionEveryBars +
  " · states " + n
);
console.log(
  "accuracy " + (correct / n * 100).toFixed(2) + "%" +
  " · Brier " + (brier / n).toFixed(4) +
  " · called " + (calledBps / n).toFixed(3) + " bps/state" +
  " · cost-adjusted " + (calledNetBps / n).toFixed(3) + " bps/state" +
  " · non-flat " + nonFlat
);
console.log("confidence bins:");
for (let i = 0; i < bins.length; i++) {
  const b = bins[i]!;
  if (!b.n) continue;
  console.log(
    "  " + (i * 10) + "-" + ((i + 1) * 10) + "%" +
    " · n " + b.n +
    " · mean conf " + (b.confidence / b.n * 100).toFixed(1) + "%" +
    " · acc " + (b.correct / b.n * 100).toFixed(1) + "%" +
    " · called " + (b.calledBps / b.n).toFixed(2) + " bps" +
    " · net " + (b.netBps / b.n).toFixed(2) + " bps" +
    " · non-flat " + b.nonFlat
  );
}
console.log(
  "cache hits " + cache.hits +
  " · misses " + cache.misses +
  " · new evaluations " + evaluator.newEvaluations
);
if (splitName !== "test") console.log("sealed test remains untouched: " + split.test.length + " bars");
