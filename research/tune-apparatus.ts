import { extname } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { CachedEvaluator, JsonlSignalCache } from "./cache";
import { loadBarsCsv, loadBarsJsonl } from "./csv";
import { createReplayEvaluator } from "./evaluator";
import { defaultPolicyConfig } from "./policy";
import { replayBars } from "./replay";
import { chronologicalRanges, chronologicalSplit } from "./splits";
import type { AssetKind, PolicyConfig, ReplayMetrics } from "./types";
import type { InputProfile } from "./profiles";

interface PilotRow {
  status: string;
  horizonBars: number;
  profile: InputProfile;
  evaluatorNamespace: string;
}
interface PilotSummary {
  version: string;
  symbol: string;
  kind: AssetKind;
  dataset: { sha256: string; bars: number };
  decisionEveryBars: number;
  modelName: string;
  execution: {
    spreadBps: number;
    feeBps: number;
    slippageBps: number;
    allowShort?: boolean;
    shortBorrowBpsPerDay?: number;
  };
  features: { directionThresholdBpsFloor: number; directionThresholdFixedCostBps?: number };
  rows: PilotRow[];
}

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const prefix = "--" + name + "=";
  const hit = args.find((x) => x.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
};
const dataFile = args.find((x) => !x.startsWith("--"));
const pilotPath = flag("pilot");
if (!dataFile || !pilotPath) {
  console.error("usage: bun run research/tune-apparatus.ts data.csv --pilot=data/jev-pilot-summary.json --cache=data/jev-pilot-cache.jsonl");
  process.exit(1);
}

const pilot = JSON.parse(readFileSync(pilotPath, "utf8")) as PilotSummary;
if (pilot.version !== "jev-pilot-v2") throw new Error("pilot summary must be jev-pilot-v2");

const h = new Bun.CryptoHasher("sha256");
h.update(readFileSync(dataFile));
const actualHash = h.digest("hex");
if (actualHash !== pilot.dataset.sha256) throw new Error("market data does not match pilot dataset hash");

const bars = extname(dataFile).toLowerCase() === ".jsonl"
  ? loadBarsJsonl(dataFile)
  : loadBarsCsv(dataFile, {
      symbol: pilot.symbol,
      kind: pilot.kind,
      defaultSpreadBps: pilot.execution.spreadBps,
    });
if (bars.length !== pilot.dataset.bars) throw new Error("market data bar count differs from pilot summary");

const split = chronologicalSplit(bars);
const ranges = chronologicalRanges(bars);
const cache = new JsonlSignalCache(flag("cache", "data/jev-pilot-cache.jsonl")!);
const outPath = flag("out", "data/apparatus-selection.json")!;
const grid = flag("grid", "full")!;

const fast = grid === "fast";
const edges = fast ? [0.08, 0.14] : [0.04, 0.08, 0.12, 0.16];
const confidences = fast ? [0.48, 0.58] : [0.42, 0.48, 0.54, 0.60];
const adverse = fast ? [0.65, 0.90] : [0.55, 0.65, 0.75, 0.90];
const exposures = fast ? [0.50, 1.00] : [0.25, 0.50, 0.75, 1.00];
const costMultiples = fast ? [0.5, 1.25] : [0.25, 0.5, 0.75, 1.0, 1.25, 1.5];
const flatExits = fast ? [0.54, 0.64] : [0.50, 0.58, 0.66];
const minChanges = fast ? [0.08, 0.18] : [0.05, 0.12, 0.20];
const sizeThresholdSets: [number, number, number][] = fast
  ? [[0.08, 0.20, 0.36], [0.12, 0.26, 0.44]]
  : [[0.06, 0.16, 0.30], [0.10, 0.22, 0.38], [0.14, 0.28, 0.46]];

function objective(m: ReplayMetrics) {
  const sharpe = m.sharpe ?? 0;
  const ddPenalty = Math.abs(Math.min(0, m.maxDrawdownPct)) * 0.5;
  const turnoverPenalty = Math.max(0, m.turnover - 25) * 0.02;
  const inactivityPenalty = m.orders === 0 ? 2 : 0;
  return m.returnPct + sharpe * 0.5 - ddPenalty - turnoverPenalty - inactivityPenalty;
}

const costStressMultipliers = [1, 1.5, 2] as const;

function validationSegments() {
  const start = ranges.validation.start;
  const end = ranges.validation.end;
  const rawMid = Math.floor((start + end) / 2);
  const alignedMid =
    start + Math.max(1, Math.floor((rawMid - start) / pilot.decisionEveryBars)) * pilot.decisionEveryBars;
  const mid = Math.min(end - pilot.decisionEveryBars, alignedMid);
  return [
    { name: "early", start, end: mid },
    { name: "late", start: mid, end },
  ];
}

