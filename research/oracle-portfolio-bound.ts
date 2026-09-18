import { replayPortfolio } from "./portfolio";
import { chronologicalRanges } from "./splits";
import type { Direction, FeatureState, JevSignal, Magnitude, SignalEvaluator } from "./types";
import { alignUniverse, loadUniverse } from "./universe";

class PortfolioOracleEvaluator implements SignalEvaluator {
  readonly name: string;
  private indexBySymbolTs = new Map<string, Map<number, number>>();

  constructor(
    private assets: ReturnType<typeof alignUniverse>,
    private horizonBars: number,
  ) {
    this.name = "diagnostic-portfolio-oracle-v1-h" + horizonBars;
    for (const asset of assets) {
      this.indexBySymbolTs.set(
        asset.spec.symbol,
        new Map(asset.bars.map((b, i) => [b.ts, i])),
      );
    }
  }

  async evaluate(state: FeatureState): Promise<JevSignal> {
    const asset = this.assets.find((a) => a.spec.symbol === state.symbol);
    const i = this.indexBySymbolTs.get(state.symbol)?.get(state.ts);
    if (!asset || i === undefined) throw new Error("oracle state missing from aligned universe");
    const future = asset.bars[i + this.horizonBars];
    if (!future) throw new Error("oracle future unavailable");
    const retBps = (future.close / state.price - 1) * 10_000;
    const abs = Math.abs(retBps);
    const t = state.directionThresholdBps;
    const direction: Direction = retBps > t ? "long" : retBps < -t ? "short" : "flat";
    const magnitude: Magnitude = abs <= t ? "tiny" : abs <= 2 * t ? "small" : abs <= 4 * t ? "medium" : "large";
    const dp = { long: 0.005, flat: 0.005, short: 0.005 };
    dp[direction] = 0.99;
    const mp = { tiny: 0.005, small: 0.005, medium: 0.005, large: 0.005 };
    mp[magnitude] = 0.985;
    return {
      version: "portfolio-oracle-v1",
      model: this.name,
      direction: { choice: direction, probabilities: dp },
      magnitude: { choice: magnitude, probabilities: mp },
      adverseSelection: 0.01,
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
const manifest = args.find((x) => !x.startsWith("--"));
if (!manifest) {
  console.error("usage: bun run research/oracle-portfolio-bound.ts universe.json --horizons=2,4,8 --split=dev");
  process.exit(1);
}

const assets = alignUniverse(loadUniverse(manifest));
const bars = assets[0]!.bars;
const ranges = chronologicalRanges(bars);
const splitName = flag("split", "dev")!;
const allowTest = flag("allow-test", "false") === "true";
let range: { start: number; end: number };
if (splitName === "train") range = ranges.train;
else if (splitName === "validation") range = ranges.validation;
else if (splitName === "dev") range = { start: ranges.train.start, end: ranges.validation.end };
else if (splitName === "test") {
  if (!allowTest) throw new Error("oracle refuses sealed test; pass --allow-test=true only after the apparatus is frozen");
  range = ranges.test;
} else throw new Error("unknown --split=" + splitName);

const horizons = (flag("horizons", "2,4,8,12") ?? "2,4,8,12")
  .split(",").map((x) => Number(x.trim())).filter((x, i, a) => Number.isFinite(x) && x > 0 && a.indexOf(x) === i);
const decisionEveryBars = Math.max(1, Number(flag("decision-every", "4")));
const feeBps = Number(flag("fee-bps", "4"));
const slippageBps = Number(flag("slippage-bps", "1"));
const spreadBps = Number(flag("spread-bps", "4"));
const allowShort = flag(
  "allow-short",
  assets.every((a) => a.spec.kind === "perp") ? "true" : "false",
) !== "false";
const directionThresholdFixedCostBps = Number(flag(
  "direction-threshold-fixed-cost-bps",
  String(2 * feeBps + 2 * slippageBps),
));

for (const horizonBars of horizons) {
  const result = await replayPortfolio(assets, {
    evaluator: new PortfolioOracleEvaluator(assets, horizonBars),
    startIndex: Math.max(50, range.start),
    endIndex: range.end - horizonBars - 1,
    decisionEveryBars,
    topN: Math.max(1, Number(flag("top-n", "2"))),
    maxGrossExposure: Number(flag("max-gross", "1")),
    maxAssetExposure: Number(flag("max-asset", "0.5")),
    features: {
      horizonBars,
      directionThresholdBpsFloor: Number(flag("direction-threshold-bps-floor", "1")),
      directionThresholdFixedCostBps,
    },
    execution: {
      initialCash: Number(flag("cash", "100")),
      feeBps,
      slippageBps,
      spreadBpsFallback: spreadBps,
      allowShort,
      shortBorrowBpsPerDay: Number(flag("short-borrow-bps-day", "1")),
    },
    policy: {
      minDirectionalEdge: 0,
      minDirectionalConfidence: 0,
      maxAdverseSelection: 1,
      minExpectedMoveCostMultiple: Number(flag("cost-multiple", "1.25")),
      flatExitProbability: 0.5,
    },
  });

  console.log("PERFECT-FORESIGHT PORTFOLIO DIAGNOSTIC, NOT A TRADABLE MODEL");
  console.log(
    "split " + splitName +
    " · horizon " + horizonBars +
    " bars · every " + decisionEveryBars +
    " · symbols " + result.symbols.join(",")
  );
  console.log(
    "P&L $" + result.pnl.toFixed(2) +
    " · return " + result.returnPct.toFixed(2) + "%" +
    " · max DD " + result.maxDrawdownPct.toFixed(2) + "%"
  );
  console.log(
    "turnover " + result.turnover.toFixed(1) +
    "x · fills " + result.fills.length +
    " · fees $" + result.fees.toFixed(4) +
    " · funding net $" + result.fundingNet.toFixed(4)
  );
  console.log("");
}
