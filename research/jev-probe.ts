import { extname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CachedEvaluator, JsonlSignalCache } from "./cache";
import { loadBarsCsv, loadBarsJsonl } from "./csv";
import { createReplayEvaluator } from "./evaluator";
import { buildFeatureState, defaultFeatureConfig } from "./features";
import type { InputProfile } from "./profiles";
import { chronologicalRanges, chronologicalSplit } from "./splits";
import type { AssetKind, FeatureState } from "./types";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const prefix = "--" + name + "=";
  const hit = args.find((x) => x.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
};
const file = args.find((x) => !x.startsWith("--"));
if (!file) {
  console.error("usage: bun run research/jev-probe.ts data.csv --symbol=BTCUSDT --kind=spot --horizons=6,12 --profiles=minimal,technical,path,full");
  process.exit(1);
}

const symbol = flag("symbol", "UNKNOWN")!;
const kind = flag("kind", "spot") as AssetKind;
const horizons = (flag("horizons", "6,12") ?? "6,12").split(",").map(Number).filter((x) => Number.isFinite(x) && x > 0);
const profiles = (flag("profiles", "minimal,technical,path,full") ?? "minimal,technical,path,full")
  .split(",").map((x) => x.trim()).filter(Boolean) as InputProfile[];
const decisionEveryBars = Math.max(1, Number(flag("decision-every", "4")));
const samplePerCell = Math.max(1, Number(flag("sample-per-cell", "5")));
const maxNewEvaluations = Math.max(1, Number(flag("max-new-evals", String(horizons.length * profiles.length * samplePerCell))));
const cachePath = flag("cache", "data/jev-probe-cache.jsonl")!;
const outPath = flag("out", "data/jev-probe-summary.json")!;
const spreadBps = Number(flag("spread-bps", kind === "stock" ? "2" : "4"));
const feeBps = Number(flag("fee-bps", kind === "stock" ? "1" : "4"));
const slippageBps = Number(flag("slippage-bps", "1"));
const usdPerMTok = Number(flag("usd-per-mtok", "0.042"));
const directionThresholdBpsFloor = Number(flag(
  "direction-threshold-bps",
  String(spreadBps + 2 * slippageBps + 2 * feeBps),
));

const bars = extname(file).toLowerCase() === ".jsonl"
  ? loadBarsJsonl(file)
  : loadBarsCsv(file, { symbol, kind, defaultSpreadBps: spreadBps });
const split = chronologicalSplit(bars);
const ranges = chronologicalRanges(bars);
const cache = new JsonlSignalCache(cachePath);

function candidateStates(horizonBars: number): FeatureState[] {
  const cfg = { ...defaultFeatureConfig, horizonBars, directionThresholdBpsFloor };
  const out: FeatureState[] = [];
  for (const range of [ranges.train, ranges.validation]) {
    const start = Math.max(cfg.minHistoryBars, range.start);
    for (let i = start; i + horizonBars < range.end; i += decisionEveryBars) {
      const state = buildFeatureState(bars, i, cfg);
      if (state) out.push(state);
    }
  }
  return out;
}

function evenlySample<T>(xs: T[], n: number) {
  if (xs.length <= n) return [...xs];
  const out: T[] = [];
  for (let i = 0; i < n; i++) {
    const index = Math.floor(i * (xs.length - 1) / Math.max(1, n - 1));
    out.push(xs[index]!);
  }
  return out;
}

let usedNewEvaluations = 0;
let totalFreshTokens = 0;
const rows: any[] = [];

for (const horizonBars of horizons) {
  const states = candidateStates(horizonBars);
  for (const profile of profiles) {
    const raw = createReplayEvaluator("jev", profile);
    const missingBefore = states.filter((s) => !cache.has(raw.name, s));
    const sample = evenlySample(missingBefore, Math.min(samplePerCell, Math.max(0, maxNewEvaluations - usedNewEvaluations)));
    if (!sample.length) {
      rows.push({
        horizonBars,
        profile,
        evaluatorNamespace: raw.name,
        totalDevelopmentStates: states.length,
        missingBefore: missingBefore.length,
        sampledNewEvaluations: 0,
        status: missingBefore.length ? "budget-skipped" : "fully-cached",
      });
      continue;
    }

    const evaluator = new CachedEvaluator(raw, cache, sample.length);
    let tokenSum = 0;
    let latencySum = 0;
    const observed: { ts: number; inputTokens: number; latencyMs: number }[] = [];
    for (const state of sample) {
      const signal = await evaluator.evaluate(state);
      tokenSum += signal.inputTokens;
      latencySum += signal.latencyMs;
      observed.push({ ts: state.ts, inputTokens: signal.inputTokens, latencyMs: signal.latencyMs });
    }
    usedNewEvaluations += evaluator.newEvaluations;
    totalFreshTokens += evaluator.newInputTokens;

    const avgTokens = evaluator.newEvaluations ? tokenSum / evaluator.newEvaluations : 0;
    const avgLatencyMs = evaluator.newEvaluations ? latencySum / evaluator.newEvaluations : 0;
    const missingAfter = states.filter((s) => !cache.has(raw.name, s)).length;
    const projectedRemainingTokens = avgTokens * missingAfter;
    const projectedRemainingUsd = projectedRemainingTokens / 1e6 * usdPerMTok;
    const projectedTotalUsdFromScratch = avgTokens * states.length / 1e6 * usdPerMTok;

    rows.push({
      horizonBars,
      profile,
      evaluatorNamespace: raw.name,
      totalDevelopmentStates: states.length,
      missingBefore: missingBefore.length,
      sampledNewEvaluations: evaluator.newEvaluations,
      avgInputTokens: avgTokens,
      avgLatencyMs,
      missingAfter,
      projectedRemainingTokens,
      projectedRemainingUsd,
      projectedTotalUsdFromScratch,
      observed,
      status: "complete",
    });

    console.log(
      profile + " h=" + horizonBars +
      " · sample " + evaluator.newEvaluations +
      " · avg tokens " + avgTokens.toFixed(0) +
      " · avg latency " + avgLatencyMs.toFixed(1) + " ms" +
      " · remaining states " + missingAfter +
      " · projected remaining $" + projectedRemainingUsd.toFixed(4)
    );
  }
}

const datasetHasher = new Bun.CryptoHasher("sha256");
datasetHasher.update(readFileSync(file));
const summary = {
  version: "jev-probe-v1",
  createdAt: Date.now(),
  symbol,
  kind,
  dataset: {
    file,
    sha256: datasetHasher.digest("hex"),
    bars: bars.length,
    trainBars: split.train.length,
    validationBars: split.validation.length,
    sealedTestBars: split.test.length,
  },
  horizons,
  profiles,
  decisionEveryBars,
  samplePerCell,
  maxNewEvaluations,
  usedNewEvaluations,
  freshInputTokens: totalFreshTokens,
  actualProbeCostUsd: totalFreshTokens / 1e6 * usdPerMTok,
  usdPerMTok,
  execution: { spreadBps, feeBps, slippageBps },
  features: { directionThresholdBpsFloor },
  rows,
};

mkdirSync(outPath.includes("/") ? outPath.slice(0, outPath.lastIndexOf("/")) : ".", { recursive: true });
writeFileSync(outPath, JSON.stringify(summary, null, 2) + "\n");
console.log("wrote " + outPath);
console.log("fresh probe tokens " + totalFreshTokens + " · estimated probe cost $" + summary.actualProbeCostUsd.toFixed(6));
console.log("sealed test remained untouched: " + split.test.length + " bars");
