import { readFileSync, writeFileSync } from "node:fs";
import { CachedEvaluator, JsonlSignalCache } from "./cache";
import {
  CalibratedEvaluator,
  fitIsotonicCalibration,
  rawExpectedMoveBps,
} from "./calibration";
import { createReplayEvaluator } from "./evaluator";
import { defaultFeatureConfig } from "./features";
import { buildPortfolioFeatureStates } from "./portfolio-features";
import { defaultPolicyConfig } from "./policy";
import { replayPortfolio, type PortfolioResult } from "./portfolio";
import type { InputProfile } from "./profiles";
import { chronologicalRanges, chronologicalSplit } from "./splits";
import type { PolicyConfig } from "./types";
import { alignUniverse, fingerprintUniverse, loadUniverse } from "./universe";

interface PilotCell {
  status: string;
  horizonBars: number;
  profile: InputProfile;
  evaluatorNamespace: string;
}
interface PortfolioPilot {
  version: "portfolio-pilot-v1";
  manifest: string;
  fingerprint: { combinedSha256: string };
  modelName: string;
  alignedBars: number;
  decisionEveryBars: number;
  portfolio: { topN: number; maxGrossExposure: number; maxAssetExposure: number };
  execution: {
    feeBps: number;
    slippageBps: number;
    spreadBpsFallback: number;
    allowShort: boolean;
  };
  features: {
    directionThresholdBpsFloor: number;
    directionThresholdFixedCostBps: number;
  };
  cells: PilotCell[];
}

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const prefix = "--" + name + "=";
  const hit = args.find((x) => x.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
};
const manifest = args.find((x) => !x.startsWith("--"));
const pilotPath = flag("pilot");
if (!manifest || !pilotPath) {
  console.error(
    "usage: bun run research/tune-calibrated-portfolio.ts universe.json --pilot=data/portfolio-pilot-summary.json --cache=data/portfolio-pilot-cache.jsonl",
  );
  process.exit(1);
}

const pilot = JSON.parse(readFileSync(pilotPath, "utf8")) as PortfolioPilot;
if (pilot.version !== "portfolio-pilot-v1") throw new Error("portfolio pilot summary must be portfolio-pilot-v1");
const fingerprint = fingerprintUniverse(manifest);
if (fingerprint.combinedSha256 !== pilot.fingerprint.combinedSha256) {
  throw new Error("universe fingerprint differs from pilot");
}

const assets = alignUniverse(loadUniverse(manifest));
const bars = assets[0]!.bars;
if (bars.length !== pilot.alignedBars) throw new Error("aligned universe bar count differs from pilot");
const ranges = chronologicalRanges(bars);
const split = chronologicalSplit(bars);
const cache = new JsonlSignalCache(flag("cache", "data/portfolio-pilot-cache.jsonl")!);
const outPath = flag("out", "data/portfolio-calibrated-selection.json")!;
const calibrationFraction = Math.min(0.9, Math.max(0.5, Number(flag("calibration-fraction", "0.70"))));
const quantileBins = Math.max(7, Number(flag("calibration-bins", "31")));
const shrinkage = Math.max(0, Number(flag("calibration-shrinkage", "100")));

function objective(r: PortfolioResult) {
  const ddPenalty = Math.abs(Math.min(0, r.maxDrawdownPct)) * 0.6;
  const days = Math.max(1, (r.endTs - r.startTs) / 86_400_000);
  const turnoverPerDay = r.turnover / days;
  const turnoverPenalty = Math.max(0, turnoverPerDay - 1.25) * 0.5;
  const inactivityPenalty = r.fills.length === 0 ? 2 : 0;
  return r.returnPct - ddPenalty - turnoverPenalty - inactivityPenalty;
}

function alignedCut(start: number, end: number, fraction: number, every: number) {
  const raw = start + Math.floor((end - start) * fraction);
  const steps = Math.max(1, Math.floor((raw - start) / every));
  return Math.min(end - every, start + steps * every);
}

