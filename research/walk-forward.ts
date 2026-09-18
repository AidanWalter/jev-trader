import { extname } from "node:path";
import { CachedEvaluator, JsonlSignalCache } from "./cache";
import { loadBarsCsv, loadBarsJsonl } from "./csv";
import { createReplayEvaluator } from "./evaluator";
import type { InputProfile } from "./profiles";
import { replayBars } from "./replay";
import { chronologicalRanges, chronologicalSplit, walkForwardRanges } from "./splits";
import { defaultPolicyConfig } from "./policy";
import type { AssetKind, PolicyConfig, ReplayMetrics } from "./types";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const prefix = "--" + name + "=";
  const hit = args.find((x) => x.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
};

const file = args.find((x) => !x.startsWith("--"));
if (!file) {
  console.error("usage: bun run research/walk-forward.ts data.csv --symbol=BTCUSDT --kind=spot --model=mock|jev");
  process.exit(1);
}

const symbol = flag("symbol", "UNKNOWN")!;
const kind = flag("kind", "spot") as AssetKind;
const modelName = flag("model", "mock")!;
const profile = flag("profile", "full") as InputProfile;
const horizonBars = Math.max(1, Number(flag("horizon", "12")));
const decisionEveryBars = Math.max(1, Number(flag("decision-every", "1")));
const spreadBps = Number(flag("spread-bps", kind === "stock" ? "2" : "4"));
const feeBps = Number(flag("fee-bps", kind === "stock" ? "1" : "4"));
const slippageBps = Number(flag("slippage-bps", "1"));
const directionThresholdBpsFloor = Number(flag(
  "direction-threshold-bps",
  String(spreadBps + 2 * slippageBps + 2 * feeBps),
));
const maxNewEvaluations = Math.max(0, Number(flag("max-new-evals", modelName === "jev" ? "25000" : "1000000000")));
const cache = new JsonlSignalCache(flag("cache", "data/jev-cache.jsonl")!);
const evaluator = new CachedEvaluator(createReplayEvaluator(modelName, profile), cache, maxNewEvaluations);

const bars = extname(file).toLowerCase() === ".jsonl"
  ? loadBarsJsonl(file)
  : loadBarsCsv(file, { symbol, kind, defaultSpreadBps: spreadBps });
const split = chronologicalSplit(bars);
const ranges = chronologicalRanges(bars);
const devEnd = ranges.validation.end;
const devLength = devEnd - ranges.train.start;

const defaultTrain = Math.max(200, Math.floor(devLength * 0.45));
const defaultValidation = Math.max(100, Math.floor(devLength * 0.15));
const trainBars = Math.max(60, Number(flag("train-bars", String(defaultTrain))));
const validationBars = Math.max(30, Number(flag("validation-bars", String(defaultValidation))));
const stepBars = Math.max(1, Number(flag("step-bars", String(validationBars))));
const folds = walkForwardRanges(bars.slice(0, devEnd), trainBars, validationBars, stepBars);
if (!folds.length) throw new Error("no walk-forward folds; reduce --train-bars or --validation-bars");

function objective(m: ReplayMetrics) {
  const sharpe = m.sharpe ?? 0;
  const ddPenalty = Math.abs(Math.min(0, m.maxDrawdownPct)) * 0.35;
  const turnoverPenalty = Math.max(0, m.turnover - 50) * 0.01;
  return m.returnPct + sharpe * 0.75 - ddPenalty - turnoverPenalty;
}

const edges = [0.06, 0.10, 0.14, 0.18];
const confidences = [0.44, 0.50, 0.56, 0.62];
const adverse = [0.55, 0.65, 0.75];
const exposures = [0.25, 0.50, 0.75, 1.00];
const costMultiples = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

const policyGrid: PolicyConfig[] = [];
for (const minDirectionalEdge of edges) {
  for (const minDirectionalConfidence of confidences) {
    for (const maxAdverseSelection of adverse) {
      for (const maxTargetExposure of exposures) {
        for (const minExpectedMoveCostMultiple of costMultiples) {
          policyGrid.push({
            ...defaultPolicyConfig,
            minDirectionalEdge,
            minDirectionalConfidence,
            maxAdverseSelection,
            maxTargetExposure,
            minExpectedMoveCostMultiple,
          });
        }
      }
    }
  }
}

const results: {
  fold: number;
  policy: PolicyConfig;
  train: ReplayMetrics;
  validation: ReplayMetrics;
}[] = [];

for (const fold of folds) {
  let best: { policy: PolicyConfig; metrics: ReplayMetrics; score: number } | null = null;
  for (const policy of policyGrid) {
    const r = await replayBars(bars, {
      evaluator,
      policy,
      features: { horizonBars, directionThresholdBpsFloor },
      startIndex: Math.max(50, fold.train.start),
      endIndex: fold.train.end - horizonBars - 1,
      decisionEveryBars,
      execution: { feeBps, slippageBps, spreadBpsFallback: spreadBps },
    });
    const score = objective(r.metrics);
    if (!best || score > best.score) best = { policy, metrics: r.metrics, score };
  }
  const validation = await replayBars(bars, {
    evaluator,
    policy: best!.policy,
    features: { horizonBars, directionThresholdBpsFloor },
    startIndex: fold.validation.start,
    endIndex: fold.validation.end - horizonBars - 1,
    decisionEveryBars,
    execution: { feeBps, slippageBps, spreadBpsFallback: spreadBps },
  });
  results.push({ fold: fold.index, policy: best!.policy, train: best!.metrics, validation: validation.metrics });
  console.log(
    "fold " + (fold.index + 1) + "/" + folds.length +
    " · train " + best!.metrics.returnPct.toFixed(2) + "%" +
    " · validation " + validation.metrics.returnPct.toFixed(2) + "%" +
    " · DD " + validation.metrics.maxDrawdownPct.toFixed(2) + "%" +
    " · edge " + best!.policy.minDirectionalEdge +
    " conf " + best!.policy.minDirectionalConfidence +
    " adverse " + best!.policy.maxAdverseSelection +
    " exposure " + best!.policy.maxTargetExposure +
    " costx " + best!.policy.minExpectedMoveCostMultiple
  );
}

const validationReturns = results.map((x) => x.validation.returnPct);
const validationSharpes = results.map((x) => x.validation.sharpe).filter((x): x is number => x !== null);
const positive = validationReturns.filter((x) => x > 0).length;
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const sorted = [...validationReturns].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)] ?? 0;

console.log("");
console.log("walk-forward folds " + results.length + " · positive validation folds " + positive + "/" + results.length);
console.log("validation return mean " + mean(validationReturns).toFixed(2) + "% · median " + median.toFixed(2) + "% · mean Sharpe " + mean(validationSharpes).toFixed(2));
console.log("cache " + cache.size + " · hits " + cache.hits + " · misses " + cache.misses + " · new " + evaluator.newEvaluations + " · fresh tokens " + evaluator.newInputTokens);
console.log("sealed chronological test bars remain untouched: " + split.test.length);
