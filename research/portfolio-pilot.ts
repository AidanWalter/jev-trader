import { mkdirSync, writeFileSync } from "node:fs";
import { CachedEvaluator, JsonlSignalCache } from "./cache";
import { mapLimit } from "./concurrency";
import { assertResearchDataQuality } from "./data-quality";
import { createReplayEvaluator } from "./evaluator";
import { defaultFeatureConfig } from "./features";
import { buildPortfolioFeatureStates } from "./portfolio-features";
import type { InputProfile } from "./profiles";
import { replayPortfolio } from "./portfolio";
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
  console.error("usage: bun run research/portfolio-pilot.ts universe.json --model=jev --horizons=6,12 --profiles=minimal,technical,path,full");
  process.exit(1);
}

const modelName = flag("model", "jev")!;
const concurrency = Math.max(1, Number(flag("concurrency", modelName === "jev" ? "4" : "8")));
const horizons = (flag("horizons", "6,12") ?? "6,12")
  .split(",").map(Number).filter((x) => Number.isFinite(x) && x > 0);
const profiles = (flag("profiles", "minimal,technical,path,full") ?? "minimal,technical,path,full")
  .split(",").map((x) => x.trim()).filter(Boolean) as InputProfile[];
const decisionEveryBars = Math.max(1, Number(flag("decision-every", "4")));
const maxNewEvaluations = Math.max(0, Number(flag("max-new-evals", modelName === "jev" ? "20000" : "1000000000")));
const cachePath = flag("cache", "data/portfolio-pilot-cache.jsonl")!;
const outPath = flag("out", "data/portfolio-pilot-summary.json")!;
const feeBps = Number(flag("fee-bps", "4"));
const slippageBps = Number(flag("slippage-bps", "1"));
const maxGrossExposure = Number(flag("max-gross", "1"));
const maxAssetExposure = Number(flag("max-asset", "0.35"));
const topN = Math.max(1, Number(flag("top-n", "3")));
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

type Score = {
  n: number;
  accuracy: number;
  brier: number;
  logLoss: number;
  meanCalledSideReturnBps: number;
};

function collectStates(
  horizonBars: number,
  range: { start: number; end: number },
): { state: FeatureState; assetIndex: number; barIndex: number }[] {
  const cfg = {
    ...defaultFeatureConfig,
    horizonBars,
    directionThresholdBpsFloor,
    directionThresholdFixedCostBps,
  };
  const out: { state: FeatureState; assetIndex: number; barIndex: number }[] = [];
  const first = Math.max(cfg.minHistoryBars, range.start);
  const series = assets.map((asset) => ({ symbol: asset.spec.symbol, bars: asset.bars }));
  for (let i = first; i + horizonBars < range.end; i += decisionEveryBars) {
    const states = buildPortfolioFeatureStates(series, i, cfg);
    for (let a = 0; a < assets.length; a++) {
      const state = states.get(assets[a]!.spec.symbol);
      if (state) out.push({ state, assetIndex: a, barIndex: i });
    }
  }
  return out;
}

async function scoreStates(
  rows: { state: FeatureState; assetIndex: number; barIndex: number }[],
  evaluator: CachedEvaluator,
  horizonBars: number,
): Promise<Score> {
  const labels: Direction[] = ["long", "flat", "short"];
  let n = 0, correct = 0, brier = 0, logLoss = 0, called = 0;
  const prepared = rows.map((row) => {
    const future = assets[row.assetIndex]!.bars[row.barIndex + horizonBars]!;
    const retBps = (future.close / row.state.price - 1) * 10_000;
    const truth: Direction =
      retBps > row.state.directionThresholdBps ? "long" :
      retBps < -row.state.directionThresholdBps ? "short" : "flat";
    return { row, retBps, truth };
  });
  const signals = await mapLimit(prepared, concurrency, (x) => evaluator.evaluate(x.row.state));
  for (let i = 0; i < prepared.length; i++) {
    const { retBps, truth } = prepared[i]!;
    const signal = signals[i]!;
    n++;
    if (signal.direction.choice === truth) correct++;
    for (const label of labels) {
      const y = label === truth ? 1 : 0;
      const p = signal.direction.probabilities[label];
      brier += (p - y) ** 2;
    }
    logLoss += -Math.log(Math.max(1e-12, signal.direction.probabilities[truth]));
    called += signal.direction.choice === "long" ? retBps : signal.direction.choice === "short" ? -retBps : 0;
  }
  if (!n) throw new Error("no scoreable universe states");
  return {
    n,
    accuracy: correct / n,
    brier: brier / n,
    logLoss: logLoss / n,
    meanCalledSideReturnBps: called / n,
  };
}

