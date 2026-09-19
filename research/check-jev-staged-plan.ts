import { readFileSync } from "node:fs";
import { JsonlSignalCache } from "./cache";
import { createReplayEvaluator } from "./evaluator";
import { defaultFeatureConfig } from "./features";
import { nestedJevSample, jevSampleId } from "./jev-sampling";
import { buildPortfolioFeatureStates } from "./portfolio-features";
import { chronologicalRanges } from "./splits";
import type { FeatureState } from "./types";
import { alignUniverse, fingerprintUniverse, loadUniverse } from "./universe";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const prefix = "--" + name + "=";
  return args.find((x) => x.startsWith(prefix))?.slice(prefix.length) ?? fallback;
};

const manifest = args.find((x) => !x.startsWith("--"));
const referenceCachePath = flag("reference-cache");
if (!manifest || !referenceCachePath) {
  console.error("usage: bun run research/check-jev-staged-plan.ts universe.json --reference-cache=paid-cache.jsonl");
  process.exit(1);
}

const horizonBars = Math.max(1, Number(flag("horizon", "8")));
const decisionEveryBars = Math.max(1, Number(flag("decision-every", "8")));
const usdPerMTok = Number(flag("usd-per-mtok", "0.042"));
const reserveTokensPerRequest = Math.max(1, Number(flag("reserve-tokens", "2000")));

const assets = alignUniverse(loadUniverse(manifest));
const bars = assets[0]!.bars;
const ranges = chronologicalRanges(bars);
const cfg = {
  ...defaultFeatureConfig,
  horizonBars,
  directionThresholdBpsFloor: 1,
  directionThresholdFixedCostBps: 10,
};
const series = assets.map((asset) => ({ symbol: asset.spec.symbol, bars: asset.bars }));
const referenceRaw = createReplayEvaluator("jev", "path");
const referenceCache = new JsonlSignalCache(referenceCachePath);

type Row = { state: FeatureState; assetIndex: number; barIndex: number };
function rowsFor(range: { start: number; end: number }) {
  const rows: Row[] = [];
  const first = Math.max(cfg.minHistoryBars, range.start);
  for (let i = first; i + horizonBars < range.end; i += decisionEveryBars) {
    const states = buildPortfolioFeatureStates(series, i, cfg);
    for (let a = 0; a < assets.length; a++) {
      const state = states.get(assets[a]!.spec.symbol);
      if (state) rows.push({ state, assetIndex: a, barIndex: i });
    }
  }
  return rows;
}

const trainRows = rowsFor(ranges.train);
const validationRows = rowsFor(ranges.validation);
const testRows = rowsFor(ranges.test);
const devRows = [...trainRows, ...validationRows];
const eligibleReferenceRows = trainRows.filter((row) => referenceCache.has(referenceRaw.name, row.state));

const s12 = nestedJevSample(eligibleReferenceRows, 12, 4);
const s48 = nestedJevSample(eligibleReferenceRows, 48, 4);
const s240 = nestedJevSample(eligibleReferenceRows, 240, 4);
const s1000 = nestedJevSample(eligibleReferenceRows, 1000, 4);

const ids = (xs: Row[]) => xs.map(jevSampleId);
const prefix = (small: Row[], big: Row[]) =>
  JSON.stringify(ids(small)) === JSON.stringify(ids(big).slice(0, small.length));

const stagedFreshRequests = {
  canary: 12,
  sample48: 36,
  sample240: 192,
  sample1000: 760,
  development: Math.max(0, devRows.length - s1000.length),
  sealed: testRows.length,
};
const totalFreshRequests = Object.values(stagedFreshRequests).reduce((a, b) => a + b, 0);
const reservedTokens = totalFreshRequests * reserveTokensPerRequest;
const reservedUsd = reservedTokens / 1_000_000 * usdPerMTok;

let failures = 0;
const check = (name: string, ok: boolean) => {
  console.log((ok ? "ok  " : "FAIL") + " " + name);
  if (!ok) failures++;
};

check("fixed universe is BTC ETH SOL", assets.map((a) => a.spec.symbol).join(",") === "BTCUSDT,ETHUSDT,SOLUSDT");
check("reference full-Jev cache has at least 1000 eligible train states", eligibleReferenceRows.length >= 1000);
check("12-state sample nests exactly into 48", prefix(s12, s48));
check("48-state sample nests exactly into 240", prefix(s48, s240));
check("240-state sample nests exactly into 1000", prefix(s240, s1000));
check("1000-state checkpoint contains exactly 1000 states", s1000.length === 1000);
check("development state count matches pinned 6996", devRows.length === 6996);
check("development expansion after 1000 cache hits is at most 5996", devRows.length - s1000.length <= 5996);
check("sealed tail fits the 1752-call hard ceiling", testRows.length <= 1752);
check("staged research request ceiling is at most 8748", totalFreshRequests <= 8748);
check("2000-token reservation ceiling costs less than $0.75", reservedUsd < 0.75);

console.log(JSON.stringify({
  version: "jev-staged-plan-readiness-v1",
  fingerprint: fingerprintUniverse(manifest).combinedSha256,
  referenceNamespace: referenceRaw.name,
  referenceCacheSize: referenceCache.size,
  eligibleReferenceTrainStates: eligibleReferenceRows.length,
  states: {
    train: trainRows.length,
    validation: validationRows.length,
    development: devRows.length,
    sealed: testRows.length,
  },
  nestedSamples: {
    sample12: ids(s12),
    sample48Prefix12Matches: prefix(s12, s48),
    sample240Prefix48Matches: prefix(s48, s240),
    sample1000Prefix240Matches: prefix(s240, s1000),
  },
  stagedFreshRequests,
  totalFreshRequests,
  reserveTokensPerRequest,
  reservedTokens,
  reservedUsd,
  usdPerMTok,
}, null, 2));

process.exit(failures ? 1 : 0);
