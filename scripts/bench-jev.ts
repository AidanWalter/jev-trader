/**
 * Measures Jev inference latency and cost for two payload shapes:
 *
 *   full     what `Trader.buildState` sends today (depth, top-5 book, sampled mids, recent prints)
 *   minimal  mid, spread, imbalance, a couple of returns, allowed sides
 *
 * A decision and an order have to fit in one ~300 ms Monad block. If `full` p50 is above the
 * block time, trimming the payload (or colocating the bot with the API) is the fix, not the RPC.
 *
 *   bun run scripts/bench-jev.ts [iterations]
 */
import { JevModel, type TradeState } from "../src/model";
import { config } from "../src/config";

const iterations = Number(process.argv[2] ?? 5);

const shape: Omit<TradeState, "allowed"> = {
  market: "MON-USDC",
  block: 105_711_000,
  horizonBlocks: config.horizonBlocks,
  blockMs: 300,
  mid: 0.023093,
  spreadBps: 6.93,
  bookImbalance: -0.08,
  depth: { "10bps": { bid: 4820.5, ask: 5130.2 }, "25bps": { bid: 9920.0, ask: 10440.7 }, "50bps": { bid: 15110.3, ask: 16002.9 } },
  book: {
    bids: ["0.023093 x 1200.0", "0.023092 x 980.4", "0.023091 x 2210.7", "0.023090 x 640.1", "0.023089 x 3300.0"],
    asks: ["0.023094 x 1105.2", "0.023095 x 880.9", "0.023096 x 1990.5", "0.023097 x 725.3", "0.023098 x 2870.6"],
  },
  returnsBps: { last1: 0.13, last5: -0.26, last20: 0.42, last100: -0.9 },
  recentMids: Array.from({ length: 20 }, (_, i) => (0.023093 + (i % 5) * 0.000001).toFixed(6)).join(" "),
  trades: { count: 37, buyMon: 14820.0, sellMon: 17330.5, cvdMon: -2510.5, vwap: 0.02309, lastPrice: 0.023094, lastSide: "buy" },
  recentTrades: Array.from({ length: 10 }, (_, i) => `${105_710_990 + i * 3} ${i % 3 === 0 ? "sell" : "buy"} ${200 + i * 5} @ 0.02309${i}`),
};

const full: TradeState = { ...shape, allowed: { buy: true, sell: true } };
const minimal: TradeState = {
  market: "MON-USDC",
  block: shape.block,
  horizonBlocks: shape.horizonBlocks,
  blockMs: shape.blockMs,
  mid: shape.mid,
  spreadBps: shape.spreadBps,
  bookImbalance: shape.bookImbalance,
  depth: shape.depth,
  book: shape.book,
  returnsBps: shape.returnsBps,
  recentMids: shape.recentMids,
  trades: shape.trades,
  recentTrades: shape.recentTrades,
  allowed: { buy: true, sell: true },
};
// The minimal payload keeps only what the question text actually points at.
const trimmed: TradeState = {
  market: "MON-USDC",
  block: shape.block,
  horizonBlocks: shape.horizonBlocks,
  blockMs: shape.blockMs,
  mid: shape.mid,
  spreadBps: shape.spreadBps,
  bookImbalance: shape.bookImbalance,
  depth: { "25bps": shape.depth["25bps"]! },
  book: { bids: shape.book.bids.slice(0, 3), asks: shape.book.asks.slice(0, 3) },
  returnsBps: { last1: shape.returnsBps.last1, last5: shape.returnsBps.last5, last20: shape.returnsBps.last20, last100: shape.returnsBps.last100 },
  recentMids: shape.recentMids.split(" ").slice(-10).join(" "),
  trades: shape.trades,
  recentTrades: shape.recentTrades.slice(-5),
  allowed: { buy: true, sell: true },
};

const model = new JevModel();
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return { p50: s[Math.floor(s.length / 2)]!, min: s[0]!, max: s.at(-1)!, mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length) };
};

for (const [name, state] of [["full", full], ["trimmed", trimmed]] as const) {
  const bytes = Buffer.byteLength(JSON.stringify(state));
  const lat: number[] = [];
  const calls: { ms: number; tokens: number; action: string; buy: number; sell: number }[] = [];
  for (let i = 0; i < iterations; i++) {
    try {
      const d = await model.decide({ ...state, block: state.block + i });
      lat.push(d.latencyMs);
      calls.push({ ms: Math.round(d.latencyMs), tokens: d.inputTokens, action: d.action, buy: d.probabilities.buy, sell: d.probabilities.sell });
    } catch (e) {
      console.error(`${name} #${i}: ${(e as Error).message}`);
    }
  }
  const s = stats(lat);
  const tokens = calls.reduce((a, c) => a + c.tokens, 0) / (calls.length || 1);
  const usd = (tokens / 1e6) * config.jevUsdPerMTok;
  console.log(`${name.padEnd(8)} ${String(bytes).padStart(5)} B  p50 ${s.p50} ms  min ${s.min}  max ${s.max}  mean ${s.mean}  ~${Math.round(tokens)} tok  $${usd.toFixed(6)} per call`);
  for (const c of calls) console.log(`   ${c.ms} ms  ${c.action}  b${(c.buy * 100).toFixed(0)} s${(c.sell * 100).toFixed(0)}  ${c.tokens} tok`);
}
