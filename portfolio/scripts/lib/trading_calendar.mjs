import { readFileSync } from "node:fs";

const CN_HOLIDAY_PAYLOAD = JSON.parse(
  readFileSync(new URL("../../../funds/holiday.json", import.meta.url), "utf8")
);

function normalizeDateText(dateText) {
  const normalized = String(dateText ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null;
}

function addOneDay(dateText) {
  const base = new Date(`${dateText}T12:00:00+08:00`);
  if (!Number.isFinite(base.getTime())) {
    return null;
  }
  base.setUTCDate(base.getUTCDate() + 1);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(base);
}

function isWeekend(dateText) {
  const base = new Date(`${dateText}T12:00:00+08:00`);
  if (!Number.isFinite(base.getTime())) {
    return false;
  }
  return [0, 6].includes(base.getUTCDay());
}

export function isTradingHoliday(dateText) {
  const normalized = normalizeDateText(dateText);
  if (!normalized) {
    return false;
  }

  const [year, month, day] = normalized.split("-");
  const yearPayload = CN_HOLIDAY_PAYLOAD?.data?.[year];
  return Boolean(yearPayload?.[`${month}-${day}`]?.holiday);
}

export function nextTradingDay(dateText) {
  let cursor = normalizeDateText(dateText);
  if (!cursor) {
    return null;
  }

  do {
    cursor = addOneDay(cursor);
  } while (cursor && (isWeekend(cursor) || isTradingHoliday(cursor)));

  return cursor;
}

export function secondTradingDay(dateText) {
  const first = nextTradingDay(dateText);
  return first ? nextTradingDay(first) : null;
}
