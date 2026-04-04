import { readFile } from "node:fs/promises";

function round(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return null;
  }

  return Number(Number(value).toFixed(digits));
}

function formatSigned(value, suffix = "") {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "--";
  }

  const numeric = round(value);
  const prefix = numeric > 0 ? "+" : "";
  return `${prefix}${numeric}${suffix}`;
}

function listOrFallback(items, fallback = "暂无") {
  const values = Array.isArray(items) ? items.filter(Boolean) : [];
  return values.length > 0 ? values.join("、") : fallback;
}

function formatFlowLeaders(items, limit = 3) {
  const values = Array.isArray(items) ? items.slice(0, limit) : [];
  if (values.length === 0) {
    return "暂无";
  }

  return values
    .map((item) => `${item.name} ${formatSigned(item.main_net_inflow_100m_cny, "亿元")}`)
    .join("、");
}

export function isUsableCnMarketSnapshot(snapshot) {
  return ["ok", "partial"].includes(String(snapshot?.status ?? ""));
}

export async function loadCnMarketSnapshotFromManifest(manifest) {
  const snapshotPath = manifest?.canonical_entrypoints?.latest_cn_market_snapshot;
  if (!snapshotPath) {
    return null;
  }

  try {
    return JSON.parse(await readFile(snapshotPath, "utf8"));
  } catch {
    return null;
  }
}

export function buildCnMarketBriefLines(snapshot) {
  if (!isUsableCnMarketSnapshot(snapshot)) {
    return [];
  }

  const breadth = snapshot.sections?.market_breadth ?? {};
  const northbound = snapshot.sections?.northbound_flow ?? {};
  const southbound = snapshot.sections?.southbound_flow ?? {};
  const macroCycle = snapshot.sections?.macro_cycle ?? {};
  const sectorFlow = snapshot.sections?.sector_fund_flow ?? {};
  const rotation = snapshot.sections?.sector_rotation_validation ?? {};
  const notes = Array.isArray(snapshot.notes) ? snapshot.notes.slice(0, 2) : [];
  const lines = [];

  if (breadth.total_count) {
    lines.push(
      `- 宽度：上涨 ${breadth.up_count ?? "--"} / ${breadth.total_count}，下跌 ${breadth.down_count ?? "--"} / ${breadth.total_count}，中位涨跌幅 ${formatSigned(breadth.median_change_pct, "%")}`
    );
  }

  const northboundLooksSuppressed =
    northbound.note &&
    Number(northbound.latest_summary_net_buy_100m_cny ?? 0) === 0 &&
    Number(northbound.latest_intraday_net_inflow_100m_cny ?? 0) === 0;

  if (!northboundLooksSuppressed && northbound.latest_date && northbound.latest_summary_net_buy_100m_cny !== null && northbound.latest_summary_net_buy_100m_cny !== undefined) {
    lines.push(
      `- 北向资金：${northbound.latest_date} 净买额 ${formatSigned(northbound.latest_summary_net_buy_100m_cny, " 亿元")}；盘中最新 ${northbound.latest_intraday_time ?? "--"} 为 ${formatSigned(northbound.latest_intraday_net_inflow_100m_cny, " 亿元")}`
    );
  } else if (northbound.note) {
    lines.push(`- 北向资金：${northbound.note}`);
  }

  const southboundLooksSuppressed =
    southbound.note &&
    Number(southbound.latest_summary_net_buy_100m_hkd ?? 0) === 0 &&
    Number(southbound.latest_intraday_net_inflow_100m_hkd ?? 0) === 0;

  if (
    !southboundLooksSuppressed &&
    southbound.latest_date &&
    southbound.latest_summary_net_buy_100m_hkd !== null &&
    southbound.latest_summary_net_buy_100m_hkd !== undefined
  ) {
    lines.push(
      `- 南向资金：${southbound.latest_date} 净买额 ${formatSigned(southbound.latest_summary_net_buy_100m_hkd, " 亿元")}；盘中最新 ${southbound.latest_intraday_time ?? "--"} 为 ${formatSigned(southbound.latest_intraday_net_inflow_100m_hkd, " 亿元")}`
    );
  } else if (southbound.note) {
    lines.push(`- 南向资金：${southbound.note}`);
  }

  if (macroCycle.phase_label) {
    lines.push(
      `- 宏观相位：${macroCycle.phase_label}；制造业 PMI ${macroCycle.manufacturing_pmi ?? "--"}，M2 同比 ${macroCycle.m2_yoy ?? "--"}%，CPI 同比 ${macroCycle.cpi_yoy ?? "--"}%`
    );
    lines.push(
      `- 风格提示：相对占优 ${listOrFallback(macroCycle.favored_groups)}；暂偏谨慎 ${listOrFallback(macroCycle.disfavored_groups)}`
    );
  }

  if (sectorFlow.industry?.today?.leaders?.length > 0) {
    lines.push(
      `- 行业资金流：今日主力净流入前三 ${formatFlowLeaders(sectorFlow.industry.today.leaders)}；5日主线 ${formatFlowLeaders(sectorFlow.industry?.five_day?.leaders)}`
    );
  }

  if (sectorFlow.concept?.today?.leaders?.length > 0) {
    lines.push(
      `- 概念资金流：今日主力净流入前三 ${formatFlowLeaders(sectorFlow.concept.today.leaders)}`
    );
  }

  if (rotation.rotation_mode_label) {
    lines.push(
      `- 轮动验证：${rotation.rotation_mode_label}（确认度 ${rotation.confirmation_level_label ?? "--"}），当前更偏 ${listOrFallback(rotation.today_focus_styles)}；${rotation.conclusion ?? "暂无结论"}`
    );
  }

  if (notes.length > 0) {
    lines.push(...notes.map((item) => `- 补充判断：${item}`));
  }

  return lines;
}

