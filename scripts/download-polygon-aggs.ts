import { mkdirSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const prefix = "--" + name + "=";
  const hit = args.find((x) => x.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
};

const ticker = flag("ticker", "AAPL")!.toUpperCase();
const multiplier = Math.max(1, Number(flag("multiplier", "15")));
const timespan = flag("timespan", "minute")!;
const from = flag("from", "2025-01-01")!;
const to = flag("to", "2025-02-01")!;
const adjusted = flag("adjusted", "true") !== "false";
const out = flag("out", "data/market/polygon-" + ticker.toLowerCase() + "-" + multiplier + timespan + ".csv")!;
const apiKey = process.env.POLYGON_API_KEY;
if (!apiKey) throw new Error("POLYGON_API_KEY is required");

type Agg = { t: number; o: number; h: number; l: number; c: number; v?: number };
type Response = { results?: Agg[]; next_url?: string; status?: string; error?: string };

let url = new URL(
  "https://api.polygon.io/v2/aggs/ticker/" +
  encodeURIComponent(ticker) + "/range/" +
  multiplier + "/" + encodeURIComponent(timespan) + "/" +
  encodeURIComponent(from) + "/" + encodeURIComponent(to)
);
url.searchParams.set("adjusted", adjusted ? "true" : "false");
url.searchParams.set("sort", "asc");
url.searchParams.set("limit", "50000");
url.searchParams.set("apiKey", apiKey);

const rows: Agg[] = [];
let page = 0;
while (url) {
  page++;
  const res = await fetch(url);
  const body = await res.text();
  if (!res.ok) throw new Error("Polygon HTTP " + res.status + ": " + body.slice(0, 300));
  const parsed = JSON.parse(body) as Response;
  if (parsed.error) throw new Error("Polygon: " + parsed.error);
  rows.push(...(parsed.results ?? []));
  if (!parsed.next_url) break;
  const next = new URL(parsed.next_url);
  next.searchParams.set("apiKey", apiKey);
  url = next;
  await Bun.sleep(13_000);
}

rows.sort((a, b) => a.t - b.t);
const unique = rows.filter((r, i) => i === 0 || r.t > rows[i - 1]!.t);
if (!unique.length) throw new Error("Polygon returned no aggregate bars");

mkdirSync(out.includes("/") ? out.slice(0, out.lastIndexOf("/")) : ".", { recursive: true });
const csv = "timestamp,open,high,low,close,volume\n" + unique.map((r) => [
  new Date(r.t).toISOString(),
  r.o,
  r.h,
  r.l,
  r.c,
  r.v ?? 0,
].join(",")).join("\n") + "\n";
writeFileSync(out, csv);
console.log(
  "wrote " + unique.length + " adjusted=" + adjusted + " bars for " + ticker +
  " from " + new Date(unique[0]!.t).toISOString() +
  " through " + new Date(unique.at(-1)!.t).toISOString() +
  " to " + out
);
