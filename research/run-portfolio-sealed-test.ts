import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CachedEvaluator, JsonlSignalCache } from "./cache";
import { BudgetedEvaluator, defaultSpendBudget, SpendBudgetLedger } from "./budget";
import { mapLimit } from "./concurrency";
import { createReplayEvaluator } from "./evaluator";
import { defaultFeatureConfig } from "./features";
import { buildPortfolioFeatureStates } from "./portfolio-features";
import type { InputProfile } from "./profiles";
import { replayPortfolio } from "./portfolio";
import { chronologicalRanges, chronologicalSplit } from "./splits";
import { portfolioStateIds, stateSetDigest } from "./state-set";
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
  stateSets?: {
    train: { count: number; sha256: string };
    validation: { count: number; sha256: string };
    development: { count: number; sha256: string };
    sealed: { count: number; sha256: string };
  };
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
const paidModel = freeze.evaluator.kind.startsWith("jev");
const concurrency = Math.max(1, Number(flag("concurrency", paidModel ? "1" : "8")));
const spendLedger = paidModel && maxNewEvaluations > 0
  ? new SpendBudgetLedger(defaultSpendBudget({
      maxRequests: Math.max(1, Number(flag("max-paid-requests", "50"))),
      maxInputTokens: Math.max(1, Number(flag("max-input-tokens", "125000"))),
      maxUsd: Math.max(0.000001, Number(flag("max-usd", "0.01"))),
      usdPerMTok: Number(flag("usd-per-mtok", "0.042")),
      reserveTokensPerRequest: Math.max(1, Number(flag("reserve-tokens-per-request", "2000"))),
    }))
  : null;
const paidRaw = spendLedger ? new BudgetedEvaluator(raw, spendLedger) : raw;
const evaluator = new CachedEvaluator(paidRaw, cache, maxNewEvaluations);

const sealedFeatureConfig = {
  ...defaultFeatureConfig,
  horizonBars: freeze.features.horizonBars,
  directionThresholdBpsFloor: freeze.features.directionThresholdBpsFloor,
  directionThresholdFixedCostBps: freeze.features.directionThresholdFixedCostBps,
};
if (freeze.stateSets) {
  const sealedIds = portfolioStateIds(assets, ranges.test, sealedFeatureConfig, freeze.cadence.decisionEveryBars);
  const actual = stateSetDigest(sealedIds);
  if (
    actual.count !== freeze.stateSets.sealed.count ||
    actual.sha256 !== freeze.stateSets.sealed.sha256
  ) {
    throw new Error(
      "sealed state-set identity differs from freeze; refusing paid evaluation before any Jev call"
    );
  }
}
const series = assets.map((asset) => ({ symbol: asset.spec.symbol, bars: asset.bars }));
const sealedStart = Math.max(sealedFeatureConfig.minHistoryBars, ranges.test.start);
const sealedEnd = ranges.test.end - freeze.features.horizonBars - 1;
const missingStates = [];
for (let i = sealedStart; i <= sealedEnd; i += freeze.cadence.decisionEveryBars) {
  const states = buildPortfolioFeatureStates(series, i, sealedFeatureConfig);
  for (const asset of assets) {
    const state = states.get(asset.spec.symbol);
    if (state && !cache.has(raw.name, state)) missingStates.push(state);
  }
}
if (missingStates.length > maxNewEvaluations) {
  throw new Error(
    "sealed portfolio test requires " + missingStates.length +
    " fresh evaluations but --max-new-evals=" + maxNewEvaluations +
    "; no Jev calls were made"
  );
}
await mapLimit(missingStates, concurrency, (state) => evaluator.evaluate(state));
console.log(
  "portfolio sealed prefetch · missing " + missingStates.length +
  " · concurrency " + concurrency +
  " · fresh tokens " + evaluator.newInputTokens
);

const signalRows: {
  symbol: string;
  truth: "long" | "flat" | "short";
  choice: "long" | "flat" | "short";
  forwardReturnBps: number;
  calledSideReturnBps: number;
}[] = [];
for (let i = sealedStart; i <= sealedEnd; i += freeze.cadence.decisionEveryBars) {
  const states = buildPortfolioFeatureStates(series, i, sealedFeatureConfig);
  for (const asset of assets) {
    const state = states.get(asset.spec.symbol);
    if (!state) continue;
    const signal = cache.get(raw.name, state);
    if (!signal) throw new Error("sealed signal unexpectedly missing after prefetch");
    const future = asset.bars[i + freeze.features.horizonBars]!;
    const forwardReturnBps = (future.close / state.price - 1) * 10_000;
    const truth =
      forwardReturnBps > state.directionThresholdBps ? "long" :
      forwardReturnBps < -state.directionThresholdBps ? "short" : "flat";
    const choice = signal.direction.choice;
    signalRows.push({
      symbol: asset.spec.symbol,
      truth,
      choice,
      forwardReturnBps,
      calledSideReturnBps:
        choice === "long" ? forwardReturnBps :
        choice === "short" ? -forwardReturnBps : 0,
    });
  }
}
const signalDiagnostics = (() => {
  const summarize = (rows: typeof signalRows) => ({
    n: rows.length,
    directionAccuracy: rows.length ? rows.filter((x) => x.choice === x.truth).length / rows.length : 0,
    meanCalledSideReturnBps: rows.length
      ? rows.reduce((s, x) => s + x.calledSideReturnBps, 0) / rows.length
      : 0,
    meanForwardReturnBps: rows.length
      ? rows.reduce((s, x) => s + x.forwardReturnBps, 0) / rows.length
      : 0,
  });
  return {
    overall: summarize(signalRows),
    bySymbol: Object.fromEntries(
      assets.map((asset) => [
        asset.spec.symbol,
        summarize(signalRows.filter((x) => x.symbol === asset.spec.symbol)),
      ]),
    ),
  };
})();

