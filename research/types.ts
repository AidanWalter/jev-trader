export type AssetKind = "stock" | "spot" | "perp";

export interface MarketBar {
  ts: number;
  symbol: string;
  kind: AssetKind;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  spreadBps?: number;
  fundingBps?: number;
}

export interface FeatureState {
  symbol: string;
  kind: AssetKind;
  ts: number;
  intervalMs: number;
  horizonBars: number;
  price: number;
  spreadBps: number;
  returnsBps: { r1: number; r3: number; r12: number; r48: number };
  realizedVolBps: { v12: number; v48: number };
  rangeBps: number;
  volumeRatio20: number;
  trendBps20: number;
  recentReturnsBps: number[];
}

export type Direction = "long" | "flat" | "short";
export type Magnitude = "tiny" | "small" | "medium" | "large";

export interface ChoiceDistribution<T extends string> {
  choice: T;
  probabilities: Record<T, number>;
}

export interface JevSignal {
  version: string;
  model: string;
  direction: ChoiceDistribution<Direction>;
  magnitude: ChoiceDistribution<Magnitude>;
  adverseSelection: number;
  latencyMs: number;
  inputTokens: number;
  cacheKey?: string;
}

export interface SignalEvaluator {
  readonly name: string;
  evaluate(state: FeatureState): Promise<JevSignal>;
}

export interface PolicyConfig {
  minDirectionalEdge: number;
  minDirectionalConfidence: number;
  flatExitProbability: number;
  maxAdverseSelection: number;
  maxTargetExposure: number;
  minExposureChange: number;
  sizeScoreThresholds: [number, number, number];
}

export interface PolicyAction {
  kind: "hold" | "target";
  targetExposure: number;
  score: number;
  reason: string;
}

export interface FeatureConfig {
  horizonBars: number;
  minHistoryBars: number;
  spreadBpsFallback: number;
  recentPoints: number;
}

export interface ExecutionConfig {
  initialCash: number;
  feeBps: number;
  slippageBps: number;
  spreadBpsFallback: number;
  maxGrossExposure: number;
  minTradeNotional: number;
  allowShort: boolean;
  shortBorrowBpsPerDay: number;
}

export interface FillRecord {
  decisionTs: number;
  executionTs: number;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  notional: number;
  fee: number;
  targetExposure: number;
}

export interface EquityPoint {
  ts: number;
  equity: number;
  cash: number;
  quantity: number;
  exposure: number;
}

export interface ReplayDecision {
  ts: number;
  signal: JevSignal;
  action: PolicyAction;
  fill: FillRecord | null;
}

export interface ReplayMetrics {
  initialEquity: number;
  finalEquity: number;
  pnl: number;
  returnPct: number;
  buyHoldReturnPct: number;
  maxDrawdownPct: number;
  sharpe: number | null;
  turnover: number;
  fees: number;
  borrowCost: number;
  orders: number;
  roundTrips: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  profitFactor: number | null;
}

export interface ReplayResult {
  symbol: string;
  startTs: number;
  endTs: number;
  metrics: ReplayMetrics;
  equity: EquityPoint[];
  decisions: ReplayDecision[];
}
