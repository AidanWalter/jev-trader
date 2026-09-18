import { readFileSync, writeFileSync } from "node:fs";
import { CachedEvaluator, JsonlSignalCache } from "./cache";
import { createReplayEvaluator } from "./evaluator";
import { defaultPolicyConfig } from "./policy";
import { replayPortfolio, type PortfolioResult } from "./portfolio";
import { chronologicalRanges, chronologicalSplit } from "./splits";
import type { InputProfile } from "./profiles";
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
  console.error("usage: bun run research/tune-portfolio-apparatus.ts universe.json --pilot=data/portfolio-pilot-summary.json --cache=data/portfolio-pilot-cache.jsonl");
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
const split = chronologicalSplit(bars);
const ranges = chronologicalRanges(bars);
const cache = new JsonlSignalCache(flag("cache", "data/portfolio-pilot-cache.jsonl")!);
const outPath = flag("out", "data/portfolio-apparatus-selection.json")!;
const grid = flag("grid", "full")!;
const fast = grid === "fast";
const directionOnly = flag("direction-only", "false") === "true";

const edges = fast ? [0.08, 0.14] : [0.04, 0.08, 0.12, 0.16];
const confidences = fast
  ? [0.58, 0.80, 0.90]
  : [0.42, 0.48, 0.54, 0.60, 0.70, 0.80, 0.90, 0.95];
const adverse = directionOnly ? [1] : (fast ? [0.65, 0.90] : [0.55, 0.65, 0.75, 0.90]);
const costMultiples = directionOnly ? [1] : (fast ? [0.5, 1.25] : [0.25, 0.5, 0.75, 1.0, 1.25, 1.5]);
const topNs = fast
  ? [...new Set([Math.max(1, Math.min(pilot.portfolio.topN, assets.length)), Math.max(1, Math.min(2, assets.length))])]
  : [...new Set([1, Math.max(1, Math.min(2, assets.length)), Math.max(1, Math.min(3, assets.length)), Math.max(1, Math.min(pilot.portfolio.topN, assets.length))])];
const maxAssets = fast
  ? [...new Set([pilot.portfolio.maxAssetExposure, Math.min(0.5, pilot.portfolio.maxGrossExposure)])]
  : [...new Set([0.2, 0.35, 0.5, pilot.portfolio.maxAssetExposure].map((x) => Math.min(x, pilot.portfolio.maxGrossExposure)))];
const flatExits = fast ? [0.54, 0.64] : [0.50, 0.58, 0.66];
const minChanges = fast ? [0.08, 0.18] : [0.05, 0.12, 0.20];
const sizeThresholdSets: [number, number, number][] = fast
  ? [[0.08, 0.20, 0.36], [0.12, 0.26, 0.44]]
  : [[0.06, 0.16, 0.30], [0.10, 0.22, 0.38], [0.14, 0.28, 0.46]];
const cadenceCandidates = [...new Set(
  (fast ? [1, 2] : [1, 2, 3, 4]).map((m) => pilot.decisionEveryBars * m)
)];

function objective(r: PortfolioResult) {
  const ddPenalty = Math.abs(Math.min(0, r.maxDrawdownPct)) * 0.6;
  const days = Math.max(1, (r.endTs - r.startTs) / 86_400_000);
  const turnoverPerDay = r.turnover / days;
  const turnoverPenalty = Math.max(0, turnoverPerDay - 1.25) * 0.5;
  const inactivityPenalty = r.fills.length === 0 ? 2 : 0;
  return r.returnPct - ddPenalty - turnoverPenalty - inactivityPenalty;
}

const costStressMultipliers = [1, 1.5, 2] as const;

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
  const out = [];
  for (let i = 0; i < 4; i++) {
    if (cuts[i + 1]! <= cuts[i]!) continue;
    out.push({ name: "q" + (i + 1), start: cuts[i]!, end: cuts[i + 1]! });
  }
  return out;
}

