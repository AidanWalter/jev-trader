import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CachedEvaluator, JsonlSignalCache } from "./cache";
import { BudgetedEvaluator, defaultSpendBudget, remainingSpendBudget, SpendBudgetExceededError, SpendBudgetLedger } from "./budget";
import { createReplayEvaluator } from "./evaluator";
import { defaultFeatureConfig } from "./features";
import { buildPortfolioFeatureStates } from "./portfolio-features";
import { choosePolicyAction } from "./policy";
import { classifyLiveBoundary } from "./live-boundary";
import { allocatePortfolioTargets, type PortfolioCandidate } from "./portfolio";
import type { InputProfile } from "./profiles";
import type { PolicyConfig, MarketBar } from "./types";

interface FreezeRecord {
  version: "portfolio-apparatus-freeze-v1";
  universe: {
    symbols: string[];
    intervalMs: number;
    kinds: Record<string, string>;
    spreadsBps: Record<string, number | null>;
  };
  evaluator: { kind: string; namespace: string; profile: InputProfile };
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
  portfolio: { topN: number; maxGrossExposure: number; maxAssetExposure: number };
  policy: PolicyConfig;
}

interface PaperState {
  version: "frozen-hyperliquid-portfolio-paper-v1";
  freezeSha256: string;
  evaluatorNamespace: string;
  symbols: string[];
  interval: string;
  cash: number;
  quantities: Record<string, number>;
  fees: number;
  fundingNet: number;
  paidRequests?: number;
  paidInputTokens?: number;
  lastOpenTs: number;
  lastDecisionTs: number | null;
  barsSinceDecision: number;
  startedAt: number;
}

type FetchedBars = { symbol: string; closed: MarketBar[]; current: MarketBar };

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
if (freeze.universe.symbols.some((s) => freeze.universe.kinds[s] !== "perp")) {
  throw new Error("Hyperliquid frozen paper runner requires a perpetual-only frozen universe");
}

const freezeHasher = new Bun.CryptoHasher("sha256");
freezeHasher.update(freezeBytes);
const freezeSha256 = freezeHasher.digest("hex");

const intervalMap = new Map<number, string>([
  [60_000, "1m"], [180_000, "3m"], [300_000, "5m"], [900_000, "15m"],
  [1_800_000, "30m"], [3_600_000, "1h"], [7_200_000, "2h"], [14_400_000, "4h"],
  [28_800_000, "8h"], [43_200_000, "12h"], [86_400_000, "1d"],
]);
const intervalCandidate = flag("interval", intervalMap.get(freeze.universe.intervalMs));
if (!intervalCandidate) throw new Error("could not map frozen interval to a Hyperliquid candle interval");
const interval = intervalCandidate;

const statePath = flag("state", "data/frozen-hyperliquid-portfolio-paper.json")!;
const eventsPath = flag("events", "data/frozen-hyperliquid-portfolio-paper-events.jsonl")!;
const cachePath = flag("cache", "data/portfolio-pilot-cache.jsonl")!;
const pollMs = Math.max(1000, Number(flag("poll-ms", "5000")));
const cycles = Math.max(0, Number(flag("cycles", "0")));
const historyBars = Math.max(200, Number(flag("history-bars", "500")));
const paidModel = freeze.evaluator.kind.startsWith("jev");
if (paidModel && flag("confirm-paid", "false") !== "true") {
  throw new Error("paid Jev live paper is locked; pass --confirm-paid=true with explicit spend caps");
}
const lifetimeMaxNewEvaluations = Math.max(
  0,
  Number(flag("max-new-evals", paidModel ? "12" : "1000000000")),
);
const lifetimeMaxPaidRequests = Math.max(0, Number(flag("max-paid-requests", "12")));
const lifetimeMaxInputTokens = Math.max(0, Number(flag("max-input-tokens", "30000")));
const lifetimeMaxUsd = Math.max(0, Number(flag("max-usd", "0.002")));
const usdPerMTok = Number(flag("usd-per-mtok", "0.042"));
const reserveTokensPerRequest = Math.max(1, Number(flag("reserve-tokens-per-request", "2000")));

let priorPaidRequests = 0;
let priorPaidInputTokens = 0;
if (paidModel && existsSync(statePath)) {
  try {
    const prior = JSON.parse(readFileSync(statePath, "utf8")) as Partial<PaperState>;
    if (prior.freezeSha256 === freezeSha256 && prior.evaluatorNamespace === freeze.evaluator.namespace) {
      priorPaidRequests = Math.max(0, Number(prior.paidRequests ?? 0));
      priorPaidInputTokens = Math.max(0, Number(prior.paidInputTokens ?? 0));
    }
  } catch {
    // loadState() below remains authoritative.
  }
}

