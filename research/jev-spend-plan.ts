import { defaultFeatureConfig } from "./features";
import { buildPortfolioFeatureStates } from "./portfolio-features";
import { chronologicalRanges } from "./splits";
import { alignUniverse, loadUniverse } from "./universe";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const prefix = "--" + name + "=";
  const hit = args.find((x) => x.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
};
const manifest = args.find((x) => !x.startsWith("--"));
if (!manifest) {
  console.error("usage: bun run research/jev-spend-plan.ts universe.json --horizon=8 --decision-every=8");
  process.exit(1);
}

const horizonBars = Math.max(1, Number(flag("horizon", "8")));
const decisionEveryBars = Math.max(1, Number(flag("decision-every", "8")));
const assumedTokensPerRequest = Math.max(1, Number(flag("tokens-per-request", "1500")));
const usdPerMTok = Number(flag("usd-per-mtok", "0.042"));
const assets = alignUniverse(loadUniverse(manifest));
const ranges = chronologicalRanges(assets[0]!.bars);
const cfg = {
  ...defaultFeatureConfig,
  horizonBars,
  directionThresholdBpsFloor: Number(flag("direction-threshold-bps-floor", "1")),
  directionThresholdFixedCostBps: Number(flag("direction-threshold-fixed-cost-bps", "10")),
};
const series = assets.map((asset) => ({ symbol: asset.spec.symbol, bars: asset.bars }));

function count(range: { start: number; end: number }) {
  let requests = 0;
  const first = Math.max(cfg.minHistoryBars, range.start);
  for (let i = first; i + horizonBars < range.end; i += decisionEveryBars) {
    requests += buildPortfolioFeatureStates(series, i, cfg).size;
  }
  return requests;
}

const rows = [
  { name: "train", requests: count(ranges.train) },
  { name: "validation", requests: count(ranges.validation) },
  { name: "sealed-test", requests: count(ranges.test) },
];
for (const row of rows) {
  const tokens = row.requests * assumedTokensPerRequest;
  const usd = tokens / 1_000_000 * usdPerMTok;
  console.log(
    row.name +
    " · requests " + row.requests +
    " · assumed tokens " + tokens +
    " · projected $" + usd.toFixed(4)
  );
}

const developmentRequests = rows[0]!.requests + rows[1]!.requests;
const developmentTokens = developmentRequests * assumedTokensPerRequest;
const allRequests = rows.reduce((s, x) => s + x.requests, 0);
const allTokens = allRequests * assumedTokensPerRequest;

console.log("");
console.log("FIXED-APPARATUS SPEND PLAN, NO API CALLS MADE");
console.log("symbols " + assets.map((a) => a.spec.symbol).join(","));
console.log("horizon " + horizonBars + " · decision every " + decisionEveryBars + " bar(s)");
console.log("assumption " + assumedTokensPerRequest + " input tokens/request at $" + usdPerMTok + "/MTok");
console.log("development total · requests " + developmentRequests + " · projected $" + (developmentTokens / 1_000_000 * usdPerMTok).toFixed(4));
console.log("development + sealed · requests " + allRequests + " · projected $" + (allTokens / 1_000_000 * usdPerMTok).toFixed(4));
console.log("This is a planning ceiling only. Before any larger batch, reconcile the provider dashboard after the 12-request probe.");