function validationSegments(decisionEveryBars: number) {
  const start = ranges.validation.start;
  const end = ranges.validation.end;
  const span = end - start;
  const cuts = [0, 0.25, 0.5, 0.75, 1].map((f, idx) => {
    if (idx === 0) return start;
    if (idx === 4) return end;
    const raw = start + Math.floor(span * f);
    const aligned =
      start + Math.max(1, Math.floor((raw - start) / decisionEveryBars)) * decisionEveryBars;
    return Math.min(end - decisionEveryBars, aligned);
  });
  const out: { name: string; start: number; end: number }[] = [];
  for (let i = 0; i < 4; i++) {
    if (cuts[i + 1]! <= cuts[i]!) continue;
    out.push({ name: "q" + (i + 1), start: cuts[i]!, end: cuts[i + 1]! });
  }
  return out;
}

async function replayCell(
  evaluator: CalibratedEvaluator,
  cell: PilotCell,
  policy: PolicyConfig,
  topN: number,
  maxAssetExposure: number,
  range: { start: number; end: number },
  costMultiplier = 1,
  decisionEveryBars = pilot.decisionEveryBars,
) {
  return replayPortfolio(assets, {
    evaluator,
    policy,
    topN,
    maxGrossExposure: pilot.portfolio.maxGrossExposure,
    maxAssetExposure,
    startIndex: Math.max(defaultFeatureConfig.minHistoryBars, range.start),
    endIndex: range.end - cell.horizonBars - 1,
    decisionEveryBars,
    features: {
      horizonBars: cell.horizonBars,
      directionThresholdBpsFloor: pilot.features.directionThresholdBpsFloor,
      directionThresholdFixedCostBps: pilot.features.directionThresholdFixedCostBps,
    },
    execution: {
      initialCash: Number(flag("cash", "100")),
      feeBps: pilot.execution.feeBps * costMultiplier,
      slippageBps: pilot.execution.slippageBps * costMultiplier,
      spreadBpsFallback: pilot.execution.spreadBpsFallback,
      spreadCostMultiplier: costMultiplier,
      allowShort: pilot.execution.allowShort,
      shortBorrowBpsPerDay: Number(flag("short-borrow-bps-day", "1")),
    },
  });
}

