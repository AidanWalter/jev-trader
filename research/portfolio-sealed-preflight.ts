import { readFileSync } from "node:fs";
import { JsonlSignalCache } from "./cache";
import { defaultFeatureConfig } from "./features";
import { buildPortfolioFeatureStates } from "./portfolio-features";
import { chronologicalRanges } from "./splits";
import { portfolioStateIds, stateSetDigest } from "./state-set";
import type { InputProfile } from "./profiles";
import { alignUniverse, fingerprintUniverse, loadUniverse } from "./universe";

interface FreezeRecord {
  version: "portfolio-apparatus-freeze-v1";
  fingerprint: { combinedSha256: string };
  evaluator: { kind: string; namespace: string; profile: InputProfile };
  features: {
    horizonBars: number;
    directionThresholdBpsFloor: number;
    directionThresholdFixedCostBps: number;
  };
  cadence: { decisionEveryBars: number };
  stateSets?: {
    train: { count: number; sha256: string };
    validation: { count: number; sha256: string };
    development: { count: number; sha256: string };
    sealed: { count: number; sha256: string };
  };
}

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const prefix = "--" + name + "=";
  const hit = args.find((x) => x.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
};
const freezePath = args.find((x) => !x.startsWith("--")) ?? "data/portfolio-apparatus-freeze.json";
const manifest = flag("manifest");
if (!manifest) throw new Error("--manifest is required");
const freeze = JSON.parse(readFileSync(freezePath, "utf8")) as FreezeRecord;
if (freeze.version !== "portfolio-apparatus-freeze-v1") throw new Error("unsupported freeze version");

const fingerprint = fingerprintUniverse(manifest);
if (fingerprint.combinedSha256 !== freeze.fingerprint.combinedSha256) throw new Error("universe fingerprint differs from freeze");
const assets = alignUniverse(loadUniverse(manifest));
const ranges = chronologicalRanges(assets[0]!.bars);
const cache = new JsonlSignalCache(flag("cache", "data/portfolio-pilot-cache.jsonl")!);
const cfg = {
  ...defaultFeatureConfig,
  horizonBars: freeze.features.horizonBars,
  directionThresholdBpsFloor: freeze.features.directionThresholdBpsFloor,
  directionThresholdFixedCostBps: freeze.features.directionThresholdFixedCostBps,
};
if (freeze.stateSets) {
  const sealedIds = portfolioStateIds(assets, ranges.test, cfg, freeze.cadence.decisionEveryBars);
  const actual = stateSetDigest(sealedIds);
  if (
    actual.count !== freeze.stateSets.sealed.count ||
    actual.sha256 !== freeze.stateSets.sealed.sha256
  ) {
    throw new Error(
      "sealed state-set identity differs from freeze: expected " +
      freeze.stateSets.sealed.count + "/" + freeze.stateSets.sealed.sha256 +
      " got " + actual.count + "/" + actual.sha256
    );
  }
}

let states = 0, cached = 0, missing = 0;
const series = assets.map((asset) => ({ symbol: asset.spec.symbol, bars: asset.bars }));
const first = Math.max(cfg.minHistoryBars, ranges.test.start);
for (let i = first; i + cfg.horizonBars < ranges.test.end; i += freeze.cadence.decisionEveryBars) {
  const featureStates = buildPortfolioFeatureStates(series, i, cfg);
  for (const asset of assets) {
    const state = featureStates.get(asset.spec.symbol);
    if (!state) continue;
    states++;
    if (cache.has(freeze.evaluator.namespace, state)) cached++;
    else missing++;
  }
}

console.log("PORTFOLIO SEALED TEST PREFLIGHT");
console.log("symbols " + assets.map((a) => a.spec.symbol).join(", "));
console.log("horizon " + cfg.horizonBars + " bars · every " + freeze.cadence.decisionEveryBars + " bar(s)");
console.log("scoreable asset-states " + states + " · cached " + cached + " · new Jev calls required " + missing);
console.log("universe fingerprint verified · no model calls were made · sealed test was not evaluated");
