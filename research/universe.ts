import { extname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { loadBarsCsv, loadBarsJsonl } from "./csv";
import type { AssetKind, MarketBar } from "./types";

export interface UniverseEntry {
  file: string;
  symbol: string;
  kind: AssetKind;
  spreadBps?: number;
}

export interface UniverseManifest {
  name?: string;
  assets: UniverseEntry[];
}

export interface LoadedAsset {
  spec: UniverseEntry;
  bars: MarketBar[];
}

export function loadUniverseManifest(path: string): UniverseManifest {
  const raw = JSON.parse(readFileSync(path, "utf8")) as UniverseManifest;
  if (!raw || !Array.isArray(raw.assets) || !raw.assets.length) throw new Error("universe manifest needs a non-empty assets array");
  const seen = new Set<string>();
  for (const a of raw.assets) {
    if (!a.file || !a.symbol || !a.kind) throw new Error("every universe asset needs file, symbol and kind");
    if (seen.has(a.symbol)) throw new Error("duplicate universe symbol: " + a.symbol);
    seen.add(a.symbol);
  }
  return raw;
}

export function loadUniverse(path: string): LoadedAsset[] {
  const manifest = loadUniverseManifest(path);
  const base = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
  return manifest.assets.map((spec) => {
    const file = resolve(base, spec.file);
    const bars = extname(file).toLowerCase() === ".jsonl"
      ? loadBarsJsonl(file)
      : loadBarsCsv(file, { symbol: spec.symbol, kind: spec.kind, defaultSpreadBps: spec.spreadBps });
    if (bars.length < 3) throw new Error(`${spec.symbol}: not enough bars`);
    return { spec, bars };
  });
}

/** Timestamps shared by every asset. V1 portfolio replay intentionally requires synchronized bars. */
export function commonTimestamps(assets: LoadedAsset[]) {
  if (!assets.length) return [];
  let common = new Set(assets[0]!.bars.map((b) => b.ts));
  for (const asset of assets.slice(1)) {
    const ts = new Set(asset.bars.map((b) => b.ts));
    common = new Set([...common].filter((x) => ts.has(x)));
  }
  return [...common].sort((a, b) => a - b);
}

export function alignUniverse(assets: LoadedAsset[]) {
  const timestamps = commonTimestamps(assets);
  if (timestamps.length < 3) throw new Error("universe assets do not have enough synchronized timestamps");
  return assets.map((asset) => {
    const byTs = new Map(asset.bars.map((b) => [b.ts, b]));
    return {
      ...asset,
      bars: timestamps.map((ts) => byTs.get(ts)!).filter(Boolean),
    };
  });
}

export function fingerprintUniverse(path: string) {
  const manifestBytes = readFileSync(path);
  const manifest = loadUniverseManifest(path);
  const base = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
  const files = manifest.assets.map((spec) => {
    const resolved = resolve(base, spec.file);
    const bytes = readFileSync(resolved);
    const h = new Bun.CryptoHasher("sha256");
    h.update(bytes);
    return { file: spec.file, symbol: spec.symbol, sha256: h.digest("hex"), bytes: bytes.length };
  });
  const combined = new Bun.CryptoHasher("sha256");
  combined.update(manifestBytes);
  for (const f of files) combined.update(f.symbol + ":" + f.file + ":" + f.sha256 + "\n");
  return {
    manifestSha256: (() => {
      const h = new Bun.CryptoHasher("sha256");
      h.update(manifestBytes);
      return h.digest("hex");
    })(),
    combinedSha256: combined.digest("hex"),
    files,
  };
}
