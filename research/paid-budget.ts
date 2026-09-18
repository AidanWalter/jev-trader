import type { FeatureState, JevSignal, SignalEvaluator } from "./types";

export interface PaidBudget {
  maxRequests: number;
  maxInputTokens: number;
  reserveInputTokensPerRequest: number;
  usdPerMTok: number;
}

export class BudgetedEvaluator implements SignalEvaluator {
  readonly name: string;
  requestsStarted = 0;
  requestsCompleted = 0;
  inputTokens = 0;
  private reservedInputTokens = 0;

  constructor(
    private inner: SignalEvaluator,
    readonly budget: PaidBudget,
  ) {
    this.name = inner.name;
    if (!(budget.maxRequests >= 0)) throw new Error("maxRequests must be non-negative");
    if (!(budget.maxInputTokens >= 0)) throw new Error("maxInputTokens must be non-negative");
    if (!(budget.reserveInputTokensPerRequest > 0)) {
      throw new Error("reserveInputTokensPerRequest must be positive");
    }
  }

  private assertCanStart() {
    if (this.requestsStarted >= this.budget.maxRequests) {
      throw new Error(
        "PAID BUDGET STOP: request cap reached (" + this.budget.maxRequests + "). " +
        "Completed answers remain cached; raise the cap deliberately in a new run."
      );
    }
    const projected =
      this.inputTokens +
      this.reservedInputTokens +
      this.budget.reserveInputTokensPerRequest;
    if (projected > this.budget.maxInputTokens) {
      throw new Error(
        "PAID BUDGET STOP: token reservation would exceed cap (" +
        projected + " > " + this.budget.maxInputTokens + "). " +
        "Completed answers remain cached; raise the cap deliberately in a new run."
      );
    }
  }

  async evaluate(state: FeatureState): Promise<JevSignal> {
    this.assertCanStart();
    this.requestsStarted++;
    this.reservedInputTokens += this.budget.reserveInputTokensPerRequest;

    try {
      const signal = await this.inner.evaluate(state);
      this.requestsCompleted++;
      this.inputTokens += Math.max(0, signal.inputTokens);
      if (this.inputTokens > this.budget.maxInputTokens) {
        throw new Error(
          "PAID BUDGET STOP: provider-reported input tokens exceeded cap after the last request (" +
          this.inputTokens + " > " + this.budget.maxInputTokens + ")."
        );
      }
      return signal;
    } finally {
      this.reservedInputTokens -= this.budget.reserveInputTokensPerRequest;
    }
  }

  get estimatedUsd() {
    return this.inputTokens / 1_000_000 * this.budget.usdPerMTok;
  }

  snapshot() {
    return {
      evaluator: this.name,
      requestsStarted: this.requestsStarted,
      requestsCompleted: this.requestsCompleted,
      inputTokens: this.inputTokens,
      reservedInputTokens: this.reservedInputTokens,
      maxRequests: this.budget.maxRequests,
      maxInputTokens: this.budget.maxInputTokens,
      reserveInputTokensPerRequest: this.budget.reserveInputTokensPerRequest,
      usdPerMTok: this.budget.usdPerMTok,
      estimatedUsdFromReportedTokens: this.estimatedUsd,
    };
  }
}
