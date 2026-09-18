import { extname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadBarsCsv, loadBarsJsonl } from "./csv";
import { inferIntervalMs } from "./features";
import { chronologicalSplit } from "./splits";
import type { AssetKind, PolicyConfig } from "./types";

interface SelectedPolicyFile {
  evaluatorKind: string;
  evaluatorNamespace: string;
  profile: string;
  horizonBars: number;
  decisionEveryBars: number;
  spreadBps: number;
  feeBps: number;
  slippageBps: number;
  policy: PolicyConfig;
  trainMetrics?: unknown;
  validationMetrics?: unknown;
  directionThresholdBpsFloor?: number;
}

interface ApparatusSelectionFile {
  version: "apparatus-selection-v1";
  decisionEveryBars: number;
  evaluatorKind: string;
  execution: { spreadBps: number; feeBps: number; slippageBps: number };
  features: { directionThresholdBpsFloor: number };
  chosen: {
    horizonBars: number;
    profile: string;
    evaluatorNamespace: string;
    policy: PolicyConfig;
    trainMetrics?: unknown;
    validationMetrics?: unknown;
  };
}

function normalizeSelection(raw: SelectedPolicyFile | ApparatusSelectionFile): SelectedPolicyFile {
  if ((raw as ApparatusSelectionFile).version === "apparatus-selection-v1") {
    const s = raw as ApparatusSelectionFile;
    return {
      evaluatorKind: s.evaluatorKind,
      evaluatorNamespace: s.chosen.evaluatorNamespace,
      profile: s.chosen.profile,
      horizonBars: s.chosen.horizonBars,
      decisionEveryBars: s.decisionEveryBars,
      spreadBps: s.execution.spreadBps,
      feeBps: s.execution.feeBps,
      slippageBps: s.execution.slippageBps,
      policy: s.chosen.policy,
      directionThresholdBpsFloor: s.features.directionThresholdBpsFloor,
      trainMetrics: s.chosen.trainMetrics,
      validationMetrics: s.chosen.validationMetrics,
    };
  }
  return raw as SelectedPolicyFile;
}

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const prefix = "--" + name + "=";
  const hit = args.find((x) => x.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
};

const file = args.find((x) => !x.startsWith("--"));
const policyFile = flag("policy");
if (!file || !policyFile) {
  console.error("usage: bun run research/freeze.ts data.csv --policy=data/selected-policy.json --symbol=BTCUSDT --kind=spot");
  process.exit(1);
}

const symbol = flag("symbol", "UNKNOWN")!;
const kind = flag("kind", "spot") as AssetKind;
const out = flag("out", "data/apparatus-freeze.json")!;
const selected = normalizeSelection(JSON.parse(readFileSync(policyFile, "utf8")) as SelectedPolicyFile | ApparatusSelectionFile);

const bars = extname(file).toLowerCase() === ".jsonl"
  ? loadBarsJsonl(file)
  : loadBarsCsv(file, { symbol, kind, defaultSpreadBps: selected.spreadBps });
const split = chronologicalSplit(bars);

const h = new Bun.CryptoHasher("sha256");
h.update(readFileSync(file));
const sha256 = h.digest("hex");

const freezeRecord = {
  version: "apparatus-freeze-v1",
  createdAt: Date.now(),
  gitSha: process.env.GITHUB_SHA ?? null,
  dataset: {
    file,
    sha256,
    symbol,
    kind,
    bars: bars.length,
    intervalMs: inferIntervalMs(bars, Math.min(bars.length - 1, Math.max(1, Math.min(100, bars.length - 1)))),
    firstTs: bars[0]!.ts,
    lastTs: bars.at(-1)!.ts,
    trainBars: split.train.length,
    validationBars: split.validation.length,
    testBars: split.test.length,
    testStartTs: split.test[0]!.ts,
    testEndTs: split.test.at(-1)!.ts,
  },
  evaluator: {
    kind: selected.evaluatorKind,
    namespace: selected.evaluatorNamespace,
    profile: selected.profile,
  },
  features: {
    horizonBars: selected.horizonBars,
    directionThresholdBpsFloor: selected.directionThresholdBpsFloor ?? 1,
  },
  cadence: {
    decisionEveryBars: selected.decisionEveryBars,
  },
  execution: {
    initialCash: Number(flag("cash", "100")),
    spreadBps: selected.spreadBps,
    feeBps: selected.feeBps,
    slippageBps: selected.slippageBps,
    allowShort: flag("allow-short", "true") !== "false",
    shortBorrowBpsPerDay: Number(flag("short-borrow-bps-day", "1")),
    maxGrossExposure: Number(flag("max-gross", "1")),
    minTradeNotional: Number(flag("min-trade", "1")),
  },
  policy: selected.policy,
  sourcePolicyFile: policyFile,
};

const dir = out.includes("/") ? out.slice(0, out.lastIndexOf("/")) : ".";
mkdirSync(dir, { recursive: true });
writeFileSync(out, JSON.stringify(freezeRecord, null, 2) + "\n");
console.log("wrote apparatus freeze " + out);
console.log("dataset sha256 " + sha256);
console.log("sealed test bars " + split.test.length + " · " + new Date(split.test[0]!.ts).toISOString() + " -> " + new Date(split.test.at(-1)!.ts).toISOString());
console.log("no sealed-test evaluation was performed");
