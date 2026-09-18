import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = ".github/workflows";
const allowed = new Set([
  "jev-direction-canary.yml",
  "jev-direction-sample.yml",
]);

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
