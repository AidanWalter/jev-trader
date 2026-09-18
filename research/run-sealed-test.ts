import { extname } from "node:path";
import { readFileSync } from "node:fs";
import { CachedEvaluator, JsonlSignalCache } from "./cache";
import { loadBarsCsv, loadBarsJsonl } from "./csv";
import { createReplayEvaluator } from "./evaluator";
import type { InputProfile } from "./profiles";
import { replayBars } from "./replay";
import { chronologicalRanges, chronologicalSplit } from "./splits";
import type { AssetKind, PolicyConfig } from "./types";

interface FreezeRecord {
  version: string;
  dataset: {
    file: string;
    sha256: string;
    symbol: string;
    kind: AssetKind;
    bars: number;
    testBars: number;
    testStartTs: number;
    testEndTs: number;
  };
  evaluator: {
    kind: string;
    namespace: string;
    profile: InputProfile;
  };
  features: { horizonBars: number };
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

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const prefix = "--" + name + "=";
  const hit = args.find((x) => x.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
};
const freezePath = args.find((x) => !x.startsWith("--")) ?? "data/apparatus-freeze.json";
const record = JSON.parse(readFileSync(freezePath, "utf8")) as FreezeRecord;
if (record.version !== "apparatus-freeze-v1") throw new Error("unsupported freeze version");

const file = flag("data", record.dataset.file)!;
const bytes = readFileSync(file);
const h = new Bun.CryptoHasher("sha256");
h.update(bytes);
const actualHash = h.digest("hex");
if (actualHash !== record.dataset.sha256) throw new Error("dataset hash differs from frozen apparatus");

const bars = extname(file).toLowerCase() === ".jsonl"
  ? loadBarsJsonl(file)
  : loadBarsCsv(file, {
      symbol: record.dataset.symbol,
      kind: record.dataset.kind,
      defaultSpreadBps: record.execution.spreadBps,
    });
if (bars.length !== record.dataset.bars) throw new Error("dataset bar count differs from frozen apparatus");
const split = chronologicalSplit(bars);
const ranges = chronologicalRanges(bars);
if (
  split.test.length !== record.dataset.testBars ||
  split.test[0]?.ts !== record.dataset.testStartTs ||
  split.test.at(-1)?.ts !== record.dataset.testEndTs
) throw new Error("sealed test boundary differs from frozen apparatus");

const cache = new JsonlSignalCache(flag("cache", "data/jev-cache.jsonl")!);
const raw = createReplayEvaluator(record.evaluator.kind, record.evaluator.profile);
if (raw.name !== record.evaluator.namespace) {
  throw new Error("evaluator namespace changed since freeze: frozen=" + record.evaluator.namespace + " current=" + raw.name);
}

const maxNewEvaluations = Math.max(0, Number(flag("max-new-evals", "0")));
const evaluator = new CachedEvaluator(raw, cache, maxNewEvaluations);
const result = await replayBars(bars, {
  evaluator,
  policy: record.policy,
  features: { horizonBars: record.features.horizonBars },
  startIndex: ranges.test.start,
  endIndex: ranges.test.end - record.features.horizonBars - 1,
  decisionEveryBars: record.cadence.decisionEveryBars,
  execution: {
    initialCash: record.execution.initialCash,
    spreadBpsFallback: record.execution.spreadBps,
    feeBps: record.execution.feeBps,
    slippageBps: record.execution.slippageBps,
    allowShort: record.execution.allowShort,
    shortBorrowBpsPerDay: record.execution.shortBorrowBpsPerDay,
    maxGrossExposure: record.execution.maxGrossExposure,
    minTradeNotional: record.execution.minTradeNotional,
  },
});

const m = result.metrics;
console.log("SEALED TEST");
console.log(record.dataset.symbol + " · " + new Date(result.startTs).toISOString() + " -> " + new Date(result.endTs).toISOString());
console.log("P&L $" + m.pnl.toFixed(2) + " · return " + m.returnPct.toFixed(2) + "% · buy/hold " + m.buyHoldReturnPct.toFixed(2) + "%");
console.log("max DD " + m.maxDrawdownPct.toFixed(2) + "% · Sharpe " + (m.sharpe === null ? "n/a" : m.sharpe.toFixed(2)) + " · turnover " + m.turnover.toFixed(1) + "x");
console.log("orders " + m.orders + " · wins " + m.wins + " · losses " + m.losses + " · fees $" + m.fees.toFixed(4));
console.log("cache hits " + cache.hits + " · misses " + cache.misses + " · NEW evaluations " + evaluator.newEvaluations + " · fresh tokens " + evaluator.newInputTokens);
