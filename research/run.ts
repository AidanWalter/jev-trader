import { mkdirSync, writeFileSync } from "node:fs";
import { extname } from "node:path";
import { CachedEvaluator, JsonlSignalCache } from "./cache";
import { loadBarsCsv, loadBarsJsonl } from "./csv";
import { createReplayEvaluator } from "./evaluator";
import type { InputProfile } from "./profiles";
import { replayBars } from "./replay";
import type { AssetKind, PolicyConfig } from "./types";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const prefix = "--" + name + "=";
  const hit = args.find((x) => x.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
};

const file = args.find((x) => !x.startsWith("--"));
if (!file) {
  console.error("usage: bun run research/run.ts data.csv --symbol=BTCUSDT --kind=spot --model=mock|jev [--out=data/result.json]");
  process.exit(1);
}

const symbol = flag("symbol", "UNKNOWN")!;
const kind = flag("kind", "spot") as AssetKind;
const modelName = flag("model", "mock")!;
const profile = flag("profile", "full") as InputProfile;
const cachePath = flag("cache", "data/jev-cache.jsonl")!;
const outPath = flag("out");
const horizonBars = Number(flag("horizon", "12"));
const initialCash = Number(flag("cash", "100"));
const feeBps = Number(flag("fee-bps", kind === "stock" ? "1" : "4"));
const slippageBps = Number(flag("slippage-bps", "1"));
const spreadBps = Number(flag("spread-bps", kind === "stock" ? "2" : "4"));
const allowShort = flag("allow-short", "true") !== "false";
const decisionEveryBars = Math.max(1, Number(flag("decision-every", "1")));
const maxNewEvaluations = Math.max(0, Number(flag("max-new-evals", modelName === "jev" ? "1000" : "1000000000")));

const policy: Partial<PolicyConfig> = {
  minDirectionalEdge: Number(flag("min-edge", "0.12")),
  minDirectionalConfidence: Number(flag("min-confidence", "0.48")),
  flatExitProbability: Number(flag("flat-exit", "0.58")),
  maxAdverseSelection: Number(flag("max-adverse", "0.72")),
  maxTargetExposure: Number(flag("max-exposure", "1")),
  minExposureChange: Number(flag("min-change", "0.12")),
};

const bars = extname(file).toLowerCase() === ".jsonl"
  ? loadBarsJsonl(file)
  : loadBarsCsv(file, { symbol, kind, defaultSpreadBps: spreadBps });

const rawEvaluator = createReplayEvaluator(modelName, profile);
const cache = new JsonlSignalCache(cachePath);
const evaluator = new CachedEvaluator(rawEvaluator, cache, maxNewEvaluations);

const result = await replayBars(bars, {
  evaluator,
  policy,
  features: { horizonBars },
  decisionEveryBars,
  execution: {
    initialCash,
    feeBps,
    slippageBps,
    spreadBpsFallback: spreadBps,
    allowShort,
  },
});

const m = result.metrics;
console.log(`${result.symbol}  ${new Date(result.startTs).toISOString()} -> ${new Date(result.endTs).toISOString()}`);
console.log(`model ${rawEvaluator.name} · bars ${bars.length} · every ${decisionEveryBars} bar(s) · cache ${cache.size} (${cache.hits} hits, ${cache.misses} misses, ${evaluator.newEvaluations} new)`);
console.log(`P&L $${m.pnl.toFixed(2)} · return ${m.returnPct.toFixed(2)}% · buy/hold ${m.buyHoldReturnPct.toFixed(2)}%`);
console.log(`max DD ${m.maxDrawdownPct.toFixed(2)}% · Sharpe ${m.sharpe === null ? "n/a" : m.sharpe.toFixed(2)} · turnover ${m.turnover.toFixed(1)}x`);
console.log(`orders ${m.orders} · round trips ${m.roundTrips} · wins ${m.wins} · losses ${m.losses} · win rate ${m.winRatePct === null ? "n/a" : m.winRatePct.toFixed(1) + "%"}`);
console.log(`fees $${m.fees.toFixed(4)} · borrow $${m.borrowCost.toFixed(4)}`);

if (outPath) {
  mkdirSync(outPath.includes("/") ? outPath.slice(0, outPath.lastIndexOf("/")) : ".", { recursive: true });
  writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
  console.log("wrote " + outPath);
}
