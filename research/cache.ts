import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FeatureState, JevSignal, SignalEvaluator } from "./types";

interface CacheRecord {
  key: string;
  namespace: string;
  stateVersion: string;
  state: FeatureState;
  signal: JevSignal;
  createdAt: number;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  const obj = value as Record<string, unknown>;
  return "{" + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + stable(obj[k])).join(",") + "}";
}

export function stateCacheKey(namespace: string, stateVersion: string, state: FeatureState) {
  const h = new Bun.CryptoHasher("sha256");
  h.update(stable({ namespace, stateVersion, state }));
  return h.digest("hex");
}

export class JsonlSignalCache {
  private records = new Map<string, JevSignal>();
  hits = 0;
  misses = 0;

  constructor(readonly path: string, readonly stateVersion = "market-bars-v1") {
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as CacheRecord;
        if (r.key && r.signal) this.records.set(r.key, r.signal);
      } catch {
        // Ignore a partial final line from an interrupted writer.
      }
    }
  }

  get(namespace: string, state: FeatureState) {
    const key = stateCacheKey(namespace, this.stateVersion, state);
    const signal = this.records.get(key);
    if (signal) {
      this.hits++;
      return { ...signal, cacheKey: key };
    }
    this.misses++;
    return null;
  }

  put(namespace: string, state: FeatureState, signal: JevSignal) {
    const key = stateCacheKey(namespace, this.stateVersion, state);
    const stored = { ...signal, cacheKey: key };
    this.records.set(key, stored);
    mkdirSync(dirname(this.path), { recursive: true });
    const record: CacheRecord = {
      key,
      namespace,
      stateVersion: this.stateVersion,
      state,
      signal: stored,
      createdAt: Date.now(),
    };
    appendFileSync(this.path, JSON.stringify(record) + "\n");
    return stored;
  }

  get size() { return this.records.size; }
}

export class CachedEvaluator implements SignalEvaluator {
  readonly name: string;

  constructor(
    private inner: SignalEvaluator,
    readonly cache: JsonlSignalCache,
  ) {
    this.name = "cached:" + inner.name;
  }

  async evaluate(state: FeatureState): Promise<JevSignal> {
    const hit = this.cache.get(this.inner.name, state);
    if (hit) return hit;
    return this.cache.put(this.inner.name, state, await this.inner.evaluate(state));
  }
}