const result = await replayPortfolio(assets, {
  evaluator,
  policy: freeze.policy,
  topN: freeze.portfolio.topN,
  maxGrossExposure: freeze.portfolio.maxGrossExposure,
  maxAssetExposure: freeze.portfolio.maxAssetExposure,
  startIndex: ranges.test.start,
  endIndex: ranges.test.end - freeze.features.horizonBars - 1,
  decisionEveryBars: freeze.cadence.decisionEveryBars,
  features: sealedFeatureConfig,
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

function equalWeightLongHoldBenchmark() {
  const startIndex = ranges.test.start;
  const endIndex = ranges.test.end - freeze.features.horizonBars - 1;
  const perAsset = freeze.execution.initialCash / assets.length;
  let cash = freeze.execution.initialCash;
  const quantities = new Map<string, number>();

  for (const asset of assets) {
    const bar = asset.bars[startIndex]!;
    const spread = Number.isFinite(bar.spreadBps) ? bar.spreadBps! : freeze.execution.spreadBpsFallback;
    const frictionBps =
      spread * freeze.execution.spreadCostMultiplier / 2 +
      freeze.execution.slippageBps;
    const entryPrice = bar.open * (1 + frictionBps / 10_000);
    const feeRate = freeze.execution.feeBps / 10_000;
    const quantity = perAsset / (entryPrice * (1 + feeRate));
    const notional = quantity * entryPrice;
    const fee = notional * feeRate;
    cash -= notional + fee;
    quantities.set(asset.spec.symbol, quantity);
  }

  let fundingNet = 0;
  const equity: { ts: number; equity: number }[] = [];
  let peak = freeze.execution.initialCash;
  let maxDrawdownPct = 0;

  for (let i = startIndex; i <= endIndex; i++) {
    if (i > startIndex) {
      for (const asset of assets) {
        const q = quantities.get(asset.spec.symbol) ?? 0;
        const bar = asset.bars[i]!;
        if (bar.kind === "perp" && bar.fundingBps) {
          const pnl = -q * bar.open * bar.fundingBps / 10_000;
          cash += pnl;
          fundingNet += pnl;
        }
      }
    }
    let marked = cash;
    for (const asset of assets) {
      marked += (quantities.get(asset.spec.symbol) ?? 0) * asset.bars[i]!.close;
    }
    peak = Math.max(peak, marked);
    const dd = peak > 0 ? (marked / peak - 1) * 100 : 0;
    maxDrawdownPct = Math.min(maxDrawdownPct, dd);
    equity.push({ ts: assets[0]!.bars[i]!.ts, equity: marked });
  }

  const finalEquity = equity.at(-1)!.equity;
  return {
    name: "equal-weight-long-hold",
    initialEquity: freeze.execution.initialCash,
    finalEquity,
    pnl: finalEquity - freeze.execution.initialCash,
    returnPct: (finalEquity / freeze.execution.initialCash - 1) * 100,
    maxDrawdownPct,
    fundingNet,
  };
}

const benchmark = equalWeightLongHoldBenchmark();
const turnoverDays = Math.max(1, (result.endTs - result.startTs) / 86_400_000);
const turnoverPerDay = result.turnover / turnoverDays;

console.log("PORTFOLIO SEALED TEST");
console.log(result.symbols.join(", "));
console.log(new Date(result.startTs).toISOString() + " -> " + new Date(result.endTs).toISOString());
console.log("P&L $" + result.pnl.toFixed(2) + " · return " + result.returnPct.toFixed(2) + "% · max DD " + result.maxDrawdownPct.toFixed(2) + "%");
console.log("turnover " + result.turnover.toFixed(1) + "x · " + turnoverPerDay.toFixed(2) + "x/day · fills " + result.fills.length + " · fees $" + result.fees.toFixed(4) + " · borrow $" + result.borrowCost.toFixed(6) + " · funding net $" + result.fundingNet.toFixed(6));
console.log("benchmark equal-weight long hold · return " + benchmark.returnPct.toFixed(2) + "% · max DD " + benchmark.maxDrawdownPct.toFixed(2) + "% · funding net $" + benchmark.fundingNet.toFixed(6));
console.log("benchmark cash · return 0.00%");
console.log(
  "raw Jev signal · accuracy " + (signalDiagnostics.overall.directionAccuracy * 100).toFixed(1) + "%" +
  " · called-side forward " + signalDiagnostics.overall.meanCalledSideReturnBps.toFixed(2) + " bps" +
  " · market forward " + signalDiagnostics.overall.meanForwardReturnBps.toFixed(2) + " bps"
);
console.log("cache hits " + cache.hits + " · misses " + cache.misses + " · NEW evaluations " + evaluator.newEvaluations + " · fresh tokens " + evaluator.newInputTokens);
if (spendLedger) console.log("HARD SPEND RECEIPT " + JSON.stringify(spendLedger.snapshot()));

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
    concurrency,
    prefetchedMissingStates: missingStates.length,
    newEvaluations: evaluator.newEvaluations,
    spendBudget: spendLedger?.budget ?? null,
    spend: spendLedger?.snapshot() ?? null,
    freshInputTokens: evaluator.newInputTokens,
    diagnostics: { turnoverPerDay, signal: signalDiagnostics },
    benchmarks: {
      cash: { returnPct: 0, pnl: 0, finalEquity: freeze.execution.initialCash },
      equalWeightLongHold: benchmark,
    },
    result,
  }, null, 2) + "\n");
  console.log("wrote portfolio sealed result " + outPath);
}
