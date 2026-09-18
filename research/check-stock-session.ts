import { replayBars } from "./replay";
import type { FeatureState, JevSignal, MarketBar, SignalEvaluator } from "./types";

class SessionFlip implements SignalEvaluator {
  readonly name = "test-session-flip";
  constructor(private flipTs: number) {}
  async evaluate(state: FeatureState): Promise<JevSignal> {
    const short = state.ts >= this.flipTs;
    return {
      version: "test",
      model: this.name,
      direction: short
        ? { choice: "short", probabilities: { long: 0.005, flat: 0.005, short: 0.99 } }
        : { choice: "long", probabilities: { long: 0.99, flat: 0.005, short: 0.005 } },
      magnitude: { choice: "large", probabilities: { tiny: 0.005, small: 0.005, medium: 0.005, large: 0.985 } },
      adverseSelection: 0,
      latencyMs: 0,
      inputTokens: 0,
    };
  }
}

function bar(ts: number, price: number): MarketBar {
  return {
    ts,
    symbol: "TEST",
    kind: "stock",
    open: price,
    high: price * 1.001,
    low: price * 0.999,
    close: price * 1.0002,
    volume: 10000,
    spreadBps: 2,
  };
}

const day1 = Date.UTC(2025, 0, 2, 14, 30);
const day2 = Date.UTC(2025, 0, 3, 14, 30);
const step = 15 * 60_000;
const bars: MarketBar[] = [];
for (let i = 0; i < 6; i++) bars.push(bar(day1 + i * step, 100 + i * 0.1));
for (let i = 0; i < 6; i++) bars.push(bar(day2 + i * step, 101 + i * 0.1));

const overnightDecisionTs = day1 + 5 * step;
const result = await replayBars(bars, {
  evaluator: new SessionFlip(overnightDecisionTs),
  features: { minHistoryBars: 2, directionThresholdBpsFloor: 1 },
  policy: {
    minDirectionalEdge: 0,
    minDirectionalConfidence: 0,
    maxAdverseSelection: 1,
    minExpectedMoveCostMultiple: 0,
  },
  execution: {
    initialCash: 100,
    feeBps: 0,
    slippageBps: 0,
    spreadBpsFallback: 2,
    minTradeNotional: 0.01,
  },
});

let failures = 0;
const check = (name: string, ok: boolean) => {
  console.log((ok ? "ok  " : "FAIL") + " " + name);
  if (!ok) failures++;
};

const fills = result.decisions.flatMap((d) => d.fill ? [d.fill] : []);
check("stock session test produces at least one fill", fills.length > 0);
check(
  "no stock fill crosses an overnight gap",
  fills.every((f) => f.executionTs - f.decisionTs <= 2 * step),
);
check(
  "trading resumes inside the second session",
  fills.some((f) => f.executionTs >= day2 && f.executionTs - f.decisionTs === step),
);
check(
  "last first-session reversal has no overnight fill",
  !fills.some((f) => f.decisionTs === overnightDecisionTs),
);

process.exit(failures ? 1 : 0);