async function validateUnderCosts(
  evaluator: CachedEvaluator,
  cell: PilotRow,
  policy: PolicyConfig,
) {
  const out: { multiplier: number; metrics: ReplayMetrics; objective: number }[] = [];
  for (const multiplier of costStressMultipliers) {
    const r = await replayBars(bars, {
      evaluator,
      policy,
      features: {
        horizonBars: cell.horizonBars,
        directionThresholdBpsFloor: pilot.features.directionThresholdBpsFloor,
                directionThresholdFixedCostBps: pilot.features.directionThresholdFixedCostBps ?? 0,
      },
      startIndex: ranges.validation.start,
      endIndex: ranges.validation.end - cell.horizonBars - 1,
      decisionEveryBars: pilot.decisionEveryBars,
      execution: {
        feeBps: pilot.execution.feeBps * multiplier,
        slippageBps: pilot.execution.slippageBps * multiplier,
        spreadBpsFallback: pilot.execution.spreadBps,
        spreadCostMultiplier: multiplier,
        allowShort: pilot.execution.allowShort ?? (pilot.kind === "perp"),
        shortBorrowBpsPerDay: pilot.execution.shortBorrowBpsPerDay ?? (pilot.kind === "perp" ? 0 : 1),
      },
    });
    out.push({ multiplier, metrics: r.metrics, objective: objective(r.metrics) });
  }
  return out;
}

