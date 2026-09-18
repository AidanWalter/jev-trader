import { extname } from "node:path";
import { readFileSync } from "node:fs";
import { JsonlSignalCache } from "./cache";
import { loadBarsCsv, loadBarsJsonl } from "./csv";
import { buildFeatureState, defaultFeatureConfig } from "./features";
import { chronologicalRanges } from "./splits";
import type { AssetKind } from "./types";
import type { InputProfile } from "./profiles";

interface FreezeRecord {
  version: "apparatus-freeze-v1";
  dataset: {
    file: string;
    sha256: string;
    symbol: string;
    kind: AssetKind;
    bars: number;
  };
  evaluator: {
    kind: string;
    namespace: string;
    profile: InputProfile;
  };
  features: {
    horizonBars: number;
    directionThresholdBpsFloor?: number;
  };
  cadence: { decisionEveryBars: number };
  execution: { spreadBps: number };
}

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const prefix = "--" + name + "=";
  const hit = args.find((x) => x.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
};
const freezePath = args.find((x) => !x.startsWith("--")) ?? "data/apparatus-freeze.json";
const freeze = JSON.parse(readFileSync(freezePath, "utf8")) as FreezeRecord;
if (freeze.version !== "apparatus-freeze-v1") throw new Error("unsupported freeze version");

const dataFile = flag("data", freeze.dataset.file)!;
const cachePath = flag("cache", "data/jev-pilot-cache.jsonl")!;
const rawBytes = readFileSync(dataFile);
const hasher = new Bun.CryptoHasher("sha256");
hasher.update(rawBytes);
if (hasher.digest("hex") !== freeze.dataset.sha256) throw new Error("dataset hash differs from freeze");

const bars = extname(dataFile).toLowerCase() === ".jsonl"
  ? loadBarsJsonl(dataFile)
  : loadBarsCsv(dataFile, {
      symbol: freeze.dataset.symbol,
      kind: freeze.dataset.kind,
      defaultSpreadBps: freeze.execution.spreadBps,
    });
if (bars.length !== freeze.dataset.bars) throw new Error("dataset bar count differs from freeze");

const ranges = chronologicalRanges(bars);
const cache = new JsonlSignalCache(cachePath);
const cfg = {
  ...defaultFeatureConfig,
  horizonBars: freeze.features.horizonBars,
  directionThresholdBpsFloor: freeze.features.directionThresholdBpsFloor ?? 1,
};

let states = 0;
let cached = 0;
let missing = 0;
const first = Math.max(cfg.minHistoryBars, ranges.test.start);
const endExclusive = ranges.test.end - cfg.horizonBars;
for (let i = first; i < endExclusive; i += freeze.cadence.decisionEveryBars) {
  const state = buildFeatureState(bars, i, cfg);
  if (!state) continue;
  states++;
  if (cache.has(freeze.evaluator.namespace, state)) cached++;
  else missing++;
}

console.log("SEALED TEST PREFLIGHT");
console.log("symbol " + freeze.dataset.symbol + " · horizon " + cfg.horizonBars + " bars · every " + freeze.cadence.decisionEveryBars + " bar(s)");
console.log("scoreable decision states " + states + " · already cached " + cached + " · new Jev calls required " + missing);
console.log("dataset hash verified · no model calls were made · sealed test was not evaluated");
