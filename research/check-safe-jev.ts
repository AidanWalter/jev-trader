import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetedEvaluator, SpendBudgetLedger } from "./budget";
import { CachedEvaluator, JsonlSignalCache } from "./cache";
import { choosePolicyAction } from "./policy";
import { projectState } from "./profiles";
import type { FeatureState, JevSignal, SignalEvaluator } from "./types";

function feature(ts = 1): FeatureState {
  return {
    symbol: "BTCUSDT",
    kind: "spot",
    ts,
    intervalMs: 3_600_000,
    horizonBars: 8,
    price: 100,
    spreadBps: 4,
    fundingBps: 0,
    lastFundingBps: 0,
    barsSinceFunding: -1,
    directionThresholdBps: 14,
    returnsBps: { r1: 2, r3: 4, r12: 8, r48: -3 },
    realizedVolBps: { v12: 18, v48: 22 },
    rangeBps: 15,
    volumeRatio20: 1.1,
    trendBps20: 6,
    recentReturnsBps: [1,2,3],
    marketContext: {
      universeSize: 3,
      breadthR1PositivePct: 66.67,
      breadthR12PositivePct: 66.67,
      meanR1Bps: 1,
      meanR12Bps: 5,
      dispersionR12Bps: 4,
      relativeR1Bps: 1,
      relativeR12Bps: 3,
      relativeTrendBps20: 2,
      rankR12Pct: 100,
    },
  };
}

class DummyEvaluator implements SignalEvaluator {
  readonly name = "dummy-direction-v1";
  calls = 0;
  constructor(private tokens = 900, private delayMs = 10) {}
  async evaluate(_state: FeatureState): Promise<JevSignal> {
    this.calls++;
    await Bun.sleep(this.delayMs);
    return {
      version: "dummy",
      decisionMode: "direction-only",
      model: this.name,
      direction: { choice: "long", probabilities: { long: 0.75, flat: 0.15, short: 0.10 } },
      magnitude: { choice: "large", probabilities: { tiny: 0, small: 0, medium: 0, large: 1 } },
      adverseSelection: 1,
      latencyMs: this.delayMs,
      inputTokens: this.tokens,
    };
  }
}

let failures = 0;
const check = (name: string, ok: boolean) => {
  console.log((ok ? "ok  " : "FAIL") + " " + name);
  if (!ok) failures++;
};

const lean = projectState(feature(), "lean") as Record<string, unknown>;
check("lean profile keeps direction-relevant returns", "returnsBps" in lean && "realizedVolBps" in lean);
check("lean profile keeps compact market context", "marketContext" in lean);
check("lean profile removes raw price and timestamp", !("price" in lean) && !("ts" in lean));
check("lean profile removes recent path array", !("recentReturnsBps" in lean));

const signal = await new DummyEvaluator().evaluate(feature());
const directionOnly = choosePolicyAction(signal, 0, {
  directionOnly: true,
  minDirectionalEdge: 0.1,
  minDirectionalConfidence: 0.5,
  flatExitProbability: 0.7,
  maxAdverseSelection: 0,
  maxTargetExposure: 1,
  minExposureChange: 0.05,
  minExpectedMoveCostMultiple: 99,
  sizeScoreThresholds: [0.2, 0.4, 0.6],
});
check("direction-only policy ignores magnitude/adverse placeholders", directionOnly.kind === "target" && directionOnly.targetExposure > 0);

const fullMode = choosePolicyAction({ ...signal, decisionMode: "full" }, 0, {
  minDirectionalEdge: 0.1,
  minDirectionalConfidence: 0.5,
  flatExitProbability: 0.7,
  maxAdverseSelection: 0.5,
  maxTargetExposure: 1,
  minExposureChange: 0.05,
  minExpectedMoveCostMultiple: 1,
  sizeScoreThresholds: [0.2, 0.4, 0.6],
});
check("full policy still honors adverse-selection gate", fullMode.kind === "hold");

const dir = mkdtempSync(join(tmpdir(), "jev-safe-budget-"));
try {
  const inner = new DummyEvaluator(900, 25);
  const ledger = new SpendBudgetLedger({
    maxRequests: 2,
    maxInputTokens: 2500,
    maxUsd: 1,
    reserveTokensPerRequest: 1000,
    usdPerMTok: 0.042,
  });
  const budgeted = new BudgetedEvaluator(inner, ledger);
  const cached = new CachedEvaluator(budgeted, new JsonlSignalCache(join(dir, "cache.jsonl")), 100);

  const results = await Promise.allSettled([
    cached.evaluate(feature(10)),
    cached.evaluate(feature(20)),
    cached.evaluate(feature(30)),
  ]);
  const fulfilled = results.filter((x) => x.status === "fulfilled").length;
  const rejected = results.filter((x) => x.status === "rejected").length;
  check("concurrent hard request cap allows exactly two unique paid calls", fulfilled === 2 && rejected === 1 && inner.calls === 2);
  check("provider-token accounting remains below hard cap", ledger.snapshot().inputTokens === 1800 && ledger.snapshot().inputTokens <= 2500);

  const before = inner.calls;
  await cached.evaluate(feature(10));
  check("cache hit spends no additional request", inner.calls === before);

  const snap = ledger.snapshot();
  check("budget snapshot reports exact request count", snap.requestsStarted === 2 && snap.requestsCompleted === 2);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.exit(failures ? 1 : 0);
