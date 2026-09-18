import { extname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { CachedEvaluator, JsonlSignalCache } from "./cache";
import { loadBarsCsv, loadBarsJsonl } from "./csv";
import { createReplayEvaluator } from "./evaluator";
import { buildFeatureState, defaultFeatureConfig } from "./features";
import type { InputProfile } from "./profiles";
import { replayBars } from "./replay";
import { chronologicalSplit } from "./splits";
import type { AssetKind, Direction, MarketBar } from "./types";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const prefix = "--" + name + "=";
  const hit = args.find((x) => x.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
};
const file = args.find((x) => !x.startsWith("--"));
if (!file) {
  console.error("usage: bun run research/pilot.ts data.csv --symbol=BTCUSDT --kind=spot --model=jev --horizons=6,12,24 --profiles=minimal,technical,path,full");
  process.exit(1);
}

const symbol = flag("symbol", "UNKNOWN")!;
const kind = flag("kind", "spot") as AssetKind;
const modelName = flag("model", "jev")!;
const horizons = (flag("horizons", "6,12") ?? "6,12").split(",").map(Number).filter((x) => Number.isFinite(x) && x > 0);
const profiles = (flag("profiles", "minimal,technical,path,full") ?? "minimal,technical,path,full")
  .split(",").map((x) => x.trim()).filter(Boolean) as InputProfile[];
const decisionEveryBars = Math.max(1, Number(flag("decision-every", "4")));
const maxNewEvaluations = Math.max(0, Number(flag("max-new-evals", modelName === "jev" ? "10000" : "1000000000")));
const cachePath = flag("cache", "data/jev-pilot-cache.jsonl")!;
const outPath = flag("out", "data/jev-pilot-summary.json")!;
const spreadBps = Number(flag("spread-bps", kind === "stock" ? "2" : "4"));
const feeBps = Number(flag("fee-bps", kind === "stock" ? "1" : "4"));
const slippageBps = Number(flag("slippage-bps", "1"));

const bars = extname(file).toLowerCase() === ".jsonl"
  ? loadBarsJsonl(file)
  : loadBarsCsv(file, { symbol, kind, defaultSpreadBps: spreadBps });
const split = chronologicalSplit(bars);

type Score = {
  n: number;
  accuracy: number;
  brier: number;
  logLoss: number;
  ece: number;
  meanCalledSideReturnBps: number;
};

async function score(
  bars: MarketBar[],
  horizonBars: number,
  evaluator: CachedEvaluator,
): Promise<Score> {
  const cfg = { ...defaultFeatureConfig, horizonBars };
  const labels: Direction[] = ["long", "flat", "short"];
  const bins = Array.from({ length: 10 }, () => ({ n: 0, conf: 0, correct: 0 }));
  let n = 0;
  let correct = 0;
  let brier = 0;
  let logLoss = 0;
  let calledReturn = 0;

  for (let i = cfg.minHistoryBars; i + horizonBars < bars.length; i += decisionEveryBars) {
    const state = buildFeatureState(bars, i, cfg);
    if (!state) continue;
    const future = bars[i + horizonBars]!;
    const r = (future.close / state.price - 1) * 10_000;
    const truth: Direction = r > state.directionThresholdBps ? "long" : r < -state.directionThresholdBps ? "short" : "flat";
    const signal = await evaluator.evaluate(state);
    n++;
    if (signal.direction.choice === truth) correct++;
    for (const label of labels) {
      const y = label === truth ? 1 : 0;
      const p = signal.direction.probabilities[label];
      brier += (p - y) ** 2;
    }
    logLoss += -Math.log(Math.max(1e-12, signal.direction.probabilities[truth]));
    const conf = Math.max(...labels.map((x) => signal.direction.probabilities[x]));
    const bi = Math.min(9, Math.floor(conf * 10));
    bins[bi]!.n++;
    bins[bi]!.conf += conf;
    bins[bi]!.correct += signal.direction.choice === truth ? 1 : 0;
    calledReturn += signal.direction.choice === "long" ? r : signal.direction.choice === "short" ? -r : 0;
  }
  if (!n) throw new Error("no scoreable states");

  let ece = 0;
  for (const b of bins) {
    if (!b.n) continue;
    ece += b.n / n * Math.abs(b.conf / b.n - b.correct / b.n);
  }
  return {
    n,
    accuracy: correct / n,
    brier: brier / n,
    logLoss: logLoss / n,
    ece,
    meanCalledSideReturnBps: calledReturn / n,
  };
}

const cache = new JsonlSignalCache(cachePath);
const rows: any[] = [];
let usedNewEvaluations = 0;

function scoreableCount(bars: MarketBar[], horizonBars: number) {
  const start = defaultFeatureConfig.minHistoryBars;
  if (start + horizonBars >= bars.length) return 0;
  return Math.floor((bars.length - horizonBars - 1 - start) / decisionEveryBars) + 1;
}

for (const horizonBars of horizons) {
  for (const profile of profiles) {
    const raw = createReplayEvaluator(modelName, profile);
    const expectedFreshCalls = scoreableCount(split.train, horizonBars) + scoreableCount(split.validation, horizonBars);
    const remaining = Math.max(0, maxNewEvaluations - usedNewEvaluations);
    if (expectedFreshCalls > remaining && modelName === "jev") {
      rows.push({
        symbol,
        horizonBars,
        profile,
        evaluatorNamespace: raw.name,
        status: "budget-skipped",
        expectedFreshCalls,
        remainingBudget: remaining,
      });
      console.log(profile + " h=" + horizonBars + " · skipped, needs up to " + expectedFreshCalls + " fresh calls with " + remaining + " remaining");
      continue;
    }

    const evaluator = new CachedEvaluator(raw, cache, remaining);
    const trainScore = await score(split.train, horizonBars, evaluator);
    const validationScore = await score(split.validation, horizonBars, evaluator);

    const validationReplay = await replayBars(split.validation, {
      evaluator,
      features: { horizonBars },
      decisionEveryBars,
      execution: { feeBps, slippageBps, spreadBpsFallback: spreadBps },
    });

    const row = {
      symbol,
      horizonBars,
      profile,
      evaluatorNamespace: raw.name,
      train: trainScore,
      validation: validationScore,
      validationReplay: validationReplay.metrics,
      status: "complete",
      expectedFreshCalls,
      newEvaluations: evaluator.newEvaluations,
      freshInputTokens: evaluator.newInputTokens,
    };
    usedNewEvaluations += evaluator.newEvaluations;
    rows.push(row);
    console.log(
      profile + " h=" + horizonBars +
      " · val acc " + (validationScore.accuracy * 100).toFixed(1) + "%" +
      " · Brier " + validationScore.brier.toFixed(4) +
      " · ECE " + validationScore.ece.toFixed(4) +
      " · called " + validationScore.meanCalledSideReturnBps.toFixed(2) + " bps" +
      " · replay " + validationReplay.metrics.returnPct.toFixed(2) + "%" +
      " · new " + row.newEvaluations
    );
  }
}

const summary = {
  version: "jev-pilot-v1",
  createdAt: Date.now(),
  symbol,
  kind,
  bars: bars.length,
  trainBars: split.train.length,
  validationBars: split.validation.length,
  sealedTestBars: split.test.length,
  decisionEveryBars,
  execution: { spreadBps, feeBps, slippageBps },
  modelName,
  horizons,
  profiles,
  newEvaluationBudget: maxNewEvaluations,
  usedNewEvaluations,
  freshInputTokens: rows.reduce((s, x) => s + (x.freshInputTokens ?? 0), 0),
  rows,
};

mkdirSync(outPath.includes("/") ? outPath.slice(0, outPath.lastIndexOf("/")) : ".", { recursive: true });
writeFileSync(outPath, JSON.stringify(summary, null, 2) + "\n");
console.log("wrote " + outPath);
console.log("sealed test remained untouched: " + split.test.length + " bars");
