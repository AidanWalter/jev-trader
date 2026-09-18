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

  has(namespace: string, state: FeatureState) {
    const key = stateCacheKey(namespace, this.stateVersion, state);
    return this.records.has(key);
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

export interface EvaluationBudget {
  /** Hard cap on fresh provider calls. */
  maxNewEvaluations?: number;
  /** Hard pre-call budget using a conservative reservation per fresh evaluation. */
  maxFreshInputTokens?: number;
  /** Tokens reserved before each fresh call. Set above observed per-call input usage. */
  reserveInputTokensPerEvaluation?: number;
}

export class CachedEvaluator implements SignalEvaluator {
  readonly name: string;
  newEvaluations = 0;
  newInputTokens = 0;
  private reservedInputTokens = 0;
  private inFlight = new Map<string, Promise<JevSignal>>();
  readonly maxNewEvaluations: number;
  readonly maxFreshInputTokens: number;
  readonly reserveInputTokensPerEvaluation: number;

  constructor(
    private inner: SignalEvaluator,
    readonly cache: JsonlSignalCache,
    maxNewEvaluationsOrBudget: number | EvaluationBudget = Infinity,
  ) {
    this.name = "cached:" + inner.name;
    if (typeof maxNewEvaluationsOrBudget === "number") {
      this.maxNewEvaluations = maxNewEvaluationsOrBudget;
      this.maxFreshInputTokens = Infinity;
      this.reserveInputTokensPerEvaluation = 0;
    } else {
      this.maxNewEvaluations = maxNewEvaluationsOrBudget.maxNewEvaluations ?? Infinity;
      this.maxFreshInputTokens = maxNewEvaluationsOrBudget.maxFreshInputTokens ?? Infinity;
      this.reserveInputTokensPerEvaluation = Math.max(
        0,
        maxNewEvaluationsOrBudget.reserveInputTokensPerEvaluation ?? 0,
      );
    }
  }

  async evaluate(state: FeatureState): Promise<JevSignal> {
    const hit = this.cache.get(this.inner.name, state);
    if (hit) return hit;

    const key = stateCacheKey(this.inner.name, this.cache.stateVersion, state);
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    if (this.newEvaluations >= this.maxNewEvaluations) {
      throw new Error(`new-evaluation limit reached (${this.maxNewEvaluations}); increase --max-new-evals deliberately`);
    }
    const reserve = this.reserveInputTokensPerEvaluation;
    if (this.newInputTokens + this.reservedInputTokens + reserve > this.maxFreshInputTokens) {
      throw new Error(
        `fresh-input-token budget would be exceeded: used ${this.newInputTokens}, reserved ${this.reservedInputTokens}, next reserve ${reserve}, cap ${this.maxFreshInputTokens}`,
      );
    }

    this.newEvaluations++;
    this.reservedInputTokens += reserve;

    const work = (async () => {
      const signal = await this.inner.evaluate(state);
      this.newInputTokens += signal.inputTokens;
      if (signal.inputTokens > reserve && reserve > 0) {
        console.warn(
          `Jev call used ${signal.inputTokens} input tokens, above the ${reserve}-token pre-call reservation`,
        );
      }
      return this.cache.put(this.inner.name, state, signal);
    })();
    this.inFlight.set(key, work);

    try {
      return await work;
    } finally {
      this.reservedInputTokens -= reserve;
      this.inFlight.delete(key);
    }
  }
}
