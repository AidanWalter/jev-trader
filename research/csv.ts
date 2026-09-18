import { readFileSync } from "node:fs";
import type { AssetKind, MarketBar } from "./types";

export interface CsvLoadOptions {
  symbol?: string;
  kind?: AssetKind;
  timestampColumn?: string;
  timestampUnit?: "s" | "ms";
  defaultSpreadBps?: number;
}

function splitCsv(line: string) {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

const aliases: Record<string, string[]> = {
  timestamp: ["timestamp", "time", "date", "datetime", "open_time", "opentime"],
  open: ["open", "o"],
  high: ["high", "h"],
  low: ["low", "l"],
  close: ["close", "c"],
  volume: ["volume", "vol", "v"],
  spreadBps: ["spreadbps", "spread_bps"],
  fundingBps: ["fundingbps", "funding_bps"],
};

function normalize(x: string) {
  return x.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
}

function findColumn(headers: string[], name: string) {
  const wanted = aliases[name] ?? [name];
  const normalized = headers.map(normalize);
  for (const a of wanted) {
    const i = normalized.indexOf(normalize(a));
    if (i >= 0) return i;
  }
  return -1;
}

function parseTs(raw: string, unit?: "s" | "ms") {
  const n = Number(raw);
  if (Number.isFinite(n)) {
    if (unit === "s") return n * 1000;
    if (unit === "ms") return n;
    return n < 10_000_000_000 ? n * 1000 : n;
  }
  const d = Date.parse(raw);
  if (!Number.isFinite(d)) throw new Error("invalid timestamp: " + raw);
  return d;
}

export function loadBarsCsv(path: string, options: CsvLoadOptions = {}): MarketBar[] {
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((x) => x.trim());
  if (lines.length < 2) throw new Error("CSV has no data rows");
  const headers = splitCsv(lines[0]!);
  const tsIndex = options.timestampColumn
    ? headers.map(normalize).indexOf(normalize(options.timestampColumn))
    : findColumn(headers, "timestamp");
  const indexes = {
    open: findColumn(headers, "open"),
    high: findColumn(headers, "high"),
    low: findColumn(headers, "low"),
    close: findColumn(headers, "close"),
    volume: findColumn(headers, "volume"),
    spreadBps: findColumn(headers, "spreadBps"),
    fundingBps: findColumn(headers, "fundingBps"),
  };
  if (tsIndex < 0 || indexes.open < 0 || indexes.high < 0 || indexes.low < 0 || indexes.close < 0) {
    throw new Error("CSV needs timestamp/date, open, high, low and close columns");
  }

  const symbol = options.symbol ?? "UNKNOWN";
  const kind = options.kind ?? "spot";
  const out: MarketBar[] = [];
  for (const line of lines.slice(1)) {
    const row = splitCsv(line);
    const open = Number(row[indexes.open]);
    const high = Number(row[indexes.high]);
    const low = Number(row[indexes.low]);
    const close = Number(row[indexes.close]);
    if (![open, high, low, close].every(Number.isFinite) || close <= 0) continue;
    const volume = indexes.volume >= 0 ? Number(row[indexes.volume]) : 0;
    const spread = indexes.spreadBps >= 0 ? Number(row[indexes.spreadBps]) : options.defaultSpreadBps;
    const funding = indexes.fundingBps >= 0 ? Number(row[indexes.fundingBps]) : undefined;
    out.push({
      ts: parseTs(row[tsIndex]!, options.timestampUnit),
      symbol,
      kind,
      open,
      high,
      low,
      close,
      volume: Number.isFinite(volume) ? volume : 0,
      spreadBps: Number.isFinite(spread) ? spread : undefined,
      fundingBps: Number.isFinite(funding) ? funding : undefined,
    });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out.filter((b, i) => i === 0 || b.ts > out[i - 1]!.ts);
}

export function loadBarsJsonl(path: string): MarketBar[] {
  const out: MarketBar[] = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const b = JSON.parse(line) as MarketBar;
    if (Number.isFinite(b.ts) && b.symbol && b.close > 0) out.push(b);
  }
  return out.sort((a, b) => a.ts - b.ts);
}