const lifetimeBudget = defaultSpendBudget({
  maxRequests: lifetimeMaxPaidRequests,
  maxInputTokens: lifetimeMaxInputTokens,
  maxUsd: lifetimeMaxUsd,
  usdPerMTok,
  reserveTokensPerRequest,
});
const remainingBudget = paidModel
  ? remainingSpendBudget(lifetimeBudget, {
      requests: priorPaidRequests,
      inputTokens: priorPaidInputTokens,
    })
  : null;
const remainingNewEvaluations = paidModel
  ? Math.max(
      0,
      Math.min(
        lifetimeMaxNewEvaluations - priorPaidRequests,
        remainingBudget?.maxRequests ?? 0,
      ),
    )
  : lifetimeMaxNewEvaluations;

if (paidModel && (!remainingBudget || remainingNewEvaluations <= 0)) {
  throw new SpendBudgetExceededError("paid Jev live-paper lifetime budget is exhausted for this persisted state");
}

const spendLedger = paidModel && remainingBudget ? new SpendBudgetLedger(remainingBudget) : null;
const raw = createReplayEvaluator(freeze.evaluator.kind, freeze.evaluator.profile);
if (raw.name !== freeze.evaluator.namespace) throw new Error("evaluator namespace differs from frozen apparatus");
const paidRaw = spendLedger ? new BudgetedEvaluator(raw, spendLedger) : raw;
const cache = new JsonlSignalCache(cachePath);
const evaluator = new CachedEvaluator(paidRaw, cache, remainingNewEvaluations);

const featureConfig = {
  ...defaultFeatureConfig,
  horizonBars: freeze.features.horizonBars,
  spreadBpsFallback: freeze.execution.spreadBpsFallback,
  directionThresholdBpsFloor: freeze.features.directionThresholdBpsFloor,
  directionThresholdFixedCostBps: freeze.features.directionThresholdFixedCostBps,
};

const coinFor = (symbol: string) => symbol.replace(/USDT$/i, "").replace(/USD$/i, "");
const spreadFor = (symbol: string) => {
  const x = freeze.universe.spreadsBps[symbol];
  return Number.isFinite(x) ? Number(x) : freeze.execution.spreadBpsFallback;
};

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
    state.version !== "frozen-hyperliquid-portfolio-paper-v1" ||
    state.freezeSha256 !== freezeSha256 ||
    state.evaluatorNamespace !== freeze.evaluator.namespace ||
    state.interval !== interval ||
    state.symbols.join("|") !== freeze.universe.symbols.join("|")
  ) throw new Error("Hyperliquid paper state does not match frozen apparatus");
  state.paidRequests = Math.max(0, Number(state.paidRequests ?? 0));
  state.paidInputTokens = Math.max(0, Number(state.paidInputTokens ?? 0));
  return state;
}

function syncPaidSpend(state: PaperState) {
  if (!spendLedger) return;
  const snap = spendLedger.snapshot();
  state.paidRequests = priorPaidRequests + snap.requestsStarted;
  state.paidInputTokens = priorPaidInputTokens + snap.inputTokens;
  saveState(state);
}

async function postInfo<T>(body: unknown): Promise<T> {
  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error("Hyperliquid HTTP " + res.status + ": " + text.slice(0, 300));
  return JSON.parse(text) as T;
}

async function fetchFunding(coin: string, startTime: number, endTime: number) {
  const rows = await postInfo<{ time: number; fundingRate: string }[]>({
    type: "fundingHistory",
    coin,
    startTime,
    endTime,
  });
  return rows
    .map((x) => ({ ts: Number(x.time), rateBps: Number(x.fundingRate) * 10_000 }))
    .filter((x) => Number.isFinite(x.ts) && Number.isFinite(x.rateBps))
    .sort((a, b) => a.ts - b.ts);
}

async function fetchSymbolBars(symbol: string): Promise<FetchedBars> {
  const now = Date.now();
  const coin = coinFor(symbol);
  const startTime = now - historyBars * freeze.universe.intervalMs;
  const candles = await postInfo<any[]>({
    type: "candleSnapshot",
    req: { coin, interval, startTime, endTime: now },
  });
  if (candles.length < featureConfig.minHistoryBars + 2) {
    throw new Error(symbol + " has insufficient Hyperliquid candle history");
  }

  const parsed = candles
    .map((x) => ({
      bar: {
        ts: Number(x.t),
        symbol,
        kind: "perp" as const,
        open: Number(x.o),
        high: Number(x.h),
        low: Number(x.l),
        close: Number(x.c),
        volume: Number(x.v),
        spreadBps: spreadFor(symbol),
        fundingBps: 0,
      } satisfies MarketBar,
      closeTime: Number(x.T),
    }))
    .filter((x) =>
      Number.isFinite(x.bar.ts) &&
      [x.bar.open, x.bar.high, x.bar.low, x.bar.close, x.bar.volume].every(Number.isFinite)
    )
    .sort((a, b) => a.bar.ts - b.bar.ts);

  const funding = await fetchFunding(coin, parsed[0]!.bar.ts, now);
  for (const event of funding) {
    const target = parsed.find((x) => x.bar.ts >= event.ts);
    if (target) target.bar.fundingBps = (target.bar.fundingBps ?? 0) + event.rateBps;
  }

  const currentRow = parsed.at(-1)!;
  if (!(currentRow.closeTime > now)) {
    throw new Error(symbol + " Hyperliquid response has no currently open candle");
  }
  return {
    symbol,
    closed: parsed.slice(0, -1).filter((x) => x.closeTime <= now).map((x) => x.bar),
    current: currentRow.bar,
  };
}

