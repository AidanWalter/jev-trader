import type {
  EquityPoint,
  ExecutionConfig,
  FeatureConfig,
  FillRecord,
  MarketBar,
  PolicyConfig,
  ReplayDecision,
  ReplayMetrics,
  ReplayResult,
  SignalEvaluator,
} from "./types";
import { buildFeatureState, defaultFeatureConfig } from "./features";
import { choosePolicyAction, defaultPolicyConfig } from "./policy";

export const defaultExecutionConfig: ExecutionConfig = {
  initialCash: 100,
  feeBps: 2,
  slippageBps: 1,
  spreadBpsFallback: 5,
  maxGrossExposure: 1,
  minTradeNotional: 1,
  allowShort: true,
  shortBorrowBpsPerDay: 1,
};

const sgn = (x: number) => x > 1e-12 ? 1 : x < -1e-12 ? -1 : 0;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

function stdev(xs: number[]) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

function median(xs: number[]) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function periodsPerYear(bars: MarketBar[]) {
  const diffs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const d = bars[i]!.ts - bars[i - 1]!.ts;
    if (d > 0) diffs.push(d);
  }
  const ms = median(diffs);
  if (!ms) return 0;
  const days = bars[0]?.kind === "stock" ? 252 : 365;
  const hours = bars[0]?.kind === "stock" ? 6.5 : 24;
  return days * hours * 60 * 60 * 1000 / ms;
}

function metrics(
  bars: MarketBar[],
  equity: EquityPoint[],
  fills: FillRecord[],
  initialCash: number,
  fees: number,
  borrowCost: number,
  episodePnls: number[],
): ReplayMetrics {
  const finalEquity = equity.at(-1)?.equity ?? initialCash;
  let peak = initialCash;
  let maxDd = 0;
  const rs: number[] = [];

  for (let i = 0; i < equity.length; i++) {
    const e = equity[i]!.equity;
    peak = Math.max(peak, e);
    if (peak > 0) maxDd = Math.min(maxDd, e / peak - 1);
    if (i > 0) {
      const p = equity[i - 1]!.equity;
      if (p > 0) rs.push(e / p - 1);
    }
  }

  const sd = stdev(rs);
  const annual = periodsPerYear(bars);
  const sharpe = sd > 0 && annual > 0 ? mean(rs) / sd * Math.sqrt(annual) : null;
  const wins = episodePnls.filter((x) => x > 0);
  const losses = episodePnls.filter((x) => x < 0);
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = -losses.reduce((a, b) => a + b, 0);
  const first = bars[0]?.close ?? 0;
  const last = bars.at(-1)?.close ?? first;

  return {
    initialEquity: initialCash,
    finalEquity,
    pnl: finalEquity - initialCash,
    returnPct: initialCash ? (finalEquity / initialCash - 1) * 100 : 0,
    buyHoldReturnPct: first > 0 ? (last / first - 1) * 100 : 0,
    maxDrawdownPct: maxDd * 100,
    sharpe,
    turnover: fills.reduce((s, f) => s + f.notional, 0) / Math.max(initialCash, 1e-9),
    fees,
    borrowCost,
    orders: fills.length,
    roundTrips: episodePnls.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: wins.length + losses.length ? wins.length / (wins.length + losses.length) * 100 : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : null,
  };
}

export interface ReplayOptions {
  evaluator: SignalEvaluator;
  execution?: Partial<ExecutionConfig>;
  policy?: Partial<PolicyConfig>;
  features?: Partial<FeatureConfig>;
  startIndex?: number;
  endIndex?: number;
  /** Ask the evaluator every N bars; the current position persists between decisions. */
  decisionEveryBars?: number;
}

