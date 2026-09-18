import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CachedEvaluator, JsonlSignalCache } from "./cache";
import type { FeatureState, JevSignal, SignalEvaluator } from "./types";

const dir = mkdtempSync(join(tmpdir(), "jev-cache-concurrency-"));
const cachePath = join(dir, "cache.jsonl");

function state(ts: number): FeatureState {
  return {
    symbol: "TEST",
    kind: "spot",
    ts,
    intervalMs: 60_000,
    horizonBars: 1,
    price: 100,
    spreadBps: 1,
    fundingBps: 0,
    lastFundingBps: 0,
    barsSinceFunding: -1,
    directionThresholdBps: 5,
    returnsBps: { r1: 1, r3: 2, r12: 3, r48: 4 },
    realizedVolBps: { v12: 10, v48: 12 },
    rangeBps: 8,
    volumeRatio20: 1,
    trendBps20: 2,
    recentReturnsBps: [1, 2, 3],
  };
}

class SlowEvaluator implements SignalEvaluator {
  readonly name = "slow-test-v1";
  calls = 0;
  async evaluate(s: FeatureState): Promise<JevSignal> {
    this.calls++;
    await Bun.sleep(25);
    return {
      version: "test",
      model: this.name,
      direction: { choice: "long", probabilities: { long: 0.8, flat: 0.1, short: 0.1 } },
      magnitude: { choice: "small", probabilities: { tiny: 0.1, small: 0.7, medium: 0.15, large: 0.05 } },
      adverseSelection: 0.1,
      latencyMs: 25,
      inputTokens: 123,
    };
  }
}

let failures = 0;
function check(name: string, ok: boolean) {
  console.log((ok ? "ok  " : "FAIL") + " " + name);
  if (!ok) failures++;
}

try {
  const inner = new SlowEvaluator();
  const cache = new JsonlSignalCache(cachePath);
  const evaluator = new CachedEvaluator(inner, cache, 2);

  const same = state(1_000);
  const answers = await Promise.all(Array.from({ length: 12 }, () => evaluator.evaluate(same)));
  check("twelve concurrent identical requests use one inner call", inner.calls === 1);
  check("fresh evaluation counter counts the deduplicated request once", evaluator.newEvaluations === 1);
  check("input tokens count once", evaluator.newInputTokens === 123);
  check("all callers receive the same cache key", new Set(answers.map((x) => x.cacheKey)).size === 1);

  const cachedAgain = await evaluator.evaluate(same);
  check("subsequent request is a cache hit", inner.calls === 1 && !!cachedAgain.cacheKey);

  const second = state(2_000);
  await Promise.all(Array.from({ length: 8 }, () => evaluator.evaluate(second)));
  check("second unique state consumes exactly one more call", inner.calls === 2 && evaluator.newEvaluations === 2);

  const third = state(3_000);
  let rejected = false;
  try {
    await evaluator.evaluate(third);
  } catch (e) {
    rejected = String((e as Error).message).includes("new-evaluation limit reached");
  }
  check("hard fresh-call budget still rejects a third unique state", rejected && inner.calls === 2);

  const tokenInner = new SlowEvaluator();
  const tokenCache = new JsonlSignalCache(join(dir, "token-cache.jsonl"));
  const tokenBudgeted = new CachedEvaluator(tokenInner, tokenCache, {
    maxNewEvaluations: 10,
    maxFreshInputTokens: 3_600,
    reserveInputTokensPerEvaluation: 1_800,
  });
  await Promise.all([
    tokenBudgeted.evaluate(state(10_000)),
    tokenBudgeted.evaluate(state(11_000)),
  ]);
  let tokenRejected = false;
  try {
    await tokenBudgeted.evaluate(state(12_000));
  } catch (e) {
    tokenRejected = String((e as Error).message).includes("fresh-input-token budget would be exceeded");
  }
  check("pre-call token reservation blocks spend before a third call", tokenRejected && tokenInner.calls === 2);

  console.log(JSON.stringify({
    innerCalls: inner.calls,
    newEvaluations: evaluator.newEvaluations,
    newInputTokens: evaluator.newInputTokens,
    cacheSize: cache.size,
    hits: cache.hits,
    misses: cache.misses,
  }, null, 2));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.exit(failures ? 1 : 0);
