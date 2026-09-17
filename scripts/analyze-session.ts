/**
 * Analyses a collected session: does the model have an edge, and at which horizon?
 *
 * The bot asks Jev about a fixed horizon (100 blocks by default) but replaces its order every
 * block, so the question and the trade live on different clocks. This script scores the same
 * decisions over several horizons at once, next to the two numbers that decide whether any of it
 * can pay: how far the price actually moves (mean absolute move) and how wide the spread is.
 *
 * If the move over the horizon is smaller than the spread, no amount of directional skill survives
 * the cost of crossing. If the called side is not better than always-buy or always-sell, the model
 * is not adding anything the market was not already doing.
 *
 *   bun run scripts/analyze-session.ts [file] [horizons]
 *
 *   bun run scripts/analyze-session.ts data/server-events.jsonl 1,5,10,25,50,100
 */
import { config } from "../src/config";

const file = process.argv[2] ?? "data/server-events.jsonl";
const horizons = (process.argv[3] ?? "1,5,10,25,50,100").split(",").map(Number).filter((h) => h > 0);

interface Event {
  block: number;
  mid: number;
  spreadBps: number;
  decision: { action: "buy" | "sell" | "hold"; probabilities: Record<string, number>; bigMove?: number; late: boolean } | null;
  fill: { side: "buy" | "sell"; size: number; simulated: boolean } | null;
}

const events: Event[] = [];
for (const line of (await Bun.file(file).text()).split("\n")) {
  if (!line.trim()) continue;
  try {
    events.push(JSON.parse(line) as Event);
  } catch {
    // a partial last line from a script that is still writing is safe to skip
  }
}
events.sort((a, b) => a.block - b.block);
if (events.length < 10) {
  console.error(`not enough events in ${file}`);
  process.exit(1);
}

/** Runs are separated by big gaps: a container restart, or two sessions in one file. */
const runs: Event[][] = [];
for (const e of events) {
  const cur = runs.at(-1);
  if (!cur || e.block - cur.at(-1)!.block > 60) runs.push([e]);
  else cur.push(e);
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (x: number) => `${x.toFixed(0)}%`;
const bps = (x: number) => x.toFixed(2).padStart(7);

const decided = events.filter((e) => e.decision && !e.decision.late);
const late = events.length - decided.length;
const span = events.at(-1)!.block - events[0]!.block + 1;
const minutes = span / 200; // 200 blocks per minute at 300 ms each

console.log(`${file}`);
console.log(`${events.length} events · ${runs.length} run(s) · ${span} blocks (~${minutes.toFixed(0)} min) · ${decided.length} decisions · ${late} late (${pct((late / events.length) * 100)})`);
console.log(`calls: buy ${decided.filter((e) => e.decision!.action === "buy").length} · sell ${decided.filter((e) => e.decision!.action === "sell").length}`);
console.log(`spread: mean ${mean(decided.map((e) => e.spreadBps)).toFixed(2)} bps · median ${[...decided.map((e) => e.spreadBps)].sort((a, b) => a - b)[Math.floor(decided.length / 2)]?.toFixed(2)} bps`);
console.log(`fills recorded: ${events.filter((e) => e.fill).length} (simulated in a dry run: optimistic, they ignore the queue)\n`);

console.log(`horizon   scored   flat   right   right when it moved   called bps   always buy   mean |move|   move / spread`);
for (const h of horizons) {
  const rows: { call: number; move: number }[] = [];
  for (const e of decided) {
    const target = e.block + h;
    const later = events.find((x) => x.block >= target);
    if (!later) continue;
    const move = ((later.mid - e.mid) / e.mid) * 10_000;
    rows.push({ call: e.decision!.action === "buy" ? move : -move, move });
  }
  if (!rows.length) continue;
  // A window where the mid did not move at all is not a directional call that was wrong: it is a
  // window with nothing to call. Counting those as misses is what makes short horizons look awful.
  const flat = rows.filter((r) => r.move === 0).length;
  const moved = rows.filter((r) => r.move !== 0);
  const right = rows.filter((r) => r.call > 0).length;
  const rightWhenMoved = moved.filter((r) => r.call > 0).length;
  const absMove = mean(rows.map((r) => Math.abs(r.move)));
  const spread = mean(decided.map((e) => e.spreadBps));
  const h_ = String(h).padStart(6);
  console.log(
    `${h_} ${String(rows.length).padStart(8)} ${pct((flat / rows.length) * 100).padStart(5)} ${pct((right / rows.length) * 100).padStart(6)}   ${pct((rightWhenMoved / Math.max(1, moved.length)) * 100).padStart(18)}   ${bps(mean(rows.map((r) => r.call)))}     ${bps(mean(rows.map((r) => r.move)))}       ${bps(absMove)}        ${(absMove / spread).toFixed(2)}x`,
  );
}

const gasBpsPerBlock = ((config.gasLimit ?? config.gasLimitFallback) * (100 + config.priorityFeeGwei) * 1e-9 * config.tradeSizeMon === 0)
  ? 0
  : ((config.gasLimit ?? config.gasLimitFallback) * (100 + config.priorityFeeGwei) * 1e-9) / config.tradeSizeMon * 10_000;
console.log(`\ngas per posted order: ${gasBpsPerBlock.toFixed(2)} bps of a ${config.tradeSizeMon} MON order (projected; a dry run pays none)`);
console.log(`round trip capture: spread - 2 ticks = ${(mean(decided.map((e) => e.spreadBps)) - 0.87).toFixed(2)} bps, against ${(gasBpsPerBlock * 2).toFixed(2)} bps of gas for the two blocks it takes`);

// ---------------------------------------------------------------------------------------------
// The adverse selection question: does the model know when a big move is coming?

const withSignal = decided.filter((e) => typeof e.decision!.bigMove === "number" && e.decision!.bigMove! > 0);
if (!withSignal.length) {
  console.log(`\nno bigMove answers in this file: it was recorded by a build before the question existed`);
  process.exit(0);
}

const horizon = horizons.includes(100) ? 100 : horizons.at(-1)!;
const buckets2: [string, number, number][] = [["<30%", 0, 0.3], ["30-40%", 0.3, 0.4], ["40-50%", 0.4, 0.5], ["50-60%", 0.5, 0.6], [">60%", 0.6, 1.01]];
console.log(`\nwhen it says a move bigger than the spread is coming (horizon ${horizon} blocks):`);
console.log(`bucket     answers   mean |move|   move > spread   spread at the time`);
for (const [label, lo, hi] of buckets2) {
  const rows = withSignal.filter((e) => e.decision!.bigMove! >= lo && e.decision!.bigMove! < hi);
  if (!rows.length) continue;
  const outcomes = rows.map((e) => {
    const later = events.find((x) => x.block >= e.block + horizon);
    return later ? Math.abs((later.mid - e.mid) / e.mid) * 10_000 : null;
  }).filter((x): x is number => x !== null);
  if (!outcomes.length) continue;
  const exceeded = outcomes.filter((m, i) => m > rows[i]!.spreadBps).length;
  console.log(`${label.padEnd(9)} ${String(rows.length).padStart(7)}   ${bps(mean(outcomes))}        ${pct((exceeded / outcomes.length) * 100).padStart(6)}          ${bps(mean(rows.map((e) => e.spreadBps)))}`);
}
console.log(`\nbaseline: over every decision, ${pct((withSignal.filter((e) => {
  const later = events.find((x) => x.block >= e.block + horizon);
  return later ? Math.abs((later.mid - e.mid) / e.mid) * 10_000 > e.spreadBps : false;
}).length / withSignal.length) * 100)} of windows moved further than the spread`);
