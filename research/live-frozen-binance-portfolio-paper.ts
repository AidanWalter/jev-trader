import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CachedEvaluator, JsonlSignalCache } from "./cache";
import { createReplayEvaluator } from "./evaluator";
import { buildFeatureState, defaultFeatureConfig } from "./features";
import { choosePolicyAction } from "./policy";
import { allocatePortfolioTargets, type PortfolioCandidate } from "./portfolio";
import type { InputProfile } from "./profiles";
import type { PolicyConfig, MarketBar } from "./types";

interface FreezeRecord {
  version: "portfolio-apparatus-freeze-v1";
  fingerprint: { combinedSha256: string };
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
  version: "frozen-binance-portfolio-paper-v1";
  freezeSha256: string;
  evaluatorNamespace: string;
  symbols: string[];
  interval: string;
  cash: number;
  quantities: Record<string, number>;
  fees: number;
  borrowCost: number;
  lastOpenTs: number;
  pendingTargets: Record<string, number> | null;
  lastDecisionTs: number | null;
  barsSinceDecision: number;
  startedAt: number;
}

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const prefix = "--" + name + "=";
  const hit = args.find((x) => x.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
};

const freezePath = args.find((x) => !x.startsWith("--")) ?? "data/portfolio-apparatus-freeze.json";
const freezeBytes = readFileSync(freezePath);
const freeze = JSON.parse(freezeBytes.toString("utf8")) as FreezeRecord;
if (freeze.version !== "portfolio-apparatus-freeze-v1") throw new Error("unsupported freeze version");
if (!freeze.universe.symbols.length) throw new Error("frozen universe is empty");
for (const symbol of freeze.universe.symbols) {
  if (freeze.universe.kinds[symbol] !== "spot") {
    throw new Error("frozen Binance portfolio paper runner currently supports spot datasets only");
  }
}

const freezeHasher = new Bun.CryptoHasher("sha256");
freezeHasher.update(freezeBytes);
const freezeSha256 = freezeHasher.digest("hex");

const intervalMap = new Map<number, string>([
  [60_000, "1m"], [180_000, "3m"], [300_000, "5m"], [900_000, "15m"],
  [1_800_000, "30m"], [3_600_000, "1h"], [7_200_000, "2h"], [14_400_000, "4h"],
  [21_600_000, "6h"], [28_800_000, "8h"], [43_200_000, "12h"], [86_400_000, "1d"],
]);
const intervalCandidate = flag("interval", intervalMap.get(freeze.universe.intervalMs));
if (!intervalCandidate) throw new Error("could not map frozen portfolio interval to Binance interval; pass --interval explicitly");
const interval = intervalCandidate;

const statePath = flag("state", "data/frozen-portfolio-paper.json")!;
const eventsPath = flag("events", "data/frozen-portfolio-paper-events.jsonl")!;
const cachePath = flag("cache", "data/portfolio-pilot-cache.jsonl")!;
const pollMs = Math.max(1000, Number(flag("poll-ms", "5000")));
const cycles = Math.max(0, Number(flag("cycles", "0")));
const maxNewEvaluations = Math.max(
  0,
  Number(flag("max-new-evals", freeze.evaluator.kind === "jev" ? "5000" : "1000000000")),
);

const raw = createReplayEvaluator(freeze.evaluator.kind, freeze.evaluator.profile);
if (raw.name !== freeze.evaluator.namespace) throw new Error("evaluator namespace differs from frozen portfolio apparatus");
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
    state.version !== "frozen-binance-portfolio-paper-v1" ||
    state.freezeSha256 !== freezeSha256 ||
    state.evaluatorNamespace !== freeze.evaluator.namespace ||
    state.interval !== interval ||
    state.symbols.join("|") !== freeze.universe.symbols.join("|")
  ) throw new Error("portfolio paper state does not match the frozen apparatus");
  return state;
}

type FetchedBars = { symbol: string; closed: MarketBar[]; current: MarketBar };

async function fetchSymbolBars(symbol: string, limit = 250): Promise<FetchedBars> {
  const url = new URL("https://data-api.binance.vision/api/v3/klines");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(limit));
  const res = await fetch(url);
  if (!res.ok) throw new Error(symbol + " Binance HTTP " + res.status + ": " + (await res.text()).slice(0, 200));
  const rows = await res.json() as unknown[][];
  if (rows.length < featureConfig.minHistoryBars + 2) throw new Error(symbol + " has insufficient live history");
  const now = Date.now();
  const parsed = rows.map((r): { bar: MarketBar; closeTime: number } => ({
    bar: {
      ts: Number(r[0]),
      symbol,
      kind: "spot",
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
      spreadBps: spreadFor(symbol),
    },
    closeTime: Number(r[6]),
  }));
  const currentRow = parsed.at(-1)!;
  if (currentRow.closeTime <= now) throw new Error(symbol + " latest Binance kline is unexpectedly already closed");
  return {
    symbol,
    closed: parsed.slice(0, -1).filter((x) => x.closeTime <= now).map((x) => x.bar),
    current: currentRow.bar,
  };
}

