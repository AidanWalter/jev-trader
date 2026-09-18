import { mkdirSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const prefix = "--" + name + "=";
  const hit = args.find((x) => x.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
};

const selectionDate = flag("selection-date", "2025-01-02")!;
const selectionMs = Date.parse(selectionDate + "T00:00:00Z");
if (!Number.isFinite(selectionMs)) throw new Error("invalid --selection-date");
const defaultFrom = new Date(selectionMs + 86_400_000).toISOString().slice(0, 10);
const from = flag("from", defaultFrom)!;
const to = flag("to", "2025-02-01")!;
const top = Math.max(1, Number(flag("top", "10")));
const multiplier = Math.max(1, Number(flag("multiplier", "15")));
const timespan = flag("timespan", "minute")!;
const minPrice = Math.max(0, Number(flag("min-price", "5")));
const minDollarVolume = Math.max(0, Number(flag("min-dollar-volume", "10000000")));
const outDir = flag("out-dir", "data/market/polygon-universe")!;
const manifestPath = flag("manifest", outDir + "/universe.json")!;
const apiKey = process.env.POLYGON_API_KEY;
if (!apiKey) throw new Error("POLYGON_API_KEY is required");
const fromMs = Date.parse(from + "T00:00:00Z");
if (!Number.isFinite(fromMs) || fromMs <= selectionMs) {
  throw new Error("--from must be strictly after --selection-date so universe selection cannot look ahead");
}

type Grouped = { T: string; c: number; v?: number; vw?: number };
type Agg = { t: number; o: number; h: number; l: number; c: number; v?: number };

async function polygonJson(url: URL) {
  url.searchParams.set("apiKey", apiKey);
  const res = await fetch(url);
  const body = await res.text();
  if (!res.ok) throw new Error("Polygon HTTP " + res.status + ": " + body.slice(0, 300));
  const parsed = JSON.parse(body);
  if (parsed.error) throw new Error("Polygon: " + parsed.error);
  return parsed;
}

const groupedUrl = new URL(
  "https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/" + encodeURIComponent(selectionDate)
);
groupedUrl.searchParams.set("adjusted", "true");
const grouped = await polygonJson(groupedUrl);
const candidates: { ticker: string; price: number; dollarVolume: number }[] = (grouped.results ?? [])
  .map((r: Grouped) => {
    const price = Number(r.vw ?? r.c);
    const volume = Number(r.v ?? 0);
    return { ticker: String(r.T ?? ""), price, dollarVolume: price * volume };
  })
  .filter((x: any) =>
    /^[A-Z]{1,5}$/.test(x.ticker) &&
    Number.isFinite(x.price) &&
    x.price >= minPrice &&
    Number.isFinite(x.dollarVolume) &&
    x.dollarVolume >= minDollarVolume
  )
  .sort((a: any, b: any) => b.dollarVolume - a.dollarVolume)
  .slice(0, top);

if (!candidates.length) throw new Error("no liquid universe candidates found on " + selectionDate);
console.log(
  "selected point-in-time universe on " + selectionDate + ": " +
  candidates.map((x: any) => x.ticker + "($" + Math.round(x.dollarVolume / 1e6) + "m)").join(", ")
);

mkdirSync(outDir, { recursive: true });
const assets: any[] = [];
const skipped: any[] = [];

for (let n = 0; n < candidates.length; n++) {
  const candidate = candidates[n]!;
  if (n > 0) await Bun.sleep(13_000);

  const url = new URL(
    "https://api.polygon.io/v2/aggs/ticker/" +
    encodeURIComponent(candidate.ticker) + "/range/" +
    multiplier + "/" + encodeURIComponent(timespan) + "/" +
    encodeURIComponent(from) + "/" + encodeURIComponent(to)
  );
  url.searchParams.set("adjusted", "true");
  url.searchParams.set("sort", "asc");
  url.searchParams.set("limit", "50000");

  try {
    const parsed = await polygonJson(url);
    const rows: Agg[] = parsed.results ?? [];
    rows.sort((a, b) => a.t - b.t);
    const unique = rows.filter((r, i) => i === 0 || r.t > rows[i - 1]!.t);
    if (unique.length < 100) {
      skipped.push({ ticker: candidate.ticker, reason: "fewer than 100 bars", bars: unique.length });
      continue;
    }
    const file = candidate.ticker.toLowerCase() + "-" + multiplier + timespan + ".csv";
    writeFileSync(
      outDir + "/" + file,
      "timestamp,open,high,low,close,volume\n" +
      unique.map((r) => [
        new Date(r.t).toISOString(), r.o, r.h, r.l, r.c, r.v ?? 0,
      ].join(",")).join("\n") + "\n"
    );
    assets.push({
      file,
      symbol: candidate.ticker,
      kind: "stock",
      spreadBps: Number(flag("spread-bps", "2")),
      selectionDate,
      selectionDollarVolume: candidate.dollarVolume,
    });
    console.log(candidate.ticker + ": " + unique.length + " bars");
  } catch (e) {
    skipped.push({ ticker: candidate.ticker, reason: (e as Error).message });
    console.warn(candidate.ticker + ": skipped · " + (e as Error).message);
  }
}

if (!assets.length) throw new Error("no selected equity downloaded usable intraday bars");
writeFileSync(manifestPath, JSON.stringify({
  name: "polygon-point-in-time-" + selectionDate + "-" + multiplier + timespan,
  provider: "polygon",
  universeMethod: "top dollar volume on historical selection date; simple common-stock-like ticker syntax",
  selectionDate,
  from,
  to,
  multiplier,
  timespan,
  minPrice,
  minDollarVolume,
  requestedTop: top,
  assets,
  skipped,
}, null, 2) + "\n");
console.log("wrote point-in-time universe " + manifestPath + " with " + assets.length + " assets");
