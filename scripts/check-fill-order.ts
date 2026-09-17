// Deterministic regression check for the fill/block ordering race in src/trader.ts.
// The trade poll resolves while model inference is still in flight. The fill must be attached to
// its own block event and the fill callback must fire only after that block event is published.
import { Trader } from "../src/trader";
import type { Book, Fill, Quote } from "../src/market";
import type { Decision, TradeState } from "../src/model";

const log: string[] = [];
const seen: Record<number, { hasFill: boolean; size: number }> = {};

const book = (block: number, mid: number): Book => ({
  block, bid: mid - 0.000001, ask: mid + 0.000001, mid, spreadBps: 0.89, imbalance: 0,
  levels: { bids: [], asks: [] }, depthBps: {},
});

const market = {
  wallet: null,
  margin: { mon: 0, usdc: 0 },
  address: null,
  params: { sizePrecision: { toString: () => "10000000000" }, pricePrecision: { toString: () => "100000000" }, tickSize: { toString: () => "100" } },
  readBook: async () => book(currentBlock, 0.0225),
  send: async (block: number, side: "buy" | "sell", size: number, b: Book): Promise<Quote> => ({
    side, price: side === "buy" ? b.bid : b.ask, size, txHash: null, gasMon: 0, cancel: [], status: "sim", orderId: null, capped: false,
  }),
  pollPending: async () => [],
  refresh: async () => {},
};

const model = {
  name: "fake",
  decide: async (_s: TradeState): Promise<Decision> => {
    await Bun.sleep(30);
    return { action: "buy", probabilities: { buy: 0.8, sell: 0.2, hold: 0 }, upIn10: 0.8, bigMove: 0.2, latencyMs: 30, inputTokens: 0 };
  },
};

let currentBlock = 9;
const printsFor: Record<number, { block: number; price: number; size: number; side: "buy" | "sell" }[]> = {
  10: [{ block: 10, price: 0.022498, size: 200, side: "sell" }],
};
const feed = {
  poll: async () => {},
  drainPrints: () => printsFor[currentBlock] ?? [],
  drainFills: () => [] as never[],
  summary: () => ({ count: 0, buyMon: 0, sellMon: 0, cvdMon: 0, vwap: null, lastPrice: null, lastSide: null }),
  recent: () => [],
};

const trader = new Trader(market as never, model as never,
  (e) => {
    const f = e.fill as Fill | null;
    seen[e.block] = { hasFill: !!f, size: f?.size ?? 0 };
    log.push(`block:${e.block}:fill=${f ? f.size : "null"}`);
  },
  (block, fill) => { log.push(`fill:${block}:${fill.size}`); },
);
(trader as never as { trades: unknown }).trades = feed;

currentBlock = 9; await trader.onBlock(9);
currentBlock = 10; await trader.onBlock(10);

const ok = (label: string, cond: boolean) => console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
console.log("call order:", log.join(" | "));
ok("fill is attached to its own block event", seen[10]?.hasFill === true && seen[10]?.size === 200);
ok("fill callback follows block callback", log.indexOf("block:10:fill=200") < log.indexOf("fill:10:200"));
ok("no fill leaks onto the previous block", seen[9]?.hasFill === false);
process.exit(log.indexOf("fill:10:200") > log.indexOf("block:10:fill=200") && seen[10]?.hasFill ? 0 : 1);
