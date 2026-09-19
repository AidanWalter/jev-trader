import { writeFileSync } from "node:fs";
import { createReplayEvaluator } from "./evaluator";
import { defaultFeatureConfig } from "./features";
import { portfolioStateIds, stateSetDigest } from "./state-set";
import type { InputProfile } from "./profiles";
import { chronologicalRanges } from "./splits";
import { fingerprintUniverse, alignUniverse, loadUniverse } from "./universe";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const prefix = "--" + name + "=";
  return args.find((x) => x.startsWith(prefix))?.slice(prefix.length) ?? fallback;
};

const manifest = args.find((x) => !x.startsWith("--"));
if (!manifest) {
  console.error("usage: bun run research/build-jev-apparatus-manifest.ts universe.json --model=jev-direction --profile=lean --horizon=8 --decision-every=8 --out=data/apparatus.json");
  process.exit(1);
}

const model = flag("model", "jev-direction")!;
const profile = flag("profile", "lean") as InputProfile;
const horizonBars = Math.max(1, Number(flag("horizon", "8")));
const decisionEveryBars = Math.max(1, Number(flag("decision-every", "8")));
const feeBps = Number(flag("fee-bps", "4"));
const slippageBps = Number(flag("slippage-bps", "1"));
const spreadBps = Number(flag("spread-bps", "4"));
const directionThresholdBpsFloor = Number(flag("direction-threshold-bps-floor", "1"));
const directionThresholdFixedCostBps = Number(
  flag("direction-threshold-fixed-cost-bps", String(2 * feeBps + 2 * slippageBps)),
);
const outPath = flag("out", "data/jev-apparatus-manifest.json")!;

const assets = alignUniverse(loadUniverse(manifest));
const bars = assets[0]!.bars;
const ranges = chronologicalRanges(bars);
const evaluator = createReplayEvaluator(model, profile);
const cfg = {
  ...defaultFeatureConfig,
  horizonBars,
  spreadBpsFallback: spreadBps,
  directionThresholdBpsFloor,
  directionThresholdFixedCostBps,
};
const trainIds = portfolioStateIds(assets, ranges.train, cfg, decisionEveryBars);
const validationIds = portfolioStateIds(assets, ranges.validation, cfg, decisionEveryBars);
const testIds = portfolioStateIds(assets, ranges.test, cfg, decisionEveryBars);
const developmentIds = [...trainIds, ...validationIds];

const record = {
  version: "jev-apparatus-manifest-v1",
  createdAt: Date.now(),
  sourceManifest: manifest,
  universeFingerprint: fingerprintUniverse(manifest),
  symbols: assets.map((a) => a.spec.symbol),
  evaluator: {
    model,
    namespace: evaluator.name,
    profile,
  },
  features: {
    horizonBars,
    decisionEveryBars,
    directionThresholdBpsFloor,
    directionThresholdFixedCostBps,
    spreadBpsFallback: spreadBps,
  },
  executionAssumptions: {
    feeBps,
    slippageBps,
    spreadBps,
  },
  splitStateSets: {
    train: stateSetDigest(trainIds),
    validation: stateSetDigest(validationIds),
    development: stateSetDigest(developmentIds),
    sealed: stateSetDigest(testIds),
  },
  boundaries: {
    trainStartTs: bars[ranges.train.start]?.ts ?? null,
    trainEndTs: bars[Math.max(ranges.train.start, ranges.train.end - 1)]?.ts ?? null,
    validationStartTs: bars[ranges.validation.start]?.ts ?? null,
    validationEndTs: bars[Math.max(ranges.validation.start, ranges.validation.end - 1)]?.ts ?? null,
    sealedStartTs: bars[ranges.test.start]?.ts ?? null,
    sealedEndTs: bars[Math.max(ranges.test.start, ranges.test.end - 1)]?.ts ?? null,
  },
};

writeFileSync(outPath, JSON.stringify(record, null, 2) + "\n");
console.log("JEV APPARATUS MANIFEST");
console.log("universe " + record.universeFingerprint.combinedSha256);
console.log("namespace " + record.evaluator.namespace);
console.log("train " + trainIds.length + " · " + record.splitStateSets.train.sha256);
console.log("validation " + validationIds.length + " · " + record.splitStateSets.validation.sha256);
console.log("development " + developmentIds.length + " · " + record.splitStateSets.development.sha256);
console.log("sealed " + testIds.length + " · " + record.splitStateSets.sealed.sha256);
console.log("wrote " + outPath);
