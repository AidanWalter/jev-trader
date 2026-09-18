import { MockReplayEvaluator } from "./evaluator";
import { replayBars } from "./replay";
import type { MarketBar } from "./types";

function syntheticBars(n = 700): MarketBar[] {
  const out: MarketBar[] = [];
  let price = 100;
  let ts = Date.UTC(2025, 0, 1);
  for (let i = 0; i < n; i++) {
    const regime = i < 220 ? 0.0012 : i < 430 ? -0.0009 : 0.0005;
    const cyc = Math.sin(i / 11) * 0.0015;
    const ret = regime + cyc;
    const open = price;
    const close = Math.max(1, open * (1 + ret));
    const high = Math.max(open, close) * 1.001;
    const low = Math.min(open, close) * 0.999;
    out.push({
      ts,
      symbol: "SYNTH",
      kind: "spot",
      open,
      high,
      low,
      close,
      volume: 1000 + (i % 17) * 30,
      spreadBps: 2,
    });
    price = close;
    ts += 5 * 60_000;
  }
  return out;
}

const bars = syntheticBars();
const evaluator = new MockReplayEvaluator();
const result = await replayBars(bars, {
  evaluator,
  execution: { feeBps: 1, slippageBps: 0.5, spreadBpsFallback: 2, initialCash: 100 },
});

let failures = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failures++;
};

check("replay produced decisions", result.decisions.length > 100);
check("every fill executes after its decision", result.decisions.every((d) => !d.fill || d.fill.executionTs > d.fill.decisionTs));
check("equity is finite", result.equity.every((e) => Number.isFinite(e.equity) && Number.isFinite(e.cash) && Number.isFinite(e.quantity)));
check("metrics are finite where required", [
  result.metrics.finalEquity,
  result.metrics.pnl,
  result.metrics.returnPct,
  result.metrics.maxDrawdownPct,
  result.metrics.turnover,
  result.metrics.fees,
].every(Number.isFinite));
check("initial bankroll is preserved in metrics", result.metrics.initialEquity === 100);
check("some orders were generated", result.metrics.orders > 0);

console.log(JSON.stringify(result.metrics, null, 2));
process.exit(failures ? 1 : 0);
