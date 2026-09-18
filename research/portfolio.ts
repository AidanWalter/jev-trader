import { buildFeatureState, defaultFeatureConfig } from "./features";
import { choosePolicyAction, defaultPolicyConfig } from "./policy";
import type { ExecutionConfig, FeatureConfig, PolicyConfig, SignalEvaluator } from "./types";
import type { LoadedAsset } from "./universe";

export interface PortfolioReplayOptions {
  evaluator: SignalEvaluator;
  execution?: Partial<ExecutionConfig>;
  policy?: Partial<PolicyConfig>;
  features?: Partial<FeatureConfig>;
  decisionEveryBars?: number;
  maxGrossExposure?: number;
  maxAssetExposure?: number;
  topN?: number;
}

export interface PortfolioFill {
  ts: number;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  notional: number;
  fee: number;
  targetExposure: number;
}

export interface PortfolioPoint {
  ts: number;
  equity: number;
  cash: number;
  grossExposure: number;
  netExposure: number;
  positions: Record<string, { quantity: number; value: number; exposure: number }>;
}

export interface PortfolioResult {
  symbols: string[];
  startTs: number;
  endTs: number;
  initialEquity: number;
  finalEquity: number;
  pnl: number;
  returnPct: number;
  maxDrawdownPct: number;
  turnover: number;
  fees: number;
  borrowCost: number;
  fills: PortfolioFill[];
  equity: PortfolioPoint[];
}

const defaultExecution: ExecutionConfig = {
  initialCash: 100,
  feeBps: 2,
  slippageBps: 1,
  spreadBpsFallback: 5,
  maxGrossExposure: 1,
  minTradeNotional: 1,
  allowShort: true,
  shortBorrowBpsPerDay: 1,
};

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

