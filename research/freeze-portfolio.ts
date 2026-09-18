import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { assertResearchDataQuality } from "./data-quality";
import { chronologicalSplit } from "./splits";
import { alignUniverse, fingerprintUniverse, loadUniverse } from "./universe";
import type { PolicyConfig } from "./types";
import type { InputProfile } from "./profiles";

interface PortfolioSelection {
  version: "portfolio-apparatus-selection-v1";
  manifest: string;
  fingerprint: ReturnType<typeof fingerprintUniverse>;
  evaluatorKind: string;
  decisionEveryBars: number;
  execution: {
    feeBps: number;
    slippageBps: number;
    spreadBpsFallback: number;
    allowShort: boolean;
  };
  features: {
    directionThresholdBpsFloor: number;
    directionThresholdFixedCostBps: number;
  };
  qualification?: { passed: boolean; reasons?: string[] };
  chosen: {
    horizonBars: number;
    profile: InputProfile;
    evaluatorNamespace: string;
    policy: PolicyConfig;
    portfolio: {
      topN: number;
      maxGrossExposure: number;
      maxAssetExposure: number;
    };
    trainMetrics?: unknown;
    validationMetrics?: unknown;
    validationStress?: unknown;
  };
}

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const prefix = "--" + name + "=";
  const hit = args.find((x) => x.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
};
const manifest = args.find((x) => !x.startsWith("--"));
const selectionPath = flag("selection");
if (!manifest || !selectionPath) {
  console.error("usage: bun run research/freeze-portfolio.ts universe.json --selection=data/portfolio-apparatus-selection.json");
  process.exit(1);
}
const out = flag("out", "data/portfolio-apparatus-freeze.json")!;
const allowUnqualified = flag("allow-unqualified", "false") === "true";
const selection = JSON.parse(readFileSync(selectionPath, "utf8")) as PortfolioSelection;
if (selection.version !== "portfolio-apparatus-selection-v1") throw new Error("unsupported portfolio selection version");
if (selection.qualification && !selection.qualification.passed && !allowUnqualified) {
  throw new Error("portfolio apparatus failed qualification: " + (selection.qualification.reasons ?? []).join("; "));
}

const fingerprint = fingerprintUniverse(manifest);
if (fingerprint.combinedSha256 !== selection.fingerprint.combinedSha256) {
  throw new Error("universe fingerprint differs from apparatus selection");
}
const rawAssets = loadUniverse(manifest);
for (const asset of rawAssets) assertResearchDataQuality(asset.bars);
const assets = alignUniverse(rawAssets);
const bars = assets[0]!.bars;
const split = chronologicalSplit(bars);
if (!split.test.length) throw new Error("portfolio universe has no sealed test bars");

const record = {
  version: "portfolio-apparatus-freeze-v1",
  createdAt: Date.now(),
  gitSha: process.env.GITHUB_SHA ?? null,
  manifest,
  fingerprint,
  universe: {
    symbols: assets.map((a) => a.spec.symbol),
    intervalMs: (() => {
      const diffs = bars.slice(1).map((b, i) => b.ts - bars[i]!.ts).filter((x) => x > 0).sort((a, b) => a - b);
      return diffs.length ? diffs[Math.floor(diffs.length / 2)]! : 0;
    })(),
    kinds: Object.fromEntries(assets.map((a) => [a.spec.symbol, a.spec.kind])),
    spreadsBps: Object.fromEntries(assets.map((a) => [a.spec.symbol, a.spec.spreadBps ?? null])),
    alignedBars: bars.length,
    firstTs: bars[0]!.ts,
    lastTs: bars.at(-1)!.ts,
    trainBars: split.train.length,
    validationBars: split.validation.length,
    testBars: split.test.length,
    testStartTs: split.test[0]!.ts,
    testEndTs: split.test.at(-1)!.ts,
  },
  evaluator: {
    kind: selection.evaluatorKind,
    namespace: selection.chosen.evaluatorNamespace,
    profile: selection.chosen.profile,
  },
  features: {
    horizonBars: selection.chosen.horizonBars,
    directionThresholdBpsFloor: selection.features.directionThresholdBpsFloor,
    directionThresholdFixedCostBps: selection.features.directionThresholdFixedCostBps,
  },
  cadence: {
    decisionEveryBars: selection.decisionEveryBars,
  },
  execution: {
    initialCash: Number(flag("cash", "100")),
    feeBps: selection.execution.feeBps,
    slippageBps: selection.execution.slippageBps,
    spreadBpsFallback: selection.execution.spreadBpsFallback,
    spreadCostMultiplier: 1,
    allowShort: selection.execution.allowShort,
    shortBorrowBpsPerDay: Number(flag("short-borrow-bps-day", "1")),
    minTradeNotional: Number(flag("min-trade", "1")),
  },
  portfolio: selection.chosen.portfolio,
  policy: selection.chosen.policy,
  validation: {
    metrics: selection.chosen.validationMetrics ?? null,
    stress: selection.chosen.validationStress ?? null,
  },
  sourceSelection: selectionPath,
};

mkdirSync(out.includes("/") ? out.slice(0, out.lastIndexOf("/")) : ".", { recursive: true });
writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
console.log("wrote portfolio apparatus freeze " + out);
console.log("universe fingerprint " + fingerprint.combinedSha256);
console.log("sealed synchronized bars " + split.test.length + " · " + new Date(split.test[0]!.ts).toISOString() + " -> " + new Date(split.test.at(-1)!.ts).toISOString());
console.log("no sealed-test evaluation was performed");
