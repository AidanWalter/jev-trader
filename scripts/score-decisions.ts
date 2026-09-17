/**
 * Scores the decisions in `data/events.jsonl` against what the market actually did.
 *
 * Each recorded block event carries the mid at that block and the model's call. For every decided
 * (non-late) block the script looks up the first recorded event at or after `block + horizon` and
 * computes the realized return. Then it answers the only questions that matter for this demo:
 *
 *   hit rate      how often the called direction was the direction price moved
 *   call bps      mean return of taking the called side (before spread and gas)
 *   baselines     always-buy / always-sell over the same windows, for comparison
 *   cost bps      gas per block and the quoted spread, expressed in bps of order notional
 *
 * Blocks with no event (the model was late) leave gaps in the mid series; returns are measured
 * between the recorded events that bracket `block + horizon`, so the horizon can be slightly long.
 *
 *   bun run scripts/score-decisions.ts [horizonBlocks] [file]
 *
 * `file` defaults to `data/events.jsonl` (a local run). Point it at `data/server-events.jsonl` to
 * score what `collect-history.ts` pulled down from a deployed bot.
 */
import { config } from "../src/config";

const horizon = Number(process.argv[2] ?? config.horizonBlocks);
const file = process.argv[3] ?? "data/events.jsonl";

type Action = "buy" | "sell" | "hold";
interface Event {
  block: number;
  mid: number;
  spreadBps: number;
  decision: { action: Action; probabilities: Record<Action, number>; late: boolean } | null;
  totals?: { gasMon: number };
}

const text = await Bun.file(file).text();
const events: Event[] = [];
for (const line of text.split("\n")) {
  if (!line.trim()) continue;
  try {
    events.push(JSON.parse(line) as Event);
  } catch {
    // a partial last line from a running process is fine to skip
  }
}
events.sort((a, b) => a.block - b.block);
if (events.length < 3) {
  console.error(`not enough events in ${file}`);
  process.exit(1);
}

/** Runs are separated by big block gaps (a restart), so old mock data does not pollute the score. */
const runs: Event[][] = [];
for (const e of events) {
  const cur = runs.at(-1);
  if (!cur || e.block - cur.at(-1)!.block > 60) runs.push([e]);
  else cur.push(e);
}

const stats = (xs: number[]) => {
  if (!xs.length) return { n: 0, mean: 0, median: 0, p25: 0, p75: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
  return { n: s.length, mean: s.reduce((a, b) => a + b, 0) / s.length, median: q(0.5), p25: q(0.25), p75: q(0.75) };
};
const f = (x: number) => x.toFixed(3).padStart(9);

console.log(`horizon ${horizon} blocks · ${events.length} events · ${runs.length} run(s)\n`);

for (const [i, run] of runs.entries()) {
  const decided = run.filter((e) => e.decision && !e.decision.late);
  const late = run.length - decided.length;
  if (!decided.length) {
    console.log(`run ${i + 1}: blocks ${run[0]!.block}..${run.at(-1)!.block} (no decisions)\n`);
    continue;
  }

  const calls: { callBps: number; buyBps: number; prob: number }[] = [];
  for (const e of decided) {
    const target = e.block + horizon;
    const later = run.find((x) => x.block >= target);
    if (!later) continue; // horizon has not elapsed yet
    const moveBps = ((later.mid - e.mid) / e.mid) * 10_000;
    const callBps = e.decision!.action === "buy" ? moveBps : -moveBps;
    calls.push({ callBps, buyBps: moveBps, prob: e.decision!.probabilities[e.decision!.action] ?? 0 });
  }

  /** Accuracy by how sure the model said it was. If the buckets all look the same, confidence means nothing. */
  const buckets: [string, number, number][] = [["50-60%", 0.5, 0.6], ["60-70%", 0.6, 0.7], ["70-80%", 0.7, 0.8], ["80-90%", 0.8, 0.9], ["90-100%", 0.9, 1.01]];
  const byConfidence = buckets.map(([label, lo, hi]) => {
    const inBucket = calls.filter((c) => c.prob >= lo && c.prob < hi);
    const right = inBucket.filter((c) => c.callBps > 0).length;
    const mean = inBucket.length ? inBucket.reduce((a, c) => a + c.callBps, 0) / inBucket.length : 0;
    return { label, n: inBucket.length, hit: inBucket.length ? (right / inBucket.length) * 100 : 0, mean };
  }).filter((b) => b.n > 0);

  const buys = decided.filter((e) => e.decision!.action === "buy").length;
  const hits = calls.filter((c) => c.callBps > 0).length;
  const call = stats(calls.map((c) => c.callBps));
  const flat = stats(calls.map((c) => c.buyBps));
  const probs = stats(decided.map((e) => e.decision!.probabilities[e.decision!.action] ?? 0));
  const spreads = stats(decided.map((e) => e.spreadBps));
  // Dry runs record no gas: fall back to the projected cost so the number stays comparable.
  // Monad charges the gas LIMIT, so this is gasLimit x (base + priority), not gasUsed.
  const measuredGas = decided.reduce((a, e) => a + (e.totals?.gasMon ?? 0), 0);
  const projectedGasMon = ((config.gasLimit ?? config.gasLimitFallback) * (100 + config.priorityFeeGwei) * 1e-9);
  const gasMon = measuredGas > 0 ? measuredGas / decided.length : projectedGasMon;
  const gasLabel = measuredGas > 0 ? "measured" : "projected";

  console.log(`run ${i + 1}: blocks ${run[0]!.block}..${run.at(-1)!.block} · ${run.length} events · ${decided.length} decided · ${late} late (${((late / run.length) * 100).toFixed(0)}%)`);
  console.log(`  calls          buy ${buys} (${((buys / decided.length) * 100).toFixed(0)}%) · sell ${decided.length - buys}`);
  console.log(`  called side%   mean ${(probs.mean * 100).toFixed(1)}% · median ${(probs.median * 100).toFixed(1)}%`);
  console.log(`  spread bps     mean ${f(spreads.mean)} · p25 ${f(spreads.p25)} · p75 ${f(spreads.p75)}`);
  if (!calls.length) {
    console.log(`  scored         0 (no decision is ${horizon} blocks old yet)\n`);
    continue;
  }
  console.log(`  scored         ${call.n} decisions with a realized ${horizon} block window`);
  console.log(`  hit rate       ${((hits / calls.length) * 100).toFixed(1)}%`);
  console.log(`  called side    mean ${f(call.mean)} bps · median ${f(call.median)} · p25 ${f(call.p25)} · p75 ${f(call.p75)}`);
  console.log(`  always buy     mean ${f(flat.mean)} bps · always sell ${f(-flat.mean)} bps`);
  for (const b of byConfidence) console.log(`  said ${b.label.padEnd(8)} ${String(b.n).padStart(4)} decisions · right ${b.hit.toFixed(0)}% · mean ${f(b.mean)} bps`);
  console.log(`  gas per block  ${gasMon.toFixed(6)} MON (${gasLabel}) = ${((gasMon / config.tradeSizeMon) * 10_000).toFixed(2)} bps of a ${config.tradeSizeMon} MON order\n`);
}
