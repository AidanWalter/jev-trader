import { mkdirSync, writeFileSync } from "node:fs";
import { BudgetedEvaluator, SpendBudgetLedger } from "./budget";
import { CachedEvaluator, JsonlSignalCache } from "./cache";
import { createReplayEvaluator } from "./evaluator";
import { defaultFeatureConfig } from "./features";
import { buildPortfolioFeatureStates } from "./portfolio-features";
import type { InputProfile } from "./profiles";
import { chronologicalRanges, chronologicalSplit } from "./splits";
import type { Direction, FeatureState } from "./types";
import { alignUniverse, fingerprintUniverse, loadUniverse } from "./universe";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const prefix = "--" + name + "=";
  const hit = args.find((x) => x.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
};
const manifest = args.find((x) => !x.startsWith("--"));
if (!manifest) {
  console.error("usage: bun run research/safe-jev-direction-probe.ts universe.json --horizon=8 --profile=lean");
  process.exit(1);
}

const horizonBars = Math.max(1, Number(flag("horizon", "8")));
const profile = flag("profile", "lean") as InputProfile;
const decisionEveryBars = Math.max(1, Number(flag("decision-every", "8")));
const sampleCount = Math.max(1, Number(flag("sample", "12")));
const maxRequests = Math.max(0, Number(flag("max-requests", String(sampleCount))));
const maxInputTokens = Math.max(0, Number(flag("max-input-tokens", "30000")));
const reserveInputTokensPerRequest = Math.max(1, Number(flag("reserve-input-tokens", "2000")));
const usdPerMTok = Number(flag("usd-per-mtok", "0.042"));
const maxUsd = Math.max(0, Number(flag("max-usd", "0.0015")));
const concurrency = Math.max(1, Number(flag("concurrency", "1")));
const cachePath = flag("cache", "data/safe-jev-direction-probe-cache.jsonl")!;
const outPath = flag("out", "data/safe-jev-direction-probe.json")!;
const feeBps = Number(flag("fee-bps", "4"));
const slippageBps = Number(flag("slippage-bps", "1"));
const spreadBps = Number(flag("spread-bps", "4"));

if (sampleCount > maxRequests) {
  throw new Error("sample count exceeds the hard request cap");
}
const dollarTokenCeiling = Math.floor(maxUsd / usdPerMTok * 1_000_000);
const effectiveTokenCeiling = Math.min(maxInputTokens, dollarTokenCeiling);
if (maxRequests * reserveInputTokensPerRequest > effectiveTokenCeiling) {
  throw new Error(
    "requested batch cannot fit the hard spend envelope: " +
    maxRequests + " × " + reserveInputTokensPerRequest +
    " reserved tokens > " + effectiveTokenCeiling + " effective token ceiling"
  );
}

const assets = alignUniverse(loadUniverse(manifest));
const bars = assets[0]!.bars;
const ranges = chronologicalRanges(bars);
const split = chronologicalSplit(bars);
const fingerprint = fingerprintUniverse(manifest);
const cfg = {
  ...defaultFeatureConfig,
  horizonBars,
  directionThresholdBpsFloor: 1,
  directionThresholdFixedCostBps: 2 * feeBps + 2 * slippageBps,
};
const series = assets.map((asset) => ({ symbol: asset.spec.symbol, bars: asset.bars }));

type Row = { state: FeatureState; assetIndex: number; barIndex: number };
const rows: Row[] = [];
const first = Math.max(cfg.minHistoryBars, ranges.train.start);
for (let i = first; i + horizonBars < ranges.train.end; i += decisionEveryBars) {
  const states = buildPortfolioFeatureStates(series, i, cfg);
  for (let a = 0; a < assets.length; a++) {
    const state = states.get(assets[a]!.spec.symbol);
    if (state) rows.push({ state, assetIndex: a, barIndex: i });
  }
}
if (!rows.length) throw new Error("no train states available for the safe probe");

function stratifiedSample(input: Row[], n: number) {
  if (input.length <= n) return [...input];
  const bySymbol = new Map<string, Row[]>();
  for (const row of input) {
    const xs = bySymbol.get(row.state.symbol) ?? [];
    xs.push(row);
    bySymbol.set(row.state.symbol, xs);
  }
  const symbols = [...bySymbol.keys()].sort();
  const picked: Row[] = [];
  const perSymbol = Math.max(1, Math.floor(n / symbols.length));
  for (const symbol of symbols) {
    const xs = bySymbol.get(symbol)!;
    for (let j = 0; j < perSymbol && picked.length < n; j++) {
      const idx = Math.floor((j + 0.5) * xs.length / perSymbol);
      picked.push(xs[Math.min(xs.length - 1, idx)]!);
    }
  }
  if (picked.length < n) {
    const remaining = input.filter((row) => !picked.includes(row));
    const need = n - picked.length;
    for (let j = 0; j < need; j++) {
      const idx = Math.floor((j + 0.5) * remaining.length / need);
      const row = remaining[Math.min(remaining.length - 1, idx)];
      if (row) picked.push(row);
    }
  }
  return picked.slice(0, n).sort((a, b) => a.state.ts - b.state.ts || a.state.symbol.localeCompare(b.state.symbol));
}

