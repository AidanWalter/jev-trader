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
    "ref: 9c7ae2796ea6c7e01a59522177b150e8c99c34c2",
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
    "jev-credit-reference-v1",
    "run-id: 35420536540",
    "reference-full-jev-cache.jsonl",
    "if: success()",
    "if: failure()",
  ],
  "jev-direction-sample-48.yml": [
    "ref: 9c7ae2796ea6c7e01a59522177b150e8c99c34c2",
    "--horizon=8",
    "--profile=lean",
    "--decision-every=8",
    "--sample=48",
    "--min-cache-hits=12",
    "MAX_REQ=36",
    "MAX_TOK=80000",
    "S48_REMAINING_REQ",
    "S48_REMAINING_TOK",
    "--reserve-input-tokens=2000",
    "resume_run_id",
    "resume_dashboard_verified",
    "resume_dashboard_request_delta",
    "resume_dashboard_input_token_delta",
    "--max-usd=0.004",
    "--concurrency=1",
    "reference-full-jev-cache.jsonl",
    "dashboard_verified",
    "dashboard_request_delta",
    "dashboard_input_token_delta",
    "Refuse duplicate 48-state spend",
    "Verify true nested expansion",
    "if: success()",
    "if: failure()",
  ],
  "jev-direction-sample.yml": [
    "ref: 9c7ae2796ea6c7e01a59522177b150e8c99c34c2",
    "--horizon=8",
    "--profile=lean",
    "--decision-every=8",
    "--sample=240",
    "--min-cache-hits=48",
    "MAX_REQ=192",
    "MAX_TOK=384000",
    "S240_REMAINING_REQ",
    "S240_REMAINING_TOK",
    "--reserve-input-tokens=2000",
    "resume_run_id",
    "resume_dashboard_verified",
    "resume_dashboard_request_delta",
    "resume_dashboard_input_token_delta",
    "--max-usd=0.017",
    "--concurrency=1",
    "reference-full-jev-cache.jsonl",
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
    "ref: 9c7ae2796ea6c7e01a59522177b150e8c99c34c2",
    "--horizon=8",
    "--profile=lean",
    "--decision-every=8",
    "--sample=1000",
    "--min-cache-hits=240",
    "MAX_REQ=760",
    "MAX_TOK=1520000",
    "S1000_REMAINING_REQ",
    "S1000_REMAINING_TOK",
    "--reserve-input-tokens=2000",
    "resume_run_id",
    "resume_dashboard_verified",
    "resume_dashboard_request_delta",
    "resume_dashboard_input_token_delta",
    "--max-usd=0.065",
    "--concurrency=1",
    "reference-full-jev-cache.jsonl",
    "dashboard_verified",
    "dashboard_request_delta",
    "dashboard_input_token_delta",
    ".metrics.brier < 0.6666667",
    ".metrics.nonFlatCount >= 150",
    ".positiveTimeQuartiles >= 3",
    ".positiveSymbols >= 2",
    "Refuse duplicate 1000-state spend",
    "if: success()",
    "if: failure()",
  ],
  "jev-direction-development.yml": [
    "ref: 9c7ae2796ea6c7e01a59522177b150e8c99c34c2",
    "--model=jev-direction",
    "--horizons=8",
    "--profiles=lean",
    "--decision-every=8",
    "--direction-only=true",
    "MAX_REQ=5996",
    "MAX_TOK=11992000",
    "DEV_REMAINING_REQ",
    "DEV_REMAINING_TOK",
    "--reserve-tokens-per-request=2000",
    "resume_run_id",
    "resume_dashboard_verified",
    "resume_dashboard_request_delta",
    "resume_dashboard_input_token_delta",
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
    "ref: 9c7ae2796ea6c7e01a59522177b150e8c99c34c2",
    "MAX_REQ=1752",
    "MAX_TOK=3504000",
    "SEALED_REMAINING_REQ",
    "SEALED_REMAINING_TOK",
    "--reserve-tokens-per-request=2000",
    "resume_run_id",
    "resume_dashboard_verified",
    "resume_dashboard_request_delta",
    "resume_dashboard_input_token_delta",
    "--max-usd=0.15",
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
  "jev-direction-sample-1000.yml": { requests: 760, usd: 0.065 },
  "jev-direction-development.yml": { requests: 5996, usd: 0.505 },
  "jev-direction-sealed.yml": { requests: 1752, usd: 0.15 },
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

if (totalStagedRequests !== 8748) {
  fail("staged paid research request ceiling changed from 8,748: " + totalStagedRequests);
} else {
  ok("entire staged paid research chain is capped at 8,748 fresh requests");
}
if (totalStagedUsd > 0.75) {
  fail("staged paid research dollar ceiling exceeds $0.75: $" + totalStagedUsd.toFixed(6));
} else {
  ok("entire staged paid research chain is capped at $" + totalStagedUsd.toFixed(4));
}

process.exit(failures ? 1 : 0);
