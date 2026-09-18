import { CachedEvaluator, JsonlSignalCache } from "./cache";
import { createReplayEvaluator } from "./evaluator";
import type { InputProfile } from "./profiles";
import { replayPortfolio } from "./portfolio";
import { alignUniverse, loadUniverse } from "./universe";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const prefix = "--" + name + "=";
  const hit = args.find((x) => x.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
};
const manifest = args.find((x) => !x.startsWith("--"));
if (!manifest) {
  console.error("usage: bun run research/run-portfolio.ts universe.json --model=mock|jev --profile=full");
  process.exit(1);
}

const modelName = flag("model", "mock")!;
const profile = flag("profile", "full") as InputProfile;
const cache = new JsonlSignalCache(flag("cache", "data/jev-cache.jsonl")!);
const maxNewEvaluations = Math.max(0, Number(flag("max-new-evals", modelName === "jev" ? "1000" : "1000000000")));
const evaluator = new CachedEvaluator(createReplayEvaluator(modelName, profile), cache, maxNewEvaluations);
const feeBps = Number(flag("fee-bps", "4"));
const slippageBps = Number(flag("slippage-bps", "1"));
const spreadBps = Number(flag("spread-bps", "4"));
const directionThresholdBpsFloor = Number(flag(
  "direction-threshold-bps",
  String(spreadBps + 2 * slippageBps + 2 * feeBps),
));

const assets = alignUniverse(loadUniverse(manifest));
const result = await replayPortfolio(assets, {
  evaluator,
  decisionEveryBars: Math.max(1, Number(flag("decision-every", "1"))),
  topN: Math.max(1, Number(flag("top-n", String(assets.length)))),
  maxGrossExposure: Number(flag("max-gross", "1")),
  maxAssetExposure: Number(flag("max-asset", assets.length > 1 ? "0.35" : "1")),
  execution: {
    initialCash: Number(flag("cash", "100")),
    feeBps,
    slippageBps,
    spreadBpsFallback: spreadBps,
    allowShort: flag("allow-short", "true") !== "false",
  },
  policy: {
    minDirectionalEdge: Number(flag("min-edge", "0.12")),
    minDirectionalConfidence: Number(flag("min-confidence", "0.48")),
    flatExitProbability: Number(flag("flat-exit", "0.58")),
    maxAdverseSelection: Number(flag("max-adverse", "0.72")),
    minExpectedMoveCostMultiple: Number(flag("cost-multiple", "1.25")),
  },
  features: {
    horizonBars: Math.max(1, Number(flag("horizon", "12"))),
    directionThresholdBpsFloor,
  },
});

console.log(`symbols ${result.symbols.join(", ")}`);
console.log(`${new Date(result.startTs).toISOString()} -> ${new Date(result.endTs).toISOString()}`);
console.log(`P&L $${result.pnl.toFixed(2)} · return ${result.returnPct.toFixed(2)}% · max DD ${result.maxDrawdownPct.toFixed(2)}%`);
console.log(`turnover ${result.turnover.toFixed(1)}x · fees ${result.fees.toFixed(4)} · borrow ${result.borrowCost.toFixed(4)} · funding net ${result.fundingNet.toFixed(4)} · fills ${result.fills.length}`);
console.log(`cache ${cache.size} · hits ${cache.hits} · misses ${cache.misses} · new ${evaluator.newEvaluations} · fresh tokens ${evaluator.newInputTokens}`);
