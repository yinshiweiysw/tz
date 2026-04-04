function round(value, digits = 2) {
  return Number(Number(value ?? 0).toFixed(digits));
}

function compareDateStrings(left, right) {
  const leftText = String(left ?? "").trim();
  const rightText = String(right ?? "").trim();
  if (!leftText || !rightText) {
    return 0;
  }
  return leftText.localeCompare(rightText);
}

function lifecycleAmount(entry) {
  const normalized = entry?.normalized ?? {};
  if (entry?.type === "conversion") {
    return round(
      Math.max(
        Number(normalized?.from_amount_cny ?? 0),
        Number(normalized?.to_amount_cny ?? 0)
      )
    );
  }
  return round(Number(normalized?.amount_cny ?? 0));
}

export function resolveLedgerEntryLifecycleStage(entry, referenceDate = "") {
  const status = String(entry?.status ?? "").trim().toLowerCase();
  if (status === "cancelled") {
    return "cancelled";
  }

  const type = String(entry?.type ?? "").trim().toLowerCase();
  const normalized = entry?.normalized ?? {};
  const executionType = String(normalized?.execution_type ?? "OTC").trim().toUpperCase();

  if (type === "buy") {
    if (executionType === "EXCHANGE") {
      return "profit_effective";
    }
    const profitEffectiveOn = String(
      entry?.profit_effective_on ?? normalized?.profit_effective_on ?? ""
    ).trim();
    if (profitEffectiveOn && referenceDate && compareDateStrings(profitEffectiveOn, referenceDate) > 0) {
      return "platform_confirmed_pending_profit";
    }
    return "profit_effective";
  }

  if (type === "sell") {
    const cashArrived = entry?.original?.cash_arrived === true || Number(normalized?.cash_effect_cny ?? 0) > 0;
    if (cashArrived) {
      return "cash_arrived";
    }
    if (entry?.original?.cash_arrived === false || Number(normalized?.pending_sell_to_arrive_cny ?? 0) > 0) {
      return "platform_confirmed_pending_cash_arrival";
    }
    return "platform_confirmed_pending_cash_arrival";
  }

  if (type === "conversion") {
    return "platform_confirmed_conversion";
  }

  return "recorded";
}

export function summarizeLedgerEntryLifecycles(entries = [], referenceDate = "") {
  const countsByStage = {};
  const amountsByStage = {};

  for (const entry of entries) {
    const stage = resolveLedgerEntryLifecycleStage(entry, referenceDate);
    countsByStage[stage] = Number(countsByStage[stage] ?? 0) + 1;
    amountsByStage[stage] = round(Number(amountsByStage[stage] ?? 0) + lifecycleAmount(entry));
  }

  return {
    countsByStage,
    amountsByStage
  };
}
