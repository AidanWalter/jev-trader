import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CachedEvaluator, JsonlSignalCache } from "./cache";
import { createReplayEvaluator } from "./evaluator";
import { buildFeatureState, defaultFeatureConfig } from "./features";
import { choosePolicyAction } from "./policy";
import type { InputProfile } from "./profiles";
import type { AssetKind, MarketBar, PolicyConfig } from "./types";

interface FreezeRecord {
  version: "apparatus-freeze-v1";
  dataset: {
    symbol: string;
    kind: AssetKind;
    intervalMs?: number;
  };
  evaluator: {
    kind: string;
    namespace: string;
    profile: InputProfile;
  };
  features: {
    horizonBars: number;
    directionThresholdBpsFloor?: number;
  };
  cadence: { decisionEveryBars: number };
  execution: {
    initialCash: number;
    spreadBps: number;
    feeBps: number;
    slippageBps: number;
    allowShort: boolean;
    shortBorrowBpsPerDay: number;
    maxGrossExposure: number;
    minTradeNotional: number;
  };
  policy: PolicyConfig;
}

interface PaperState {
  version: "frozen-binance-paper-v2";
  freezeSha256: string;
  evaluatorNamespace: string;
  symbol: string;
  interval: string;
  cash: number;
  quantity: number;
  fees: number;
  borrowCost: number;
  lastOpenTs: number;
  pendingTarget: number | null;
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
const freezePath = args.find((x) => !x.startsWith("--")) ?? "data/apparatus-freeze.json";
const freezeBytes = readFileSync(freezePath);
const freeze = JSON.parse(freezeBytes.toString("utf8")) as FreezeRecord;
if (freeze.version !== "apparatus-freeze-v1") throw new Error("unsupported freeze version");
if (freeze.dataset.kind !== "spot") throw new Error("frozen Binance paper runner currently supports spot datasets only");

const freezeHasher = new Bun.CryptoHasher("sha256");
freezeHasher.update(freezeBytes);
const freezeSha256 = freezeHasher.digest("hex");

const intervalMap = new Map<number, string>([
  [60_000, "1m"], [180_000, "3m"], [300_000, "5m"], [900_000, "15m"],
  [1_800_000, "30m"], [3_600_000, "1h"], [7_200_000, "2h"], [14_400_000, "4h"],
  [21_600_000, "6h"], [28_800_000, "8h"], [43_200_000, "12h"], [86_400_000, "1d"],
]);
const intervalMs = Number(flag("interval-ms", String(freeze.dataset.intervalMs ?? 0)));
const intervalCandidate = flag("interval", intervalMap.get(intervalMs));
if (!intervalCandidate) throw new Error("could not map frozen interval to Binance interval; pass --interval explicitly");
const interval: string = intervalCandidate;

const symbol = flag("symbol", freeze.dataset.symbol)!.toUpperCase();
if (symbol !== freeze.dataset.symbol.toUpperCase()) throw new Error("symbol differs from frozen apparatus");

const statePath = flag("state", "data/frozen-paper-" + symbol.toLowerCase() + ".json")!;
const eventsPath = flag("events", "data/frozen-paper-" + symbol.toLowerCase() + ".jsonl")!;
const cachePath = flag("cache", "data/jev-pilot-cache.jsonl")!;
const pollMs = Math.max(1000, Number(flag("poll-ms", "5000")));
const cycles = Math.max(0, Number(flag("cycles", "0")));
const maxNewEvaluations = Math.max(0, Number(flag("max-new-evals", freeze.evaluator.kind === "jev" ? "1000" : "1000000000")));

const raw = createReplayEvaluator(freeze.evaluator.kind, freeze.evaluator.profile);
if (raw.name !== freeze.evaluator.namespace) throw new Error("evaluator namespace differs from frozen apparatus");
const cache = new JsonlSignalCache(cachePath);
const evaluator = new CachedEvaluator(raw, cache, maxNewEvaluations);

const featureConfig = {
  ...defaultFeatureConfig,
  horizonBars: freeze.features.horizonBars,
  spreadBpsFallback: freeze.execution.spreadBps,
  directionThresholdBpsFloor: freeze.features.directionThresholdBpsFloor ?? 1,
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
  const s = JSON.parse(readFileSync(statePath, "utf8")) as PaperState;
  if (
    s.version !== "frozen-binance-paper-v2" ||
    s.freezeSha256 !== freezeSha256 ||
    s.evaluatorNamespace !== freeze.evaluator.namespace ||
    s.symbol !== symbol ||
    s.interval !== interval
  ) throw new Error("paper state does not match the frozen apparatus");
  return s;
}
function equity(state: PaperState, price: number) {
  return state.cash + state.quantity * price;
}
function exposure(state: PaperState, price: number) {
  const e = equity(state, price);
  return e > 0 ? state.quantity * price / e : 0;
}

async function fetchBars(limit = 250): Promise<{ closed: MarketBar[]; current: MarketBar }> {
  const url = new URL("https://data-api.binance.vision/api/v3/klines");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(limit));
  const res = await fetch(url);
  if (!res.ok) throw new Error("Binance HTTP " + res.status + ": " + (await res.text()).slice(0, 200));
  const rows = await res.json() as unknown[][];
  if (rows.length < featureConfig.minHistoryBars + 2) throw new Error("not enough Binance bars for frozen features");
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
      spreadBps: freeze.execution.spreadBps,
    },
    closeTime: Number(r[6]),
  }));
  const currentRow = parsed.at(-1)!;
  if (currentRow.closeTime <= now) throw new Error("latest Binance kline is unexpectedly already closed");
  return {
    closed: parsed.slice(0, -1).filter((x) => x.closeTime <= now).map((x) => x.bar),
    current: currentRow.bar,
  };
}

