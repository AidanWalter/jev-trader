import { replayBars } from "./replay";
import type { FeatureState, JevSignal, MarketBar, SignalEvaluator } from "./types";

class FixedDirection implements SignalEvaluator {
  readonly name: string;
  constructor(private direction: "long" | "short") {
    this.name = "test-fixed-" + direction;
  }
  async evaluate(_state: FeatureState): Promise<JevSignal> {
    return {
      version: "test",
      model: this.name,
      direction: this.direction === "long"
        ? { choice: "long", probabilities: { long: 0.99, flat: 0.005, short: 0.005 } }
        : { choice: "short", probabilities: { long: 0.005, flat: 0.005, short: 0.99 } },
      magnitude: {
        choice: "large",
        probabilities: { tiny: 0.005, small: 0.005, medium: 0.005, large: 0.985 },
      },
      adverseSelection: 0,
      latencyMs: 0,
      inputTokens: 0,
    };
  }
}

function makeBars(): MarketBar[] {
  const out: MarketBar[] = [];
  const start = Date.UTC(2025, 0, 1);
  const step = 60 * 60_000;
  for (let i = 0; i < 12; i++) {
    out.push({
      ts: start + i * step,
      symbol: "TESTPERP",
      kind: "perp",
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 1000,
      spreadBps: 0,
      fundingBps: i === 5 ? 10 : 0,
    });
  }
  return out;
}

async function run(direction: "long" | "short") {
  return replayBars(makeBars(), {
    evaluator: new FixedDirection(direction),
    features: {
      minHistoryBars: 1,
      horizonBars: 1,
      spreadBpsFallback: 0,
      directionThresholdBpsFloor: 1,
      directionThresholdFixedCostBps: 0,
    },
    policy: {
      minDirectionalEdge: 0,
      minDirectionalConfidence: 0,
      maxAdverseSelection: 1,
      minExpectedMoveCostMultiple: 0,
      maxTargetExposure: 1,
      minExposureChange: 0,
    },
    execution: {
      initialCash: 100,
      feeBps: 0,
      slippageBps: 0,
      spreadBpsFallback: 0,
      spreadCostMultiplier: 1,
      minTradeNotional: 0,
      allowShort: true,
      shortBorrowBpsPerDay: 1000,
    },
  });
}

const long = await run("long");
const short = await run("short");

let failures = 0;
const check = (name: string, ok: boolean) => {
  console.log((ok ? "ok  " : "FAIL") + " " + name);
  if (!ok) failures++;
};

check("positive funding is paid by long", long.metrics.fundingPnl < 0);
check("positive funding is received by short", short.metrics.fundingPnl > 0);
check("long and short funding cashflows are approximately symmetric", Math.abs(long.metrics.fundingPnl + short.metrics.fundingPnl) < 0.01);
check("perpetual long has no borrow charge", long.metrics.borrowCost === 0);
check("perpetual short has no stock-style borrow charge", short.metrics.borrowCost === 0);
check("funding affects final equity", long.metrics.finalEquity < 100 && short.metrics.finalEquity > 100);

console.log(JSON.stringify({
  long: {
    finalEquity: long.metrics.finalEquity,
    fundingPnl: long.metrics.fundingPnl,
    borrowCost: long.metrics.borrowCost,
  },
  short: {
    finalEquity: short.metrics.finalEquity,
    fundingPnl: short.metrics.fundingPnl,
    borrowCost: short.metrics.borrowCost,
  },
}, null, 2));

process.exit(failures ? 1 : 0);
