import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CachedEvaluator, JsonlSignalCache } from "./cache";
import { createReplayEvaluator } from "./evaluator";
import type { InputProfile } from "./profiles";
import { replayPortfolio } from "./portfolio";
import { chronologicalRanges, chronologicalSplit } from "./splits";
import type { PolicyConfig } from "./types";
import { alignUniverse, fingerprintUniverse, loadUniverse } from "./universe";

interface FreezeRecord {
  version: "portfolio-apparatus-freeze-v1";
  fingerprint: { combinedSha256: string };
  universe: {
    symbols: string[];
    alignedBars: number;
    testBars: number;
    testStartTs: number;
    testEndTs: number;
  };
  evaluator: {
    kind: string;
    namespace: string;
    profile: InputProfile;
  };
  features: {
    horizonBars: number;
    directionThresholdBpsFloor: number;
    directionThresholdFixedCostBps: number;
  };
  cadence: { decisionEveryBars: number };
  execution: {
    initialCash: number;
    feeBps: number;
    slippageBps: number;
    spreadBpsFallback: number;
    spreadCostMultiplier: number;
    allowShort: boolean;
    shortBorrowBpsPerDay: number;
    minTradeNotional: number;
  };
  portfolio: {
    topN: number;
    maxGrossExposure: number;
    maxAssetExposure: number;
  };
  policy: PolicyConfig;
}

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const prefix = "--" + name + "=";
  const hit = args.find((x) => x.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
};
const freezePath = args.find((x) => !x.startsWith("--")) ?? "data/portfolio-apparatus-freeze.json";
const manifest = flag("manifest");
if (!manifest) throw new Error("--manifest is required");
const freeze = JSON.parse(readFileSync(freezePath, "utf8")) as FreezeRecord;
if (freeze.version !== "portfolio-apparatus-freeze-v1") throw new Error("unsupported freeze version");

const fingerprint = fingerprintUniverse(manifest);
if (fingerprint.combinedSha256 !== freeze.fingerprint.combinedSha256) throw new Error("universe fingerprint differs from freeze");

const assets = alignUniverse(loadUniverse(manifest));
const bars = assets[0]!.bars;
if (bars.length !== freeze.universe.alignedBars) throw new Error("aligned universe bar count differs from freeze");
if (assets.map((a) => a.spec.symbol).join("|") !== freeze.universe.symbols.join("|")) {
  throw new Error("universe symbol order differs from freeze");
}
const split = chronologicalSplit(bars);
const ranges = chronologicalRanges(bars);
if (
  split.test.length !== freeze.universe.testBars ||
  split.test[0]?.ts !== freeze.universe.testStartTs ||
  split.test.at(-1)?.ts !== freeze.universe.testEndTs
) throw new Error("sealed portfolio test boundary differs from freeze");

const cache = new JsonlSignalCache(flag("cache", "data/portfolio-pilot-cache.jsonl")!);
const raw = createReplayEvaluator(freeze.evaluator.kind, freeze.evaluator.profile);
if (raw.name !== freeze.evaluator.namespace) {
  throw new Error("evaluator namespace changed since freeze: frozen=" + freeze.evaluator.namespace + " current=" + raw.name);
}
const maxNewEvaluations = Math.max(0, Number(flag("max-new-evals", "0")));
const evaluator = new CachedEvaluator(raw, cache, maxNewEvaluations);

const result = await replayPortfolio(assets, {
  evaluator,
  policy: freeze.policy,
  topN: freeze.portfolio.topN,
  maxGrossExposure: freeze.portfolio.maxGrossExposure,
  maxAssetExposure: freeze.portfolio.maxAssetExposure,
  startIndex: ranges.test.start,
  endIndex: ranges.test.end - freeze.features.horizonBars - 1,
  decisionEveryBars: freeze.cadence.decisionEveryBars,
  features: {
    horizonBars: freeze.features.horizonBars,
    directionThresholdBpsFloor: freeze.features.directionThresholdBpsFloor,
    directionThresholdFixedCostBps: freeze.features.directionThresholdFixedCostBps,
  },
  execution: {
    initialCash: freeze.execution.initialCash,
    feeBps: freeze.execution.feeBps,
    slippageBps: freeze.execution.slippageBps,
    spreadBpsFallback: freeze.execution.spreadBpsFallback,
    spreadCostMultiplier: freeze.execution.spreadCostMultiplier,
    allowShort: freeze.execution.allowShort,
    shortBorrowBpsPerDay: freeze.execution.shortBorrowBpsPerDay,
    minTradeNotional: freeze.execution.minTradeNotional,
  },
});

console.log("PORTFOLIO SEALED TEST");
console.log(result.symbols.join(", "));
console.log(new Date(result.startTs).toISOString() + " -> " + new Date(result.endTs).toISOString());
console.log("P&L $" + result.pnl.toFixed(2) + " · return " + result.returnPct.toFixed(2) + "% · max DD " + result.maxDrawdownPct.toFixed(2) + "%");
console.log("turnover " + result.turnover.toFixed(1) + "x · fills " + result.fills.length + " · fees $" + result.fees.toFixed(4) + " · borrow $" + result.borrowCost.toFixed(6) + " · funding net $" + result.fundingNet.toFixed(6));
console.log("cache hits " + cache.hits + " · misses " + cache.misses + " · NEW evaluations " + evaluator.newEvaluations + " · fresh tokens " + evaluator.newInputTokens);

const outPath = flag("out");
if (outPath) {
  const dir = outPath.includes("/") ? outPath.slice(0, outPath.lastIndexOf("/")) : ".";
  mkdirSync(dir, { recursive: true });
  writeFileSync(outPath, JSON.stringify({
    version: "portfolio-sealed-result-v1",
    evaluatedAt: Date.now(),
    freeze: freezePath,
    universeFingerprint: fingerprint.combinedSha256,
    evaluatorNamespace: raw.name,
    newEvaluations: evaluator.newEvaluations,
    freshInputTokens: evaluator.newInputTokens,
    result,
  }, null, 2) + "\n");
  console.log("wrote portfolio sealed result " + outPath);
}
