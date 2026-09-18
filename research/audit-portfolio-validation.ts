import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CachedEvaluator, JsonlSignalCache } from "./cache";
import { createReplayEvaluator } from "./evaluator";
import { replayPortfolio } from "./portfolio";
import { chronologicalRanges } from "./splits";
import type { InputProfile } from "./profiles";
import type { PolicyConfig } from "./types";
import { alignUniverse, fingerprintUniverse, loadUniverse } from "./universe";

interface FreezeRecord {
  version: "portfolio-apparatus-freeze-v1";
  fingerprint: { combinedSha256: string };
  evaluator: {
    kind: string;
    namespace: string;
    profile: InputProfile;
  };
  features: {
    horizonBars: number;
    directionThresholdBpsFloor: number;
    directionThresholdFixedCostBps: number;
  };
  cadence: { decisionEveryBars: number };
  execution: {
    initialCash: number;
    feeBps: number;
    slippageBps: number;
    spreadBpsFallback: number;
    spreadCostMultiplier: number;
    allowShort: boolean;
    shortBorrowBpsPerDay: number;
    minTradeNotional: number;
  };
  portfolio: {
    topN: number;
    maxGrossExposure: number;
    maxAssetExposure: number;
  };
  policy: PolicyConfig;
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
const cachePath = flag("cache", "data/portfolio-pilot-cache.jsonl")!;
const outPath = flag("out", "data/portfolio-validation-audit.json")!;
const requiredPositiveSegments = Math.max(1, Number(flag("min-positive-segments", "3")));
const segmentCount = Math.max(requiredPositiveSegments, Number(flag("segments", "4")));

const freeze = JSON.parse(readFileSync(freezePath, "utf8")) as FreezeRecord;
if (freeze.version !== "portfolio-apparatus-freeze-v1") throw new Error("unsupported freeze version");

const fingerprint = fingerprintUniverse(manifest);
if (fingerprint.combinedSha256 !== freeze.fingerprint.combinedSha256) {
  throw new Error("universe fingerprint differs from freeze");
}

const assets = alignUniverse(loadUniverse(manifest));
const bars = assets[0]!.bars;
const ranges = chronologicalRanges(bars);
const raw = createReplayEvaluator(freeze.evaluator.kind, freeze.evaluator.profile);
if (raw.name !== freeze.evaluator.namespace) {
  throw new Error("evaluator namespace changed since freeze");
}
const evaluator = new CachedEvaluator(raw, new JsonlSignalCache(cachePath), 0);

async function replayRange(start: number, end: number) {
  return replayPortfolio(assets, {
    evaluator,
    policy: freeze.policy,
    topN: freeze.portfolio.topN,
    maxGrossExposure: freeze.portfolio.maxGrossExposure,
    maxAssetExposure: freeze.portfolio.maxAssetExposure,
    startIndex: Math.max(50, start),
    endIndex: end - freeze.features.horizonBars - 1,
    decisionEveryBars: freeze.cadence.decisionEveryBars,
    features: {
      horizonBars: freeze.features.horizonBars,
      directionThresholdBpsFloor: freeze.features.directionThresholdBpsFloor,
      directionThresholdFixedCostBps: freeze.features.directionThresholdFixedCostBps,
    },
    execution: {
      initialCash: freeze.execution.initialCash,
      feeBps: freeze.execution.feeBps,
      slippageBps: freeze.execution.slippageBps,
      spreadBpsFallback: freeze.execution.spreadBpsFallback,
      spreadCostMultiplier: freeze.execution.spreadCostMultiplier,
      allowShort: freeze.execution.allowShort,
      shortBorrowBpsPerDay: freeze.execution.shortBorrowBpsPerDay,
      minTradeNotional: freeze.execution.minTradeNotional,
    },
  });
}

const validation = ranges.validation;
const length = validation.end - validation.start;
const segments: any[] = [];
for (let i = 0; i < segmentCount; i++) {
  const start = validation.start + Math.floor(length * i / segmentCount);
  const end = validation.start + Math.floor(length * (i + 1) / segmentCount);
  if (end - start <= freeze.features.horizonBars + 2) {
    throw new Error("validation segment too short for frozen horizon");
  }
  const result = await replayRange(start, end);
  segments.push({
    index: i + 1,
    startIndex: start,
    endIndex: end,
    startTs: bars[start]!.ts,
    endTs: bars[end - 1]!.ts,
    returnPct: result.returnPct,
    pnl: result.pnl,
    maxDrawdownPct: result.maxDrawdownPct,
    turnover: result.turnover,
    fills: result.fills.length,
    fees: result.fees,
    borrowCost: result.borrowCost,
    fundingNet: result.fundingNet,
  });
}

const positiveSegments = segments.filter((x) => x.returnPct > 0).length;
const passed = positiveSegments >= requiredPositiveSegments;
const audit = {
  version: "portfolio-validation-audit-v1",
  createdAt: Date.now(),
  freeze: freezePath,
  manifest,
  universeFingerprint: fingerprint.combinedSha256,
  segmentCount,
  requiredPositiveSegments,
  positiveSegments,
  passed,
  segments,
};

mkdirSync(outPath.includes("/") ? outPath.slice(0, outPath.lastIndexOf("/")) : ".", { recursive: true });
writeFileSync(outPath, JSON.stringify(audit, null, 2) + "\n");

for (const s of segments) {
  console.log(
    "validation quarter " + s.index +
    " · return " + s.returnPct.toFixed(2) + "%" +
    " · DD " + s.maxDrawdownPct.toFixed(2) + "%" +
    " · fills " + s.fills
  );
}
console.log(
  "validation-quarter audit " + (passed ? "PASSED" : "FAILED") +
  " · positive " + positiveSegments + "/" + segmentCount +
  " · required " + requiredPositiveSegments
);
console.log("wrote " + outPath);

if (!passed) process.exit(2);
