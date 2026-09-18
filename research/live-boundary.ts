export interface LiveBoundary {
  isNew: boolean;
  gapBars: number;
  priorClosedMatches: boolean;
  clean: boolean;
}

/**
 * Classify whether a newly observed open can be used for a replay-equivalent fill.
 * A clean boundary requires exactly one elapsed bar and a just-closed bar whose
 * timestamp is exactly one interval before the new open.
 */
export function classifyLiveBoundary(
  lastObservedOpenTs: number,
  currentOpenTs: number,
  latestClosedTs: number,
  intervalMs: number,
): LiveBoundary {
  if (!(intervalMs > 0)) throw new Error("intervalMs must be positive");
  if (currentOpenTs <= lastObservedOpenTs) {
    return {
      isNew: false,
      gapBars: 0,
      priorClosedMatches: latestClosedTs + intervalMs === currentOpenTs,
      clean: false,
    };
  }

  const elapsed = currentOpenTs - lastObservedOpenTs;
  const gapBars = Math.max(1, Math.round(elapsed / intervalMs));
  const priorClosedMatches = latestClosedTs + intervalMs === currentOpenTs;
  return {
    isNew: true,
    gapBars,
    priorClosedMatches,
    clean: gapBars === 1 && priorClosedMatches,
  };
}