function alignLiveHistory(fetched: FetchedBars[]) {
  const currentTs = fetched[0]!.current.ts;
  if (fetched.some((x) => x.current.ts !== currentTs)) throw new Error("Hyperliquid current bars are not synchronized");
  let common = new Set(fetched[0]!.closed.map((b) => b.ts));
  for (const f of fetched.slice(1)) {
    const ts = new Set(f.closed.map((b) => b.ts));
    common = new Set([...common].filter((x) => ts.has(x)));
  }
  const timestamps = [...common].sort((a, b) => a - b);
  if (timestamps.length < featureConfig.minHistoryBars + 1) throw new Error("not enough synchronized Hyperliquid closed bars");
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
  return Object.fromEntries(state.symbols.map((symbol) => [
    symbol,
    equity > 0 ? (state.quantities[symbol] ?? 0) * prices[symbol]! / equity : 0,
  ])) as Record<string, number>;
}

function accrueFunding(
  state: PaperState,
  closedBySymbol: Map<string, MarketBar[]>,
  currents: Record<string, MarketBar>,
) {
  const ts = currents[state.symbols[0]!]!.ts;
  if (state.lastOpenTs <= 0 || ts <= state.lastOpenTs) return 0;
  let funding = 0;
  for (const symbol of state.symbols) {
    const q = state.quantities[symbol] ?? 0;
    if (q === 0) continue;
    const bars = [
      ...closedBySymbol.get(symbol)!.filter((b) => b.ts > state.lastOpenTs && b.ts < ts),
      currents[symbol]!,
    ];
    for (const bar of bars) {
      const rate = bar.fundingBps ?? 0;
      if (!rate) continue;
      const pnl = -q * bar.open * rate / 10_000;
      state.cash += pnl;
      state.fundingNet += pnl;
      funding += pnl;
      writeEvent({
        type: "funding",
        at: Date.now(),
        venue: "hyperliquid",
        barTs: bar.ts,
        symbol,
        quantity: q,
        price: bar.open,
        fundingBps: rate,
        pnl,
        cumulativeFundingNet: state.fundingNet,
      });
    }
  }
  return funding;
}

