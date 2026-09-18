import { mkdirSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const prefix = "--" + name + "=";
  const hit = args.find((x) => x.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
};

const symbols = flag("symbols", "BTCUSDT,ETHUSDT,SOLUSDT")!
  .split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);
const interval = flag("interval", "15m")!;
const startRaw = flag("start", "2025-01-01")!;
const endRaw = flag("end", "2025-02-01")!;
const spreadBps = Number(flag("spread-bps", "4"));
const outDir = flag("out-dir", "data/market/perp-universe")!;
const manifestPath = flag("manifest", outDir + "/universe.json")!;

const start = Date.parse(startRaw);
const end = Date.parse(endRaw + (endRaw.length === 10 ? "T23:59:59.999Z" : ""));
if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error("invalid --start/--end");
mkdirSync(outDir, { recursive: true });

type Kline = unknown[];
type Funding = {
  symbol: string;
  fundingTime: number;
  fundingRate: string;
  markPrice?: string;
  rateType?: string;
};

async function getJson(url: URL) {
  const res = await fetch(url, { headers: { "User-Agent": "jev-trader-research/1.0" } });
  const body = await res.text();
  if (!res.ok) throw new Error("Binance Futures HTTP " + res.status + ": " + body.slice(0, 300));
  const parsed = JSON.parse(body);
  if (parsed && !Array.isArray(parsed) && typeof parsed.code === "number" && parsed.code < 0) {
    throw new Error("Binance Futures " + parsed.code + ": " + parsed.msg);
  }
  return parsed;
}

async function downloadKlines(symbol: string) {
  const rows: Kline[] = [];
  let cursor = start;
  while (cursor < end) {
    const url = new URL("https://fapi.binance.com/fapi/v1/klines");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("startTime", String(cursor));
    url.searchParams.set("endTime", String(end));
    url.searchParams.set("limit", "1500");
    const batch = await getJson(url) as Kline[];
    if (!batch.length) break;
    rows.push(...batch);
    const lastOpen = Number(batch.at(-1)?.[0]);
    if (!Number.isFinite(lastOpen) || lastOpen < cursor) throw new Error(symbol + " kline pagination did not advance");
    cursor = lastOpen + 1;
    if (batch.length < 1500) break;
    await Bun.sleep(40);
  }
  return rows;
}

async function downloadFunding(symbol: string) {
  const rows: Funding[] = [];
  let cursor = start;
  while (cursor <= end) {
    const url = new URL("https://fapi.binance.com/fapi/v1/fundingRate");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("startTime", String(cursor));
    url.searchParams.set("endTime", String(end));
    url.searchParams.set("limit", "1000");
    const batch = await getJson(url) as Funding[];
    if (!batch.length) break;
    rows.push(...batch);
    const last = Number(batch.at(-1)?.fundingTime);
    if (!Number.isFinite(last) || last < cursor) throw new Error(symbol + " funding pagination did not advance");
    cursor = last + 1;
    if (batch.length < 1000) break;
    await Bun.sleep(40);
  }
  return rows;
}

const assets: any[] = [];
const skipped: any[] = [];
for (const symbol of symbols) {
  try {
    const [klines, funding] = await Promise.all([downloadKlines(symbol), downloadFunding(symbol)]);
    if (!klines.length) throw new Error("no klines");

    const fundingByTs = new Map<number, number>();
    for (const f of funding) {
      const rate = Number(f.fundingRate);
      if (!Number.isFinite(rate)) continue;
      fundingByTs.set(Number(f.fundingTime), rate * 10_000);
    }

    const unique = klines
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .filter((r, i, a) => i === 0 || Number(r[0]) > Number(a[i - 1]![0]));
    const file = symbol.toLowerCase() + "-" + interval + "-perp.csv";
    const body = unique.map((r) => {
      const ts = Number(r[0]);
      const fundingBps = fundingByTs.get(ts) ?? 0;
      return [
        new Date(ts).toISOString(),
        r[1], r[2], r[3], r[4], r[5],
        fundingBps,
      ].join(",");
    }).join("\n");
    writeFileSync(
      outDir + "/" + file,
      "timestamp,open,high,low,close,volume,funding_bps\n" + body + "\n",
    );
    assets.push({
      file,
      symbol,
      kind: "perp",
      spreadBps,
      fundingObservations: funding.length,
    });
    console.log(symbol + ": " + unique.length + " klines · " + funding.length + " funding observations");
  } catch (e) {
    skipped.push({ symbol, reason: (e as Error).message });
    console.warn(symbol + ": skipped · " + (e as Error).message);
  }
}

if (!assets.length) throw new Error("no perpetual-futures assets downloaded");
writeFileSync(manifestPath, JSON.stringify({
  name: "binance-usdm-perp-" + interval + "-" + startRaw + "-" + endRaw,
  provider: "binance-usdm-futures",
  requestedSymbols: symbols,
  interval,
  start: startRaw,
  end: endRaw,
  assets,
  skipped,
}, null, 2) + "\n");
console.log("wrote perpetual universe " + manifestPath + " with " + assets.length + " assets");
