import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CachedEvaluator, JsonlSignalCache } from "./cache";
import { createReplayEvaluator } from "./evaluator";
import { buildFeatureState, defaultFeatureConfig } from "./features";
import { choosePolicyAction, defaultPolicyConfig } from "./policy";
import type { InputProfile } from "./profiles";
import type { MarketBar } from "./types";

interface PaperState {
  version: "binance-paper-v2";
  symbol: string;
  interval: string;
  evaluatorNamespace: string;
  cash: number;
  quantity: number;
  fees: number;
  lastOpenTs: number;
  pendingTarget: number | null;
  lastDecisionTs: number | null;
  startedAt: number;
}

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const prefix = "--" + name + "=";
  const hit = args.find((x) => x.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
};

const symbol = flag("symbol", "BTCUSDT")!.toUpperCase();
const interval = flag("interval", "5m")!;
const modelName = flag("model", "mock")!;
const profile = flag("profile", "full") as InputProfile;
const statePath = flag("state", "data/live-paper-" + symbol.toLowerCase() + ".json")!;
const eventsPath = flag("events", "data/live-paper-" + symbol.toLowerCase() + ".jsonl")!;
const cachePath = flag("cache", "data/jev-cache.jsonl")!;
const pollMs = Math.max(1000, Number(flag("poll-ms", "5000")));
const cycles = Math.max(0, Number(flag("cycles", "0"))); // 0 means run continuously
const horizonBars = Math.max(1, Number(flag("horizon", "12")));
const initialCash = Number(flag("cash", "100"));
const feeBps = Number(flag("fee-bps", "4"));
const spreadBps = Number(flag("spread-bps", "4"));
const slippageBps = Number(flag("slippage-bps", "1"));
const allowShort = flag("allow-short", "true") !== "false";
const maxNewEvaluations = Math.max(0, Number(flag("max-new-evals", modelName === "jev" ? "1000" : "1000000000")));
const directionThresholdBpsFloor = Number(flag(
  "direction-threshold-bps",
  String(spreadBps + 2 * slippageBps + 2 * feeBps),
));

const featureConfig = {
  ...defaultFeatureConfig,
  horizonBars,
  spreadBpsFallback: spreadBps,
  directionThresholdBpsFloor,
};
const policy = {
  ...defaultPolicyConfig,
  minDirectionalEdge: Number(flag("min-edge", String(defaultPolicyConfig.minDirectionalEdge))),
  minDirectionalConfidence: Number(flag("min-confidence", String(defaultPolicyConfig.minDirectionalConfidence))),
  flatExitProbability: Number(flag("flat-exit", String(defaultPolicyConfig.flatExitProbability))),
  maxAdverseSelection: Number(flag("max-adverse", String(defaultPolicyConfig.maxAdverseSelection))),
  maxTargetExposure: Number(flag("max-exposure", String(defaultPolicyConfig.maxTargetExposure))),
  minExpectedMoveCostMultiple: Number(flag("cost-multiple", String(defaultPolicyConfig.minExpectedMoveCostMultiple))),
};
const raw = createReplayEvaluator(modelName, profile);
const cache = new JsonlSignalCache(cachePath);
const evaluator = new CachedEvaluator(raw, cache, maxNewEvaluations);

