import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function normalizeString(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function toTimestamp(value) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.getTime() : null;
}

const SESSION_SLOT_BY_MARKET_SESSION = {
  pre_open: "morning",
  intraday: "noon",
  post_close: "close",
  overnight: "close",
  market_closed: "close"
};

export function resolveReportSessionSlot({ session = null, researchBrain = {} } = {}) {
  const explicitSession = normalizeString(session, null);
  if (explicitSession) {
    return explicitSession;
  }

  const marketSession = normalizeString(researchBrain?.meta?.market_session, null);
  return SESSION_SLOT_BY_MARKET_SESSION[marketSession] ?? "close";
}

export function isClosingSessionSlot(session) {
  return normalizeString(session, null) === "close";
}

function getShanghaiHourFromIso(value) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return null;
  }

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    hourCycle: "h23"
  });
  const hour = Number(formatter.format(parsed));
  return Number.isFinite(hour) ? hour : null;
}

export function isClosingSessionRecord(record = {}) {
  if (!isClosingSessionSlot(record?.session)) {
    return false;
  }

  const marketSession = normalizeString(record?.market_session, null);
  if (marketSession) {
    return SESSION_SLOT_BY_MARKET_SESSION[marketSession] === "close";
  }

  const shanghaiHour = getShanghaiHourFromIso(record?.generated_at);
  return shanghaiHour !== null ? shanghaiHour >= 15 : false;
}

function buildValidationStatus(referenceRecord, currentRecord) {
  if (!referenceRecord?.primary_driver || !currentRecord?.primary_driver) {
    return "待验证";
  }

  if (
    referenceRecord.primary_driver === currentRecord.primary_driver &&
    referenceRecord.liquidity_regime === currentRecord.liquidity_regime
  ) {
    return "已验证";
  }

  if (referenceRecord.primary_driver === currentRecord.primary_driver) {
    return "部分验证";
  }

  return "被证伪";
}

export function buildReportSessionRecord({
  tradeDate,
  session,
  reportType,
  researchBrain = {}
} = {}) {
  const eventDriver = researchBrain?.event_driver ?? {};
  const flowMacroRadar = researchBrain?.flow_macro_radar ?? {};
  const deskConclusion = researchBrain?.actionable_decision?.desk_conclusion ?? {};

  return {
    trade_date: normalizeString(tradeDate, null),
    session: resolveReportSessionSlot({ session, researchBrain }),
    report_type: normalizeString(reportType, "unknown"),
    generated_at: normalizeString(researchBrain?.generated_at, null),
    market_session: normalizeString(researchBrain?.meta?.market_session, null),
    primary_driver: normalizeString(eventDriver?.primary_driver, "暂无明确主线"),
    driver_status: normalizeString(eventDriver?.status, "unavailable"),
    expectation_gap: normalizeString(eventDriver?.expectation_gap, "暂无预期差结论"),
    liquidity_regime: normalizeString(flowMacroRadar?.liquidity_regime, "neutral"),
    flow_summary: normalizeString(flowMacroRadar?.summary, "暂无流动性摘要"),
    trade_permission: normalizeString(deskConclusion?.trade_permission, "restricted"),
    action_order: normalizeString(deskConclusion?.one_sentence_order, "暂无动作指令"),
    confidence: normalizeString(researchBrain?.section_confidence?.actionable_decision, "unknown"),
    next_bias:
      normalizeString(deskConclusion?.trade_permission, "restricted") === "allowed"
        ? "prepare"
        : normalizeString(deskConclusion?.trade_permission, "restricted") === "blocked"
        ? "blocked"
        : "observe"
  };
}

export function updateReportSessionMemory(existingMemory = {}, record = {}) {
  const tradeDate = normalizeString(record?.trade_date, null);
  const session = normalizeString(record?.session, null);
  if (!tradeDate || !session) {
    return existingMemory;
  }

  const days = existingMemory?.days && typeof existingMemory.days === "object" ? existingMemory.days : {};
  const currentDay = days[tradeDate] && typeof days[tradeDate] === "object" ? days[tradeDate] : {};

  return {
    generated_at: existingMemory?.generated_at ?? record.generated_at ?? null,
    updated_at: record.generated_at ?? new Date().toISOString(),
    days: {
      ...days,
      [tradeDate]: {
        ...currentDay,
        [session]: record
      }
    }
  };
}

