/**
 * Asks Jev the same question on synthetic markets that differ only in how strong the trend is: one
 * clearly rising, one clearly falling, one flat, plus two mild cases in between. The answers say
 * whether the model reads the data or just repeats a habit, and they are the before/after yardstick
 * for any change to the question text in `src/model.ts`.
 *
 *   bun run scripts/probe-jev-bias.ts [repetitions]
 */
import { JevModel, type TradeState } from "../src/model";
import { config } from "../src/config";

const reps = Number(process.argv[2] ?? 3);

/** t = strength, -1 (clearly falling) .. 1 (clearly rising). 0 is flat. */
function state(t: number): TradeState {
  const dir = t === 0 ? 0 : t > 0 ? 1 : -1;
  const abs = Math.abs(t);
  const depth = (bid: number, ask: number) => ({ "10bps": { bid, ask }, "25bps": { bid: bid * 2, ask: ask * 2 }, "50bps": { bid: bid * 3, ask: ask * 3 } });
  const balanced = 5000 + abs * 0;
  const heavy = 5000 + abs * 4000;
  const light = 5000 - abs * 3800;
  const flow = 22000 * abs;
  return {
    market: "MON-USDC",
    block: 105_715_000,
    horizonBlocks: config.horizonBlocks,
    blockMs: 300,
    mid: 0.0231,
    spreadBps: 3.5,
    bookImbalance: dir * 0.55 * abs,
    depth: dir === 1 ? depth(heavy, light) : dir === -1 ? depth(light, heavy) : depth(balanced, balanced),
    book: dir === 1
      ? { bids: ["0.023100 x 1400", "0.023099 x 1200", "0.023098 x 900"], asks: ["0.023101 x 120", "0.023102 x 90", "0.023103 x 60"] }
      : dir === -1
        ? { bids: ["0.023100 x 120", "0.023099 x 90", "0.023098 x 60"], asks: ["0.023101 x 1400", "0.023102 x 1200", "0.023103 x 900"] }
        : { bids: ["0.023100 x 800", "0.023099 x 700", "0.023098 x 600"], asks: ["0.023101 x 800", "0.023102 x 700", "0.023103 x 600"] },
    returnsBps: { last1: dir * 1.2 * abs, last5: dir * 6 * abs, last20: dir * 18 * abs, last100: dir * 40 * abs },
    recentMids: Array.from({ length: 20 }, (_, i) => (0.023100 + dir * abs * (i - 10) * 0.000002).toFixed(6)).join(" "),
    // taker flow agrees with the move
    trades: { count: 220, buyMon: flow, sellMon: flow, cvdMon: dir * flow, vwap: 0.0231, lastPrice: 0.0231, lastSide: dir === 1 ? "buy" : "sell" },
    recentTrades: Array.from({ length: 6 }, (_, i) => `${105_714_900 + i * 4} ${dir === -1 ? "sell" : "buy"} ${900 + i * 40} @ 0.0231`),
    allowed: { buy: true, sell: true },
  };
}

const model = new JevModel();
const cases: [string, number][] = [
  ["in salita forte", 1],
  ["in salita piano", 0.25],
  ["piatto", 0],
  ["in discesa piano", -0.25],
  ["in discesa forte", -1],
];

for (const [name, t] of cases) {
  const answers: string[] = [];
  for (let i = 0; i < reps; i++) {
    try {
      const d = await model.decide(state(t));
      answers.push(`${d.action === "buy" ? "COMPRA" : "VENDE"} ${(d.probabilities.buy * 100).toFixed(0)}/${(d.probabilities.sell * 100).toFixed(0)} ${Math.round(d.latencyMs)}ms`);
    } catch (e) {
      answers.push(`errore: ${(e as Error).message.slice(0, 60)}`);
    }
  }
  console.log(`${name.padEnd(18)} ${answers.join("  |  ")}`);
}
