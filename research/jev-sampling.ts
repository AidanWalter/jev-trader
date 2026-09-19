export interface JevSampleRow {
  state: {
    symbol: string;
    ts: number;
  };
}

export function jevSampleRank(row: JevSampleRow) {
  const text = row.state.symbol + ":" + row.state.ts;
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Deterministic nested sample across symbol and time regime.
 *
 * Rows are split into time buckets, then each symbol/time bucket is sorted by a
 * stable hash. Selection round-robins across buckets. Therefore sample(N) is
 * always an exact prefix of sample(M) for M > N when the eligible row set is
 * unchanged.
 */
export function nestedJevSample<T extends JevSampleRow>(
  input: readonly T[],
  n: number,
  timeBuckets = 4,
): T[] {
  if (!(n > 0) || !input.length) return [];
  if (!(timeBuckets >= 1)) throw new Error("timeBuckets must be at least 1");

  const minTs = Math.min(...input.map((x) => x.state.ts));
  const maxTs = Math.max(...input.map((x) => x.state.ts));
  const span = Math.max(1, maxTs - minTs + 1);

  const grouped = new Map<string, T[]>();
  for (const row of input) {
    const rawBucket = Math.floor((row.state.ts - minTs) / span * timeBuckets);
    const bucket = Math.min(timeBuckets - 1, Math.max(0, rawBucket));
    const key = row.state.symbol + "\u0000" + String(bucket).padStart(3, "0");
    const xs = grouped.get(key) ?? [];
    xs.push(row);
    grouped.set(key, xs);
  }

  const keys = [...grouped.keys()].sort();
  for (const key of keys) {
    grouped.get(key)!.sort((a, b) =>
      jevSampleRank(a) - jevSampleRank(b) ||
      a.state.ts - b.state.ts ||
      a.state.symbol.localeCompare(b.state.symbol)
    );
  }

  const limit = Math.min(n, input.length);
  const picked: T[] = [];
  let rank = 0;
  while (picked.length < limit) {
    let added = false;
    for (const key of keys) {
      const row = grouped.get(key)![rank];
      if (row && picked.length < limit) {
        picked.push(row);
        added = true;
      }
    }
    if (!added) break;
    rank++;
  }
  return picked;
}

export function jevSampleId(row: JevSampleRow) {
  return row.state.symbol + ":" + row.state.ts;
}