const candidates: any[] = [];
for (const cell of pilot.cells.filter((x) => x.status === "complete")) {
  const raw = createReplayEvaluator(pilot.modelName, cell.profile);
  if (raw.name !== cell.evaluatorNamespace) {
    throw new Error("evaluator namespace changed since pilot for " + cell.profile + " h=" + cell.horizonBars);
  }
  const cachedRaw = new CachedEvaluator(raw, cache, 0);

  const calibrationEnd = alignedCut(
    ranges.train.start,
    ranges.train.end,
    calibrationFraction,
    pilot.decisionEveryBars,
  );
  const calibrationRange = { start: ranges.train.start, end: calibrationEnd };
  const tuningRange = { start: calibrationEnd, end: ranges.train.end };
  const cfg = {
    ...defaultFeatureConfig,
    horizonBars: cell.horizonBars,
    directionThresholdBpsFloor: pilot.features.directionThresholdBpsFloor,
    directionThresholdFixedCostBps: pilot.features.directionThresholdFixedCostBps,
  };
  const series = assets.map((asset) => ({ symbol: asset.spec.symbol, bars: asset.bars }));
  const points: { rawExpectedBps: number; realizedReturnBps: number }[] = [];

  const first = Math.max(cfg.minHistoryBars, calibrationRange.start);
  for (let i = first; i + cell.horizonBars < calibrationRange.end; i += pilot.decisionEveryBars) {
    const states = buildPortfolioFeatureStates(series, i, cfg);
    for (const asset of assets) {
      const state = states.get(asset.spec.symbol);
      if (!state) continue;
      const signal = await cachedRaw.evaluate(state);
      const future = asset.bars[i + cell.horizonBars]!;
      const realizedReturnBps = (future.close / state.price - 1) * 10_000;
      points.push({
        rawExpectedBps: rawExpectedMoveBps(signal, state),
        realizedReturnBps,
      });
    }
  }

  const calibration = fitIsotonicCalibration(points, quantileBins, shrinkage);
  const evaluator = new CalibratedEvaluator(cachedRaw, calibration);

  const edges = [0.01, 0.02, 0.04, 0.08, 0.12];
  const confidences = [0.50, 0.52, 0.55, 0.60];
  const costMultiples = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5];
  const topNs = [...new Set([1, 2, Math.min(3, assets.length)])];
  const maxAssets = [...new Set([0.2, 0.35, 0.5, pilot.portfolio.maxAssetExposure])];
  let best: {
    policy: PolicyConfig;
    topN: number;
    maxAssetExposure: number;
    decisionEveryBars: number;
    train: PortfolioResult;
    score: number;
  } | null = null;

  for (const minDirectionalEdge of edges) {
    for (const minDirectionalConfidence of confidences) {
      for (const minExpectedMoveCostMultiple of costMultiples) {
        for (const topN of topNs) {
          for (const maxAssetExposure of maxAssets) {
            const policy: PolicyConfig = {
              ...defaultPolicyConfig,
              minDirectionalEdge,
              minDirectionalConfidence,
              maxAdverseSelection: 1,
              minExpectedMoveCostMultiple,
              flatExitProbability: 0.99,
            };
            const train = await replayCell(
              evaluator,
              cell,
              policy,
              topN,
              maxAssetExposure,
              tuningRange,
            );
            const score = objective(train);
            if (!best || score > best.score) {
              best = {
                policy,
                topN,
                maxAssetExposure,
                decisionEveryBars: pilot.decisionEveryBars,
                train,
                score,
              };
            }
          }
        }
      }
    }
  }

  const cadenceCandidates = [...new Set([1, 2, 3, 4].map((m) => pilot.decisionEveryBars * m))];
  const minChanges = [0.05, 0.12, 0.20];
  const sizeThresholdSets: [number, number, number][] = [
    [0.02, 0.05, 0.10],
    [0.04, 0.08, 0.16],
    [0.08, 0.16, 0.30],
  ];

  let refined = best!;
  for (const decisionEveryBars of cadenceCandidates) {
    for (const minExposureChange of minChanges) {
      for (const sizeScoreThresholds of sizeThresholdSets) {
        const policy: PolicyConfig = {
          ...best!.policy,
          minExposureChange,
          sizeScoreThresholds,
        };
        const train = await replayCell(
          evaluator,
          cell,
          policy,
          best!.topN,
          best!.maxAssetExposure,
          tuningRange,
          1,
          decisionEveryBars,
        );
        const score = objective(train);
        if (score > refined.score) {
          refined = {
            policy,
            topN: best!.topN,
            maxAssetExposure: best!.maxAssetExposure,
            decisionEveryBars,
            train,
            score,
          };
        }
      }
    }
  }
  best = refined;

  const validationStress = [];
  for (const multiplier of [1, 1.5, 2] as const) {
    const validation = await replayCell(
      evaluator,
      cell,
      best.policy,
      best.topN,
      best.maxAssetExposure,
      ranges.validation,
      multiplier,
      best.decisionEveryBars,
    );
    validationStress.push({
      multiplier,
      metrics: {
        returnPct: validation.returnPct,
        pnl: validation.pnl,
        maxDrawdownPct: validation.maxDrawdownPct,
        turnover: validation.turnover,
        fills: validation.fills.length,
        fees: validation.fees,
        borrowCost: validation.borrowCost,
        fundingNet: validation.fundingNet,
      },
      objective: objective(validation),
    });
  }

  const validationSegmentsResult = [];
  for (const segment of validationSegments(best.decisionEveryBars)) {
    const result = await replayCell(
      evaluator,
      cell,
      best.policy,
      best.topN,
      best.maxAssetExposure,
      segment,
      1,
      best.decisionEveryBars,
    );
    validationSegmentsResult.push({
      name: segment.name,
      metrics: {
        returnPct: result.returnPct,
        pnl: result.pnl,
        maxDrawdownPct: result.maxDrawdownPct,
        turnover: result.turnover,
        fills: result.fills.length,
        fees: result.fees,
        borrowCost: result.borrowCost,
        fundingNet: result.fundingNet,
      },
      objective: objective(result),
    });
  }

  const nominal = validationStress.find((x) => x.multiplier === 1)!;
  const stress15 = validationStress.find((x) => x.multiplier === 1.5)!;
  const stress2 = validationStress.find((x) => x.multiplier === 2)!;
  const weakestSegmentObjective = Math.min(...validationSegmentsResult.map((x) => x.objective));
  const costRobustObjective =
    nominal.objective * 0.5 +
    stress15.objective * 0.3 +
    stress2.objective * 0.2;
  const robustValidationObjective =
    costRobustObjective * 0.8 +
    weakestSegmentObjective * 0.2;

  candidates.push({
    horizonBars: cell.horizonBars,
    profile: cell.profile,
    evaluatorNamespace: cell.evaluatorNamespace,
    calibration,
    calibrationRange,
    tuningRange,
    policy: best.policy,
    decisionEveryBars: best.decisionEveryBars,
    portfolio: {
      topN: best.topN,
      maxGrossExposure: pilot.portfolio.maxGrossExposure,
      maxAssetExposure: best.maxAssetExposure,
    },
    trainMetrics: {
      returnPct: best.train.returnPct,
      pnl: best.train.pnl,
      maxDrawdownPct: best.train.maxDrawdownPct,
      turnover: best.train.turnover,
      fills: best.train.fills.length,
      fees: best.train.fees,
    },
    trainObjective: best.score,
    validationMetrics: nominal.metrics,
    validationObjective: nominal.objective,
    validationStress,
    validationSegments: validationSegmentsResult,
    weakestSegmentObjective,
    costRobustObjective,
    robustValidationObjective,
  });

  console.log(
    cell.profile + " h=" + cell.horizonBars +
    " · cal blocks " + calibration.blocks.length +
    " · tune " + best.train.returnPct.toFixed(2) + "%" +
    " · validation " + nominal.metrics.returnPct.toFixed(2) + "%" +
    " · 1.5x " + stress15.metrics.returnPct.toFixed(2) + "%" +
    " · 2x " + stress2.metrics.returnPct.toFixed(2) + "%" +
    " · quarters " + validationSegmentsResult.map((x) => x.metrics.returnPct.toFixed(2) + "%").join("/") +
    " · cadence " + best.decisionEveryBars +
    " · topN " + best.topN +
    " · maxAsset " + best.maxAssetExposure.toFixed(2),
  );
}

