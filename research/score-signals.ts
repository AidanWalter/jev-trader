import { extname } from "node:path";
import { CachedEvaluator, JsonlSignalCache } from "./cache";
import { loadBarsCsv, loadBarsJsonl } from "./csv";
import { createReplayEvaluator } from "./evaluator";
import { buildFeatureState, defaultFeatureConfig } from "./features";
import type { InputProfile } from "./profiles";
import { chronologicalRanges, chronologicalSplit } from "./splits";
import type { AssetKind, Direction, Magnitude } from "./types";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const prefix = "--" + name + "=";
  const hit = args.find((x) => x.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
};
const file = args.find((x) => !x.startsWith("--"));
if (!file) {
  console.error("usage: bun run research/score-signals.ts data.csv --symbol=BTCUSDT --kind=spot --model=jev --split=validation");
  process.exit(1);
}

const symbol = flag("symbol", "UNKNOWN")!;
const kind = flag("kind", "spot") as AssetKind;
const modelName = flag("model", "jev")!;
const profile = flag("profile", "full") as InputProfile;
const splitName = flag("split", "validation")!;
const allowTest = flag("allow-test", "false") === "true";
const cachePath = flag("cache", "data/jev-cache.jsonl")!;
const horizonBars = Math.max(1, Number(flag("horizon", "12")));
const decisionEveryBars = Math.max(1, Number(flag("decision-every", "1")));
const spreadBps = Number(flag("spread-bps", kind === "stock" ? "2" : "4"));
const maxNewEvaluations = Math.max(0, Number(flag("max-new-evals", modelName === "jev" ? "0" : "1000000000")));

const allBars = extname(file).toLowerCase() === ".jsonl"
  ? loadBarsJsonl(file)
  : loadBarsCsv(file, { symbol, kind, defaultSpreadBps: spreadBps });
const split = chronologicalSplit(allBars);
const ranges = chronologicalRanges(allBars);

let selectedRange: { start: number; end: number };
if (splitName === "train") selectedRange = ranges.train;
else if (splitName === "validation") selectedRange = ranges.validation;
else if (splitName === "dev") selectedRange = { start: ranges.train.start, end: ranges.validation.end };
else if (splitName === "test") {
  if (!allowTest) throw new Error("sealed test requested; pass --allow-test=true only after the apparatus is frozen");
  selectedRange = ranges.test;
} else throw new Error("unknown --split=" + splitName);

const raw = createReplayEvaluator(modelName, profile);
const cache = new JsonlSignalCache(cachePath);
const evaluator = new CachedEvaluator(raw, cache, maxNewEvaluations);
const featureConfig = { ...defaultFeatureConfig, horizonBars };

const directions: Direction[] = ["long", "flat", "short"];
const magnitudes: Magnitude[] = ["tiny", "small", "medium", "large"];
const dirCounts = Object.fromEntries(directions.map((x) => [x, 0])) as Record<Direction, number>;
const magCounts = Object.fromEntries(magnitudes.map((x) => [x, 0])) as Record<Magnitude, number>;

type Bin = { n: number; confidence: number; correct: number };
const bins: Bin[] = Array.from({ length: 10 }, () => ({ n: 0, confidence: 0, correct: 0 }));

let n = 0;
let dirCorrect = 0;
let magCorrect = 0;
let dirBrier = 0;
let magBrier = 0;
let dirLogLoss = 0;
let magLogLoss = 0;
let adverseN = 0;
let adverseBrier = 0;
let adverseCorrect = 0;