async function replayCell(
  evaluator: CachedEvaluator,
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
    startIndex: Math.max(50, range.start),
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
  const evaluator = new CachedEvaluator(raw, cache, 0);
  let best: { policy: PolicyConfig; topN: number; maxAssetExposure: number; decisionEveryBars: number; train: PortfolioResult; score: number } | null = null;

  for (const minDirectionalEdge of edges) {
    for (const minDirectionalConfidence of confidences) {
      for (const maxAdverseSelection of adverse) {
        for (const minExpectedMoveCostMultiple of costMultiples) {
          for (const topN of topNs) {
            for (const maxAssetExposure of maxAssets) {
              const policy: PolicyConfig = {
                ...defaultPolicyConfig,
                directionOnly,
                minDirectionalEdge,
                minDirectionalConfidence,
                maxAdverseSelection,
                minExpectedMoveCostMultiple,
              };
              const train = await replayCell(evaluator, cell, policy, topN, maxAssetExposure, ranges.train);
              const score = objective(train);
              if (!best || score > best.score) best = { policy, topN, maxAssetExposure, decisionEveryBars: pilot.decisionEveryBars, train, score };
            }
          }
        }
      }
    }
  }

  let refined = best!;
  for (const decisionEveryBars of cadenceCandidates) {
    for (const flatExitProbability of flatExits) {
      for (const minExposureChange of minChanges) {
        for (const sizeScoreThresholds of sizeThresholdSets) {
          const policy: PolicyConfig = {
            ...best!.policy,
            flatExitProbability,
            minExposureChange,
            sizeScoreThresholds,
          };
          const train = await replayCell(
            evaluator,
            cell,
            policy,
            best!.topN,
            best!.maxAssetExposure,
            ranges.train,
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
  }
  best = refined;

  const validationStress = [];
  for (const multiplier of costStressMultipliers) {
    const validation = await replayCell(
      evaluator,
      cell,
      best!.policy,
      best!.topN,
      best!.maxAssetExposure,
      ranges.validation,
      multiplier,
      best!.decisionEveryBars,
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

  const nominal = validationStress.find((x) => x.multiplier === 1)!;
  const stress15 = validationStress.find((x) => x.multiplier === 1.5)!;
  const stress2 = validationStress.find((x) => x.multiplier === 2)!;

  const validationSegmentsResult = [];
  for (const segment of validationSegments(best!.decisionEveryBars)) {
    const r = await replayCell(
      evaluator,
      cell,
      best!.policy,
      best!.topN,
      best!.maxAssetExposure,
      segment,
      1,
      best!.decisionEveryBars,
    );
    validationSegmentsResult.push({
      name: segment.name,
      metrics: {
        returnPct: r.returnPct,
        pnl: r.pnl,
        maxDrawdownPct: r.maxDrawdownPct,
        turnover: r.turnover,
        fills: r.fills.length,
        fees: r.fees,
        borrowCost: r.borrowCost,
        fundingNet: r.fundingNet,
      },
      objective: objective(r),
    });
  }
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
    policy: best!.policy,
    decisionEveryBars: best!.decisionEveryBars,
    portfolio: {
      topN: best!.topN,
      maxGrossExposure: pilot.portfolio.maxGrossExposure,
      maxAssetExposure: best!.maxAssetExposure,
    },
    trainMetrics: {
      returnPct: best!.train.returnPct,
      pnl: best!.train.pnl,
      maxDrawdownPct: best!.train.maxDrawdownPct,
      turnover: best!.train.turnover,
      fills: best!.train.fills.length,
      fees: best!.train.fees,
      borrowCost: best!.train.borrowCost,
      fundingNet: best!.train.fundingNet,
    },
    trainObjective: best!.score,
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
    " · train " + best!.train.returnPct.toFixed(2) + "%" +
    " · validation " + nominal.metrics.returnPct.toFixed(2) + "%" +
    " · 1.5x " + stress15.metrics.returnPct.toFixed(2) + "%" +
    " · 2x " + stress2.metrics.returnPct.toFixed(2) + "%" +
    " · halves " + validationSegmentsResult.map((x) => x.metrics.returnPct.toFixed(2) + "%").join("/") +
    " · cadence " + best!.decisionEveryBars +
    " · topN " + best!.topN +
    " · maxAsset " + best!.maxAssetExposure.toFixed(2)
  );
}

if (!candidates.length) throw new Error("portfolio pilot contains no complete cells");
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
const losingValidationSegments = (chosen.validationSegments ?? []).filter((x: any) => !(x.metrics.returnPct > 0));
if (losingValidationSegments.length) {
  reasons.push("one or more chronological validation segments are not positive: " + losingValidationSegments.map((x: any) => x.name).join(","));
}
const weakObjectiveSegments = (chosen.validationSegments ?? []).filter((x: any) => !(x.objective > 0));
if (weakObjectiveSegments.length) {
  reasons.push("one or more chronological validation segment objectives are not positive: " + weakObjectiveSegments.map((x: any) => x.name).join(","));
}
if (!(chosen.weakestSegmentObjective > 0)) reasons.push("weakest validation segment objective is not positive");
if (!(chosen.robustValidationObjective > 0)) reasons.push("robust validation objective is not positive");

const selection = {
  version: "portfolio-apparatus-selection-v1",
  selectedAt: Date.now(),
  sourcePilot: pilotPath,
  manifest,
  fingerprint,
  evaluatorKind: pilot.modelName,
  decisionEveryBars: pilot.decisionEveryBars,
  execution: pilot.execution,
  features: pilot.features,
  sealedTestBars: split.test.length,
  chosen,
  grid,
  policyRefinement: { flatExits, minChanges, sizeThresholdSets, cadenceCandidates },
  costStressMultipliers,
  qualification: {
    passed: reasons.length === 0,
    reasons,
    criteria: {
      positiveNominalReturn: true,
      positiveReturnAtCostMultiplier: 2,
      minimumValidationFills: 10,
      positiveNominalObjective: true,
      positiveEachChronologicalValidationSegment: true,
      positiveEachChronologicalValidationSegmentObjective: true,
      positiveRobustValidationObjective: true,
    },
  },
  candidates,
};

writeFileSync(outPath, JSON.stringify(selection, null, 2) + "\n");
console.log("");
console.log("selected " + chosen.profile + " h=" + chosen.horizonBars + " · topN " + chosen.portfolio.topN);
console.log("validation return " + chosen.validationMetrics.returnPct.toFixed(2) + "% · DD " + chosen.validationMetrics.maxDrawdownPct.toFixed(2) + "% · fills " + chosen.validationMetrics.fills);
console.log("qualification " + (selection.qualification.passed ? "PASSED" : "FAILED") + (reasons.length ? " · " + reasons.join("; ") : ""));
console.log("wrote " + outPath);
console.log("sealed test remained untouched: " + split.test.length + " synchronized bars");
