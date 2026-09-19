import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = ".github/workflows";
const allowed = new Set([
  "jev-direction-canary.yml",
  "jev-direction-sample-48.yml",
  "jev-direction-sample.yml",
  "jev-direction-sample-1000.yml",
  "jev-direction-development.yml",
  "jev-direction-sealed.yml",
]);

const exactRequirements: Record<string, string[]> = {
  "jev-direction-canary.yml": [
    "--horizon=8",
    "--profile=lean",
    "--decision-every=8",
    "--sample=12",
    "--max-requests=12",
    "--max-input-tokens=30000",
    "--reserve-input-tokens=2000",
    "--max-usd=0.0015",
    "--concurrency=1",
    "Refuse duplicate paid canary",
    "if: success()",
    "if: failure()",
  ],
  "jev-direction-sample-48.yml": [
    "--horizon=8",
    "--profile=lean",
    "--decision-every=8",
    "--sample=48",
    "--min-cache-hits=12",
    "--max-requests=36",
    "--max-input-tokens=80000",
    "--reserve-input-tokens=2000",
    "--max-usd=0.004",
    "--concurrency=1",
    "dashboard_verified",
    "dashboard_request_delta",
    "dashboard_input_token_delta",
    "Refuse duplicate 48-state spend",
    "Verify true nested expansion",
    "if: success()",
    "if: failure()",
  ],
  "jev-direction-sample.yml": [
    "--horizon=8",
    "--profile=lean",
    "--decision-every=8",
    "--sample=240",
    "--min-cache-hits=48",
    "--max-requests=192",
    "--max-input-tokens=384000",
    "--reserve-input-tokens=2000",
    "--max-usd=0.017",
    "--concurrency=1",
    "dashboard_verified",
    "dashboard_request_delta",
    "dashboard_input_token_delta",
    ".metrics.brier < 0.80",
    ".metrics.nonFlatCount >= 8",
    "Refuse duplicate paid sample",
    "if: success()",
    "if: failure()",
  ],
  "jev-direction-sample-1000.yml": [
    "--horizon=8",
    "--profile=lean",
    "--decision-every=8",
    "--sample=1000",
    "--min-cache-hits=240",
    "--max-requests=760",
    "--max-input-tokens=1520000",
    "--reserve-input-tokens=2000",
    "--max-usd=0.065",
    "--concurrency=1",
    "dashboard_verified",
    "dashboard_request_delta",
    "dashboard_input_token_delta",
    "Refuse duplicate 1000-state spend",
    "if: success()",
    "if: failure()",
  ],
  "jev-direction-development.yml": [
    "--model=jev-direction",
    "--horizons=8",
    "--profiles=lean",
    "--decision-every=8",
    "--direction-only=true",
    "--max-new-evals=5996",
    "--max-paid-requests=5996",
    "--max-input-tokens=11992000",
    "--reserve-tokens-per-request=2000",
    "--max-usd=0.505",
    "--concurrency=1",
    "dashboard_verified",
    "dashboard_request_delta",
    "dashboard_input_token_delta",
    ".metrics.brier < 0.6666667",
    ".positiveTimeQuartiles >= 3",
    ".positiveSymbols >= 2",
    "Refuse duplicate paid development expansion",
    "Independent four-segment validation audit",
    "if: success()",
    "if: failure()",
  ],
  "jev-direction-sealed.yml": [
    "--max-new-evals=1000",
    "--max-paid-requests=1000",
    "--max-input-tokens=2000000",
    "--reserve-tokens-per-request=2000",
    "--max-usd=0.09",
    "--concurrency=1",
    "dashboard_verified",
    "dashboard_request_delta",
    "dashboard_input_token_delta",
    "Refuse duplicate sealed spend",
    "validation-audit.json",
    "if: success()",
    "if: failure()",
  ],
};

const stagedResearchCaps = {
  "jev-direction-canary.yml": { requests: 12, usd: 0.0015 },
  "jev-direction-sample-48.yml": { requests: 36, usd: 0.004 },
  "jev-direction-sample.yml": { requests: 192, usd: 0.017 },
  "jev-direction-development.yml": { requests: 6756, usd: 0.57 },
  "jev-direction-sealed.yml": { requests: 1000, usd: 0.09 },
};
const totalStagedRequests = Object.values(stagedResearchCaps)
  .reduce((sum, x) => sum + x.requests, 0);
const totalStagedUsd = Object.values(stagedResearchCaps)
  .reduce((sum, x) => sum + x.usd, 0);

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.error("FAIL " + msg);
};
const ok = (msg: string) => console.log("ok   " + msg);

for (const name of readdirSync(dir).filter((x) => x.endsWith(".yml") || x.endsWith(".yaml"))) {
  const path = join(dir, name);
  const text = readFileSync(path, "utf8");
  if (!text.includes("TYPESAFE_AI_API_KEY")) continue;

  if (allowed.has(name)) {
    if (!text.includes("workflow_dispatch:")) fail(name + " must remain manual-only");
    if (/\n\s{2}(push|schedule):/.test(text)) fail(name + " may not have push/schedule triggers");
    if (/jobs:[\s\S]*?\n\s{4}env:\s*\n\s{6}TYPESAFE_AI_API_KEY:/.test(text)) {
      fail(name + " exposes the Jev secret at job scope");
    } else {
      ok(name + " scopes Jev secret below job level");
    }
    if (!text.includes("confirm_spend")) fail(name + " must require explicit spend confirmation");
    if (!text.includes("--max-usd=")) fail(name + " must pass an explicit hard dollar cap");
    if (!text.includes("--concurrency=1")) fail(name + " must run paid Jev calls serially");
    for (const required of exactRequirements[name] ?? []) {
      if (!text.includes(required)) fail(name + " missing pinned safety requirement: " + required);
    }
    continue;
  }

  // Legacy paid workflows must remain hard-disabled.
  if (!text.includes('if: ${{ false }}')) {
    fail(name + " references the Jev key but is not hard-disabled");
  } else {
    ok(name + " remains hard-disabled");
  }
}

if (totalStagedRequests !== 7996) {
  fail("staged paid research request ceiling changed from 7,996: " + totalStagedRequests);
} else {
  ok("entire staged paid research chain is capped at 7,996 fresh requests");
}
if (totalStagedUsd > 0.70) {
  fail("staged paid research dollar ceiling exceeds $0.70: $" + totalStagedUsd.toFixed(6));
} else {
  ok("entire staged paid research chain is capped at $" + totalStagedUsd.toFixed(4));
}

process.exit(failures ? 1 : 0);
