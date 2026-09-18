import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename } from "node:path";
import { alignUniverse, loadUniverse } from "./universe";
import type { Direction, FeatureState, JevSignal } from "./types";

interface CacheRecord {
  key: string;
  namespace: string;
  stateVersion: string;
  state: FeatureState;
  signal: JevSignal;
  createdAt: number;
}

interface Observation {
  key: string;
  namespace: string;
  profile: string;
  horizonBars: number;
  symbol: string;
  ts: number;
  truth: Direction;
  choice: Direction;
  confidence: number;
  edge: number;
  flatProbability: number;
  futureReturnBps: number;
  calledReturnBps: number;
  netCalledReturnBps: number;
  brier: number;
  logLoss: number;
  magnitudeChoice: string;
  magnitudeExpectedIndex: number;
  adverseSelection: number;
  inputTokens: number;
  latencyMs: number;
}

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const prefix = "--" + name + "=";
  return args.find((x) => x.startsWith(prefix))?.slice(prefix.length) ?? fallback;
};
const manifest = args.find((x) => !x.startsWith("--"));
if (!manifest) {
  console.error("usage: bun run research/audit-paid-cache.ts universe.json --cache=a.jsonl[,b.jsonl] --fee-bps=4 --slippage-bps=1 --out=audit.json");
  process.exit(1);
}
const cachePaths = (flag("cache", "") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
if (!cachePaths.length) throw new Error("--cache is required");
const feeBps = Number(flag("fee-bps", "4"));
const slippageBps = Number(flag("slippage-bps", "1"));
const outPath = flag("out", "data/paid-cache-audit.json")!;

const assets = alignUniverse(loadUniverse(manifest));
const bySymbol = new Map(assets.map((a) => [a.spec.symbol, a]));
const indexBySymbolTs = new Map<string, Map<number, number>>();
for (const asset of assets) {
  indexBySymbolTs.set(asset.spec.symbol, new Map(asset.bars.map((b, i) => [b.ts, i])));
}

function parseProfile(namespace: string) {
  const parts = namespace.split(":");
  return parts.at(-1) ?? "unknown";
}
function truthFor(retBps: number, threshold: number): Direction {
  return retBps > threshold ? "long" : retBps < -threshold ? "short" : "flat";
}
function magnitudeExpectedIndex(signal: JevSignal) {
  const p = signal.magnitude?.probabilities;
  if (!p) return NaN;
  return p.tiny * 0.5 + p.small * 1.5 + p.medium * 3 + p.large * 6;
}
function mean(xs: number[]) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}
function median(xs: number[]) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
function corr(xs: number[], ys: number[]) {
  if (xs.length !== ys.length || xs.length < 3) return NaN;
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) {
    const a = xs[i]! - mx, b = ys[i]! - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : NaN;
}
function summarize(rows: Observation[]) {
  const nonFlat = rows.filter((x) => x.choice !== "flat");
  return {
    n: rows.length,
    accuracyPct: rows.length ? rows.filter((x) => x.choice === x.truth).length / rows.length * 100 : null,
    brier: rows.length ? mean(rows.map((x) => x.brier)) : null,
    logLoss: rows.length ? mean(rows.map((x) => x.logLoss)) : null,
    meanConfidencePct: rows.length ? mean(rows.map((x) => x.confidence)) * 100 : null,
    meanAbsEdgePct: rows.length ? mean(rows.map((x) => Math.abs(x.edge))) * 100 : null,
    nonFlatCalls: nonFlat.length,
    calledBpsPerState: rows.length ? mean(rows.map((x) => x.calledReturnBps)) : null,
    netCalledBpsPerState: rows.length ? mean(rows.map((x) => x.netCalledReturnBps)) : null,
    calledBpsPerNonFlat: nonFlat.length ? mean(nonFlat.map((x) => x.calledReturnBps)) : null,
    netCalledBpsPerNonFlat: nonFlat.length ? mean(nonFlat.map((x) => x.netCalledReturnBps)) : null,
    medianInputTokens: rows.length ? median(rows.map((x) => x.inputTokens)) : null,
    meanInputTokens: rows.length ? mean(rows.map((x) => x.inputTokens)) : null,
    meanLatencyMs: rows.length ? mean(rows.map((x) => x.latencyMs)) : null,
    confidenceCorrectnessCorrelation: rows.length ? corr(rows.map((x) => x.confidence), rows.map((x) => x.choice === x.truth ? 1 : 0)) : null,
    edgeCalledReturnCorrelation: nonFlat.length ? corr(nonFlat.map((x) => Math.abs(x.edge)), nonFlat.map((x) => x.calledReturnBps)) : null,
    magnitudeAbsMoveCorrelation: rows.length ? corr(rows.map((x) => x.magnitudeExpectedIndex), rows.map((x) => Math.abs(x.futureReturnBps))) : null,
    adverseCalledReturnCorrelation: nonFlat.length ? corr(nonFlat.map((x) => x.adverseSelection), nonFlat.map((x) => x.calledReturnBps)) : null,
    predictionMix: {
      longPct: rows.length ? rows.filter((x) => x.choice === "long").length / rows.length * 100 : null,
      flatPct: rows.length ? rows.filter((x) => x.choice === "flat").length / rows.length * 100 : null,
      shortPct: rows.length ? rows.filter((x) => x.choice === "short").length / rows.length * 100 : null,
    },
    truthMix: {
      longPct: rows.length ? rows.filter((x) => x.truth === "long").length / rows.length * 100 : null,
      flatPct: rows.length ? rows.filter((x) => x.truth === "flat").length / rows.length * 100 : null,
      shortPct: rows.length ? rows.filter((x) => x.truth === "short").length / rows.length * 100 : null,
    },
  };
}
function group<T extends string | number>(rows: Observation[], key: (x: Observation) => T) {
  const out = new Map<T, Observation[]>();
  for (const row of rows) {
    const k = key(row);
    const xs = out.get(k) ?? [];
    xs.push(row);
    out.set(k, xs);
  }
  return [...out.entries()].map(([name, xs]) => ({ name, ...summarize(xs) }));
}
function confidenceBin(x: number) {
  const lo = Math.floor(x * 10) * 10;
  const hi = Math.min(100, lo + 10);
  return String(lo).padStart(2, "0") + "-" + String(hi).padStart(2, "0") + "%";
}
function edgeBin(x: number) {
  const a = Math.abs(x);
  if (a < 0.10) return "<10%";
  if (a < 0.20) return "10-20%";
  if (a < 0.30) return "20-30%";
  if (a < 0.40) return "30-40%";
  return ">=40%";
}
function timeQuartile(rows: Observation[], row: Observation) {
  const ts = rows.map((x) => x.ts).sort((a, b) => a - b);
  const min = ts[0]!, max = ts.at(-1)!;
  if (max <= min) return "q1";
  const f = (row.ts - min) / (max - min);
  return "q" + Math.min(4, Math.floor(f * 4) + 1);
}