function selectFresherValue(left, right) {
  const leftTs =
    toTimestamp(left?.generated_at) ??
    toTimestamp(left?.updated_at);
  const rightTs =
    toTimestamp(right?.generated_at) ??
    toTimestamp(right?.updated_at);

  if (leftTs === null) {
    return right ?? left ?? null;
  }
  if (rightTs === null) {
    return left ?? right ?? null;
  }
  return rightTs >= leftTs ? right : left;
}

function normalizeMemory(memory = {}) {
  return memory && typeof memory === "object" ? memory : {};
}

export function mergeReportSessionMemory(existingMemory = {}, incomingMemory = {}) {
  const base = normalizeMemory(existingMemory);
  const incoming = normalizeMemory(incomingMemory);
  const baseDays = base?.days && typeof base.days === "object" ? base.days : {};
  const incomingDays = incoming?.days && typeof incoming.days === "object" ? incoming.days : {};
  const mergedDays = {};

  for (const tradeDate of new Set([...Object.keys(baseDays), ...Object.keys(incomingDays)])) {
    const baseDay = baseDays[tradeDate] && typeof baseDays[tradeDate] === "object" ? baseDays[tradeDate] : {};
    const incomingDay =
      incomingDays[tradeDate] && typeof incomingDays[tradeDate] === "object" ? incomingDays[tradeDate] : {};
    const mergedDay = {};

    for (const session of new Set([...Object.keys(baseDay), ...Object.keys(incomingDay)])) {
      mergedDay[session] = selectFresherValue(baseDay[session], incomingDay[session]);
    }

    mergedDays[tradeDate] = mergedDay;
  }

  const generatedAt =
    normalizeString(base?.generated_at, null) ??
    normalizeString(incoming?.generated_at, null) ??
    null;
  const updatedAtRecord = selectFresherValue(
    { updated_at: base?.updated_at, generated_at: base?.updated_at },
    { updated_at: incoming?.updated_at, generated_at: incoming?.updated_at }
  );

  return {
    generated_at: generatedAt,
    updated_at:
      normalizeString(updatedAtRecord?.updated_at, null) ??
      normalizeString(updatedAtRecord?.generated_at, null) ??
      null,
    days: mergedDays
  };
}

export function buildReportSessionInheritanceLines({
  memory = {},
  tradeDate,
  session,
  currentRecord = {}
} = {}) {
  const dayMemory = memory?.days?.[tradeDate] ?? {};
  const morningRecord = dayMemory?.morning ?? null;
  const noonRecord = dayMemory?.noon ?? null;

  if (session === "morning") {
    return [
      `- 盘前假设：${currentRecord.primary_driver ?? "暂无明确主线"}。`,
      `- 盘前动作梯度：${currentRecord.trade_permission ?? "restricted"} / ${currentRecord.confidence ?? "unknown"}。`
    ];
  }

  if (session === "noon") {
    const validationStatus = buildValidationStatus(morningRecord, currentRecord);
    return [
      `- 早盘假设：${morningRecord?.primary_driver ?? "缺少当日早报记录"}。`,
      `- 午间验证：${validationStatus}，当前流动性状态 ${currentRecord.liquidity_regime ?? "neutral"}。`,
      `- 午间动作梯度：${currentRecord.trade_permission ?? "restricted"} / ${currentRecord.confidence ?? "unknown"}。`
    ];
  }

  const validationStatus = buildValidationStatus(morningRecord, noonRecord ?? currentRecord);
  return [
    `- 早盘假设：${morningRecord?.primary_driver ?? "缺少当日早报记录"}。`,
    `- 午间验证：${validationStatus}${noonRecord ? `（午间主线：${noonRecord.primary_driver}）` : ""}。`,
    `- 收盘归因：当前主线为 ${currentRecord.primary_driver ?? "暂无明确主线"}，动作口径 ${currentRecord.trade_permission ?? "restricted"}。`,
    `- 下一交易日偏置：${currentRecord.next_bias ?? "observe"}。`
  ];
}

export async function readReportSessionMemory(filePath) {
  if (!filePath) {
    return {};
  }

  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return {};
  }
}

export async function writeReportSessionMemory(filePath, memory = {}) {
  if (!filePath) {
    return;
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  const onDiskMemory = await readReportSessionMemory(filePath);
  const mergedMemory = mergeReportSessionMemory(onDiskMemory, memory);
  const tempPath = path.join(
    path.dirname(filePath),
    `${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  await writeFile(tempPath, `${JSON.stringify(mergedMemory, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}
