import { mkdirSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const prefix = "--" + name + "=";
  const hit = args.find((x) => x.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
};

const symbol = flag("symbol", "AAPL.US")!.toLowerCase();
const start = flag("start", "2018-01-01")!.replaceAll("-", "");
const end = flag("end", new Date().toISOString().slice(0, 10))!.replaceAll("-", "");
const out = flag("out", `data/market/stooq-${symbol.replaceAll(".", "_")}-1d.csv`)!;
const apiKey = process.env.STOOQ_API_KEY;

const url = new URL("https://stooq.com/q/d/l/");
url.searchParams.set("s", symbol);
url.searchParams.set("d1", start);
url.searchParams.set("d2", end);
url.searchParams.set("i", "d");
if (apiKey) url.searchParams.set("apikey", apiKey);

const res = await fetch(url, { headers: { "User-Agent": "jev-trader-research/1.0" } });
const body = await res.text();
if (!res.ok) throw new Error(`Stooq HTTP ${res.status}: ${body.slice(0, 200)}`);
if (!body.trim() || body.trim() === "N/D" || !/^Date,Open,High,Low,Close/m.test(body)) {
  throw new Error("Stooq returned no usable CSV. If the endpoint requires authentication, set STOOQ_API_KEY.");
}

mkdirSync(out.includes("/") ? out.slice(0, out.lastIndexOf("/")) : ".", { recursive: true });
writeFileSync(out, body.endsWith("\n") ? body : body + "\n");
console.log(`wrote ${symbol} daily bars to ${out}`);