const seen = new Set<string>();
const observations: Observation[] = [];
const skipped = { duplicate: 0, missingAsset: 0, missingTimestamp: 0, missingFuture: 0, malformed: 0 };
let rawRecords = 0;

for (const cachePath of cachePaths) {
  const text = readFileSync(cachePath, "utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    rawRecords++;
    let r: CacheRecord;
    try { r = JSON.parse(line) as CacheRecord; } catch { skipped.malformed++; continue; }
    if (!r.key || !r.state || !r.signal) { skipped.malformed++; continue; }
    if (seen.has(r.key)) { skipped.duplicate++; continue; }
    seen.add(r.key);

    const asset = bySymbol.get(r.state.symbol);
    if (!asset) { skipped.missingAsset++; continue; }
    const i = indexBySymbolTs.get(r.state.symbol)?.get(r.state.ts);
    if (i === undefined) { skipped.missingTimestamp++; continue; }
    const future = asset.bars[i + r.state.horizonBars];
    if (!future) { skipped.missingFuture++; continue; }

    const retBps = (future.close / r.state.price - 1) * 10_000;
    const truth = truthFor(retBps, r.state.directionThresholdBps);
    const p = r.signal.direction.probabilities;
    const choice = r.signal.direction.choice;
    const confidence = Math.max(p.long, p.flat, p.short);
    const edge = p.long - p.short;
    const called = choice === "long" ? retBps : choice === "short" ? -retBps : 0;
    const roundTripCost = r.state.spreadBps + 2 * feeBps + 2 * slippageBps;
    const netCalled = choice === "flat" ? 0 : called - roundTripCost;
    let brier = 0;
    for (const d of ["long","flat","short"] as const) {
      const y = truth === d ? 1 : 0;
      brier += (p[d] - y) ** 2;
    }

    observations.push({
      key: r.key,
      namespace: r.namespace,
      profile: parseProfile(r.namespace),
      horizonBars: r.state.horizonBars,
      symbol: r.state.symbol,
      ts: r.state.ts,
      truth,
      choice,
      confidence,
      edge,
      flatProbability: p.flat,
      futureReturnBps: retBps,
      calledReturnBps: called,
      netCalledReturnBps: netCalled,
      brier,
      logLoss: -Math.log(Math.max(1e-12, p[truth])),
      magnitudeChoice: r.signal.magnitude?.choice ?? "unknown",
      magnitudeExpectedIndex: magnitudeExpectedIndex(r.signal),
      adverseSelection: r.signal.adverseSelection ?? 0,
      inputTokens: r.signal.inputTokens ?? 0,
      latencyMs: r.signal.latencyMs ?? 0,
    });
  }
}

