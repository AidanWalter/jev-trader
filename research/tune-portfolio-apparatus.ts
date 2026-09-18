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

const edges = fast ? [0.08, 0.14] : [0.04, 0.08, 0.12, 0.16];
const confidences = fast ? [0.48, 0.58] : [0.42, 0.48, 0.54, 0.60];
const adverse = fast ? [0.65, 0.90] : [0.55, 0.65, 0.75, 0.90];
const costMultiples = fast ? [0.5, 1.25] : [0.25, 0.5, 0.75, 1.0, 1.25, 1.5];
const topNs = fast
  ? [...new Set([Math.max(1, Math.min(pilot.portfolio.topN, assets.length)), Math.max(1, Math.min(2, assets.length))])]
  : [...new Set([1, Math.max(1, Math.min(2, assets.length)), Math.max(1, Math.min(3, assets.length)), Math.max(1, Math.min(pilot.portfolio.topN, assets.length))])];
const maxAssets = fast
  ? [...new Set([pilot.portfolio.maxAssetExposure, Math.min(0.5, pilot.portfolio.maxGrossExposure)])]
  : [...new Set([0.2, 0.35, 0.5, pilot.portfolio.maxAssetExposure].map((x) => Math.min(x, pilot.portfolio.maxGrossExposure)))];

function objective(r: PortfolioResult) {
  const ddPenalty = Math.abs(Math.min(0, r.maxDrawdownPct)) * 0.6;
  const turnoverPenalty = Math.max(0, r.turnover - 25) * 0.03;
  const inactivityPenalty = r.fills.length === 0 ? 2 : 0;
  return r.returnPct - ddPenalty - turnoverPenalty - inactivityPenalty;
}

const costStressMultipliers = [1, 1.5, 2] as const;

async function replayCell(
  evaluator: CachedEvaluator,
  cell: PilotCell,
  policy: PolicyConfig,
  topN: number,
  maxAssetExposure: number,
  range: { start: number; end: number },
  costMultiplier = 1,
) {
  return replayPortfolio(assets, {
    evaluator,
    policy,
    topN,
    maxGrossExposure: pilot.portfolio.maxGrossExposure,
    maxAssetExposure,
    startIndex: Math.max(50, range.start),
    endIndex: range.end - cell.horizonBars - 1,
    decisionEveryBars: pilot.decisionEveryBars,
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
  let best: { policy: PolicyConfig; topN: number; maxAssetExposure: number; train: PortfolioResult; score: number } | null = null;

  for (const minDirectionalEdge of edges) {
    for (const minDirectionalConfidence of confidences) {
      for (const maxAdverseSelection of adverse) {
        for (const minExpectedMoveCostMultiple of costMultiples) {
          for (const topN of topNs) {
            for (const maxAssetExposure of maxAssets) {
              const policy: PolicyConfig = {
                ...defaultPolicyConfig,
                minDirectionalEdge,
                minDirectionalConfidence,
                maxAdverseSelection,
                minExpectedMoveCostMultiple,
              };
              const train = await replayCell(evaluator, cell, policy, topN, maxAssetExposure, ranges.train);
              const score = objective(train);
              if (!best || score > best.score) best = { policy, topN, maxAssetExposure, train, score };
            }
          }
        }
      }
    }
  }

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
      },
      objective: objective(validation),
    });
  }

  const nominal = validationStress.find((x) => x.multiplier === 1)!;
  const stress15 = validationStress.find((x) => x.multiplier === 1.5)!;
  const stress2 = validationStress.find((x) => x.multiplier === 2)!;
  const robustValidationObjective =
    nominal.objective * 0.5 +
    stress15.objective * 0.3 +
    stress2.objective * 0.2;

  candidates.push({
    horizonBars: cell.horizonBars,
    profile: cell.profile,
    evaluatorNamespace: cell.evaluatorNamespace,
    policy: best!.policy,
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
    },
    trainObjective: best!.score,
    validationMetrics: nominal.metrics,
    validationObjective: nominal.objective,
    validationStress,
    robustValidationObjective,
  });

  console.log(
    cell.profile + " h=" + cell.horizonBars +
    " · train " + best!.train.returnPct.toFixed(2) + "%" +
    " · validation " + nominal.metrics.returnPct.toFixed(2) + "%" +
    " · 1.5x " + stress15.metrics.returnPct.toFixed(2) + "%" +
    " · 2x " + stress2.metrics.returnPct.toFixed(2) + "%" +
    " · topN " + best!.topN +
    " · maxAsset " + best!.maxAssetExposure.toFixed(2)
  );
}

if (!candidates.length) throw new Error("portfolio pilot contains no complete cells");
candidates.sort((a, b) => b.robustValidationObjective - a.robustValidationObjective);
const chosen = candidates[0]!;
const stress15 = chosen.validationStress.find((x: any) => x.multiplier === 1.5);
const reasons: string[] = [];
if (!(chosen.validationMetrics.returnPct > 0)) reasons.push("nominal validation return is not positive");
if (!(stress15?.metrics.returnPct > 0)) reasons.push("validation return is not positive at 1.5x modeled costs");
if (chosen.validationMetrics.fills < 10) reasons.push("fewer than 10 validation fills");
if (!(chosen.validationObjective > 0)) reasons.push("nominal validation objective is not positive");

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
  costStressMultipliers,
  qualification: {
    passed: reasons.length === 0,
    reasons,
    criteria: {
      positiveNominalReturn: true,
      positiveReturnAtCostMultiplier: 1.5,
      minimumValidationFills: 10,
      positiveNominalObjective: true,
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
