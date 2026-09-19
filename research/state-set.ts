import { defaultFeatureConfig } from "./features";
import { buildPortfolioFeatureStates } from "./portfolio-features";
import type { FeatureConfig } from "./types";
import type { LoadedAsset } from "./universe";

export function sha256Lines(lines: readonly string[]) {
  const h = new Bun.CryptoHasher("sha256");
  for (const line of lines) h.update(line + "\n");
  return h.digest("hex");
}

export function portfolioStateIds(
  assets: LoadedAsset[],
  range: { start: number; end: number },
  config: Partial<FeatureConfig> & Pick<FeatureConfig, "horizonBars">,
  decisionEveryBars: number,
) {
  const cfg: FeatureConfig = { ...defaultFeatureConfig, ...config };
  const series = assets.map((asset) => ({ symbol: asset.spec.symbol, bars: asset.bars }));
  const ids: string[] = [];
  const first = Math.max(cfg.minHistoryBars, range.start);
  for (let i = first; i + cfg.horizonBars < range.end; i += decisionEveryBars) {
    const states = buildPortfolioFeatureStates(series, i, cfg);
    for (const asset of assets) {
      const state = states.get(asset.spec.symbol);
      if (state) ids.push(state.symbol + ":" + state.ts);
    }
  }
  return ids;
}

export function stateSetDigest(ids: readonly string[]) {
  return { count: ids.length, sha256: sha256Lines(ids) };
}