function executeTargets(
  state: PaperState,
  currents: Record<string, MarketBar>,
  requestedTargets: Record<string, number>,
) {
  const prices = Object.fromEntries(state.symbols.map((s) => [s, currents[s]!.open])) as Record<string, number>;
  const beforeEquity = markEquity(state, prices);
  if (!(beforeEquity > 0)) throw new Error("Hyperliquid paper equity is non-positive");
  const fills: any[] = [];

  for (const symbol of state.symbols) {
    const current = currents[symbol]!;
    const currentQ = state.quantities[symbol] ?? 0;
    let target = requestedTargets[symbol] ?? 0;
    target = Math.max(-freeze.portfolio.maxAssetExposure, Math.min(freeze.portfolio.maxAssetExposure, target));
    if (!freeze.execution.allowShort) target = Math.max(0, target);
    const targetQty = beforeEquity * target / current.open;
    const delta = targetQty - currentQ;
    if (Math.abs(delta * current.open) < freeze.execution.minTradeNotional) continue;

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
      venue: "hyperliquid",
      at: Date.now(),
      decisionTs: state.lastDecisionTs,
      executionTs: current.ts,
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
  const equity = markEquity(state, closePrices);
  if (!(equity > 0)) throw new Error("Hyperliquid paper equity is non-positive before decision");
  const currentExposures = exposureMap(state, closePrices);
  const series = state.symbols.map((symbol) => ({ symbol, bars: closedBySymbol.get(symbol)! }));
  const featureIndex = series[0]!.bars.length - 1;
  const featureStates = buildPortfolioFeatureStates(series, featureIndex, featureConfig);

  const candidates: PortfolioCandidate[] = [];
  const details: Record<string, unknown> = {};
  let decisionTs: number | null = null;
  for (const symbol of state.symbols) {
    const features = featureStates.get(symbol);
    if (!features) throw new Error("could not construct Hyperliquid feature state for " + symbol);
    if (decisionTs === null) decisionTs = features.ts;
    else if (decisionTs !== features.ts) throw new Error("Hyperliquid feature states are not synchronized");

    let signal;
    try {
      signal = await evaluator.evaluate(features);
    } finally {
      syncPaidSpend(state);
    }
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
    venue: "hyperliquid",
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
        version: "frozen-hyperliquid-portfolio-paper-v1",
        freezeSha256,
        evaluatorNamespace: freeze.evaluator.namespace,
        symbols: [...freeze.universe.symbols],
        interval,
        cash: freeze.execution.initialCash,
        quantities: Object.fromEntries(freeze.universe.symbols.map((s) => [s, 0])),
        fees: 0,
        fundingNet: 0,
        paidRequests: 0,
        paidInputTokens: 0,
        lastOpenTs: currentTs,
        lastDecisionTs: null,
        barsSinceDecision: Math.max(0, freeze.cadence.decisionEveryBars - 1),
        startedAt: Date.now(),
      };
      const prices = Object.fromEntries(state.symbols.map((s) => [s, currents[s]!.open])) as Record<string, number>;
      writeEvent({
        type: "initialized",
        venue: "hyperliquid",
        at: Date.now(),
        barTs: currentTs,
        symbols: state.symbols,
        equity: markEquity(state, prices),
        freezeSha256,
        note: "Read-only forward paper. No exchange order endpoint is used.",
      });
      saveState(state);
      console.log("initialized frozen Hyperliquid paper · " + state.symbols.join(",") + " · equity $" + markEquity(state, prices).toFixed(2));
    } else if (currentTs > state.lastOpenTs) {
      const latestClosedTs = closedBySymbol.get(state.symbols[0]!)!.at(-1)!.ts;
      const boundary = classifyLiveBoundary(state.lastOpenTs, currentTs, latestClosedTs, freeze.universe.intervalMs);
      const funding = accrueFunding(state, closedBySymbol, currents);
      state.lastOpenTs = currentTs;

      let targets: Record<string, number> | null = null;
      let fills: any[] = [];
      if (!boundary.clean) {
        state.barsSinceDecision = Math.max(0, freeze.cadence.decisionEveryBars - 1);
        writeEvent({
          type: "resume-gap",
          venue: "hyperliquid",
          at: Date.now(),
          currentBarTs: currentTs,
          gapBars: boundary.gapBars,
          note: "No retroactive fill or decision was simulated after missed bar boundaries.",
        });
      } else {
        state.barsSinceDecision++;
        if (state.barsSinceDecision >= freeze.cadence.decisionEveryBars) {
          targets = await decide(state, closedBySymbol);
          fills = executeTargets(state, currents, targets);
        }
      }
      saveState(state);

      const prices = Object.fromEntries(state.symbols.map((s) => [s, currents[s]!.open])) as Record<string, number>;
      const exposures = exposureMap(state, prices);
      const gross = Object.values(exposures).reduce((sum, x) => sum + Math.abs(x), 0);
      console.log(
        new Date(currentTs).toISOString() +
        " · hyperliquid perp · equity $" + markEquity(state, prices).toFixed(2) +
        " · gross " + gross.toFixed(3) +
        (!boundary.clean ? " · boundary reset" : "") +
        (targets ? " · decision and fill simulation" : " · no decision this bar") +
        (fills.length ? " · fills " + fills.length : "") +
        (funding !== 0 ? " · funding $" + funding.toFixed(6) : "")
      );
    }
  } catch (e) {
    const error = e as Error;
    const message = error.message ?? String(e);
    console.error("frozen Hyperliquid paper loop:", message);
    if (
      e instanceof SpendBudgetExceededError ||
      (paidModel && /(^|\D)402(\D|$)|no available api credits|payment required/i.test(message))
    ) {
      console.error("paid Jev live paper stopped before any further provider call");
      break;
    }
  }

  if (cycles !== 0 && cycle >= cycles) break;
  await Bun.sleep(pollMs);
}

if (state) {
  console.log(
    "state " + statePath +
    " · freeze " + freezeSha256.slice(0, 12) +
    " · cache hits " + cache.hits +
    " · misses " + cache.misses +
    " · new " + evaluator.newEvaluations +
    " · fresh tokens " + evaluator.newInputTokens +
    (paidModel
      ? " · lifetime paid requests " + (state.paidRequests ?? 0) +
        " · lifetime input tokens " + (state.paidInputTokens ?? 0) +
        " · lifetime paid $" + (((state.paidInputTokens ?? 0) / 1_000_000) * usdPerMTok).toFixed(6)
      : "") +
    " · fees $" + state.fees.toFixed(4) +
    " · funding $" + state.fundingNet.toFixed(6)
  );
}
