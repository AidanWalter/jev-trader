import { mkdirSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const prefix = "--" + name + "=";
  const hit = args.find((x) => x.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
};

const ticker = flag("ticker", "SPY")!.toUpperCase();
const interval = flag("interval", "15m")!;
const from = flag("from", new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10))!;
const to = flag("to", new Date().toISOString().slice(0, 10))!;
const out = flag("out", "data/market/yahoo-" + ticker.toLowerCase() + "-" + interval + ".csv")!;

const period1 = Math.floor(Date.parse(from + (from.length === 10 ? "T00:00:00Z" : "")) / 1000);
const period2 = Math.floor(Date.parse(to + (to.length === 10 ? "T23:59:59Z" : "")) / 1000);
if (!Number.isFinite(period1) || !Number.isFinite(period2) || period1 >= period2) throw new Error("invalid --from/--to");

const url = new URL("https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(ticker));
url.searchParams.set("period1", String(period1));
url.searchParams.set("period2", String(period2));
url.searchParams.set("interval", interval);
url.searchParams.set("events", "div,splits");
url.searchParams.set("includeAdjustedClose", "true");

const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 jev-trader-research" } });
const body = await res.text();
if (!res.ok) throw new Error("Yahoo HTTP " + res.status + ": " + body.slice(0, 300));
const json = JSON.parse(body);
if (json?.chart?.error) throw new Error("Yahoo: " + (json.chart.error.description ?? JSON.stringify(json.chart.error)));
const result = json?.chart?.result?.[0];
if (!result) throw new Error("Yahoo returned no chart result");

const timestamps: number[] = result.timestamp ?? [];
const quote = result.indicators?.quote?.[0];
if (!quote || !timestamps.length) throw new Error("Yahoo returned no OHLCV rows");

const rows: string[] = [];
for (let i = 0; i < timestamps.length; i++) {
  const o = quote.open?.[i], h = quote.high?.[i], l = quote.low?.[i], c = quote.close?.[i], v = quote.volume?.[i];
  if (![o, h, l, c].every((x) => Number.isFinite(x) && x > 0)) continue;
  rows.push([new Date(timestamps[i]! * 1000).toISOString(), o, h, l, c, Number.isFinite(v) ? v : 0].join(","));
}
if (!rows.length) throw new Error("Yahoo returned no usable OHLCV rows");

mkdirSync(out.includes("/") ? out.slice(0, out.lastIndexOf("/")) : ".", { recursive: true });
writeFileSync(out, "timestamp,open,high,low,close,volume\n" + rows.join("\n") + "\n");
console.log("wrote " + rows.length + " " + interval + " bars for " + ticker + " to " + out);
