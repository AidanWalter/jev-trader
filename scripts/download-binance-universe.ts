import { mkdirSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const prefix = "--" + name + "=";
  const hit = args.find((x) => x.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
};

const symbols = flag("symbols", "BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,AVAXUSDT,LINKUSDT")!
  .split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);
const interval = flag("interval", "15m")!;
const startRaw = flag("start", "2025-01-01")!;
const endRaw = flag("end", "2025-02-01")!;
const outDir = flag("out-dir", "data/market/crypto-universe")!;
const manifestPath = flag("manifest", outDir + "/universe.json")!;
const spreadBps = Number(flag("spread-bps", "4"));

const start = Date.parse(startRaw);
const end = Date.parse(endRaw + (endRaw.length === 10 ? "T23:59:59.999Z" : ""));
if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error("invalid --start/--end");
mkdirSync(outDir, { recursive: true });

async function download(symbol: string) {
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
    if (!res.ok) throw new Error("HTTP " + res.status + ": " + (await res.text()).slice(0, 160));
    const batch = await res.json() as unknown[][];
    if (!batch.length) break;
    rows.push(...batch);
    const lastOpen = Number(batch.at(-1)?.[0]);
    if (!Number.isFinite(lastOpen) || lastOpen < cursor) throw new Error("pagination did not advance");
    cursor = lastOpen + 1;
    if (batch.length < 1000) break;
    await Bun.sleep(30);
  }
  return rows;
}

const assets: { file: string; symbol: string; kind: "spot"; spreadBps: number }[] = [];
for (const symbol of symbols) {
  try {
    const rows = await download(symbol);
    if (!rows.length) {
      console.warn(symbol + ": no data, skipped");
      continue;
    }
    const fileName = symbol.toLowerCase() + "-" + interval + ".csv";
    const body = rows.map((r) => [
      new Date(Number(r[0])).toISOString(),
      r[1], r[2], r[3], r[4], r[5],
    ].join(",")).join("\n");
    writeFileSync(outDir + "/" + fileName, "timestamp,open,high,low,close,volume\n" + body + "\n");
    assets.push({ file: fileName, symbol, kind: "spot", spreadBps });
    console.log(symbol + ": " + rows.length + " bars");
  } catch (e) {
    console.warn(symbol + ": " + (e as Error).message + " · skipped");
  }
}

if (!assets.length) throw new Error("no universe assets downloaded");
writeFileSync(manifestPath, JSON.stringify({
  name: "binance-" + interval + "-" + startRaw + "-" + endRaw,
  assets,
}, null, 2) + "\n");
console.log("wrote universe manifest " + manifestPath + " with " + assets.length + " assets");
