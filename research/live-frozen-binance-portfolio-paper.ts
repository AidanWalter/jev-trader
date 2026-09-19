import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CachedEvaluator, JsonlSignalCache } from "./cache";
import { BudgetedEvaluator, defaultSpendBudget, SpendBudgetExceededError, SpendBudgetLedger } from "./budget";
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
  version: "frozen-binance-portfolio-paper-v3";
  freezeSha256: string;
  evaluatorNamespace: string;
  symbols: string[];
  interval: string;
  cash: number;
  quantities: Record<string, number>;
  fees: number;
  borrowCost: number;
  fundingNet: number;
  lastOpenTs: number;
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
const kinds = [...new Set(freeze.universe.symbols.map((symbol) => freeze.universe.kinds[symbol]))];
if (kinds.length !== 1 || (kinds[0] !== "spot" && kinds[0] !== "perp")) {
  throw new Error("frozen Binance portfolio paper runner requires a homogeneous spot or perpetual universe");
}
const marketKind = kinds[0] as "spot" | "perp";

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
const paidModel = freeze.evaluator.kind.startsWith("jev");
if (paidModel && flag("confirm-paid", "false") !== "true") {
  throw new Error("paid Jev live paper is locked; pass --confirm-paid=true with explicit spend caps");
}
const maxNewEvaluations = Math.max(
  0,
  Number(flag("max-new-evals", paidModel ? "12" : "1000000000")),
);
const spendLedger = paidModel
  ? new SpendBudgetLedger(defaultSpendBudget({
      maxRequests: Math.max(1, Number(flag("max-paid-requests", "12"))),
      maxInputTokens: Math.max(1, Number(flag("max-input-tokens", "30000"))),
      maxUsd: Math.max(0.000001, Number(flag("max-usd", "0.002"))),
      usdPerMTok: Number(flag("usd-per-mtok", "0.042")),
      reserveTokensPerRequest: Math.max(1, Number(flag("reserve-tokens-per-request", "2000"))),
    }))
  : null;

const raw = createReplayEvaluator(freeze.evaluator.kind, freeze.evaluator.profile);
if (raw.name !== freeze.evaluator.namespace) throw new Error("evaluator namespace differs from frozen portfolio apparatus");
const paidRaw = spendLedger ? new BudgetedEvaluator(raw, spendLedger) : raw;
const cache = new JsonlSignalCache(cachePath);
const evaluator = new CachedEvaluator(paidRaw, cache, maxNewEvaluations);

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
    state.version !== "frozen-binance-portfolio-paper-v3" ||
    state.freezeSha256 !== freezeSha256 ||
    state.evaluatorNamespace !== freeze.evaluator.namespace ||
    state.interval !== interval ||
    state.symbols.join("|") !== freeze.universe.symbols.join("|")
  ) throw new Error("portfolio paper state does not match the frozen apparatus");
  return state;
}

type FetchedBars = { symbol: string; closed: MarketBar[]; current: MarketBar };

async function fetchFundingHistory(symbol: string, startTime: number) {
  if (marketKind !== "perp") return [] as { ts: number; rateBps: number }[];
  const url = new URL("https://fapi.binance.com/fapi/v1/fundingRate");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("startTime", String(startTime));
  url.searchParams.set("limit", "1000");
  const res = await fetch(url);
  if (!res.ok) throw new Error(symbol + " Binance funding HTTP " + res.status + ": " + (await res.text()).slice(0, 200));
  const rows = await res.json() as { fundingTime: number; fundingRate: string }[];
  return rows
    .map((r) => ({ ts: Number(r.fundingTime), rateBps: Number(r.fundingRate) * 10_000 }))
    .filter((r) => Number.isFinite(r.ts) && Number.isFinite(r.rateBps))
    .sort((a, b) => a.ts - b.ts);
}

async function fetchSymbolBars(symbol: string, limit = 250): Promise<FetchedBars> {
  const base =
    marketKind === "perp"
      ? "https://fapi.binance.com/fapi/v1/klines"
      : "https://data-api.binance.vision/api/v3/klines";
  const url = new URL(base);
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
      kind: marketKind,
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
      spreadBps: spreadFor(symbol),
      fundingBps: 0,
    },
    closeTime: Number(r[6]),
  }));

  if (marketKind === "perp") {
    const funding = await fetchFundingHistory(symbol, parsed[0]!.bar.ts);
    for (const event of funding) {
      const target = parsed.find((x) => x.bar.ts >= event.ts);
      if (target) target.bar.fundingBps = (target.bar.fundingBps ?? 0) + event.rateBps;
    }
  }

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

