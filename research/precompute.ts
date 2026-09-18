import { extname } from "node:path";
import { CachedEvaluator, JsonlSignalCache } from "./cache";
import { loadBarsCsv, loadBarsJsonl } from "./csv";
import { createReplayEvaluator } from "./evaluator";
import { buildFeatureState, defaultFeatureConfig } from "./features";
import type { InputProfile } from "./profiles";
import { chronologicalRanges, chronologicalSplit } from "./splits";
import type { AssetKind } from "./types";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const prefix = "--" + name + "=";
  const hit = args.find((x) => x.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
};

const file = args.find((x) => !x.startsWith("--"));
if (!file) {
  console.error("usage: bun run research/precompute.ts data.csv --symbol=BTCUSDT --kind=spot --model=jev --split=train|validation|dev");
  process.exit(1);
}

const symbol = flag("symbol", "UNKNOWN")!;
const kind = flag("kind", "spot") as AssetKind;
const modelName = flag("model", "jev")!;
const profile = flag("profile", "full") as InputProfile;
const splitName = flag("split", "train")!;
const cachePath = flag("cache", "data/jev-cache.jsonl")!;
const horizonBars = Math.max(1, Number(flag("horizon", "12")));
const decisionEveryBars = Math.max(1, Number(flag("decision-every", "1")));
const maxNewEvaluations = Math.max(0, Number(flag("max-new-evals", "1000")));
const spreadBps = Number(flag("spread-bps", kind === "stock" ? "2" : "4"));
const feeBps = Number(flag("fee-bps", kind === "stock" ? "1" : "4"));
const slippageBps = Number(flag("slippage-bps", "1"));
const directionThresholdBpsFloor = Number(flag(
  "direction-threshold-bps",
  String(spreadBps + 2 * slippageBps + 2 * feeBps),
));
const pricePerMTok = Number(flag("usd-per-mtok", "0.042"));

const bars = extname(file).toLowerCase() === ".jsonl"
  ? loadBarsJsonl(file)
  : loadBarsCsv(file, { symbol, kind, defaultSpreadBps: spreadBps });
const split = chronologicalSplit(bars);
const ranges = chronologicalRanges(bars);

let selectedRange: { start: number; end: number };
if (splitName === "train") selectedRange = ranges.train;
else if (splitName === "validation") selectedRange = ranges.validation;
else if (splitName === "dev") selectedRange = { start: ranges.train.start, end: ranges.validation.end };
else if (splitName === "test") throw new Error("precompute refuses the sealed test split; evaluate it only after the apparatus is frozen");
else throw new Error("unknown --split=" + splitName);

const raw = createReplayEvaluator(modelName, profile);
const cache = new JsonlSignalCache(cachePath);
const evaluator = new CachedEvaluator(raw, cache, maxNewEvaluations);
const featureConfig = { ...defaultFeatureConfig, horizonBars, directionThresholdBpsFloor };

let evaluated = 0;
const firstIndex = Math.max(featureConfig.minHistoryBars, selectedRange.start);
for (let i = firstIndex; i + horizonBars < selectedRange.end; i += decisionEveryBars) {
  const state = buildFeatureState(bars, i, featureConfig);
  if (!state) continue;
  await evaluator.evaluate(state);
  evaluated++;
  if (evaluated % 100 === 0) {
    const usd = evaluator.newInputTokens / 1e6 * pricePerMTok;
    process.stdout.write(`\rstates ${evaluated} · new ${evaluator.newEvaluations} · fresh tokens ${evaluator.newInputTokens} · est $${usd.toFixed(4)}`);
  }
}
if (evaluated >= 100) process.stdout.write("\n");

const usd = evaluator.newInputTokens / 1e6 * pricePerMTok;
console.log(`dataset ${symbol} · split ${splitName} · bars ${selectedRange.end - selectedRange.start} · profile ${profile} · every ${decisionEveryBars}`);
console.log(`evaluator ${raw.name} · states ${evaluated} · cache hits ${cache.hits} · cache misses ${cache.misses}`);
console.log(`new evaluations ${evaluator.newEvaluations} · fresh input tokens ${evaluator.newInputTokens} · estimated fresh cost $${usd.toFixed(6)}`);
console.log(`sealed test bars remain untouched: ${split.test.length}`);
