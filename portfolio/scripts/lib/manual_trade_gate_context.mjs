import { resolveBucketKey, resolveThemeKey } from "./asset_master.mjs";
import { resolveFundToken } from "./manual_trade_recorder.mjs";

export function resolveRecordedCategory(latestState, resolved) {
  const positions = Array.isArray(latestState?.positions) ? latestState.positions : [];
  const pending = Array.isArray(latestState?.pending_profit_effective_positions)
    ? latestState.pending_profit_effective_positions
    : [];
  const candidates = [...positions, ...pending];
  const fundCode = String(resolved?.fundCode ?? "").trim();
  const fundName = String(resolved?.fundName ?? "").trim();

  const matched = candidates.find((item) => {
    const itemCode = String(item?.fund_code ?? item?.code ?? item?.symbol ?? "").trim();
    const itemName = String(item?.name ?? "").trim();
    return (fundCode && itemCode === fundCode) || (fundName && itemName === fundName);
  });

  return matched?.category ?? null;
}

export function buildProposedTradesForGate({
  buyItems,
  sellItems,
  conversionItems,
  lookup,
  latestState,
  assetMaster,
  sellCashArrived
}) {
  const resolveTradeMeta = (token) => {
    const resolved = resolveFundToken(token, lookup);
    const fundName = resolved?.fundName ?? String(token).trim();
    const fundCode = resolved?.fundCode ?? null;
    const category = resolveRecordedCategory(latestState, { fundName, fundCode });
    const subject = {
      fund_code: fundCode,
      name: fundName,
      category
    };
    const bucketKey = resolveBucketKey(assetMaster, subject);
    const themeKey = resolveThemeKey(assetMaster, subject);
    return { fundName, fundCode, category, bucketKey, themeKey };
  };

  return [
    ...buyItems.map((item) => {
      const meta = resolveTradeMeta(item.token);
      return {
        type: "buy",
        name: meta.fundName,
        fund_code: meta.fundCode,
        category: meta.category,
        amount_cny: item.amountCny,
        bucket_key: meta.bucketKey,
        theme_key: meta.themeKey
      };
    }),
    ...sellItems.map((item) => {
      const meta = resolveTradeMeta(item.token);
      return {
        type: "sell",
        name: meta.fundName,
        fund_code: meta.fundCode,
        category: meta.category,
        amount_cny: item.amountCny,
        bucket_key: meta.bucketKey,
        theme_key: meta.themeKey,
        cash_arrived: sellCashArrived
      };
    }),
    ...conversionItems.flatMap((item) => {
      const fromMeta = resolveTradeMeta(item.fromToken);
      const toMeta = resolveTradeMeta(item.toToken);
      return [
        {
          type: "sell",
          name: fromMeta.fundName,
          fund_code: fromMeta.fundCode,
          category: fromMeta.category,
          amount_cny: item.fromAmountCny,
          bucket_key: fromMeta.bucketKey,
          theme_key: fromMeta.themeKey,
          cash_effect_cny: 0
        },
        {
          type: "buy",
          name: toMeta.fundName,
          fund_code: toMeta.fundCode,
          category: toMeta.category,
          amount_cny: item.toAmountCny,
          bucket_key: toMeta.bucketKey,
          theme_key: toMeta.themeKey,
          cash_effect_cny: 0
        }
      ];
    })
  ];
}
