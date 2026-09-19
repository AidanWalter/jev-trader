import { readFileSync } from "node:fs";

const files = [
  "research/live-frozen-binance-paper.ts",
  "research/live-frozen-binance-portfolio-paper.ts",
  "research/live-frozen-yahoo-stock-portfolio-paper.ts",
  "research/live-frozen-hyperliquid-portfolio-paper.ts",
];

let failures = 0;
const check = (name: string, ok: boolean) => {
  console.log((ok ? "ok  " : "FAIL") + " " + name);
  if (!ok) failures++;
};

for (const file of files) {
  const text = readFileSync(file, "utf8");
  check(file + " requires explicit paid confirmation", text.includes('confirm-paid'));
  check(file + " persists lifetime paid requests", text.includes("paidRequests"));
  check(file + " persists lifetime paid input tokens", text.includes("paidInputTokens"));
  check(file + " computes remaining lifetime budget", text.includes("remainingSpendBudget"));
  check(file + " saves provider usage after attempts", text.includes("syncPaidSpend"));
  check(file + " stops on hard spend exhaustion", text.includes("SpendBudgetExceededError"));
  check(file + " stops on provider no-credit response", /402/.test(text) && /no available api credits/i.test(text));
}

process.exit(failures ? 1 : 0);
