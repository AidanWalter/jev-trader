import { writeFileSync } from "node:fs";
import { JsonlSignalCache } from "./cache";
import { createReplayEvaluator } from "./evaluator";
import { defaultFeatureConfig } from "./features";
import { buildPortfolioFeatureStates } from "./portfolio-features";
import type { InputProfile } from "./profiles";
import { chronologicalRanges } from "./splits";
import { alignUniverse, fingerprintUniverse, loadUniverse } from "./universe";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const prefix = "--" + name + "=";
  const hit = args.find((x) => x.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
};

const manifest = args.find((x) => !x.startsWith("--"));
if (!manifest) {
  console.error(
    "usage: bun run research/jev-development-preflight.ts universe.json --cache=data/cache.jsonl --model=jev-direction --profile=lean --horizon=8 --decision-every=8",
  );
  process.exit(1);
}

const cachePath = flag("cache");
if (!cachePath) throw new Error("--cache is required");
const model = flag("model", "jev-direction")!;
const profile = flag("profile", "lean") as InputProfile;
const horizonBars = Math.max(1, Number(flag("horizon", "8")));
const decisionEveryBars = Math.max(1, Number(flag("decision-every", "8")));
const feeBps = Number(flag("fee-bps", "4"));
const slippageBps = Number(flag("slippage-bps", "1"));
const maxMissing = Math.max(0, Number(flag("max-missing", "Infinity")));
const minCached = Math.max(0, Number(flag("min-cached", "0")));
const outPath = flag("out");

const assets = alignUniverse(loadUniverse(manifest));
const ranges = chronologicalRanges(assets[0]!.bars);
const evaluator = createReplayEvaluator(model, profile);
const cache = new JsonlSignalCache(cachePath);
const cfg = {
  ...defaultFeatureConfig,
  horizonBars,
  directionThresholdBpsFloor: Number(flag("direction-threshold-bps-floor", "1")),
  directionThresholdFixedCostBps: Number(
    flag("direction-threshold-fixed-cost-bps", String(2 * feeBps + 2 * slippageBps)),
  ),
};
const series = assets.map((asset) => ({ symbol: asset.spec.symbol, bars: asset.bars }));

let total = 0;
let cached = 0;
const bySplit: Record<string, { total: number; cached: number; missing: number }> = {};

for (const [name, range] of [
  ["train", ranges.train],
  ["validation", ranges.validation],
] as const) {
  let splitTotal = 0;
  let splitCached = 0;
  const first = Math.max(cfg.minHistoryBars, range.start);
  for (let i = first; i + horizonBars < range.end; i += decisionEveryBars) {
    const states = buildPortfolioFeatureStates(series, i, cfg);
    for (const asset of assets) {
      const state = states.get(asset.spec.symbol);
      if (!state) continue;
      splitTotal++;
      if (cache.has(evaluator.name, state)) splitCached++;
    }
  }
  total += splitTotal;
  cached += splitCached;
  bySplit[name] = {
    total: splitTotal,
    cached: splitCached,
    missing: splitTotal - splitCached,
  };
}

const missing = total - cached;
const result = {
  version: "jev-development-preflight-v1",
  createdAt: Date.now(),
  manifest,
  fingerprint: fingerprintUniverse(manifest),
  evaluatorNamespace: evaluator.name,
  model,
  profile,
  horizonBars,
  decisionEveryBars,
  totalStates: total,
  cachedStates: cached,
  missingStates: missing,
  cacheSize: cache.size,
  bySplit,
};

console.log("ZERO-CALL JEV DEVELOPMENT PREFLIGHT");
console.log(
  "namespace " + evaluator.name +
  " · total " + total +
  " · cached " + cached +
  " · missing " + missing
);
console.log(
  "train " + bySplit.train!.cached + "/" + bySplit.train!.total +
  " · validation " + bySplit.validation!.cached + "/" + bySplit.validation!.total
);
console.log("No Jev API call was made.");

if (outPath) writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");

if (cached < minCached) {
  throw new Error("development preflight found only " + cached + " cached states; required at least " + minCached);
}
if (missing > maxMissing) {
  throw new Error("development preflight needs " + missing + " fresh states; hard ceiling is " + maxMissing);
}