function alignLiveHistory(fetched: FetchedBars[]) {
  const currentTs = fetched[0]!.current.ts;
  if (fetched.some((x) => x.current.ts !== currentTs)) {
    throw new Error("live universe current bars are not synchronized");
  }
  let common = new Set(fetched[0]!.closed.map((b) => b.ts));
  for (const f of fetched.slice(1)) {
    const ts = new Set(f.closed.map((b) => b.ts));
    common = new Set([...common].filter((x) => ts.has(x)));
  }
  const timestamps = [...common].sort((a, b) => a - b);
  if (timestamps.length < featureConfig.minHistoryBars + 1) throw new Error("not enough synchronized closed bars across live universe");
  const closedBySymbol = new Map<string, MarketBar[]>();
  for (const f of fetched) {
    const byTs = new Map(f.closed.map((b) => [b.ts, b]));
    closedBySymbol.set(f.symbol, timestamps.map((ts) => byTs.get(ts)!).filter(Boolean));
  }
  return { currentTs, closedBySymbol };
}

function markEquity(state: PaperState, prices: Record<string, number>) {
  let equity = state.cash;
  for (const symbol of state.symbols) equity += (state.quantities[symbol] ?? 0) * prices[symbol]!;
  return equity;
}

function exposureMap(state: PaperState, prices: Record<string, number>) {
  const equity = markEquity(state, prices);
  const out: Record<string, number> = {};
  for (const symbol of state.symbols) {
    out[symbol] = equity > 0 ? (state.quantities[symbol] ?? 0) * prices[symbol]! / equity : 0;
  }
  return out;
}

