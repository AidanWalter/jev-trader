import type { FeatureState, JevSignal, SignalEvaluator } from "./types";

export interface SpendBudget {
  maxRequests: number;
  maxInputTokens: number;
  maxUsd: number;
  usdPerMTok: number;
  reserveTokensPerRequest: number;
}

export interface ConsumedSpend {
  requests: number;
  inputTokens: number;
}

export function remainingSpendBudget(
  lifetime: SpendBudget,
  consumed: ConsumedSpend,
): SpendBudget | null {
  const requests = Math.max(0, Math.floor(consumed.requests));
  const inputTokens = Math.max(0, consumed.inputTokens);
  const usedUsd = inputTokens / 1_000_000 * lifetime.usdPerMTok;
  const remaining: SpendBudget = {
    ...lifetime,
    maxRequests: Math.max(0, lifetime.maxRequests - requests),
    maxInputTokens: Math.max(0, lifetime.maxInputTokens - inputTokens),
    maxUsd: Math.max(0, lifetime.maxUsd - usedUsd),
  };
  const dollarTokenCeiling =
    remaining.maxUsd / remaining.usdPerMTok * 1_000_000;
  if (
    remaining.maxRequests < 1 ||
    remaining.maxInputTokens < remaining.reserveTokensPerRequest ||
    dollarTokenCeiling < remaining.reserveTokensPerRequest
  ) return null;
  return remaining;
}

export interface SpendSnapshot {
  requestsStarted: number;
  requestsCompleted: number;
  inputTokens: number;
  estimatedUsd: number;
  reservedTokens: number;
  remainingRequests: number;
  remainingInputTokens: number;
  remainingUsd: number;
}

export class SpendBudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpendBudgetExceededError";
  }
}

export class SpendBudgetLedger {
  requestsStarted = 0;
  requestsCompleted = 0;
  inputTokens = 0;
  private reservedTokens = 0;

  constructor(readonly budget: SpendBudget) {
    if (!(budget.maxRequests >= 1)) throw new Error("maxRequests must be at least 1");
    if (!(budget.usdPerMTok > 0)) throw new Error("usdPerMTok must be positive");
    if (!(budget.maxUsd > 0)) throw new Error("maxUsd must be positive");
    if (!(budget.reserveTokensPerRequest > 0)) throw new Error("reserveTokensPerRequest must be positive");
  }

  private tokenCeiling() {
    const byUsd = Math.floor(this.budget.maxUsd / this.budget.usdPerMTok * 1_000_000);
    return Math.min(this.budget.maxInputTokens, byUsd);
  }

  reserve() {
    if (this.requestsStarted >= this.budget.maxRequests) {
      throw new SpendBudgetExceededError(
        "paid request cap reached (" + this.budget.maxRequests + ")"
      );
    }
    const ceiling = this.tokenCeiling();
    const reserve = this.budget.reserveTokensPerRequest;
    if (this.inputTokens + this.reservedTokens + reserve > ceiling) {
      throw new SpendBudgetExceededError(
        "input-token/dollar budget would be exceeded by another reserved request"
      );
    }
    this.requestsStarted++;
    this.reservedTokens += reserve;
    return reserve;
  }

  complete(reservation: number, inputTokens: number) {
    this.reservedTokens -= reservation;
    this.inputTokens += Math.max(0, inputTokens);
    this.requestsCompleted++;
    if (this.inputTokens > this.tokenCeiling()) {
      throw new SpendBudgetExceededError(
        "provider-reported input tokens exceeded the configured budget after the last request"
      );
    }
  }

  release(reservation: number) {
    this.reservedTokens = Math.max(0, this.reservedTokens - reservation);
  }

  snapshot(): SpendSnapshot {
    const ceiling = this.tokenCeiling();
    const estimatedUsd = this.inputTokens / 1_000_000 * this.budget.usdPerMTok;
    return {
      requestsStarted: this.requestsStarted,
      requestsCompleted: this.requestsCompleted,
      inputTokens: this.inputTokens,
      estimatedUsd,
      reservedTokens: this.reservedTokens,
      remainingRequests: Math.max(0, this.budget.maxRequests - this.requestsStarted),
      remainingInputTokens: Math.max(0, ceiling - this.inputTokens - this.reservedTokens),
      remainingUsd: Math.max(0, this.budget.maxUsd - estimatedUsd),
    };
  }
}

export class BudgetedEvaluator implements SignalEvaluator {
  readonly name: string;

  constructor(
    private inner: SignalEvaluator,
    readonly ledger: SpendBudgetLedger,
  ) {
    this.name = inner.name;
  }

  async evaluate(state: FeatureState): Promise<JevSignal> {
    const reservation = this.ledger.reserve();
    let completed = false;
    try {
      const signal = await this.inner.evaluate(state);
      this.ledger.complete(reservation, signal.inputTokens);
      completed = true;
      return signal;
    } finally {
      if (!completed) this.ledger.release(reservation);
    }
  }
}

export function defaultSpendBudget(overrides: Partial<SpendBudget> = {}): SpendBudget {
  return {
    maxRequests: 50,
    maxInputTokens: 125_000,
    maxUsd: 0.01,
    usdPerMTok: 0.042,
    reserveTokensPerRequest: 2_000,
    ...overrides,
  };
}