export async function replayBars(input: MarketBar[], options: ReplayOptions): Promise<ReplayResult> {
  if (input.length < 3) throw new Error("replay requires at least 3 bars");
  const bars = [...input].sort((a, b) => a.ts - b.ts);
  const symbol = bars[0]!.symbol;
  if (bars.some((b) => b.symbol !== symbol)) throw new Error("replayBars expects one symbol");

  const execution = { ...defaultExecutionConfig, ...options.execution };
  const policy = { ...defaultPolicyConfig, ...options.policy };
  const features = { ...defaultFeatureConfig, ...options.features };
  const start = Math.max(features.minHistoryBars, options.startIndex ?? features.minHistoryBars);
  const end = Math.min(bars.length - 2, options.endIndex ?? bars.length - 2);
  const decisionEveryBars = Math.max(1, Math.floor(options.decisionEveryBars ?? 1));
  if (start > end) throw new Error("not enough bars after feature warmup");

  let cash = execution.initialCash;
  let quantity = 0;
  let fees = 0;
  let borrowCost = 0;
  let episodeStart: number | null = null;
  const episodePnls: number[] = [];
  const equity: EquityPoint[] = [];
  const decisions: ReplayDecision[] = [];

  const mark = (price: number) => cash + quantity * price;
  const exposure = (price: number) => {
    const e = mark(price);
    return e > 0 ? quantity * price / e : 0;
  };

  for (let i = start; i <= end; i++) {
    const bar = bars[i]!;
    const next = bars[i + 1]!;

    if (quantity < 0) {
      const days = Math.max(0, next.ts - bar.ts) / 86_400_000;
      const cost = Math.abs(quantity * bar.close) * execution.shortBorrowBpsPerDay / 10_000 * days;
      cash -= cost;
      borrowCost += cost;
    }

    if (bar.kind === "perp" && bar.fundingBps) {
      cash -= quantity * bar.close * bar.fundingBps / 10_000;
    }

    if ((i - start) % decisionEveryBars !== 0) {
      const eq = mark(next.close);
      equity.push({ ts: next.ts, equity: eq, cash, quantity, exposure: exposure(next.close) });
      if (!Number.isFinite(eq) || eq <= 0) break;
      continue;
    }

    const state = buildFeatureState(bars, i, features);
    if (!state) continue;
    const signal = await options.evaluator.evaluate(state);
    const roundTripCostBps = state.spreadBps + 2 * execution.slippageBps + 2 * execution.feeBps;
    const action = choosePolicyAction(signal, exposure(bar.close), policy, {
      directionThresholdBps: state.directionThresholdBps,
      estimatedRoundTripCostBps: roundTripCostBps,
    });
    let fill: FillRecord | null = null;

    if (action.kind === "target" && next.open > 0) {
      let target = clamp(action.targetExposure, -execution.maxGrossExposure, execution.maxGrossExposure);
      if (!execution.allowShort) target = Math.max(0, target);

      const equityNow = mark(bar.close);
      const targetQty = equityNow * target / next.open;
      const delta = targetQty - quantity;
      const estNotional = Math.abs(delta * next.open);

      if (estNotional >= execution.minTradeNotional) {
        const side = delta > 0 ? "buy" : "sell";
        const spread = next.spreadBps ?? bar.spreadBps ?? execution.spreadBpsFallback;
        const friction = spread / 2 + execution.slippageBps;
        const price = next.open * (1 + (side === "buy" ? 1 : -1) * friction / 10_000);
        const beforeSign = sgn(quantity);
        const notional = Math.abs(delta * price);
        const fee = notional * execution.feeBps / 10_000;

        cash -= delta * price + fee;
        quantity += delta;
        fees += fee;

        const afterSign = sgn(quantity);
        if (beforeSign === 0 && afterSign !== 0) {
          episodeStart = mark(price);
        } else if (beforeSign !== 0 && (afterSign === 0 || beforeSign !== afterSign)) {
          if (episodeStart !== null) episodePnls.push(mark(price) - episodeStart);
          episodeStart = afterSign === 0 ? null : mark(price);
        }

        fill = {
          decisionTs: bar.ts,
          executionTs: next.ts,
          side,
          quantity: Math.abs(delta),
          price,
          notional,
          fee,
          targetExposure: target,
        };
      }
    }

    const eq = mark(next.close);
    equity.push({ ts: next.ts, equity: eq, cash, quantity, exposure: exposure(next.close) });
    decisions.push({ ts: bar.ts, signal, action, fill });
    if (!Number.isFinite(eq) || eq <= 0) break;
  }

  const lastBar = bars[Math.min(bars.length - 1, end + 1)]!;
  if (sgn(quantity) !== 0 && episodeStart !== null) episodePnls.push(mark(lastBar.close) - episodeStart);

  const fills = decisions.flatMap((d) => d.fill ? [d.fill] : []);
  return {
    symbol,
    startTs: bars[start]!.ts,
    endTs: lastBar.ts,
    metrics: metrics(bars.slice(start, Math.min(bars.length, end + 2)), equity, fills, execution.initialCash, fees, borrowCost, episodePnls),
    equity,
    decisions,
  };
}