const sample = stratifiedSample(rows, sampleCount);
const raw = createReplayEvaluator("jev-direction", profile);
const ledger = new SpendBudgetLedger({
  maxRequests,
  maxInputTokens,
  maxUsd: maxInputTokens / 1_000_000 * usdPerMTok,
  usdPerMTok,
  reserveTokensPerRequest: reserveInputTokensPerRequest,
});
const budgeted = new BudgetedEvaluator(raw, ledger);
const cache = new JsonlSignalCache(cachePath);
const evaluator = new CachedEvaluator(budgeted, cache, maxRequests);

const labels: Direction[] = ["long", "flat", "short"];
const scored: any[] = [];
for (let offset = 0; offset < sample.length; offset += concurrency) {
  const batch = sample.slice(offset, offset + concurrency);
  const answers = await Promise.all(batch.map(async (row) => {
    const signal = await evaluator.evaluate(row.state);
    const future = assets[row.assetIndex]!.bars[row.barIndex + horizonBars]!;
    const retBps = (future.close / row.state.price - 1) * 10_000;
    const truth: Direction =
      retBps > row.state.directionThresholdBps ? "long" :
      retBps < -row.state.directionThresholdBps ? "short" : "flat";
    const choice = signal.direction.choice;
    const calledBps = choice === "long" ? retBps : choice === "short" ? -retBps : 0;
    const roundTripCostBps = row.state.spreadBps + 2 * feeBps + 2 * slippageBps;
    let brier = 0;
    for (const label of labels) {
      const y = truth === label ? 1 : 0;
      brier += (signal.direction.probabilities[label] - y) ** 2;
    }
    return {
      symbol: row.state.symbol,
      ts: row.state.ts,
      truth,
      choice,
      probabilities: signal.direction.probabilities,
      futureReturnBps: retBps,
      calledBps,
      netCalledBps: choice === "flat" ? 0 : calledBps - roundTripCostBps,
      brier,
      inputTokens: signal.inputTokens,
      latencyMs: signal.latencyMs,
    };
  }));
  scored.push(...answers);
}

const accuracy = scored.filter((x) => x.choice === x.truth).length / scored.length;
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const result = {
  version: "safe-jev-direction-probe-v1",
  createdAt: Date.now(),
  manifest,
  fingerprint,
  symbols: assets.map((a) => a.spec.symbol),
  horizonBars,
  profile,
  decisionEveryBars,
  trainOnly: true,
  sampleCount,
  sealedTestBars: split.test.length,
  budget: ledger.snapshot(),
  cache: { path: cachePath, hits: cache.hits, misses: cache.misses, size: cache.size },
  metrics: {
    accuracyPct: accuracy * 100,
    brier: mean(scored.map((x) => x.brier)),
    calledBpsPerState: mean(scored.map((x) => x.calledBps)),
    netCalledBpsPerState: mean(scored.map((x) => x.netCalledBps)),
    avgInputTokens: mean(scored.map((x) => x.inputTokens)),
    avgLatencyMs: mean(scored.map((x) => x.latencyMs)),
  },
  rows: scored,
};

mkdirSync(outPath.includes("/") ? outPath.slice(0, outPath.lastIndexOf("/")) : ".", { recursive: true });
writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");

console.log("SAFE JEV DIRECTION PROBE");
console.log("requests started " + ledger.snapshot().requestsStarted + "/" + maxRequests);
console.log("provider-reported input tokens " + ledger.snapshot().inputTokens + "/" + maxInputTokens);
console.log("estimated cost from reported tokens $" + ledger.snapshot().estimatedUsd.toFixed(6));
console.log("accuracy " + result.metrics.accuracyPct.toFixed(1) + "% · Brier " + result.metrics.brier.toFixed(4));
console.log("called " + result.metrics.calledBpsPerState.toFixed(2) + " bps/state · net " + result.metrics.netCalledBpsPerState.toFixed(2) + " bps/state");
console.log("avg input " + result.metrics.avgInputTokens.toFixed(0) + " tokens · latency " + result.metrics.avgLatencyMs.toFixed(1) + " ms");
console.log("sealed test remained untouched: " + split.test.length + " synchronized bars");
