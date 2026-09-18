import { extname } from "node:path";
import { loadBarsCsv, loadBarsJsonl } from "./csv";
import { replayBars } from "./replay";
import type { AssetKind, Direction, FeatureState, JevSignal, Magnitude, MarketBar, SignalEvaluator } from "./types";

class OracleEvaluator implements SignalEvaluator {
  readonly name = "diagnostic-oracle-v1";
  private byTs = new Map<number, number>();

  constructor(private bars: MarketBar[], private horizonBars: number) {
    for (let i = 0; i < bars.length; i++) this.byTs.set(bars[i]!.ts, i);
  }

  async evaluate(state: FeatureState): Promise<JevSignal> {
    const i = this.byTs.get(state.ts);
    if (i === undefined) throw new Error("oracle state timestamp missing from bars");
    const future = this.bars[i + this.horizonBars];
    if (!future) throw new Error("oracle future bar unavailable");
    const retBps = (future.close / state.price - 1) * 10_000;
    const abs = Math.abs(retBps);
    const t = state.directionThresholdBps;
    const direction: Direction = retBps > t ? "long" : retBps < -t ? "short" : "flat";
    const magnitude: Magnitude = abs <= t ? "tiny" : abs <= 2 * t ? "small" : abs <= 4 * t ? "medium" : "large";
    const dp = { long: 0.005, flat: 0.005, short: 0.005 };
    dp[direction] = 0.99;
    const mp = { tiny: 0.005, small: 0.005, medium: 0.005, large: 0.005 };
    mp[magnitude] = 0.985;

    const next = this.bars[i + 1];
    let adverse = false;
    if (next && direction !== "flat") {
      const nextRet = (next.close / next.open - 1) * 10_000;
      adverse = direction === "long" ? nextRet < -state.spreadBps : nextRet > state.spreadBps;
    }

    return {
      version: "oracle-v1",
      model: this.name,
      direction: { choice: direction, probabilities: dp },
      magnitude: { choice: magnitude, probabilities: mp },
      adverseSelection: adverse ? 0.99 : 0.01,
      latencyMs: 0,
      inputTokens: 0,
    };
  }
}

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const prefix = "--" + name + "=";
  const hit = args.find((x) => x.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
};
const file = args.find((x) => !x.startsWith("--"));
if (!file) {
  console.error("usage: bun run research/oracle-bound.ts data.csv --symbol=BTCUSDT --kind=spot");
  process.exit(1);
}

const symbol = flag("symbol", "UNKNOWN")!;
const kind = flag("kind", "spot") as AssetKind;
const horizons = (flag("horizons", flag("horizon", "12")) ?? "12")
  .split(",")
  .map((x) => Math.max(1, Number(x.trim())))
  .filter((x, i, a) => Number.isFinite(x) && a.indexOf(x) === i);
const spreadBps = Number(flag("spread-bps", kind === "stock" ? "2" : "4"));
const feeBps = Number(flag("fee-bps", kind === "stock" ? "1" : "4"));
const slippageBps = Number(flag("slippage-bps", "1"));
const directionThresholdBpsFloor = Number(flag("direction-threshold-bps-floor", "1"));
const directionThresholdFixedCostBps = Number(flag(
  "direction-threshold-fixed-cost-bps",
  String(2 * slippageBps + 2 * feeBps),
));
const bars = extname(file).toLowerCase() === ".jsonl"
  ? loadBarsJsonl(file)
  : loadBarsCsv(file, { symbol, kind, defaultSpreadBps: spreadBps });

for (const horizonBars of horizons) {
  const result = await replayBars(bars, {
    evaluator: new OracleEvaluator(bars, horizonBars),
    features: { horizonBars, directionThresholdBpsFloor, directionThresholdFixedCostBps },
    endIndex: bars.length - horizonBars - 1,
    decisionEveryBars: Math.max(1, Number(flag("decision-every", "4"))),
    execution: {
      initialCash: Number(flag("cash", "100")),
      feeBps,
      slippageBps,
      spreadBpsFallback: spreadBps,
      allowShort: flag("allow-short", "true") !== "false",
    },
    policy: {
      minDirectionalEdge: 0,
      minDirectionalConfidence: 0,
      maxAdverseSelection: 1,
      flatExitProbability: 0.5,
      minExpectedMoveCostMultiple: Number(flag("cost-multiple", "1.25")),
    },
  });

  const m = result.metrics;
  console.log("PERFECT-FORESIGHT DIAGNOSTIC, NOT A TRADABLE MODEL");
  console.log(symbol + " · horizon " + horizonBars + " bars");
  console.log("P&L $" + m.pnl.toFixed(2) + " · return " + m.returnPct.toFixed(2) + "% · buy/hold " + m.buyHoldReturnPct.toFixed(2) + "%");
  console.log("max DD " + m.maxDrawdownPct.toFixed(2) + "% · turnover " + m.turnover.toFixed(1) + "x · fees $" + m.fees.toFixed(4));
  console.log("orders " + m.orders + " · round trips " + m.roundTrips + " · wins " + m.wins + " · losses " + m.losses);
  console.log("");
}