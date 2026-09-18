import { mkdirSync, rmSync, writeFileSync } from "node:fs";

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

const start = Date.parse(startRaw + (startRaw.length === 10 ? "T00:00:00.000Z" : ""));
const end = Date.parse(endRaw + (endRaw.length === 10 ? "T23:59:59.999Z" : ""));
if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error("invalid --start/--end");
mkdirSync(outDir, { recursive: true });

function normalizeTs(x: string | number) {
  let n = Number(x);
  if (!Number.isFinite(n)) return NaN;
  if (n > 10_000_000_000_000) n = Math.floor(n / 1000);
  return n;
}

function monthKeys(startMs: number, endMs: number) {
  const out: string[] = [];
  let d = new Date(Date.UTC(new Date(startMs).getUTCFullYear(), new Date(startMs).getUTCMonth(), 1));
  const last = new Date(Date.UTC(new Date(endMs).getUTCFullYear(), new Date(endMs).getUTCMonth(), 1));
  while (d <= last) {
    out.push(d.toISOString().slice(0, 7));
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  }
  return out;
}

async function unzipCsv(url: string, label: string) {
  const res = await fetch(url, { headers: { "User-Agent": "jev-trader-research/1.0" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(label + " archive HTTP " + res.status + ": " + (await res.text()).slice(0, 250));
  const bytes = new Uint8Array(await res.arrayBuffer());
  const tmp = outDir + "/." + label.replace(/[^a-zA-Z0-9_.-]/g, "_") + "-" + crypto.randomUUID() + ".zip";
  writeFileSync(tmp, bytes);
  try {
    const proc = Bun.spawn(["unzip", "-p", tmp], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exit = await proc.exited;
    if (exit !== 0) throw new Error(label + " unzip failed: " + stderr.slice(0, 250));
    return stdout;
  } finally {
    rmSync(tmp, { force: true });
  }
}

function csvRows(text: string) {
  return text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).map((x) => x.split(","));
}

async function archiveKlines(symbol: string) {
  const rows: string[][] = [];
  for (const ym of monthKeys(start, end)) {
    const url =
      "https://data.binance.vision/data/futures/um/monthly/klines/" +
      symbol + "/" + interval + "/" + symbol + "-" + interval + "-" + ym + ".zip";
    const csv = await unzipCsv(url, symbol + "-klines-" + ym);
    if (!csv) continue;
    for (const row of csvRows(csv)) {
      const ts = normalizeTs(row[0]!);
      if (!Number.isFinite(ts)) continue;
      if (ts < start || ts > end) continue;
      rows.push(row);
    }
  }
  return rows;
}

async function archiveFunding(symbol: string) {
  const events: { ts: number; rateBps: number }[] = [];
  for (const ym of monthKeys(start, end)) {
    const url =
      "https://data.binance.vision/data/futures/um/monthly/fundingRate/" +
      symbol + "/" + symbol + "-fundingRate-" + ym + ".zip";
    const csv = await unzipCsv(url, symbol + "-funding-" + ym);
    if (!csv) continue;
    const rows = csvRows(csv);
    if (!rows.length) continue;

    const header = rows[0]!.map((x) => x.trim().toLowerCase());
    const hasHeader = !Number.isFinite(normalizeTs(rows[0]![0]!));
    let tsIndex = 0;
    let rateIndex = rows[0]!.length - 1;
    if (hasHeader) {
      const tsi = header.findIndex((x) => x === "fundingtime" || x === "funding_time" || x === "calc_time" || x === "calctime");
      const ri = header.findIndex((x) => x === "fundingrate" || x === "funding_rate" || x === "last_funding_rate");
      if (tsi >= 0) tsIndex = tsi;
      if (ri >= 0) rateIndex = ri;
    }
    for (const row of rows.slice(hasHeader ? 1 : 0)) {
      const ts = normalizeTs(row[tsIndex]!);
      const rate = Number(row[rateIndex]);
      if (!Number.isFinite(ts) || !Number.isFinite(rate)) continue;
      if (ts < start || ts > end) continue;
      events.push({ ts, rateBps: rate * 10_000 });
    }
  }
  events.sort((a, b) => a.ts - b.ts);
  return events;
}

const assets: any[] = [];
const skipped: any[] = [];
for (const symbol of symbols) {
  try {
    const [klines, funding] = await Promise.all([archiveKlines(symbol), archiveFunding(symbol)]);
    if (!klines.length) throw new Error("no archived klines");

    const parsed = klines.map((r) => ({
      ts: normalizeTs(r[0]!),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
    })).filter((r) =>
      Number.isFinite(r.ts) &&
      [r.open, r.high, r.low, r.close, r.volume].every(Number.isFinite)
    ).sort((a, b) => a.ts - b.ts);

    const unique = parsed.filter((r, i, a) => i === 0 || r.ts > a[i - 1]!.ts);
    const fundingByBar = new Map<number, number>();
    for (const event of funding) {
      let lo = 0, hi = unique.length - 1, answer = -1;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (unique[mid]!.ts >= event.ts) {
          answer = mid;
          hi = mid - 1;
        } else lo = mid + 1;
      }
      if (answer >= 0) {
        const barTs = unique[answer]!.ts;
        fundingByBar.set(barTs, (fundingByBar.get(barTs) ?? 0) + event.rateBps);
      }
    }

    const file = symbol.toLowerCase() + "-" + interval + "-perp.csv";
    writeFileSync(
      outDir + "/" + file,
      "timestamp,open,high,low,close,volume,funding_bps\n" +
      unique.map((r) => [
        new Date(r.ts).toISOString(),
        r.open, r.high, r.low, r.close, r.volume,
        fundingByBar.get(r.ts) ?? 0,
      ].join(",")).join("\n") + "\n",
    );

    assets.push({
      file,
      symbol,
      kind: "perp",
      spreadBps,
      fundingObservations: funding.length,
      archiveSource: "binance-vision",
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
  provider: "binance-vision-futures-um",
  requestedSymbols: symbols,
  interval,
  start: startRaw,
  end: endRaw,
  assets,
  skipped,
}, null, 2) + "\n");
console.log("wrote perpetual universe " + manifestPath + " with " + assets.length + " assets");