export async function replayPortfolio(assets: LoadedAsset[], options: PortfolioReplayOptions): Promise<PortfolioResult> {
  if (!assets.length) throw new Error("portfolio replay needs at least one asset");
  const n = assets[0]!.bars.length;
  if (assets.some((a) => a.bars.length !== n)) throw new Error("portfolio assets must be timestamp-aligned");
  for (let i = 0; i < n; i++) {
    const ts = assets[0]!.bars[i]!.ts;
    if (assets.some((a) => a.bars[i]!.ts !== ts)) throw new Error("portfolio assets are not timestamp-aligned");
  }

  const execution: ExecutionConfig = { ...defaultExecution, ...options.execution };
  const policy: PolicyConfig = { ...defaultPolicyConfig, ...options.policy };
  const features: FeatureConfig = { ...defaultFeatureConfig, ...options.features };
  const every = Math.max(1, Math.floor(options.decisionEveryBars ?? 1));
  const maxGross = Math.max(0, options.maxGrossExposure ?? execution.maxGrossExposure);
  const maxAsset = Math.max(0, options.maxAssetExposure ?? Math.min(1, maxGross));
  const topN = Math.max(1, Math.floor(options.topN ?? assets.length));
  const start = features.minHistoryBars;
  const end = n - 2;
  if (start > end) throw new Error("not enough synchronized bars after feature warmup");

  let cash = execution.initialCash;
  let fees = 0;
  let borrowCost = 0;
  const quantities = new Map(assets.map((a) => [a.spec.symbol, 0]));
  const fills: PortfolioFill[] = [];
  const equity: PortfolioPoint[] = [];

  const mark = (index: number) => {
    let total = cash;
    for (const asset of assets) total += (quantities.get(asset.spec.symbol) ?? 0) * asset.bars[index]!.close;
    return total;
  };

  const snapshot = (index: number): PortfolioPoint => {
    const total = mark(index);
    const positions: PortfolioPoint["positions"] = {};
    let gross = 0;
    let net = 0;
    for (const asset of assets) {
      const q = quantities.get(asset.spec.symbol) ?? 0;
      const value = q * asset.bars[index]!.close;
      const exposure = total > 0 ? value / total : 0;
      positions[asset.spec.symbol] = { quantity: q, value, exposure };
      gross += Math.abs(exposure);
      net += exposure;
    }
    return { ts: assets[0]!.bars[index]!.ts, equity: total, cash, grossExposure: gross, netExposure: net, positions };
  };

  for (let i = start; i <= end; i++) {
    const nextIndex = i + 1;

    for (const asset of assets) {
      const symbol = asset.spec.symbol;
      const q = quantities.get(symbol) ?? 0;
      const bar = asset.bars[i]!;
      const next = asset.bars[nextIndex]!;
      if (q < 0) {
        const days = Math.max(0, next.ts - bar.ts) / 86_400_000;
        const cost = Math.abs(q * bar.close) * execution.shortBorrowBpsPerDay / 10_000 * days;
        cash -= cost;
        borrowCost += cost;
      }
      if (bar.kind === "perp" && bar.fundingBps) cash -= q * bar.close * bar.fundingBps / 10_000;
    }

    if ((i - start) % every === 0) {
      const portfolioEquity = mark(i);
      if (!(portfolioEquity > 0)) break;

      const candidates: { symbol: string; target: number; score: number }[] = [];
      for (const asset of assets) {
        const state = buildFeatureState(asset.bars, i, features);
        if (!state) continue;
        const signal = await options.evaluator.evaluate(state);
        const q = quantities.get(asset.spec.symbol) ?? 0;
        const currentExposure = q * asset.bars[i]!.close / portfolioEquity;
        const action = choosePolicyAction(signal, currentExposure, policy);
        const target = action.kind === "target" ? action.targetExposure : currentExposure;
        candidates.push({ symbol: asset.spec.symbol, target, score: Math.abs(action.score) });
      }

      candidates.sort((a, b) => b.score - a.score);
      const selected = new Set(candidates.slice(0, topN).map((x) => x.symbol));
      const raw = new Map<string, number>();
      for (const c of candidates) {
        let target = selected.has(c.symbol) ? clamp(c.target, -maxAsset, maxAsset) : 0;
        if (!execution.allowShort) target = Math.max(0, target);
        raw.set(c.symbol, target);
      }

      const rawGross = [...raw.values()].reduce((s, x) => s + Math.abs(x), 0);
      const scale = rawGross > maxGross && rawGross > 0 ? maxGross / rawGross : 1;

      for (const asset of assets) {
        const symbol = asset.spec.symbol;
        const currentQ = quantities.get(symbol) ?? 0;
        const targetExposure = (raw.get(symbol) ?? 0) * scale;
        const next = asset.bars[nextIndex]!;
        if (!(next.open > 0)) continue;

        const targetNotional = portfolioEquity * targetExposure;
        const targetQ = targetNotional / next.open;
        const delta = targetQ - currentQ;
        const estimatedNotional = Math.abs(delta * next.open);
        if (estimatedNotional < execution.minTradeNotional) continue;

        const side = delta > 0 ? "buy" : "sell";
        const spread = next.spreadBps ?? asset.bars[i]!.spreadBps ?? execution.spreadBpsFallback;
        const friction = spread / 2 + execution.slippageBps;
        const price = next.open * (1 + (side === "buy" ? 1 : -1) * friction / 10_000);
        const notional = Math.abs(delta * price);
        const fee = notional * execution.feeBps / 10_000;

        cash -= delta * price + fee;
        quantities.set(symbol, currentQ + delta);
        fees += fee;
        fills.push({ ts: next.ts, symbol, side, quantity: Math.abs(delta), price, notional, fee, targetExposure });
      }
    }

    const point = snapshot(nextIndex);
    equity.push(point);
    if (!Number.isFinite(point.equity) || point.equity <= 0) break;
  }

  const initial = execution.initialCash;
  const final = equity.at(-1)?.equity ?? initial;
  let peak = initial;
  let maxDd = 0;
  for (const p of equity) {
    peak = Math.max(peak, p.equity);
    if (peak > 0) maxDd = Math.min(maxDd, p.equity / peak - 1);
  }
  const turnover = fills.reduce((s, f) => s + f.notional, 0) / Math.max(initial, 1e-9);

  return {
    symbols: assets.map((a) => a.spec.symbol),
    startTs: assets[0]!.bars[start]!.ts,
    endTs: assets[0]!.bars[Math.min(n - 1, end + 1)]!.ts,
    initialEquity: initial,
    finalEquity: final,
    pnl: final - initial,
    returnPct: initial ? (final / initial - 1) * 100 : 0,
    maxDrawdownPct: maxDd * 100,
    turnover,
    fees,
    borrowCost,
    fills,
    equity,
  };
}
