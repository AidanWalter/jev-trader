import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CachedEvaluator, JsonlSignalCache } from "./cache";
import { createReplayEvaluator } from "./evaluator";
import { defaultFeatureConfig } from "./features";
import { buildPortfolioFeatureStates } from "./portfolio-features";
import { choosePolicyAction } from "./policy";
import { allocatePortfolioTargets, type PortfolioCandidate } from "./portfolio";
import type { InputProfile } from "./profiles";
import type { MarketBar, PolicyConfig } from "./types";

interface FreezeRecord {
  version: "portfolio-apparatus-freeze-v1";
  universe: {
    symbols: string[];
    intervalMs: number;
    kinds: Record<string, string>;
    spreadsBps: Record<string, number | null>;
  };
  evaluator: {
    kind: string;
    namespace: string;
    profile: InputProfile;
  };
  features: {
    horizonBars: number;
    directionThresholdBpsFloor: number;
    directionThresholdFixedCostBps: number;
  };
  cadence: { decisionEveryBars: number };
  execution: {
    initialCash: number;
    feeBps: number;
    slippageBps: number;
    spreadBpsFallback: number;
    spreadCostMultiplier: number;
    allowShort: boolean;
    shortBorrowBpsPerDay: number;
    minTradeNotional: number;
  };
  portfolio: {
    topN: number;
    maxGrossExposure: number;
    maxAssetExposure: number;
  };
  policy: PolicyConfig;
}

interface PaperState {
  version: "frozen-yahoo-stock-portfolio-paper-v1";
  freezeSha256: string;
  evaluatorNamespace: string;
  symbols: string[];
  interval: string;
  cash: number;
  quantities: Record<string, number>;
  fees: number;
  borrowCost: number;
  lastOpenTs: number;
  lastDecisionTs: number | null;
  barsSinceDecision: number;
  startedAt: number;
}

interface FetchedBars {
  symbol: string;
  closed: MarketBar[];
  current: MarketBar | null;
}

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const prefix = "--" + name + "=";
  const hit = args.find((x) => x.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
};

const freezePath = args.find((x) => !x.startsWith("--")) ?? "data/stock-portfolio-apparatus-freeze.json";
const freezeBytes = readFileSync(freezePath);
const freeze = JSON.parse(freezeBytes.toString("utf8")) as FreezeRecord;
if (freeze.version !== "portfolio-apparatus-freeze-v1") throw new Error("unsupported freeze version");
if (!freeze.universe.symbols.length) throw new Error("frozen stock universe is empty");
for (const symbol of freeze.universe.symbols) {
  if (freeze.universe.kinds[symbol] !== "stock") throw new Error("Yahoo frozen paper runner requires a stock-only universe");
}

const intervalMap = new Map<number, string>([
  [60_000, "1m"],
  [2 * 60_000, "2m"],
  [5 * 60_000, "5m"],
  [15 * 60_000, "15m"],
  [30 * 60_000, "30m"],
  [60 * 60_000, "60m"],
  [90 * 60_000, "90m"],
]);
const intervalCandidate = flag("interval", intervalMap.get(freeze.universe.intervalMs));
if (!intervalCandidate) throw new Error("could not map frozen stock interval to Yahoo interval; pass --interval explicitly");
const interval: string = intervalCandidate;

const freezeHasher = new Bun.CryptoHasher("sha256");
freezeHasher.update(freezeBytes);
const freezeSha256 = freezeHasher.digest("hex");

const statePath = flag("state", "data/frozen-stock-portfolio-paper.json")!;
const eventsPath = flag("events", "data/frozen-stock-portfolio-paper-events.jsonl")!;
const cachePath = flag("cache", "data/stock-portfolio-pilot-cache.jsonl")!;
const pollMs = Math.max(1000, Number(flag("poll-ms", "5000")));
const cycles = Math.max(0, Number(flag("cycles", "0")));
const range = flag("range", "5d")!;
const maxNewEvaluations = Math.max(
  0,
  Number(flag("max-new-evals", freeze.evaluator.kind === "jev" ? "5000" : "1000000000")),
);