if (!observations.length) throw new Error("no cache observations could be matched to future market bars");

const audit = {
  version: "paid-jev-cache-audit-v1",
  createdAt: Date.now(),
  manifest,
  cacheFiles: cachePaths.map((p) => basename(p)),
  rawRecords,
  uniqueMatchedRecords: observations.length,
  skipped,
  overall: summarize(observations),
  byNamespace: group(observations, (x) => x.namespace),
  byProfile: group(observations, (x) => x.profile),
  byHorizon: group(observations, (x) => x.horizonBars),
  bySymbol: group(observations, (x) => x.symbol),
  byChoice: group(observations, (x) => x.choice),
  byTruth: group(observations, (x) => x.truth),
  byConfidenceBin: group(observations, (x) => confidenceBin(x.confidence)),
  byEdgeBin: group(observations, (x) => edgeBin(x.edge)),
  byMagnitudeChoice: group(observations, (x) => x.magnitudeChoice),
  byAdverseBin: group(observations, (x) => confidenceBin(x.adverseSelection)),
  byTimeQuartile: group(observations, (x) => timeQuartile(observations, x)),
};

mkdirSync(outPath.includes("/") ? outPath.slice(0, outPath.lastIndexOf("/")) : ".", { recursive: true });
writeFileSync(outPath, JSON.stringify(audit, null, 2) + "\n");

console.log("PAID JEV CACHE FORENSICS");
console.log("records " + rawRecords + " · unique matched " + observations.length + " · duplicate " + skipped.duplicate);
console.log("overall " + JSON.stringify(audit.overall));
for (const row of audit.byNamespace.sort((a, b) => b.n - a.n)) {
  console.log("namespace " + String(row.name) + " · " + JSON.stringify(row));
}
for (const row of audit.byConfidenceBin) console.log("confidence " + String(row.name) + " · " + JSON.stringify(row));
for (const row of audit.byTimeQuartile) console.log("time " + String(row.name) + " · " + JSON.stringify(row));
console.log("wrote " + outPath);
