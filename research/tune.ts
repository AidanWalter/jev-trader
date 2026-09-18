import { extname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { CachedEvaluator, JsonlSignalCache } from "./cache";
import { loadBarsCsv, loadBarsJsonl } from "./csv";
import { createReplayEvaluator } from "./evaluator";
import type { InputProfile } from "./profiles";
import { replayBars } from "./replay";
import { chronologicalSplit } from "./splits";
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
  console.error("usage: bun run research/tune.ts data.csv --symbol=BTCUSDT --kind=spot --model=mock|jev");
  process.exit(1);
}

const symbol = flag("symbol", "UNKNOWN")!;
const kind = flag("kind", "spot") as AssetKind;
const modelName = flag("model", "mock")!;
const profile = flag("profile", "full") as InputProfile;
const cache = new JsonlSignalCache(flag("cache", "data/jev-cache.jsonl")!);
const rawEvaluator = createReplayEvaluator(modelName, profile);
const maxNewEvaluations = Math.max(0, Number(flag("max-new-evals", modelName === "jev" ? "25000" : "1000000000")));
const evaluator = new CachedEvaluator(rawEvaluator, cache, maxNewEvaluations);
const spreadBps = Number(flag("spread-bps", kind === "stock" ? "2" : "4"));
const feeBps = Number(flag("fee-bps", kind === "stock" ? "1" : "4"));
const slippageBps = Number(flag("slippage-bps", "1"));
const horizonBars = Number(flag("horizon", "12"));
const decisionEveryBars = Math.max(1, Number(flag("decision-every", "1")));
const outPolicy = flag("out-policy");

const bars = extname(file).toLowerCase() === ".jsonl"
  ? loadBarsJsonl(file)
  : loadBarsCsv(file, { symbol, kind, defaultSpreadBps: spreadBps });
const split = chronologicalSplit(bars);

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

const candidates: { policy: PolicyConfig; trainScore: number; train: ReplayMetrics }[] = [];
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
          const r = await replayBars(split.train, {
          evaluator,
          policy,
          features: { horizonBars },
          decisionEveryBars,
          execution: { feeBps, slippageBps, spreadBpsFallback: spreadBps },
        });
          candidates.push({ policy, trainScore: objective(r.metrics), train: r.metrics });
        }
      }
    }
  }
}

candidates.sort((a, b) => b.trainScore - a.trainScore);
const finalists = candidates.slice(0, Math.min(12, candidates.length));
const validated = [];
for (const c of finalists) {
  const r = await replayBars(split.validation, {
    evaluator,
    policy: c.policy,
    features: { horizonBars },
    decisionEveryBars,
    execution: { feeBps, slippageBps, spreadBpsFallback: spreadBps },
  });
  validated.push({ ...c, validationScore: objective(r.metrics), validation: r.metrics });
}
validated.sort((a, b) => b.validationScore - a.validationScore);

const chosen = validated[0]!;
console.log(`model ${rawEvaluator.name} · bars train=${split.train.length} validation=${split.validation.length} sealed-test=${split.test.length}`);
console.log(`profile ${profile} · every ${decisionEveryBars} bar(s) · cache ${cache.size} entries · ${cache.hits} hits · ${cache.misses} misses · ${evaluator.newEvaluations} new`);
console.log("selected policy from train, ranked on validation:");
console.log(JSON.stringify(chosen.policy, null, 2));
console.log(`train return ${chosen.train.returnPct.toFixed(2)}% · DD ${chosen.train.maxDrawdownPct.toFixed(2)}% · Sharpe ${chosen.train.sharpe?.toFixed(2) ?? "n/a"}`);
console.log(`validation return ${chosen.validation.returnPct.toFixed(2)}% · DD ${chosen.validation.maxDrawdownPct.toFixed(2)}% · Sharpe ${chosen.validation.sharpe?.toFixed(2) ?? "n/a"}`);
if (outPolicy) {
  const dir = outPolicy.includes("/") ? outPolicy.slice(0, outPolicy.lastIndexOf("/")) : ".";
  mkdirSync(dir, { recursive: true });
  writeFileSync(outPolicy, JSON.stringify({
    selectedAt: Date.now(),
    evaluatorKind: modelName,
    evaluatorNamespace: rawEvaluator.name,
    profile,
    horizonBars,
    decisionEveryBars,
    spreadBps,
    feeBps,
    slippageBps,
    policy: chosen.policy,
    trainMetrics: chosen.train,
    validationMetrics: chosen.validation,
  }, null, 2) + "\n");
  console.log("wrote selected policy " + outPolicy);
}
console.log("sealed test was not evaluated");
