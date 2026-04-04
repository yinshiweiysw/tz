const BLOCK_SPECS = [
  { blockKey: "portfolio_state", payloadKey: "latest", asOfKey: "snapshot_date" },
  { blockKey: "risk_dashboard", payloadKey: "riskDashboard", asOfKey: "as_of" },
  { blockKey: "macro_state", payloadKey: "macroState", asOfKey: "as_of" },
  { blockKey: "macro_radar", payloadKey: "macroRadar", asOfKey: "as_of" },
  { blockKey: "regime_router_signals", payloadKey: "regimeSignals", asOfKey: "as_of" },
  { blockKey: "opportunity_pool", payloadKey: "opportunityPool", asOfKey: "as_of" },
  { blockKey: "performance_attribution", payloadKey: "performanceAttribution", asOfKey: "as_of" }
];

function normalizeBlock({ blockKey, payloadKey, asOfKey, payloads }) {
  const payload = payloads[payloadKey] ?? null;
  const available = payload !== null;

  return {
    key: blockKey,
    available,
    generated_at: available ? payload.generated_at ?? null : null,
    as_of: available ? payload[asOfKey] ?? null : null,
    payload
  };
}

export function buildResearchSnapshot({ payloads = {} } = {}) {
  const normalizedPayloads =
    payloads !== null && typeof payloads === "object" ? payloads : {};

  return Object.fromEntries(
    BLOCK_SPECS.map((spec) => [spec.blockKey, normalizeBlock({ ...spec, payloads: normalizedPayloads })])
  );
}
