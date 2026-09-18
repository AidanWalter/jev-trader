import { mkdirSync, writeFileSync } from "node:fs";
import { CachedEvaluator, JsonlSignalCache } from "./cache";
import { mapLimit } from "./concurrency";
import { assertResearchDataQuality } from "./data-quality";
import { createReplayEvaluator } from "./evaluator";
import { defaultFeatureConfig } from "./features";
import { buildPortfolioFeatureStates } from "./portfolio-features";
import type { InputProfile } from "./profiles";
import { chronologicalRanges, chronologicalSplit } from "./splits";
import type { FeatureState } from "./types";
import { alignUniverse, fingerprintUniverse, loadUniverse } from "./universe";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const prefix = "--" + name + "=";
  const hit = args.find((x) => x.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
};
const manifest = args.find((x) => !x.startsWith("--"));
if (!manifest) {
  console.error("usage: bun run research/portfolio-probe.ts universe.json --model=jev --horizons=6,12 --profiles=technical,path,cross,full");
  process.exit(1);
}

const modelName = flag("model", "jev")!;
const concurrency = Math.max(1, Number(flag("concurrency", modelName === "jev" ? "4" : "8")));
const horizons = (flag("horizons", "6,12") ?? "6,12")
  .split(",").map(Number).filter((x) => Number.isFinite(x) && x > 0);
const profiles = (flag("profiles", "technical,path,cross,full") ?? "technical,path,cross,full")
  .split(",").map((x) => x.trim()).filter(Boolean) as InputProfile[];
const decisionEveryBars = Math.max(1, Number(flag("decision-every", "8")));
const samplePerCell = Math.max(1, Number(flag("sample-per-cell", "6")));
const maxNewEvaluations = Math.max(
  1,
  Number(flag("max-new-evals", String(horizons.length * profiles.length * samplePerCell))),
);
const cachePath = flag("cache", "data/portfolio-probe-cache.jsonl")!;
const outPath = flag("out", "data/portfolio-probe-summary.json")!;
const feeBps = Number(flag("fee-bps", "4"));
const slippageBps = Number(flag("slippage-bps", "1"));
const usdPerMTok = Number(flag("usd-per-mtok", "0.042"));
const directionThresholdBpsFloor = Number(flag("direction-threshold-bps-floor", "1"));
const directionThresholdFixedCostBps = Number(flag(
  "direction-threshold-fixed-cost-bps",
  String(2 * slippageBps + 2 * feeBps),
));

const rawAssets = loadUniverse(manifest);
for (const asset of rawAssets) assertResearchDataQuality(asset.bars);
const assets = alignUniverse(rawAssets);
const bars = assets[0]!.bars;
const split = chronologicalSplit(bars);
const ranges = chronologicalRanges(bars);
const fingerprint = fingerprintUniverse(manifest);
const cache = new JsonlSignalCache(cachePath);

type StateRow = { state: FeatureState; symbol: string };

function candidateStates(horizonBars: number): StateRow[] {
  const cfg = {
    ...defaultFeatureConfig,
    horizonBars,
    directionThresholdBpsFloor,
    directionThresholdFixedCostBps,
  };
  const out: StateRow[] = [];
  const series = assets.map((asset) => ({ symbol: asset.spec.symbol, bars: asset.bars }));
  for (const range of [ranges.train, ranges.validation]) {
    const first = Math.max(cfg.minHistoryBars, range.start);
    for (let i = first; i + horizonBars < range.end; i += decisionEveryBars) {
      const states = buildPortfolioFeatureStates(series, i, cfg);
      for (const asset of assets) {
        const state = states.get(asset.spec.symbol);
        if (state) out.push({ state, symbol: asset.spec.symbol });
      }
    }
  }
  return out;
}

function stratifiedSample(rows: StateRow[], n: number) {
  if (rows.length <= n) return [...rows];
  const bySymbol = new Map<string, StateRow[]>();
  for (const row of rows) {
    const xs = bySymbol.get(row.symbol) ?? [];
    xs.push(row);
    bySymbol.set(row.symbol, xs);
  }
  const symbols = [...bySymbol.keys()].sort();
  const out: StateRow[] = [];
  let cursor = 0;
  while (out.length < n && symbols.length) {
    const symbol = symbols[cursor % symbols.length]!;
    const xs = bySymbol.get(symbol)!;
    const quotaIndex = Math.floor(out.filter((x) => x.symbol === symbol).length * Math.max(1, xs.length - 1) / Math.max(1, Math.ceil(n / symbols.length) - 1));
    const row = xs[Math.min(xs.length - 1, quotaIndex)];
    if (row && !out.some((x) => x.state.ts === row.state.ts && x.symbol === row.symbol)) out.push(row);
    cursor++;
    if (cursor > n * symbols.length * 4) break;
  }
  if (out.length < n) {
    const remaining = rows.filter((r) => !out.some((x) => x.state.ts === r.state.ts && x.symbol === r.symbol));
    for (let i = 0; out.length < n && i < remaining.length; i++) {
      const index = Math.floor(i * Math.max(0, remaining.length - 1) / Math.max(1, n - out.length - 1));
      const row = remaining[index];
      if (row) out.push(row);
    }
  }
  return out.slice(0, n);
}

