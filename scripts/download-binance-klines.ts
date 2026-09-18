import { mkdirSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const prefix = "--" + name + "=";
  const hit = args.find((x) => x.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
};

const symbol = flag("symbol", "BTCUSDT")!.toUpperCase();
const interval = flag("interval", "5m")!;
const startRaw = flag("start", "2024-01-01")!;
const endRaw = flag("end", new Date().toISOString().slice(0, 10))!;
const out = flag("out", `data/market/binance-${symbol}-${interval}.csv`)!;

const start = Date.parse(startRaw);
const end = Date.parse(endRaw + (endRaw.length === 10 ? "T23:59:59.999Z" : ""));
if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error("invalid --start/--end");

const rows: unknown[][] = [];
let cursor = start;
while (cursor < end) {
  const url = new URL("https://data-api.binance.vision/api/v3/klines");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("startTime", String(cursor));
  url.searchParams.set("endTime", String(end));
  url.searchParams.set("limit", "1000");

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance HTTP ${res.status}: ${await res.text()}`);
  const batch = await res.json() as unknown[][];
  if (!batch.length) break;
  rows.push(...batch);

  const lastOpen = Number(batch.at(-1)?.[0]);
  if (!Number.isFinite(lastOpen) || lastOpen < cursor) throw new Error("Binance pagination did not advance");
  cursor = lastOpen + 1;
  process.stdout.write(`\r${symbol} ${interval}: ${rows.length} bars through ${new Date(lastOpen).toISOString()}`);
  if (batch.length < 1000) break;
  await Bun.sleep(40);
}
process.stdout.write("\n");

mkdirSync(out.includes("/") ? out.slice(0, out.lastIndexOf("/")) : ".", { recursive: true });
const header = "timestamp,open,high,low,close,volume\n";
const body = rows.map((r) => [
  new Date(Number(r[0])).toISOString(),
  r[1], r[2], r[3], r[4], r[5],
].join(",")).join("\n");
writeFileSync(out, header + body + (body ? "\n" : ""));
console.log(`wrote ${rows.length} bars to ${out}`);