const raw = createReplayEvaluator(freeze.evaluator.kind, freeze.evaluator.profile);
if (raw.name !== freeze.evaluator.namespace) throw new Error("evaluator namespace differs from frozen stock apparatus");
const cache = new JsonlSignalCache(cachePath);
const evaluator = new CachedEvaluator(raw, cache, maxNewEvaluations);

const featureConfig = {
  ...defaultFeatureConfig,
  horizonBars: freeze.features.horizonBars,
  spreadBpsFallback: freeze.execution.spreadBpsFallback,
  directionThresholdBpsFloor: freeze.features.directionThresholdBpsFloor,
  directionThresholdFixedCostBps: freeze.features.directionThresholdFixedCostBps,
};

function spreadFor(symbol: string) {
  const x = freeze.universe.spreadsBps[symbol];
  return Number.isFinite(x) ? Number(x) : freeze.execution.spreadBpsFallback;
}

function saveState(state: PaperState) {
  mkdirSync(statePath.includes("/") ? statePath.slice(0, statePath.lastIndexOf("/")) : ".", { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
}

function writeEvent(value: unknown) {
  mkdirSync(eventsPath.includes("/") ? eventsPath.slice(0, eventsPath.lastIndexOf("/")) : ".", { recursive: true });
  appendFileSync(eventsPath, JSON.stringify(value) + "\n");
}

function loadState(): PaperState | null {
  if (!existsSync(statePath)) return null;
  const state = JSON.parse(readFileSync(statePath, "utf8")) as PaperState;
  if (
    state.version !== "frozen-yahoo-stock-portfolio-paper-v1" ||
    state.freezeSha256 !== freezeSha256 ||
    state.evaluatorNamespace !== freeze.evaluator.namespace ||
    state.interval !== interval ||
    state.symbols.join("|") !== freeze.universe.symbols.join("|")
  ) throw new Error("stock paper state does not match frozen apparatus");
  return state;
}

async function fetchSymbolBars(symbol: string): Promise<FetchedBars> {
  const url = new URL("https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(symbol));
  url.searchParams.set("range", range);
  url.searchParams.set("interval", interval);
  url.searchParams.set("events", "div,splits");
  url.searchParams.set("includeAdjustedClose", "true");
  url.searchParams.set("includePrePost", "false");

  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 jev-trader-research" } });
  const body = await res.text();
  if (!res.ok) throw new Error(symbol + " Yahoo HTTP " + res.status + ": " + body.slice(0, 250));
  const json = JSON.parse(body);
  if (json?.chart?.error) throw new Error(symbol + " Yahoo: " + (json.chart.error.description ?? JSON.stringify(json.chart.error)));
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(symbol + " Yahoo returned no chart result");

  const timestamps: number[] = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0];
  if (!quote || !timestamps.length) throw new Error(symbol + " Yahoo returned no OHLCV rows");

  const bars: MarketBar[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const open = Number(quote.open?.[i]);
    const high = Number(quote.high?.[i]);
    const low = Number(quote.low?.[i]);
    const close = Number(quote.close?.[i]);
    const volume = Number(quote.volume?.[i] ?? 0);
    if (![open, high, low, close].every((x) => Number.isFinite(x) && x > 0)) continue;
    bars.push({
      ts: Number(timestamps[i]) * 1000,
      symbol,
      kind: "stock",
      open,
      high,
      low,
      close,
      volume: Number.isFinite(volume) && volume >= 0 ? volume : 0,
      spreadBps: spreadFor(symbol),
      fundingBps: 0,
    });
  }
  bars.sort((a, b) => a.ts - b.ts);
  const unique = bars.filter((b, i) => i === 0 || b.ts > bars[i - 1]!.ts);
  if (unique.length < featureConfig.minHistoryBars + 1) throw new Error(symbol + " has insufficient Yahoo intraday history");

  const now = Date.now();
  let current: MarketBar | null = null;
  const closed: MarketBar[] = [];
  for (const bar of unique) {
    if (bar.ts <= now && now < bar.ts + freeze.universe.intervalMs) current = bar;
    else if (bar.ts + freeze.universe.intervalMs <= now) closed.push(bar);
  }
  return { symbol, closed, current };
}

function alignClosedHistory(fetched: FetchedBars[]) {
  let common = new Set(fetched[0]!.closed.map((b) => b.ts));
  for (const f of fetched.slice(1)) {
    const ts = new Set(f.closed.map((b) => b.ts));
    common = new Set([...common].filter((x) => ts.has(x)));
  }
  const timestamps = [...common].sort((a, b) => a - b);
  if (timestamps.length < featureConfig.minHistoryBars + 1) {
    throw new Error("not enough synchronized regular-session stock bars");
  }
  const closedBySymbol = new Map<string, MarketBar[]>();
  for (const f of fetched) {
    const byTs = new Map(f.closed.map((b) => [b.ts, b]));
    closedBySymbol.set(f.symbol, timestamps.map((ts) => byTs.get(ts)!).filter(Boolean));
  }
  return { timestamps, closedBySymbol };
}

function synchronizedCurrent(fetched: FetchedBars[]) {
  if (fetched.some((x) => !x.current)) return null;
  const ts = fetched[0]!.current!.ts;
  if (fetched.some((x) => x.current!.ts !== ts)) return null;
  return {
    ts,
    bars: Object.fromEntries(fetched.map((x) => [x.symbol, x.current!])) as Record<string, MarketBar>,
  };
}

function markEquity(state: PaperState, prices: Record<string, number>) {
  let total = state.cash;
  for (const symbol of state.symbols) total += (state.quantities[symbol] ?? 0) * prices[symbol]!;
  return total;
}

function exposureMap(state: PaperState, prices: Record<string, number>) {
  const total = markEquity(state, prices);
  return Object.fromEntries(state.symbols.map((symbol) => [
    symbol,
    total > 0 ? (state.quantities[symbol] ?? 0) * prices[symbol]! / total : 0,
  ])) as Record<string, number>;
}

function accrueBorrow(state: PaperState, current: Record<string, MarketBar>) {
  if (state.lastOpenTs <= 0) return 0;
  const ts = current[state.symbols[0]!]!.ts;
  if (ts <= state.lastOpenTs) return 0;
  const days = (ts - state.lastOpenTs) / 86_400_000;
  let total = 0;
  for (const symbol of state.symbols) {
    const q = state.quantities[symbol] ?? 0;
    if (q >= 0) continue;
    const price = current[symbol]!.open;
    const cost = Math.abs(q * price) * freeze.execution.shortBorrowBpsPerDay / 10_000 * days;
    if (!(cost > 0)) continue;
    state.cash -= cost;
    state.borrowCost += cost;
    total += cost;
    writeEvent({
      type: "borrow-cost",
      at: Date.now(),
      barTs: ts,
      symbol,
      quantity: q,
      price,
      days,
      cost,
      cumulativeBorrowCost: state.borrowCost,
    });
  }
  return total;
}

function executeTargets(
  state: PaperState,
  current: Record<string, MarketBar>,
  requestedTargets: Record<string, number>,
) {
  const prices = Object.fromEntries(state.symbols.map((s) => [s, current[s]!.open])) as Record<string, number>;
  const beforeEquity = markEquity(state, prices);
  if (!(beforeEquity > 0)) throw new Error("stock paper equity is non-positive");

  const fills: any[] = [];
  for (const symbol of state.symbols) {
    const bar = current[symbol]!;
    const currentQ = state.quantities[symbol] ?? 0;
    let target = requestedTargets[symbol] ?? 0;
    target = Math.max(-freeze.portfolio.maxAssetExposure, Math.min(freeze.portfolio.maxAssetExposure, target));
    if (!freeze.execution.allowShort) target = Math.max(0, target);

    const targetQty = beforeEquity * target / bar.open;
    const delta = targetQty - currentQ;
    const estimatedNotional = Math.abs(delta * bar.open);
    if (estimatedNotional < freeze.execution.minTradeNotional) continue;

    const side = delta > 0 ? "buy" : "sell";
    const frictionBps =
      spreadFor(symbol) * freeze.execution.spreadCostMultiplier / 2 +
      freeze.execution.slippageBps;
    const price = bar.open * (1 + (side === "buy" ? 1 : -1) * frictionBps / 10_000);
    const notional = Math.abs(delta * price);
    const fee = notional * freeze.execution.feeBps / 10_000;
    state.cash -= delta * price + fee;
    state.quantities[symbol] = currentQ + delta;
    state.fees += fee;

    const fill = {
      type: "fill",
      at: Date.now(),
      decisionTs: state.lastDecisionTs,
      executionTs: bar.ts,
      symbol,
      side,
      quantity: Math.abs(delta),
      price,
      notional,
      fee,
      targetExposure: target,
    };
    fills.push(fill);
    writeEvent(fill);
  }
  return fills;
}

async function decide(state: PaperState, closedBySymbol: Map<string, MarketBar[]>) {
  const closePrices = Object.fromEntries(
    state.symbols.map((symbol) => [symbol, closedBySymbol.get(symbol)!.at(-1)!.close]),
  ) as Record<string, number>;
  const total = markEquity(state, closePrices);
  if (!(total > 0)) throw new Error("stock paper equity is non-positive before decision");
  const currentExposures = exposureMap(state, closePrices);

  const series = state.symbols.map((symbol) => ({ symbol, bars: closedBySymbol.get(symbol)! }));
  const featureIndex = series[0]!.bars.length - 1;
  const featureStates = buildPortfolioFeatureStates(series, featureIndex, featureConfig);
  const candidates: PortfolioCandidate[] = [];
  const details: Record<string, unknown> = {};
  let decisionTs: number | null = null;

  for (const symbol of state.symbols) {
    const features = featureStates.get(symbol);
    if (!features) throw new Error("could not construct stock feature state for " + symbol);
    if (decisionTs === null) decisionTs = features.ts;
    else if (features.ts !== decisionTs) throw new Error("stock feature states are not timestamp-aligned");

    const signal = await evaluator.evaluate(features);
    const currentExposure = currentExposures[symbol] ?? 0;
    const roundTripCostBps =
      features.spreadBps * freeze.execution.spreadCostMultiplier +
      2 * freeze.execution.slippageBps +
      2 * freeze.execution.feeBps;
    const action = choosePolicyAction(signal, currentExposure, freeze.policy, {
      directionThresholdBps: features.directionThresholdBps,
      estimatedRoundTripCostBps: roundTripCostBps,
    });
    const target = action.kind === "target" ? action.targetExposure : currentExposure;
    const score = action.kind === "hold"
      ? Math.max(Math.abs(currentExposure), Math.abs(action.score))
      : Math.abs(action.score);
    candidates.push({ symbol, target, score });
    details[symbol] = { features, signal, action, currentExposure };
  }

  const targetMap = allocatePortfolioTargets(
    candidates,
    freeze.portfolio.topN,
    freeze.portfolio.maxGrossExposure,
    freeze.portfolio.maxAssetExposure,
    freeze.execution.allowShort,
  );
  const targets = Object.fromEntries(state.symbols.map((s) => [s, targetMap.get(s) ?? 0]));
  state.lastDecisionTs = decisionTs;
  state.barsSinceDecision = 0;
  writeEvent({
    type: "portfolio-decision",
    at: Date.now(),
    barTs: decisionTs,
    equity: total,
    exposures: currentExposures,
    targets,
    candidates,
    details,
    freezeSha256,
  });
  return targets;
}

let state = loadState();
let cycle = 0;
while (cycles === 0 || cycle < cycles) {
  cycle++;
  try {
    const fetched = await Promise.all(freeze.universe.symbols.map((symbol) => fetchSymbolBars(symbol)));
    const { timestamps, closedBySymbol } = alignClosedHistory(fetched);
    const live = synchronizedCurrent(fetched);
    const latestClosedTs = timestamps.at(-1)!;
    const latestClosePrices = Object.fromEntries(
      state?.symbols.map((symbol) => [symbol, closedBySymbol.get(symbol)!.at(-1)!.close]) ??
      freeze.universe.symbols.map((symbol) => [symbol, closedBySymbol.get(symbol)!.at(-1)!.close]),
    ) as Record<string, number>;

    if (!state) {
      const initialTs = live?.ts ?? latestClosedTs;
      state = {
        version: "frozen-yahoo-stock-portfolio-paper-v1",
        freezeSha256,
        evaluatorNamespace: freeze.evaluator.namespace,
        symbols: [...freeze.universe.symbols],
        interval,
        cash: freeze.execution.initialCash,
        quantities: Object.fromEntries(freeze.universe.symbols.map((s) => [s, 0])),
        fees: 0,
        borrowCost: 0,
        lastOpenTs: initialTs,
        lastDecisionTs: null,
        barsSinceDecision: Math.max(0, freeze.cadence.decisionEveryBars - 1),
        startedAt: Date.now(),
      };
      writeEvent({
        type: "initialized",
        at: Date.now(),
        barTs: initialTs,
        marketOpen: !!live,
        symbols: state.symbols,
        equity: markEquity(state, latestClosePrices),
        freezeSha256,
        note: live
          ? "Current regular-session bar was already open, so no startup fill was simulated."
          : "Regular session is closed or Yahoo has no synchronized live bar; waiting for a clean session boundary.",
      });
      saveState(state);
      console.log(
        "initialized frozen Yahoo stock portfolio " + state.symbols.join(",") +
        " · market " + (live ? "open" : "closed") +
        " · equity $" + markEquity(state, latestClosePrices).toFixed(2)
      );
    } else if (live && live.ts > state.lastOpenTs) {
      const current = live.bars;
      const gapBars = Math.max(1, Math.round((live.ts - state.lastOpenTs) / freeze.universe.intervalMs));
      const borrow = accrueBorrow(state, current);
      state.lastOpenTs = live.ts;

      let targets: Record<string, number> | null = null;
      let fills: any[] = [];
      const latestClosedIsPriorBar = latestClosedTs + freeze.universe.intervalMs === live.ts;
      if (gapBars > 1 || !latestClosedIsPriorBar) {
        state.barsSinceDecision = Math.max(0, freeze.cadence.decisionEveryBars - 1);
        writeEvent({
          type: "session-gap",
          at: Date.now(),
          currentBarTs: live.ts,
          latestClosedTs,
          gapBars,
          note: "No overnight or missed-boundary fill was simulated.",
        });
      } else {
        state.barsSinceDecision++;
        if (state.barsSinceDecision >= freeze.cadence.decisionEveryBars) {
          targets = await decide(state, closedBySymbol);
          fills = executeTargets(state, current, targets);
        }
      }
      saveState(state);

      const openPrices = Object.fromEntries(state.symbols.map((s) => [s, current[s]!.open])) as Record<string, number>;
      const exposures = exposureMap(state, openPrices);
      const gross = Object.values(exposures).reduce((sum, x) => sum + Math.abs(x), 0);
      console.log(
        new Date(live.ts).toISOString() +
        " · stock · equity $" + markEquity(state, openPrices).toFixed(2) +
        " · gross " + gross.toFixed(3) +
        (gapBars > 1 ? " · session/missed-bar reset" : "") +
        (targets ? " · decision and same-boundary fill simulation" : " · no decision this bar") +
        (fills.length ? " · fills " + fills.length : "") +
        (borrow > 0 ? " · borrow $" + borrow.toFixed(6) : "")
      );
    } else if (!live) {
      console.log("stock market closed or no synchronized live regular-session bar · no simulated action");
    }
  } catch (e) {
    console.error("frozen Yahoo stock paper loop:", (e as Error).message);
  }

  if (cycles !== 0 && cycle >= cycles) break;
  await Bun.sleep(pollMs);
}

if (state) {
  console.log(
    "state " + statePath +
    " · freeze " + freezeSha256.slice(0, 12) +
    " · symbols " + state.symbols.length +
    " · cache hits " + cache.hits +
    " · misses " + cache.misses +
    " · new " + evaluator.newEvaluations +
    " · fresh tokens " + evaluator.newInputTokens +
    " · fees $" + state.fees.toFixed(4) +
    " · borrow $" + state.borrowCost.toFixed(6)
  );
}