export function buildCnDailyBriefLines(snapshot) {
  if (!isUsableCnMarketSnapshot(snapshot)) {
    return [];
  }

  const breadth = snapshot.sections?.market_breadth ?? {};
  const northbound = snapshot.sections?.northbound_flow ?? {};
  const southbound = snapshot.sections?.southbound_flow ?? {};
  const macroCycle = snapshot.sections?.macro_cycle ?? {};
  const sectorFlow = snapshot.sections?.sector_fund_flow ?? {};
  const rotation = snapshot.sections?.sector_rotation_validation ?? {};
  const lines = [];

  if (breadth.total_count) {
    lines.push(
      `- A股补充信号：上涨家数 ${breadth.up_count ?? "--"} / ${breadth.total_count}，中位涨跌幅 ${formatSigned(breadth.median_change_pct, "%")}`
    );
  }

  const northboundLooksSuppressed =
    northbound.note &&
    Number(northbound.latest_summary_net_buy_100m_cny ?? 0) === 0 &&
    Number(northbound.latest_intraday_net_inflow_100m_cny ?? 0) === 0;

  if (!northboundLooksSuppressed && northbound.latest_summary_net_buy_100m_cny !== null && northbound.latest_summary_net_buy_100m_cny !== undefined) {
    lines.push(
      `- 北向核验：当日净买额 ${formatSigned(northbound.latest_summary_net_buy_100m_cny, " 亿元")}；盘中最新 ${formatSigned(northbound.latest_intraday_net_inflow_100m_cny, " 亿元")}`
    );
  } else if (northbound.note) {
    lines.push("- 北向核验：当日净流入口径当前回零，仅作辅助参考");
  }

  const southboundLooksSuppressed =
    southbound.note &&
    Number(southbound.latest_summary_net_buy_100m_hkd ?? 0) === 0 &&
    Number(southbound.latest_intraday_net_inflow_100m_hkd ?? 0) === 0;

  if (
    !southboundLooksSuppressed &&
    southbound.latest_summary_net_buy_100m_hkd !== null &&
    southbound.latest_summary_net_buy_100m_hkd !== undefined
  ) {
    lines.push(
      `- 南向核验：当日净买额 ${formatSigned(southbound.latest_summary_net_buy_100m_hkd, " 亿元")}；盘中最新 ${formatSigned(southbound.latest_intraday_net_inflow_100m_hkd, " 亿元")}`
    );
  } else if (southbound.note) {
    lines.push("- 南向核验：当日净流入口径当前回零，仅作辅助参考");
  }

  if (macroCycle.phase_label) {
    lines.push(
      `- 宏观背景：${macroCycle.phase_label}，偏向 ${listOrFallback(macroCycle.favored_groups)}`
    );
  }

  if (sectorFlow.industry?.today?.leaders?.length > 0) {
    lines.push(
      `- 行业资金流：今日前三 ${formatFlowLeaders(sectorFlow.industry.today.leaders)}`
    );
  }

  if (rotation.rotation_mode_label) {
    lines.push(
      `- 轮动验证：${rotation.rotation_mode_label}，当前主线更偏 ${listOrFallback(rotation.today_focus_styles)}`
    );
  }

  return lines;
}