const candidates: any[] = [];
for (const cell of pilot.rows.filter((x) => x.status === "complete")) {
  const raw = createReplayEvaluator(pilot.modelName, cell.profile);
  if (raw.name !== cell.evaluatorNamespace) {
    throw new Error("evaluator namespace changed since pilot for " + cell.profile + " h=" + cell.horizonBars);
  }
  const evaluator = new CachedEvaluator(raw, cache, 0);

  let bestTrain: { policy: PolicyConfig; metrics: ReplayMetrics; score: number } | null = null;
  for (const minDirectionalEdge of edges) {
    for (const minDirectionalConfidence of confidences) {
      for (const maxAdverseSelection of adverse) {
        for (const maxTargetExposure of exposures) {
          for (const minExpectedMoveCostMultiple of costMultiples) {
            const policy: PolicyConfig = {
              ...defaultPolicyConfig,
              minDirectionalEdge,
              minDirectionalConfidence,
              maxAdverseSelection,
              maxTargetExposure,
              minExpectedMoveCostMultiple,
            };
            const r = await replayBars(bars, {
              evaluator,
              policy,
              features: {
                horizonBars: cell.horizonBars,
                directionThresholdBpsFloor: pilot.features.directionThresholdBpsFloor,
                directionThresholdFixedCostBps: pilot.features.directionThresholdFixedCostBps ?? 0,
              },
              startIndex: Math.max(50, ranges.train.start),
              endIndex: ranges.train.end - cell.horizonBars - 1,
              decisionEveryBars: pilot.decisionEveryBars,
              execution: {
                feeBps: pilot.execution.feeBps,
                slippageBps: pilot.execution.slippageBps,
                spreadBpsFallback: pilot.execution.spreadBps,
                allowShort: pilot.execution.allowShort ?? (pilot.kind === "perp"),
                shortBorrowBpsPerDay: pilot.execution.shortBorrowBpsPerDay ?? (pilot.kind === "perp" ? 0 : 1),
              },
            });
            const score = objective(r.metrics);
            if (!bestTrain || score > bestTrain.score) bestTrain = { policy, metrics: r.metrics, score };
          }
        }
      }
    }
  }

  let refinedTrain = bestTrain!;
  for (const flatExitProbability of flatExits) {
    for (const minExposureChange of minChanges) {
      for (const sizeScoreThresholds of sizeThresholdSets) {
        const policy: PolicyConfig = {
          ...bestTrain!.policy,
          flatExitProbability,
          minExposureChange,
          sizeScoreThresholds,
        };
        const r = await replayBars(bars, {
          evaluator,
          policy,
          features: {
            horizonBars: cell.horizonBars,
            directionThresholdBpsFloor: pilot.features.directionThresholdBpsFloor,
            directionThresholdFixedCostBps: pilot.features.directionThresholdFixedCostBps ?? 0,
          },
          startIndex: Math.max(50, ranges.train.start),
          endIndex: ranges.train.end - cell.horizonBars - 1,
          decisionEveryBars: pilot.decisionEveryBars,
          execution: {
            feeBps: pilot.execution.feeBps,
            slippageBps: pilot.execution.slippageBps,
            spreadBpsFallback: pilot.execution.spreadBps,
            allowShort: pilot.execution.allowShort ?? (pilot.kind === "perp"),
            shortBorrowBpsPerDay: pilot.execution.shortBorrowBpsPerDay ?? (pilot.kind === "perp" ? 0 : 1),
          },
        });
        const score = objective(r.metrics);
        if (score > refinedTrain.score) refinedTrain = { policy, metrics: r.metrics, score };
      }
    }
  }
  bestTrain = refinedTrain;

  const validationStress = await validateUnderCosts(evaluator, cell, bestTrain!.policy);
  const nominal = validationStress.find((x) => x.multiplier === 1)!;
  const stress15 = validationStress.find((x) => x.multiplier === 1.5)!;
  const stress2 = validationStress.find((x) => x.multiplier === 2)!;

  const validationSegmentsResult = [];
  for (const segment of validationSegments()) {
    const r = await replayBars(bars, {
      evaluator,
      policy: bestTrain!.policy,
      features: {
        horizonBars: cell.horizonBars,
        directionThresholdBpsFloor: pilot.features.directionThresholdBpsFloor,
        directionThresholdFixedCostBps: pilot.features.directionThresholdFixedCostBps ?? 0,
      },
      startIndex: segment.start,
      endIndex: segment.end - cell.horizonBars - 1,
      decisionEveryBars: pilot.decisionEveryBars,
      execution: {
        feeBps: pilot.execution.feeBps,
        slippageBps: pilot.execution.slippageBps,
        spreadBpsFallback: pilot.execution.spreadBps,
        allowShort: pilot.execution.allowShort ?? (pilot.kind === "perp"),
        shortBorrowBpsPerDay: pilot.execution.shortBorrowBpsPerDay ?? (pilot.kind === "perp" ? 0 : 1),
      },
    });
    validationSegmentsResult.push({
      name: segment.name,
      metrics: r.metrics,
      objective: objective(r.metrics),
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
    policy: bestTrain!.policy,
    trainMetrics: bestTrain!.metrics,
    trainObjective: bestTrain!.score,
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
    " · train " + bestTrain!.metrics.returnPct.toFixed(2) + "%" +
    " · validation " + nominal.metrics.returnPct.toFixed(2) + "%" +
    " · 1.5x cost " + stress15.metrics.returnPct.toFixed(2) + "%" +
    " · 2x cost " + stress2.metrics.returnPct.toFixed(2) + "%" +
    " · halves " + validationSegmentsResult.map((x) => x.metrics.returnPct.toFixed(2) + "%").join("/") +
    " · DD " + nominal.metrics.maxDrawdownPct.toFixed(2) + "%" +
    " · orders " + nominal.metrics.orders
  );
}

if (!candidates.length) throw new Error("pilot contains no complete apparatus cells");
candidates.sort((a, b) => b.robustValidationObjective - a.robustValidationObjective);
const chosen = candidates[0]!;
const stress15 = chosen.validationStress.find((x: any) => x.multiplier === 1.5);
const stress2 = chosen.validationStress.find((x: any) => x.multiplier === 2);
const qualificationReasons: string[] = [];
if (!(chosen.validationMetrics.returnPct > 0)) qualificationReasons.push("nominal validation return is not positive");
if (!(stress15?.metrics.returnPct > 0)) qualificationReasons.push("validation return is not positive at 1.5x modeled costs");
if (!(stress2?.metrics.returnPct > 0)) qualificationReasons.push("validation return is not positive at 2x modeled costs");
if (chosen.validationMetrics.orders < 10) qualificationReasons.push("fewer than 10 validation orders");
if (!(chosen.validationObjective > 0)) qualificationReasons.push("nominal validation objective is not positive");
const qualification = {
  passed: qualificationReasons.length === 0,
  reasons: qualificationReasons,
  criteria: {
    positiveNominalReturn: true,
    positiveReturnAtCostMultiplier: 2,
    minimumValidationOrders: 10,
    positiveNominalObjective: true,
  },
};

const selection = {
  version: "apparatus-selection-v1",
  selectedAt: Date.now(),
  sourcePilot: pilotPath,
  datasetSha256: actualHash,
  symbol: pilot.symbol,
  kind: pilot.kind,
  evaluatorKind: pilot.modelName,
  decisionEveryBars: pilot.decisionEveryBars,
  execution: pilot.execution,
  features: pilot.features,
  sealedTestBars: split.test.length,
  chosen,
  grid,
  policyRefinement: { flatExits, minChanges, sizeThresholdSets },
  costStressMultipliers,
  qualification,
  candidates,
};

writeFileSync(outPath, JSON.stringify(selection, null, 2) + "\n");
console.log("");
console.log("selected " + chosen.profile + " h=" + chosen.horizonBars + " from validation only");
console.log("validation return " + chosen.validationMetrics.returnPct.toFixed(2) + "% · max DD " + chosen.validationMetrics.maxDrawdownPct.toFixed(2) + "% · orders " + chosen.validationMetrics.orders);
console.log("qualification " + (qualification.passed ? "PASSED" : "FAILED") + (qualification.reasons.length ? " · " + qualification.reasons.join("; ") : ""));
console.log("wrote " + outPath);
console.log("sealed test remained untouched: " + split.test.length + " bars");
