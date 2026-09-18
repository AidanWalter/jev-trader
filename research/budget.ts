import type { FeatureState, JevSignal, SignalEvaluator } from "./types";

export interface SpendBudget {
  maxRequests: number;
  maxInputTokens: number;
  maxUsd: number;
  usdPerMTok: number;
  reserveTokensPerRequest: number;
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

export class BudgetedEvaluator implements SignalEvaluator {
  readonly name: string;
  requestsStarted = 0;
  requestsCompleted = 0;
  inputTokens = 0;
  private reservedTokens = 0;

  constructor(
    private inner: SignalEvaluator,
    readonly budget: SpendBudget,
  ) {
    this.name = inner.name;
    if (!(budget.maxRequests >= 1)) throw new Error("maxRequests must be at least 1");
    if (!(budget.usdPerMTok > 0)) throw new Error("usdPerMTok must be positive");
    if (!(budget.reserveTokensPerRequest > 0)) throw new Error("reserveTokensPerRequest must be positive");
  }

  private tokenCeiling() {
    const byUsd = Math.floor(this.budget.maxUsd / this.budget.usdPerMTok * 1_000_000);
    return Math.min(this.budget.maxInputTokens, byUsd);
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

  async evaluate(state: FeatureState): Promise<JevSignal> {
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

    // This reservation occurs synchronously before the first await, so concurrent
    // workers cannot all pass the same remaining-budget check.
    this.requestsStarted++;
    this.reservedTokens += reserve;

    try {
      const signal = await this.inner.evaluate(state);
      this.inputTokens += Math.max(0, signal.inputTokens);
      this.requestsCompleted++;
      if (this.inputTokens > ceiling) {
        throw new SpendBudgetExceededError(
          "provider-reported input tokens exceeded the configured budget after the last request"
        );
      }
      return signal;
    } finally {
      this.reservedTokens -= reserve;
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