const eps = 1e-12;
const firstIndex = Math.max(featureConfig.minHistoryBars, selectedRange.start);
for (let i = firstIndex; i + horizonBars < selectedRange.end; i += decisionEveryBars) {
  const state = buildFeatureState(allBars, i, featureConfig);
  if (!state) continue;
  const future = allBars[i + horizonBars]!;
  const next = allBars[i + 1];
  const returnBps = (future.close / state.price - 1) * 10_000;
  const abs = Math.abs(returnBps);
  const t = state.directionThresholdBps;

  const truthDirection: Direction = returnBps > t ? "long" : returnBps < -t ? "short" : "flat";
  const truthMagnitude: Magnitude = abs <= t ? "tiny" : abs <= 2 * t ? "small" : abs <= 4 * t ? "medium" : "large";
  dirCounts[truthDirection]++;
  magCounts[truthMagnitude]++;

  const signal = await evaluator.evaluate(state);
  n++;

  if (signal.direction.choice === truthDirection) dirCorrect++;
  if (signal.magnitude.choice === truthMagnitude) magCorrect++;

  for (const label of directions) {
    const y = label === truthDirection ? 1 : 0;
    const p = signal.direction.probabilities[label];
    dirBrier += (p - y) ** 2;
  }
  for (const label of magnitudes) {
    const y = label === truthMagnitude ? 1 : 0;
    const p = signal.magnitude.probabilities[label];
    magBrier += (p - y) ** 2;
  }
  dirLogLoss += -Math.log(Math.max(eps, signal.direction.probabilities[truthDirection]));
  magLogLoss += -Math.log(Math.max(eps, signal.magnitude.probabilities[truthMagnitude]));

  const confidence = Math.max(...directions.map((x) => signal.direction.probabilities[x]));
  const binIndex = Math.min(9, Math.floor(confidence * 10));
  bins[binIndex]!.n++;
  bins[binIndex]!.confidence += confidence;
  bins[binIndex]!.correct += signal.direction.choice === truthDirection ? 1 : 0;

  if (next && signal.direction.choice !== "flat") {
    const nextRetBps = (next.close / next.open - 1) * 10_000;
    const adverse = signal.direction.choice === "long"
      ? nextRetBps < -state.spreadBps
      : nextRetBps > state.spreadBps;
    adverseN++;
    adverseBrier += (signal.adverseSelection - (adverse ? 1 : 0)) ** 2;
    adverseCorrect += (signal.adverseSelection >= 0.5) === adverse ? 1 : 0;
  }
}

if (!n) throw new Error("no scoreable states");

let ece = 0;
console.log(`dataset ${symbol} · split ${splitName} · states ${n} · horizon ${horizonBars} · every ${decisionEveryBars}`);
console.log(`evaluator ${raw.name} · new evaluations ${evaluator.newEvaluations} · fresh input tokens ${evaluator.newInputTokens}`);
console.log(`direction accuracy ${(dirCorrect / n * 100).toFixed(2)}% · Brier ${(dirBrier / n).toFixed(4)} · log loss ${(dirLogLoss / n).toFixed(4)}`);
console.log(`magnitude accuracy ${(magCorrect / n * 100).toFixed(2)}% · Brier ${(magBrier / n).toFixed(4)} · log loss ${(magLogLoss / n).toFixed(4)}`);
if (adverseN) console.log(`adverse selection accuracy ${(adverseCorrect / adverseN * 100).toFixed(2)}% · Brier ${(adverseBrier / adverseN).toFixed(4)} · n ${adverseN}`);
console.log("direction class counts " + JSON.stringify(dirCounts));
console.log("magnitude class counts " + JSON.stringify(magCounts));
console.log("direction confidence calibration:");
for (let i = 0; i < bins.length; i++) {
  const b = bins[i]!;
  if (!b.n) continue;
  const conf = b.confidence / b.n;
  const acc = b.correct / b.n;
  ece += b.n / n * Math.abs(conf - acc);
  console.log(`  ${i * 10}-${(i + 1) * 10}%: n=${b.n} mean_conf=${(conf * 100).toFixed(1)}% accuracy=${(acc * 100).toFixed(1)}%`);
}
console.log(`direction ECE ${ece.toFixed(4)}`);
if (splitName !== "test") console.log(`sealed test bars remain untouched: ${split.test.length}`);