function accrueCarryingCosts(state: PaperState, currents: Record<string, MarketBar>) {
  if (state.lastOpenTs <= 0) return 0;
  const ts = currents[state.symbols[0]!]!.ts;
  if (ts <= state.lastOpenTs) return 0;
  const days = (ts - state.lastOpenTs) / 86_400_000;
  let total = 0;
  for (const symbol of state.symbols) {
    const q = state.quantities[symbol] ?? 0;
    if (q >= 0) continue;
    const price = currents[symbol]!.open;
    const cost = Math.abs(q * price) * freeze.execution.shortBorrowBpsPerDay / 10_000 * days;
    if (cost <= 0) continue;
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

function executePending(state: PaperState, currents: Record<string, MarketBar>) {
  if (!state.pendingTargets) return [];
  const openPrices = Object.fromEntries(state.symbols.map((s) => [s, currents[s]!.open])) as Record<string, number>;
  const beforeEquity = markEquity(state, openPrices);
  if (!(beforeEquity > 0)) throw new Error("portfolio paper equity is non-positive");

  const fills: any[] = [];
  for (const symbol of state.symbols) {
    const current = currents[symbol]!;
    const currentQ = state.quantities[symbol] ?? 0;
    let target = state.pendingTargets[symbol] ?? 0;
    target = Math.max(-freeze.portfolio.maxAssetExposure, Math.min(freeze.portfolio.maxAssetExposure, target));
    if (!freeze.execution.allowShort) target = Math.max(0, target);
    const targetQty = beforeEquity * target / current.open;
    const delta = targetQty - currentQ;
    const estimatedNotional = Math.abs(delta * current.open);
    if (estimatedNotional < freeze.execution.minTradeNotional) continue;

    const side = delta > 0 ? "buy" : "sell";
    const frictionBps =
      spreadFor(symbol) * freeze.execution.spreadCostMultiplier / 2 +
      freeze.execution.slippageBps;
    const price = current.open * (1 + (side === "buy" ? 1 : -1) * frictionBps / 10_000);
    const notional = Math.abs(delta * price);
    const fee = notional * freeze.execution.feeBps / 10_000;
    state.cash -= delta * price + fee;
    state.quantities[symbol] = currentQ + delta;
    state.fees += fee;
    const fill = {
      type: "fill",
      at: Date.now(),
      barTs: current.ts,
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
  state.pendingTargets = null;
  return fills;
}

async function decide(
  state: PaperState,
  closedBySymbol: Map<string, MarketBar[]>,
) {
  const closePrices: Record<string, number> = {};
  for (const symbol of state.symbols) closePrices[symbol] = closedBySymbol.get(symbol)!.at(-1)!.close;
  const equity = markEquity(state, closePrices);
  if (!(equity > 0)) throw new Error("portfolio paper equity is non-positive before decision");
  const currentExposures = exposureMap(state, closePrices);

  const candidates: PortfolioCandidate[] = [];
  const details: Record<string, unknown> = {};
  let decisionTs: number | null = null;

  for (const symbol of state.symbols) {
    const closed = closedBySymbol.get(symbol)!;
    const i = closed.length - 1;
    const features = buildFeatureState(closed, i, featureConfig);
    if (!features) throw new Error("could not construct live feature state for " + symbol);
    if (decisionTs === null) decisionTs = features.ts;
    else if (features.ts !== decisionTs) throw new Error("live decision features are not timestamp-aligned");

    const signal = await evaluator.evaluate(features);
    const roundTripCostBps =
      features.spreadBps * freeze.execution.spreadCostMultiplier +
      2 * freeze.execution.slippageBps +
      2 * freeze.execution.feeBps;
    const currentExposure = currentExposures[symbol] ?? 0;
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

  const targetsMap = allocatePortfolioTargets(
    candidates,
    freeze.portfolio.topN,
    freeze.portfolio.maxGrossExposure,
    freeze.portfolio.maxAssetExposure,
    freeze.execution.allowShort,
  );
  const targets = Object.fromEntries(state.symbols.map((s) => [s, targetsMap.get(s) ?? 0]));
  state.pendingTargets = targets;
  state.lastDecisionTs = decisionTs;
  state.barsSinceDecision = 0;

  writeEvent({
    type: "portfolio-decision",
    at: Date.now(),
    barTs: decisionTs,
    equity,
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
    const fetched = await Promise.all(freeze.universe.symbols.map((s) => fetchSymbolBars(s)));
    const { currentTs, closedBySymbol } = alignLiveHistory(fetched);
    const currents = Object.fromEntries(fetched.map((x) => [x.symbol, x.current])) as Record<string, MarketBar>;

    if (!state) {
      state = {
        version: "frozen-binance-portfolio-paper-v1",
        freezeSha256,
        evaluatorNamespace: freeze.evaluator.namespace,
        symbols: [...freeze.universe.symbols],
        interval,
        cash: freeze.execution.initialCash,
        quantities: Object.fromEntries(freeze.universe.symbols.map((s) => [s, 0])),
        fees: 0,
        borrowCost: 0,
        lastOpenTs: currentTs,
        pendingTargets: null,
        lastDecisionTs: null,
        barsSinceDecision: Math.max(0, freeze.cadence.decisionEveryBars - 1),
        startedAt: Date.now(),
      };
      const openPrices = Object.fromEntries(state.symbols.map((s) => [s, currents[s]!.open])) as Record<string, number>;
      writeEvent({
        type: "initialized",
        at: Date.now(),
        barTs: currentTs,
        symbols: state.symbols,
        equity: markEquity(state, openPrices),
        freezeSha256,
        note: "Waiting for the next clean synchronized bar boundary before the first frozen portfolio decision.",
      });
      saveState(state);
      console.log(
        "initialized frozen portfolio " + state.symbols.join(",") + " " + interval +
        " · equity $" + markEquity(state, openPrices).toFixed(2)
      );
    } else if (currentTs > state.lastOpenTs) {
      const borrow = accrueCarryingCosts(state, currents);
      const fills = executePending(state, currents);
      state.lastOpenTs = currentTs;
      state.barsSinceDecision++;
      let targets: Record<string, number> | null = null;
      if (state.barsSinceDecision >= freeze.cadence.decisionEveryBars) {
        targets = await decide(state, closedBySymbol);
      }
      saveState(state);

      const openPrices = Object.fromEntries(state.symbols.map((s) => [s, currents[s]!.open])) as Record<string, number>;
      const exposures = exposureMap(state, openPrices);
      const gross = Object.values(exposures).reduce((sum, x) => sum + Math.abs(x), 0);
      console.log(
        new Date(currentTs).toISOString() +
        " · equity $" + markEquity(state, openPrices).toFixed(2) +
        " · gross " + gross.toFixed(3) +
        (targets ? " · decision" : " · no decision this bar") +
        (fills.length ? " · fills " + fills.length : "") +
        (borrow > 0 ? " · borrow $" + borrow.toFixed(6) : "")
      );
    }
  } catch (e) {
    console.error("frozen portfolio paper loop:", (e as Error).message);
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
