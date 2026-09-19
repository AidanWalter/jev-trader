import { readFileSync, writeFileSync } from "node:fs";
import { stateCacheKey } from "./cache";
import { chronologicalRanges } from "./splits";
import type { Direction, FeatureState, JevSignal } from "./types";
import { alignUniverse, fingerprintUniverse, loadUniverse } from "./universe";

interface CacheRecord {
  key: string;
  namespace: string;
  stateVersion: string;
  state: FeatureState;
  signal: JevSignal;
  createdAt: number;
}

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const prefix = "--" + name + "=";
  return args.find((x) => x.startsWith(prefix))?.slice(prefix.length) ?? fallback;
};

const manifest = args.find((x) => !x.startsWith("--"));
const cachePath = flag("cache");
if (!manifest || !cachePath) {
  console.error("usage: bun run research/validate-jev-cache.ts universe.json --cache=data/cache.jsonl --namespace=... --scope=development");
  process.exit(1);
}

const expectedNamespace = flag("namespace");
const scope = flag("scope", "development")!;
const outPath = flag("out");
const assets = alignUniverse(loadUniverse(manifest));
const fingerprint = fingerprintUniverse(manifest);
const bars = assets[0]!.bars;
const ranges = chronologicalRanges(bars);
const tsBySymbol = new Map(assets.map((a) => [a.spec.symbol, new Set(a.bars.map((b) => b.ts))]));
const splitForTs = (ts: number) => {
  const i = bars.findIndex((b) => b.ts === ts);
  if (i < 0) return "outside";
  if (i >= ranges.train.start && i < ranges.train.end) return "train";
  if (i >= ranges.validation.start && i < ranges.validation.end) return "validation";
  if (i >= ranges.test.start && i < ranges.test.end) return "test";
  return "outside";
};

const directions: Direction[] = ["long", "flat", "short"];
const text = readFileSync(cachePath, "utf8");
const seen = new Map<string, string>();
const namespaces = new Set<string>();
const counts = { records: 0, unique: 0, train: 0, validation: 0, test: 0, outside: 0 };
const errors: string[] = [];
let malformed = 0;

for (const [lineIndex, line] of text.split("\n").entries()) {
  if (!line.trim()) continue;
  counts.records++;
  let r: CacheRecord;
  try {
    r = JSON.parse(line) as CacheRecord;
  } catch {
    malformed++;
    errors.push("line " + (lineIndex + 1) + ": malformed JSON");
    continue;
  }

  if (!r.key || !r.namespace || !r.stateVersion || !r.state || !r.signal) {
    errors.push("line " + (lineIndex + 1) + ": missing cache-record fields");
    continue;
  }
  namespaces.add(r.namespace);
  if (expectedNamespace && r.namespace !== expectedNamespace) {
    errors.push("line " + (lineIndex + 1) + ": unexpected namespace " + r.namespace);
  }

  const recomputed = stateCacheKey(r.namespace, r.stateVersion, r.state);
  if (recomputed !== r.key) errors.push("line " + (lineIndex + 1) + ": cache key hash mismatch");

  const canonical = JSON.stringify({ namespace: r.namespace, stateVersion: r.stateVersion, state: r.state, signal: r.signal });
  const prior = seen.get(r.key);
  if (prior !== undefined && prior !== canonical) {
    errors.push("line " + (lineIndex + 1) + ": duplicate key has conflicting record contents");
  } else if (prior === undefined) {
    seen.set(r.key, canonical);
    counts.unique++;
  }

  const symbolTs = tsBySymbol.get(r.state.symbol);
  if (!symbolTs || !symbolTs.has(r.state.ts)) {
    errors.push("line " + (lineIndex + 1) + ": state is not present in the frozen universe");
  }

  const split = splitForTs(r.state.ts);
  if (split === "train") counts.train++;
  else if (split === "validation") counts.validation++;
  else if (split === "test") counts.test++;
  else counts.outside++;

  const p = r.signal.direction?.probabilities;
  if (!p) {
    errors.push("line " + (lineIndex + 1) + ": missing direction probabilities");
  } else {
    const values = directions.map((d) => Number(p[d]));
    if (values.some((x) => !Number.isFinite(x) || x < 0 || x > 1)) {
      errors.push("line " + (lineIndex + 1) + ": invalid direction probability");
    } else {
      const sum = values.reduce((a, b) => a + b, 0);
      if (Math.abs(sum - 1) > 1e-6) errors.push("line " + (lineIndex + 1) + ": direction probabilities do not sum to 1");
    }
  }
  if (!directions.includes(r.signal.direction?.choice as Direction)) {
    errors.push("line " + (lineIndex + 1) + ": invalid direction choice");
  }
  if (!Number.isFinite(r.signal.inputTokens) || r.signal.inputTokens < 0) {
    errors.push("line " + (lineIndex + 1) + ": invalid input token count");
  }
}

if (scope === "development" && counts.test > 0) {
  errors.push("development cache contains " + counts.test + " sealed-test records");
} else if (scope === "sealed" && counts.train + counts.validation > 0) {
  errors.push("sealed-only cache contains development records");
} else if (!["development", "sealed", "any"].includes(scope)) {
  errors.push("unknown --scope=" + scope);
}

const result = {
  version: "jev-cache-integrity-v1",
  manifest,
  fingerprint,
  cachePath,
  expectedNamespace: expectedNamespace ?? null,
  scope,
  namespaces: [...namespaces].sort(),
  counts,
  malformed,
  errors,
  passed: errors.length === 0,
};

console.log("JEV CACHE INTEGRITY");
console.log("records " + counts.records + " · unique " + counts.unique + " · train " + counts.train + " · validation " + counts.validation + " · test " + counts.test);
console.log("namespaces " + result.namespaces.join(", "));
console.log("integrity " + (result.passed ? "PASSED" : "FAILED"));
for (const error of errors.slice(0, 50)) console.log("ERROR " + error);
if (errors.length > 50) console.log("... " + (errors.length - 50) + " more errors");

if (outPath) writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
if (!result.passed) process.exit(2);
