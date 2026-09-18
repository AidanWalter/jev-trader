import { classifyLiveBoundary } from "./live-boundary";

const interval = 15 * 60_000;
let failures = 0;

function check(name: string, ok: boolean) {
  console.log((ok ? "ok  " : "FAIL") + " " + name);
  if (!ok) failures++;
}

const base = Date.UTC(2026, 0, 2, 14, 30);

const duplicate = classifyLiveBoundary(base, base, base - interval, interval);
check("duplicate poll is not new", !duplicate.isNew && !duplicate.clean && duplicate.gapBars === 0);

const normal = classifyLiveBoundary(base, base + interval, base, interval);
check("adjacent bar with matching just-closed bar is clean", normal.isNew && normal.clean && normal.gapBars === 1);

const missed = classifyLiveBoundary(base, base + 3 * interval, base + 2 * interval, interval);
check("missed bars force a reset even when the latest close matches", missed.isNew && !missed.clean && missed.gapBars === 3);

const delayed = classifyLiveBoundary(base, base + interval, base - interval, interval);
check("stale closed data cannot authorize a fill", delayed.isNew && !delayed.clean && delayed.gapBars === 1 && !delayed.priorClosedMatches);

const overnightOpen = base + 18 * 60 * 60;
const overnight = classifyLiveBoundary(base, overnightOpen, overnightOpen - interval, interval);
check("overnight stock gap cannot authorize a next-open fill", overnight.isNew && !overnight.clean && overnight.gapBars > 1);

const resumedSecondBar = classifyLiveBoundary(overnightOpen, overnightOpen + interval, overnightOpen, interval);
check("second bar after session open can resume clean timing", resumedSecondBar.clean && resumedSecondBar.gapBars === 1);

let threw = false;
try {
  classifyLiveBoundary(base, base + interval, base, 0);
} catch {
  threw = true;
}
check("non-positive interval is rejected", threw);

console.log(JSON.stringify({ duplicate, normal, missed, delayed, overnight, resumedSecondBar }, null, 2));
process.exit(failures ? 1 : 0);
