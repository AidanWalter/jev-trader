import { readFileSync } from "node:fs";
import { basename } from "node:path";

const args = process.argv.slice(2);
const root = args.find((x) => !x.startsWith("--")) ?? ".";
const flag = (name: string, fallback: string) => {
  const prefix = "--" + name + "=";
  return args.find((x) => x.startsWith(prefix))?.slice(prefix.length) ?? fallback;
};
const usdPerMTok = Number(flag("usd-per-mtok", "0.042"));

const glob = new Bun.Glob("**/*.jsonl");
const files = [...glob.scanSync({ cwd: root, absolute: true })]
  .filter((p) => basename(p).toLowerCase().includes("cache"))
  .sort();

let totalTokens = 0;
let totalRecords = 0;
const rows: any[] = [];

for (const file of files) {
  let tokens = 0;
  let records = 0;
  const text = readFileSync(file, "utf8").trim();
  for (const line of text ? text.split("\n") : []) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      const inputTokens = Number(value?.signal?.inputTokens ?? 0);
      if (Number.isFinite(inputTokens) && inputTokens >= 0) tokens += inputTokens;
      records++;
    } catch {
      // Ignore non-cache JSONL lines defensively.
    }
  }
  totalTokens += tokens;
  totalRecords += records;
  rows.push({
    file: file.slice(root.length).replace(/^\//, ""),
    records,
    tokens,
    estimatedUsd: tokens / 1e6 * usdPerMTok,
  });
}

for (const row of rows) {
  console.log(
    row.file +
    " · records " + row.records +
    " · tokens " + row.tokens +
    " · estimated $" + row.estimatedUsd.toFixed(6)
  );
}
console.log(
  "TOTAL · records " + totalRecords +
  " · tokens " + totalTokens +
  " · estimated $" + (totalTokens / 1e6 * usdPerMTok).toFixed(6)
);