function saveState(state: PaperState) {
  mkdirSync(statePath.includes("/") ? statePath.slice(0, statePath.lastIndexOf("/")) : ".", { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
}
function event(value: unknown) {
  mkdirSync(eventsPath.includes("/") ? eventsPath.slice(0, eventsPath.lastIndexOf("/")) : ".", { recursive: true });
  appendFileSync(eventsPath, JSON.stringify(value) + "\n");
}
function loadState(): PaperState | null {
  if (!existsSync(statePath)) return null;
  const s = JSON.parse(readFileSync(statePath, "utf8")) as PaperState;
  if (s.version !== "binance-paper-v2" || s.symbol !== symbol || s.interval !== interval) {
    throw new Error("paper state does not match requested symbol/interval");
  }
  if (s.evaluatorNamespace !== raw.name) {
    throw new Error("paper state evaluator changed; use a new --state file for a new apparatus");
  }
  return s;
}

async function fetchBars(limit = 250): Promise<{ closed: MarketBar[]; current: MarketBar }> {
  const url = new URL("https://data-api.binance.vision/api/v3/klines");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(limit));
  const res = await fetch(url);
  if (!res.ok) throw new Error("Binance HTTP " + res.status + ": " + (await res.text()).slice(0, 200));
  const rows = await res.json() as unknown[][];
  if (rows.length < featureConfig.minHistoryBars + 2) throw new Error("not enough Binance bars for features");
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
      spreadBps,
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

function equity(state: PaperState, price: number) {
  return state.cash + state.quantity * price;
}
function exposure(state: PaperState, price: number) {
  const e = equity(state, price);
  return e > 0 ? state.quantity * price / e : 0;
}

async function decide(state: PaperState, closed: MarketBar[]) {
  const i = closed.length - 1;
  const features = buildFeatureState(closed, i, featureConfig);
  if (!features) throw new Error("could not construct live feature state");
  const signal = await evaluator.evaluate(features);
  const roundTripCostBps = features.spreadBps + 2 * slippageBps + 2 * feeBps;
  const action = choosePolicyAction(signal, exposure(state, closed[i]!.close), policy, {
    directionThresholdBps: features.directionThresholdBps,
    estimatedRoundTripCostBps: roundTripCostBps,
  });
  let target = action.kind === "target" ? action.targetExposure : exposure(state, closed[i]!.close);
  if (!allowShort) target = Math.max(0, target);
  state.pendingTarget = target;
  state.lastDecisionTs = closed[i]!.ts;
  event({
    type: "decision",
    at: Date.now(),
    barTs: closed[i]!.ts,
    close: closed[i]!.close,
    equity: equity(state, closed[i]!.close),
    exposure: exposure(state, closed[i]!.close),
    signal,
    action,
    pendingTarget: target,
  });
  return { signal, action, target };
}

function executePending(state: PaperState, openBar: MarketBar) {
  if (state.pendingTarget === null || !(openBar.open > 0)) return null;
  const beforeEquity = equity(state, openBar.open);
  if (!(beforeEquity > 0)) throw new Error("paper account equity is non-positive");

  const targetNotional = beforeEquity * state.pendingTarget;
  const targetQty = targetNotional / openBar.open;
  const delta = targetQty - state.quantity;
  const estimated = Math.abs(delta * openBar.open);
  if (estimated < 1) {
    state.pendingTarget = null;
    return null;
  }

  const side = delta > 0 ? "buy" : "sell";
  const friction = spreadBps / 2 + slippageBps;
  const price = openBar.open * (1 + (side === "buy" ? 1 : -1) * friction / 10_000);
  const notional = Math.abs(delta * price);
  const fee = notional * feeBps / 10_000;
  state.cash -= delta * price + fee;
  state.quantity += delta;
  state.fees += fee;
  const fill = {
    type: "fill",
    at: Date.now(),
    barTs: openBar.ts,
    side,
    quantity: Math.abs(delta),
    price,
    notional,
    fee,
    targetExposure: state.pendingTarget,
    equityAfter: equity(state, openBar.open),
  };
  state.pendingTarget = null;
  event(fill);
  return fill;
}

let state = loadState();
let cycle = 0;
while (cycles === 0 || cycle < cycles) {
  cycle++;
  try {
    const { closed, current } = await fetchBars();
    if (!state) {
      state = {
        version: "binance-paper-v2",
        symbol,
        interval,
        evaluatorNamespace: raw.name,
        cash: initialCash,
        quantity: 0,
        fees: 0,
        lastOpenTs: current.ts,
        pendingTarget: null,
        lastDecisionTs: null,
        startedAt: Date.now(),
      };
      event({
        type: "initialized",
        at: Date.now(),
        barTs: current.ts,
        open: current.open,
        equity: equity(state, current.open),
        note: "No decision on startup because the current bar is already open; first clean decision waits for the next bar boundary.",
      });
      saveState(state);
      console.log("initialized " + symbol + " " + interval + " · equity $" + equity(state, current.open).toFixed(2) + " · waiting for clean bar boundary");
    } else if (current.ts > state.lastOpenTs) {
      const fill = executePending(state, current);
      state.lastOpenTs = current.ts;
      const d = await decide(state, closed);
      saveState(state);
      console.log(
        new Date(current.ts).toISOString() +
        " · equity $" + equity(state, current.open).toFixed(2) +
        " · position " + state.quantity.toFixed(6) +
        " · target " + d.target.toFixed(3) +
        (fill ? " · filled " + fill.side + " $" + fill.notional.toFixed(2) : "")
      );
    }
  } catch (e) {
    console.error("paper loop:", (e as Error).message);
  }

  if (cycles !== 0 && cycle >= cycles) break;
  await Bun.sleep(pollMs);
}

if (state) {
  console.log("state " + statePath + " · cache hits " + cache.hits + " · misses " + cache.misses + " · new " + evaluator.newEvaluations + " · fresh tokens " + evaluator.newInputTokens);
}
