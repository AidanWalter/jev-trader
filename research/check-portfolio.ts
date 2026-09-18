import { MockReplayEvaluator } from "./evaluator";
import { replayPortfolio } from "./portfolio";
import type { MarketBar } from "./types";
import type { LoadedAsset } from "./universe";

function series(symbol: string, phase: number): MarketBar[] {
  const bars: MarketBar[] = [];
  let price = 100 + phase * 5;
  let ts = Date.UTC(2025, 0, 1);
  for (let i = 0; i < 500; i++) {
    const drift = symbol === "AAA" ? 0.0008 : symbol === "BBB" ? -0.0005 : 0.0002;
    const ret = drift + Math.sin(i / (9 + phase)) * 0.0012;
    const open = price;
    const close = Math.max(1, open * (1 + ret));
    bars.push({
      ts,
      symbol,
      kind: "spot",
      open,
      high: Math.max(open, close) * 1.001,
      low: Math.min(open, close) * 0.999,
      close,
      volume: 1000 + ((i + phase) % 13) * 40,
      spreadBps: 2,
    });
    price = close;
    ts += 5 * 60_000;
  }
  return bars;
}

const assets: LoadedAsset[] = ["AAA", "BBB", "CCC"].map((symbol, i) => ({
  spec: { file: "", symbol, kind: "spot", spreadBps: 2 },
  bars: series(symbol, i),
}));

const result = await replayPortfolio(assets, {
  evaluator: new MockReplayEvaluator(),
  policy: { minExpectedMoveCostMultiple: 0 },
  maxGrossExposure: 1,
  maxAssetExposure: 0.5,
  topN: 2,
  execution: { initialCash: 100, feeBps: 1, slippageBps: 0.5, spreadBpsFallback: 2 },
});

let failures = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failures++;
};

check("portfolio produced an equity curve", result.equity.length > 100);
check("portfolio produced fills", result.fills.length > 0);
check("equity remains finite", result.equity.every((x) => Number.isFinite(x.equity) && Number.isFinite(x.cash)));
check("gross exposure respects cap with execution tolerance", result.equity.every((x) => x.grossExposure <= 1.03));
check("no asset exceeds allocation cap with execution tolerance", result.equity.every((x) => Object.values(x.positions).every((p) => Math.abs(p.exposure) <= 0.53)));
check("fills execute on synchronized future timestamps", result.fills.every((f) => f.ts > assets[0]!.bars[50]!.ts));

console.log(JSON.stringify({
  returnPct: result.returnPct,
  maxDrawdownPct: result.maxDrawdownPct,
  turnover: result.turnover,
  fills: result.fills.length,
}, null, 2));
process.exit(failures ? 1 : 0);
