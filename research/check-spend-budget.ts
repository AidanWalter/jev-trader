import { BudgetedEvaluator, remainingSpendBudget, SpendBudgetLedger } from "./budget";
import { choosePolicyAction, defaultPolicyConfig } from "./policy";
import type { FeatureState, JevSignal, SignalEvaluator } from "./types";

const state: FeatureState = {
  symbol: "TEST",
  kind: "spot",
  ts: 1,
  intervalMs: 60_000,
  horizonBars: 8,
  price: 100,
  spreadBps: 2,
  fundingBps: 0,
  lastFundingBps: 0,
  barsSinceFunding: -1,
  directionThresholdBps: 10,
  returnsBps: { r1: 1, r3: 2, r12: 3, r48: 4 },
  realizedVolBps: { v12: 10, v48: 12 },
  rangeBps: 8,
  volumeRatio20: 1,
  trendBps20: 2,
  recentReturnsBps: [1, 2, 3],
};

class FakePaidEvaluator implements SignalEvaluator {
  readonly name = "fake-paid";
  calls = 0;
  async evaluate(): Promise<JevSignal> {
    this.calls++;
    await Bun.sleep(20);
    return {
      version: "test",
      decisionMode: "direction-only",
      model: this.name,
      direction: { choice: "long", probabilities: { long: 0.75, flat: 0.15, short: 0.10 } },
      magnitude: { choice: "tiny", probabilities: { tiny: 1, small: 0, medium: 0, large: 0 } },
      adverseSelection: 0,
      latencyMs: 20,
      inputTokens: 500,
    };
  }
}

let failures = 0;
const check = (name: string, ok: boolean) => {
  console.log((ok ? "ok  " : "FAIL") + " " + name);
  if (!ok) failures++;
};

const inner = new FakePaidEvaluator();
const ledger = new SpendBudgetLedger({
  maxRequests: 3,
  maxInputTokens: 10_000,
  maxUsd: 1,
  usdPerMTok: 0.042,
  reserveTokensPerRequest: 1_000,
});
const budgeted = new BudgetedEvaluator(inner, ledger);
const settled = await Promise.allSettled(
  Array.from({ length: 10 }, () => budgeted.evaluate(state)),
);
const fulfilled = settled.filter((x) => x.status === "fulfilled").length;
const rejected = settled.filter((x) => x.status === "rejected").length;
check("concurrent work cannot exceed global request cap", fulfilled === 3 && rejected === 7);
check("inner evaluator receives exactly capped requests", inner.calls === 3);
check("ledger counts provider-reported tokens once", ledger.snapshot().inputTokens === 1500);
check("no reservations leak after completion", ledger.snapshot().reservedTokens === 0);

const tokenLedger = new SpendBudgetLedger({
  maxRequests: 10,
  maxInputTokens: 1_000,
  maxUsd: 1,
  usdPerMTok: 0.042,
  reserveTokensPerRequest: 600,
});
const tokenInner = new FakePaidEvaluator();
const tokenEval = new BudgetedEvaluator(tokenInner, tokenLedger);
await tokenEval.evaluate(state);
let tokenRejected = false;
try {
  await tokenEval.evaluate(state);
} catch {
  tokenRejected = true;
}
check("token reservation blocks another request before cap can be exceeded", tokenRejected && tokenInner.calls === 1);

const dollarLedger = new SpendBudgetLedger({
  maxRequests: 10,
  maxInputTokens: 100_000,
  maxUsd: 0.000042,
  usdPerMTok: 0.042,
  reserveTokensPerRequest: 600,
});
const dollarInner = new FakePaidEvaluator();
const dollarEval = new BudgetedEvaluator(dollarInner, dollarLedger);
await dollarEval.evaluate(state);
let dollarRejected = false;
try {
  await dollarEval.evaluate(state);
} catch {
  dollarRejected = true;
}
check("explicit dollar ceiling independently blocks another request", dollarRejected && dollarInner.calls === 1);

const lifetime = {
  maxRequests: 12,
  maxInputTokens: 30_000,
  maxUsd: 0.002,
  usdPerMTok: 0.042,
  reserveTokensPerRequest: 2_000,
};
const afterRestart = remainingSpendBudget(lifetime, {
  requests: 7,
  inputTokens: 8_400,
});
check(
  "restart budget preserves lifetime request usage",
  !!afterRestart && afterRestart.maxRequests === 5,
);
check(
  "restart budget preserves lifetime token usage",
  !!afterRestart && afterRestart.maxInputTokens === 21_600,
);
const exhaustedRestart = remainingSpendBudget(lifetime, {
  requests: 12,
  inputTokens: 8_400,
});
check("restart refuses a state whose lifetime request cap is exhausted", exhaustedRestart === null);
const dollarExhaustedRestart = remainingSpendBudget(lifetime, {
  requests: 3,
  inputTokens: 46_000,
});
check("restart refuses a state whose lifetime dollar cap cannot reserve another call", dollarExhaustedRestart === null);

const baseSignal: JevSignal = {
  version: "test",
  model: "jev",
  direction: { choice: "long", probabilities: { long: 0.70, flat: 0.18, short: 0.12 } },
  magnitude: { choice: "large", probabilities: { tiny: 0, small: 0, medium: 0, large: 1 } },
  adverseSelection: 0.01,
  latencyMs: 0,
  inputTokens: 0,
};
const hostileAux: JevSignal = {
  ...baseSignal,
  magnitude: { choice: "tiny", probabilities: { tiny: 1, small: 0, medium: 0, large: 0 } },
  adverseSelection: 0.99,
};
const directionPolicy = {
  ...defaultPolicyConfig,
  directionOnly: true,
  minDirectionalEdge: 0.1,
  minDirectionalConfidence: 0.5,
};
const a = choosePolicyAction(baseSignal, 0, directionPolicy, {
  directionThresholdBps: 10,
  estimatedRoundTripCostBps: 10,
});
const b = choosePolicyAction(hostileAux, 0, directionPolicy, {
  directionThresholdBps: 10,
  estimatedRoundTripCostBps: 10,
});
check("direction-only policy ignores magnitude and adverse fields", JSON.stringify(a) === JSON.stringify(b));

console.log(JSON.stringify({ spend: ledger.snapshot(), directionAction: a }, null, 2));
process.exit(failures ? 1 : 0);
