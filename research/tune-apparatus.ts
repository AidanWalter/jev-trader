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
  execution: { spreadBps: number; feeBps: number; slippageBps: number };
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

const edges = [0.04, 0.08, 0.12, 0.16];
const confidences = [0.42, 0.48, 0.54, 0.60];
const adverse = [0.55, 0.65, 0.75, 0.90];
const exposures = [0.25, 0.50, 0.75, 1.00];
const costMultiples = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5];

function objective(m: ReplayMetrics) {
  const sharpe = m.sharpe ?? 0;
  const ddPenalty = Math.abs(Math.min(0, m.maxDrawdownPct)) * 0.5;
  const turnoverPenalty = Math.max(0, m.turnover - 25) * 0.02;
  const inactivityPenalty = m.orders === 0 ? 2 : 0;
  return m.returnPct + sharpe * 0.5 - ddPenalty - turnoverPenalty - inactivityPenalty;
}

const candidates: any[] = [];
for (const cell of pilot.rows.filter((x) => x.status === "complete")) {
  const raw = createReplayEvaluator("jev", cell.profile);
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
              features: { horizonBars: cell.horizonBars },
              startIndex: Math.max(50, ranges.train.start),
              endIndex: ranges.train.end - 2,
              decisionEveryBars: pilot.decisionEveryBars,
              execution: {
                feeBps: pilot.execution.feeBps,
                slippageBps: pilot.execution.slippageBps,
                spreadBpsFallback: pilot.execution.spreadBps,
              },
            });
            const score = objective(r.metrics);
            if (!bestTrain || score > bestTrain.score) bestTrain = { policy, metrics: r.metrics, score };
          }
        }
      }
    }
  }

  const validation = await replayBars(bars, {
    evaluator,
    policy: bestTrain!.policy,
    features: { horizonBars: cell.horizonBars },
    startIndex: ranges.validation.start,
    endIndex: ranges.validation.end - 2,
    decisionEveryBars: pilot.decisionEveryBars,
    execution: {
      feeBps: pilot.execution.feeBps,
      slippageBps: pilot.execution.slippageBps,
      spreadBpsFallback: pilot.execution.spreadBps,
    },
  });

  candidates.push({
    horizonBars: cell.horizonBars,
    profile: cell.profile,
    evaluatorNamespace: cell.evaluatorNamespace,
    policy: bestTrain!.policy,
    trainMetrics: bestTrain!.metrics,
    trainObjective: bestTrain!.score,
    validationMetrics: validation.metrics,
    validationObjective: objective(validation.metrics),
  });
  console.log(
    cell.profile + " h=" + cell.horizonBars +
    " · train " + bestTrain!.metrics.returnPct.toFixed(2) + "%" +
    " · validation " + validation.metrics.returnPct.toFixed(2) + "%" +
    " · DD " + validation.metrics.maxDrawdownPct.toFixed(2) + "%" +
    " · orders " + validation.metrics.orders
  );
}

if (!candidates.length) throw new Error("pilot contains no complete apparatus cells");
candidates.sort((a, b) => b.validationObjective - a.validationObjective);
const chosen = candidates[0]!;

const selection = {
  version: "apparatus-selection-v1",
  selectedAt: Date.now(),
  sourcePilot: pilotPath,
  datasetSha256: actualHash,
  symbol: pilot.symbol,
  kind: pilot.kind,
  decisionEveryBars: pilot.decisionEveryBars,
  execution: pilot.execution,
  sealedTestBars: split.test.length,
  chosen,
  candidates,
};

writeFileSync(outPath, JSON.stringify(selection, null, 2) + "\n");
console.log("");
console.log("selected " + chosen.profile + " h=" + chosen.horizonBars + " from validation only");
console.log("validation return " + chosen.validationMetrics.returnPct.toFixed(2) + "% · max DD " + chosen.validationMetrics.maxDrawdownPct.toFixed(2) + "% · orders " + chosen.validationMetrics.orders);
console.log("wrote " + outPath);
console.log("sealed test remained untouched: " + split.test.length + " bars");