let usedNewEvaluations = 0;
let freshInputTokens = 0;
const cells: any[] = [];

for (const horizonBars of horizons) {
  const allStates = candidateStates(horizonBars);
  for (const profile of profiles) {
    const raw = createReplayEvaluator(modelName, profile);
    const missing = allStates.filter((x) => !cache.has(raw.name, x.state));
    const remainingBudget = Math.max(0, maxNewEvaluations - usedNewEvaluations);
    const sample = stratifiedSample(missing, Math.min(samplePerCell, remainingBudget));

    if (!sample.length) {
      cells.push({
        horizonBars,
        profile,
        evaluatorNamespace: raw.name,
        totalDevelopmentAssetStates: allStates.length,
        missingBefore: missing.length,
        sampledNewEvaluations: 0,
        status: missing.length ? "budget-skipped" : "fully-cached",
      });
      continue;
    }

    const evaluator = new CachedEvaluator(raw, cache, sample.length);
    const observed = await mapLimit(sample, concurrency, async (row) => {
      const signal = await evaluator.evaluate(row.state);
      return {
        symbol: row.symbol,
        ts: row.state.ts,
        inputTokens: signal.inputTokens,
        latencyMs: signal.latencyMs,
      };
    });
    const tokenSum = observed.reduce((s, x) => s + x.inputTokens, 0);
    const latencySum = observed.reduce((s, x) => s + x.latencyMs, 0);

    usedNewEvaluations += evaluator.newEvaluations;
    freshInputTokens += evaluator.newInputTokens;
    const avgTokens = evaluator.newEvaluations ? tokenSum / evaluator.newEvaluations : 0;
    const avgLatencyMs = evaluator.newEvaluations ? latencySum / evaluator.newEvaluations : 0;
    const missingAfter = allStates.filter((x) => !cache.has(raw.name, x.state)).length;
    const projectedRemainingTokens = avgTokens * missingAfter;
    const projectedRemainingUsd = projectedRemainingTokens / 1e6 * usdPerMTok;

    cells.push({
      horizonBars,
      profile,
      evaluatorNamespace: raw.name,
      totalDevelopmentAssetStates: allStates.length,
      missingBefore: missing.length,
      sampledNewEvaluations: evaluator.newEvaluations,
      avgInputTokens: avgTokens,
      avgLatencyMs,
      missingAfter,
      projectedRemainingTokens,
      projectedRemainingUsd,
      projectedTotalUsdFromScratch: avgTokens * allStates.length / 1e6 * usdPerMTok,
      observed,
      status: "complete",
    });

    console.log(
      profile + " h=" + horizonBars +
      " · sample " + evaluator.newEvaluations +
      " · avg tokens " + avgTokens.toFixed(0) +
      " · avg latency " + avgLatencyMs.toFixed(1) + " ms" +
      " · remaining asset-states " + missingAfter +
      " · projected remaining $" + projectedRemainingUsd.toFixed(4)
    );
  }
}

const summary = {
  version: "portfolio-probe-v1",
  createdAt: Date.now(),
  manifest,
  fingerprint,
  symbols: assets.map((a) => a.spec.symbol),
  alignedBars: bars.length,
  trainBars: split.train.length,
  validationBars: split.validation.length,
  sealedTestBars: split.test.length,
  modelName,
  horizons,
  profiles,
  decisionEveryBars,
  samplePerCell,
  maxNewEvaluations,
  concurrency,
  usedNewEvaluations,
  freshInputTokens,
  actualProbeCostUsd: freshInputTokens / 1e6 * usdPerMTok,
  usdPerMTok,
  execution: { feeBps, slippageBps },
  features: { directionThresholdBpsFloor, directionThresholdFixedCostBps },
  cells,
};

mkdirSync(outPath.includes("/") ? outPath.slice(0, outPath.lastIndexOf("/")) : ".", { recursive: true });
writeFileSync(outPath, JSON.stringify(summary, null, 2) + "\n");
console.log("wrote " + outPath);
console.log("fresh probe tokens " + freshInputTokens + " · estimated probe cost $" + summary.actualProbeCostUsd.toFixed(6));
console.log("sealed test remained untouched: " + split.test.length + " synchronized bars");