if (!candidates.length) throw new Error("pilot contains no complete cells");
candidates.sort((a, b) => b.robustValidationObjective - a.robustValidationObjective);
const chosen = candidates[0]!;
const stress15 = chosen.validationStress.find((x: any) => x.multiplier === 1.5);
const stress2 = chosen.validationStress.find((x: any) => x.multiplier === 2);
const reasons: string[] = [];
if (!(chosen.validationMetrics.returnPct > 0)) reasons.push("nominal validation return is not positive");
if (!(stress15?.metrics.returnPct > 0)) reasons.push("validation return is not positive at 1.5x modeled costs");
if (!(stress2?.metrics.returnPct > 0)) reasons.push("validation return is not positive at 2x modeled costs");
if (chosen.validationMetrics.fills < 10) reasons.push("fewer than 10 validation fills");
if (!(chosen.validationObjective > 0)) reasons.push("nominal validation objective is not positive");
for (const segment of chosen.validationSegments ?? []) {
  if (!(segment.metrics.returnPct > 0)) reasons.push("validation segment " + segment.name + " return is not positive");
  if (!(segment.objective > 0)) reasons.push("validation segment " + segment.name + " objective is not positive");
}
if (!(chosen.weakestSegmentObjective > 0)) reasons.push("weakest validation segment objective is not positive");
if (!(chosen.robustValidationObjective > 0)) reasons.push("robust validation objective is not positive");

const selection = {
  version: "portfolio-calibrated-selection-v1",
  selectedAt: Date.now(),
  sourcePilot: pilotPath,
  manifest,
  fingerprint,
  evaluatorKind: pilot.modelName,
  execution: pilot.execution,
  features: pilot.features,
  sealedTestBars: split.test.length,
  calibrationConfig: { calibrationFraction, quantileBins, shrinkage },
  chosen,
  qualification: {
    passed: reasons.length === 0,
    reasons,
  },
  candidates,
};

writeFileSync(outPath, JSON.stringify(selection, null, 2) + "\n");
console.log("");
console.log("selected calibrated " + chosen.profile + " h=" + chosen.horizonBars);
console.log(
  "validation " + chosen.validationMetrics.returnPct.toFixed(2) + "%" +
  " · DD " + chosen.validationMetrics.maxDrawdownPct.toFixed(2) + "%" +
  " · fills " + chosen.validationMetrics.fills,
);
console.log("qualification " + (selection.qualification.passed ? "PASSED" : "FAILED") + (reasons.length ? " · " + reasons.join("; ") : ""));
console.log("wrote " + outPath);
console.log("sealed test remained untouched: " + split.test.length + " synchronized bars");