function accrueCarryingCosts(state: PaperState, current: MarketBar) {
  if (state.quantity >= 0 || current.ts <= state.lastOpenTs) return 0;
  const days = (current.ts - state.lastOpenTs) / 86_400_000;
  const cost =
    Math.abs(state.quantity * current.open) *
    freeze.execution.shortBorrowBpsPerDay / 10_000 *
    days;
  if (cost > 0) {
    state.cash -= cost;
    state.borrowCost += cost;
    writeEvent({
      type: "borrow-cost",
      at: Date.now(),
      barTs: current.ts,
      quantity: state.quantity,
      price: current.open,
      days,
      cost,
      cumulativeBorrowCost: state.borrowCost,
    });
  }
  return cost;
}

function executePending(state: PaperState, current: MarketBar) {
  if (state.pendingTarget === null) return null;
  const beforeEquity = equity(state, current.open);
  if (!(beforeEquity > 0)) throw new Error("paper equity is non-positive");

  let target = Math.max(-freeze.execution.maxGrossExposure, Math.min(freeze.execution.maxGrossExposure, state.pendingTarget));
  if (!freeze.execution.allowShort) target = Math.max(0, target);
  const targetQty = beforeEquity * target / current.open;
  const delta = targetQty - state.quantity;
  const estimatedNotional = Math.abs(delta * current.open);
  if (estimatedNotional < freeze.execution.minTradeNotional) {
    state.pendingTarget = null;
    return null;
  }

  const side = delta > 0 ? "buy" : "sell";
  const frictionBps = freeze.execution.spreadBps / 2 + freeze.execution.slippageBps;
  const price = current.open * (1 + (side === "buy" ? 1 : -1) * frictionBps / 10_000);
  const notional = Math.abs(delta * price);
  const fee = notional * freeze.execution.feeBps / 10_000;
  state.cash -= delta * price + fee;
  state.quantity += delta;
  state.fees += fee;
  const fill = {
    type: "fill",
    at: Date.now(),
    barTs: current.ts,
    side,
    quantity: Math.abs(delta),
    price,
    notional,
    fee,
    targetExposure: target,
    equityAfter: equity(state, current.open),
  };
  state.pendingTarget = null;
  writeEvent(fill);
  return fill;
}

async function decide(state: PaperState, closed: MarketBar[]) {
  const i = closed.length - 1;
  const features = buildFeatureState(closed, i, featureConfig);
  if (!features) throw new Error("could not construct frozen live feature state");
  const signal = await evaluator.evaluate(features);
  const roundTripCostBps = features.spreadBps + 2 * freeze.execution.slippageBps + 2 * freeze.execution.feeBps;
  const action = choosePolicyAction(signal, exposure(state, closed[i]!.close), freeze.policy, {
    directionThresholdBps: features.directionThresholdBps,
    estimatedRoundTripCostBps: roundTripCostBps,
  });

  let target = action.kind === "target" ? action.targetExposure : exposure(state, closed[i]!.close);
  if (!freeze.execution.allowShort) target = Math.max(0, target);
  state.pendingTarget = target;
  state.lastDecisionTs = closed[i]!.ts;
  state.barsSinceDecision = 0;
  writeEvent({
    type: "decision",
    at: Date.now(),
    barTs: closed[i]!.ts,
    close: closed[i]!.close,
    equity: equity(state, closed[i]!.close),
    exposure: exposure(state, closed[i]!.close),
    signal,
    action,
    pendingTarget: target,
    freezeSha256,
  });
  return { action, target };
}

let state = loadState();
let cycle = 0;
while (cycles === 0 || cycle < cycles) {
  cycle++;
  try {
    const { closed, current } = await fetchBars();
    if (!state) {
      state = {
        version: "frozen-binance-paper-v2",
        freezeSha256,
        evaluatorNamespace: freeze.evaluator.namespace,
        symbol,
        interval,
        cash: freeze.execution.initialCash,
        quantity: 0,
        fees: 0,
        borrowCost: 0,
        lastOpenTs: current.ts,
        pendingTarget: null,
        lastDecisionTs: null,
        barsSinceDecision: Math.max(0, freeze.cadence.decisionEveryBars - 1),
        startedAt: Date.now(),
      };
      writeEvent({
        type: "initialized",
        at: Date.now(),
        barTs: current.ts,
        open: current.open,
        equity: equity(state, current.open),
        freezeSha256,
        note: "Waiting for the next clean bar boundary before the first frozen decision.",
      });
      saveState(state);
      console.log("initialized frozen " + symbol + " " + interval + " · equity $" + equity(state, current.open).toFixed(2));
    } else if (current.ts > state.lastOpenTs) {
      const borrow = accrueCarryingCosts(state, current);
      const fill = executePending(state, current);
      state.lastOpenTs = current.ts;
      state.barsSinceDecision++;
      let d: { action: unknown; target: number } | null = null;
      if (state.barsSinceDecision >= freeze.cadence.decisionEveryBars) d = await decide(state, closed);
      saveState(state);
      console.log(
        new Date(current.ts).toISOString() +
        " · equity $" + equity(state, current.open).toFixed(2) +
        " · exposure " + exposure(state, current.open).toFixed(3) +
        (d ? " · next target " + d.target.toFixed(3) : " · no decision this bar") +
        (fill ? " · filled " + fill.side + " $" + fill.notional.toFixed(2) : "") +
        (borrow > 0 ? " · borrow $" + borrow.toFixed(6) : "")
      );
    }
  } catch (e) {
    console.error("frozen paper loop:", (e as Error).message);
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
    " · fees $" + state.fees.toFixed(4) +
    " · borrow $" + state.borrowCost.toFixed(6)
  );
}