function accrueCarryingCosts(
  state: PaperState,
  closedBySymbol: Map<string, MarketBar[]>,
  currents: Record<string, MarketBar>,
) {
  if (state.lastOpenTs <= 0) return { borrow: 0, funding: 0 };
  const ts = currents[state.symbols[0]!]!.ts;
  if (ts <= state.lastOpenTs) return { borrow: 0, funding: 0 };

  let borrow = 0;
  let funding = 0;

  if (marketKind === "spot") {
    const days = (ts - state.lastOpenTs) / 86_400_000;
    for (const symbol of state.symbols) {
      const q = state.quantities[symbol] ?? 0;
      if (q >= 0) continue;
      const price = currents[symbol]!.open;
      const cost = Math.abs(q * price) * freeze.execution.shortBorrowBpsPerDay / 10_000 * days;
      if (cost <= 0) continue;
      state.cash -= cost;
      state.borrowCost += cost;
      borrow += cost;
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
  } else {
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
  }

  return { borrow, funding };
}

function executeTargets(
  state: PaperState,
  currents: Record<string, MarketBar>,
  requestedTargets: Record<string, number>,
) {
  const openPrices = Object.fromEntries(state.symbols.map((s) => [s, currents[s]!.open])) as Record<string, number>;
  const beforeEquity = markEquity(state, openPrices);
  if (!(beforeEquity > 0)) throw new Error("portfolio paper equity is non-positive");

  const fills: any[] = [];
  for (const symbol of state.symbols) {
    const current = currents[symbol]!;
    const currentQ = state.quantities[symbol] ?? 0;
    let target = requestedTargets[symbol] ?? 0;
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

  const series = state.symbols.map((symbol) => ({ symbol, bars: closedBySymbol.get(symbol)! }));
  const featureIndex = series[0]!.bars.length - 1;
  const featureStates = buildPortfolioFeatureStates(series, featureIndex, featureConfig);

  for (const symbol of state.symbols) {
    const features = featureStates.get(symbol);
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
        version: "frozen-binance-portfolio-paper-v3",
        freezeSha256,
        evaluatorNamespace: freeze.evaluator.namespace,
        symbols: [...freeze.universe.symbols],
        interval,
        cash: freeze.execution.initialCash,
        quantities: Object.fromEntries(freeze.universe.symbols.map((s) => [s, 0])),
        fees: 0,
        borrowCost: 0,
        fundingNet: 0,
        lastOpenTs: currentTs,
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
        marketKind,
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
      const latestClosedTs = closedBySymbol.get(state.symbols[0]!)!.at(-1)!.ts;
      const boundary = classifyLiveBoundary(
        state.lastOpenTs,
        currentTs,
        latestClosedTs,
        freeze.universe.intervalMs,
      );
      const carrying = accrueCarryingCosts(state, closedBySymbol, currents);
      state.lastOpenTs = currentTs;

      let targets: Record<string, number> | null = null;
      let fills: any[] = [];
      if (!boundary.clean) {
        state.barsSinceDecision = Math.max(0, freeze.cadence.decisionEveryBars - 1);
        writeEvent({
          type: "resume-gap",
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

      const openPrices = Object.fromEntries(state.symbols.map((s) => [s, currents[s]!.open])) as Record<string, number>;
      const exposures = exposureMap(state, openPrices);
      const gross = Object.values(exposures).reduce((sum, x) => sum + Math.abs(x), 0);
      console.log(
        new Date(currentTs).toISOString() +
        " · " + marketKind +
        " · equity $" + markEquity(state, openPrices).toFixed(2) +
        " · gross " + gross.toFixed(3) +
        (boundary.gapBars > 1 ? " · boundary reset after " + boundary.gapBars + "-bar gap" : "") +
        (targets ? " · decision and same-boundary fill simulation" : " · no decision this bar") +
        (fills.length ? " · fills " + fills.length : "") +
        (carrying.borrow > 0 ? " · borrow $" + carrying.borrow.toFixed(6) : "") +
        (carrying.funding !== 0 ? " · funding $" + carrying.funding.toFixed(6) : "")
      );
    }
  } catch (e) {
    const error = e as Error;
    const message = error.message ?? String(e);
    console.error("frozen portfolio paper loop:", message);
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
    " · symbols " + state.symbols.length +
    " · cache hits " + cache.hits +
    " · misses " + cache.misses +
    " · new " + evaluator.newEvaluations +
    " · fresh tokens " + evaluator.newInputTokens +
    (spendLedger ? " · paid $" + spendLedger.snapshot().estimatedUsd.toFixed(6) : "") +
    " · fees $" + state.fees.toFixed(4) +
    " · borrow $" + state.borrowCost.toFixed(6) +
    " · funding $" + state.fundingNet.toFixed(6)
  );
}