let usedNewEvaluations = 0;
let freshInputTokens = 0;
const cells: any[] = [];

for (const horizonBars of horizons) {
  const trainStates = collectStates(horizonBars, ranges.train);
  const validationStates = collectStates(horizonBars, ranges.validation);

  for (const profile of profiles) {
    const raw = createReplayEvaluator(modelName, profile);
    const allDevStates = [...trainStates, ...validationStates];
    const missing = allDevStates.filter((x) => !cache.has(raw.name, x.state)).length;
    const remaining = Math.max(0, maxNewEvaluations - usedNewEvaluations);

    if (modelName === "jev" && missing > remaining) {
      cells.push({
        horizonBars,
        profile,
        evaluatorNamespace: raw.name,
        status: "budget-skipped",
        missingCalls: missing,
        remainingBudget: remaining,
      });
      console.log(profile + " h=" + horizonBars + " · skipped, needs " + missing + " fresh calls with " + remaining + " remaining");
      continue;
    }

    const evaluator = new CachedEvaluator(raw, cache, remaining);
    const train = await scoreStates(trainStates, evaluator, horizonBars);
    const validation = await scoreStates(validationStates, evaluator, horizonBars);
    const validationReplay = await replayPortfolio(assets, {
      evaluator,
      startIndex: ranges.validation.start,
      endIndex: ranges.validation.end - horizonBars - 1,
      decisionEveryBars,
      topN,
      maxGrossExposure,
      maxAssetExposure,
      features: {
        horizonBars,
        directionThresholdBpsFloor,
        directionThresholdFixedCostBps,
      },
      execution: {
        initialCash: Number(flag("cash", "100")),
        feeBps,
        slippageBps,
        spreadBpsFallback: Number(flag("spread-bps", "4")),
        allowShort: flag("allow-short", "true") !== "false",
      },
    });

    usedNewEvaluations += evaluator.newEvaluations;
    freshInputTokens += evaluator.newInputTokens;
    const cell = {
      horizonBars,
      profile,
      evaluatorNamespace: raw.name,
      status: "complete",
      train,
      validation,
      validationReplay: {
        initialEquity: validationReplay.initialEquity,
        finalEquity: validationReplay.finalEquity,
        pnl: validationReplay.pnl,
        returnPct: validationReplay.returnPct,
        maxDrawdownPct: validationReplay.maxDrawdownPct,
        turnover: validationReplay.turnover,
        fees: validationReplay.fees,
        borrowCost: validationReplay.borrowCost,
        fundingNet: validationReplay.fundingNet,
        fills: validationReplay.fills.length,
      },
      newEvaluations: evaluator.newEvaluations,
      freshInputTokens: evaluator.newInputTokens,
    };
    cells.push(cell);
    console.log(
      profile + " h=" + horizonBars +
      " · val acc " + (validation.accuracy * 100).toFixed(1) + "%" +
      " · called " + validation.meanCalledSideReturnBps.toFixed(2) + " bps" +
      " · portfolio " + validationReplay.returnPct.toFixed(2) + "%" +
      " · DD " + validationReplay.maxDrawdownPct.toFixed(2) + "%" +
      " · fills " + validationReplay.fills.length +
      " · new " + evaluator.newEvaluations
    );
  }
}

const summary = {
  version: "portfolio-pilot-v1",
  createdAt: Date.now(),
  manifest,
  fingerprint,
  symbols: assets.map((x) => x.spec.symbol),
  kind: assets[0]!.spec.kind,
  alignedBars: bars.length,
  trainBars: split.train.length,
  validationBars: split.validation.length,
  sealedTestBars: split.test.length,
  modelName,
  horizons,
  profiles,
  decisionEveryBars,
  maxNewEvaluations,
  concurrency,
  usedNewEvaluations,
  freshInputTokens,
  portfolio: { topN, maxGrossExposure, maxAssetExposure },
  execution: {
    feeBps,
    slippageBps,
    spreadBpsFallback: Number(flag("spread-bps", "4")),
    allowShort: flag("allow-short", "true") !== "false",
  },
  features: { directionThresholdBpsFloor, directionThresholdFixedCostBps },
  cells,
};

mkdirSync(outPath.includes("/") ? outPath.slice(0, outPath.lastIndexOf("/")) : ".", { recursive: true });
writeFileSync(outPath, JSON.stringify(summary, null, 2) + "\n");
console.log("wrote " + outPath);
console.log("sealed test remained untouched: " + split.test.length + " synchronized bars");
