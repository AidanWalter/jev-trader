import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = ".github/workflows";
const allowed = new Set([
  "jev-direction-canary.yml",
  "jev-direction-sample-48.yml",
  "jev-direction-sample.yml",
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
    "Refuse duplicate paid sample",
    "if: success()",
    "if: failure()",
  ],
  "jev-direction-development.yml": [
    "--model=jev-direction",
    "--horizons=8",
    "--profiles=lean",
    "--decision-every=8",
    "--direction-only=true",
    "--max-new-evals=6756",
    "--max-paid-requests=6756",
    "--max-input-tokens=13512000",
    "--reserve-tokens-per-request=2000",
    "--max-usd=0.57",
    "--concurrency=1",
    "dashboard_verified",
    "dashboard_request_delta",
    "dashboard_input_token_delta",
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

process.exit(failures ? 1 : 0);
