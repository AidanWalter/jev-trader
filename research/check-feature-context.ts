import { defaultFeatureConfig } from "./features";
import { buildPortfolioFeatureStates } from "./portfolio-features";
import { projectState } from "./profiles";
import type { MarketBar } from "./types";

function series(symbol: string, drift: number, funding = false): MarketBar[] {
  const out: MarketBar[] = [];
  let price = 100;
  const start = Date.UTC(2025, 0, 1);
  for (let i = 0; i < 100; i++) {
    const ret = drift + Math.sin(i / 7) * 0.0008;
    const open = price;
    const close = open * (1 + ret);
    out.push({
      ts: start + i * 15 * 60_000,
      symbol,
      kind: funding ? "perp" : "spot",
      open,
      high: Math.max(open, close) * 1.001,
      low: Math.min(open, close) * 0.999,
      close,
      volume: 1000 + i * 3,
      spreadBps: 3,
      fundingBps: funding && i === 56 ? 1.25 : 0,
    });
    price = close;
  }
  return out;
}

const cfg = { ...defaultFeatureConfig, horizonBars: 12 };
const baseSeries = [
  { symbol: "AAA", bars: series("AAA", 0.0010, true) },
  { symbol: "BBB", bars: series("BBB", 0.0002, true) },
  { symbol: "CCC", bars: series("CCC", -0.0007, true) },
];
const index = 60;
const states = buildPortfolioFeatureStates(baseSeries, index, cfg);
const aaa = states.get("AAA");
if (!aaa) throw new Error("AAA state missing");

const mutated = baseSeries.map((s) => ({
  symbol: s.symbol,
  bars: s.bars.map((b, i) => i <= index ? { ...b } : {
    ...b,
    close: b.close * (s.symbol === "AAA" ? 4 : 0.25),
    high: b.high * 5,
    low: b.low * 0.2,
    volume: b.volume * 100,
  }),
}));
const futureMutated = buildPortfolioFeatureStates(mutated, index, cfg).get("AAA");
if (!futureMutated) throw new Error("future-mutated AAA state missing");

const minimal = projectState(aaa, "minimal") as Record<string, unknown>;
const lean = projectState(aaa, "lean") as Record<string, unknown>;
const technical = projectState(aaa, "technical") as Record<string, unknown>;
const path = projectState(aaa, "path") as Record<string, unknown>;
const cross = projectState(aaa, "cross") as Record<string, unknown>;
const full = projectState(aaa, "full") as Record<string, unknown>;

let failures = 0;
const check = (name: string, ok: boolean) => {
  console.log((ok ? "ok  " : "FAIL") + " " + name);
  if (!ok) failures++;
};

check("market context exists for synchronized portfolio states", !!aaa.marketContext);
check("context universe size is correct", aaa.marketContext?.universeSize === 3);
check("relative momentum distinguishes the strongest asset", (aaa.marketContext?.relativeR12Bps ?? 0) > 0);
check("recent funding is point-in-time visible", aaa.lastFundingBps === 1.25 && aaa.barsSinceFunding === 4);

check("minimal excludes funding", !("fundingBps" in minimal) && !("lastFundingBps" in minimal));
check("lean excludes raw price and timestamp", !("price" in lean) && !("ts" in lean));
check("lean keeps compact cross-sectional context", "marketContext" in lean);
check("lean excludes recent return path", !("recentReturnsBps" in lean));
check("technical includes perp funding", "fundingBps" in technical && "lastFundingBps" in technical);
check("technical excludes path and cross context", !("recentReturnsBps" in technical) && !("marketContext" in technical));
check("path adds recent return path only", "recentReturnsBps" in path && !("marketContext" in path));
check("cross adds market context without recent path", "marketContext" in cross && !("recentReturnsBps" in cross));
check("full combines path and market context", "marketContext" in full && "recentReturnsBps" in full);

check(
  "future bars cannot change current synchronized state",
  JSON.stringify(aaa) === JSON.stringify(futureMutated),
);

const contextSymbols = [...states.keys()].sort();
check("all synchronized symbols receive states", contextSymbols.join(",") === "AAA,BBB,CCC");

console.log(JSON.stringify({
  context: aaa.marketContext,
  funding: {
    fundingBps: aaa.fundingBps,
    lastFundingBps: aaa.lastFundingBps,
    barsSinceFunding: aaa.barsSinceFunding,
  },
  projectedKeys: {
    minimal: Object.keys(minimal).sort(),
    lean: Object.keys(lean).sort(),
    technical: Object.keys(technical).sort(),
    path: Object.keys(path).sort(),
    cross: Object.keys(cross).sort(),
    full: Object.keys(full).sort(),
  },
}, null, 2));

process.exit(failures ? 1 : 0);
