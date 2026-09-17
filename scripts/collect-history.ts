/**
 * Keeps a local copy of what a running jev-trader has seen.
 *
 * The server keeps the last 1000 block events in memory and serves them from `GET /history`. This
 * polls that endpoint and appends the events it has not written yet, so a long session can be
 * scored later with `score-decisions.ts` without reaching into the container or the volume.
 *
 * Poll faster than the server forgets: 1000 events at ~200 blocks per minute is about five minutes
 * of history, so the default one minute interval leaves a wide margin. Killing the process loses
 * nothing: every event is flushed to disk as it arrives. A container restart empties the in-memory
 * history, which costs at most one interval of events; the volume still has the full file.
 *
 *   bun run scripts/collect-history.ts <baseUrl> [pollSeconds] [outFile]
 *
 *   bun run scripts/collect-history.ts https://your-service.up.railway.app 120 data/server-events.jsonl
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const base = (process.argv[2] ?? "http://localhost:3100").replace(/\/+$/, "");
const pollSeconds = Number(process.argv[3] ?? 60);
const outFile = process.argv[4] ?? "data/server-events.jsonl";
/** Retries inside one round, so a restart or a transient edge error does not cost a full interval. */
const retries = 5;
const retryDelayMs = 10_000;

mkdirSync(dirname(outFile), { recursive: true });

/** Block numbers already written. One event per block, so the number is a safe key. */
const seen = new Set<number>();
let total = 0;
let polls = 0;

const stamp = () => new Date().toTimeString().slice(0, 8);

async function pollOnce(): Promise<number> {
  const res = await fetch(`${base}/history`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`http ${res.status}`);
  const events = (await res.json()) as { block: number; decision?: { late?: boolean } }[];
  let added = 0;
  for (const e of events) {
    if (typeof e?.block !== "number" || seen.has(e.block)) continue;
    seen.add(e.block);
    appendFileSync(outFile, JSON.stringify(e) + "\n");
    added++;
  }
  total += added;
  polls++;
  const latest = events.at(-1);
  const late = events.filter((e) => e.decision?.late).length;
  console.log(`${stamp()} poll ${polls}: +${added} new (${total} stored, ${seen.size} known) · server has ${events.length} events, ${late} of them late · latest block ${latest?.block ?? "-"}`);
  return added;
}

async function poll(): Promise<number> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await pollOnce();
    } catch (e) {
      if (attempt >= retries) throw e;
      console.warn(`${stamp()} attempt ${attempt} failed (${(e as Error).message}), retrying in ${retryDelayMs / 1000}s`);
      await Bun.sleep(retryDelayMs);
    }
  }
}

console.log(`collecting ${base}/history every ${pollSeconds}s into ${outFile}`);
for (;;) {
  try {
    await poll();
  } catch (e) {
    console.warn(`${stamp()} poll failed: ${(e as Error).message}`);
  }
  await Bun.sleep(pollSeconds * 1000);
}
