import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildPortfolioPath, defaultPortfolioRoot } from "./account_root.mjs";

export function buildNightlyConfirmedNavStatusPath({ portfolioRoot = defaultPortfolioRoot } = {}) {
  return buildPortfolioPath(portfolioRoot, "data", "nightly_confirmed_nav_status.json");
}

export async function readNightlyConfirmedNavStatus({
  portfolioRoot = defaultPortfolioRoot,
  statusPath = ""
} = {}) {
  const resolvedPath = statusPath || buildNightlyConfirmedNavStatusPath({ portfolioRoot });
  try {
    return JSON.parse(await readFile(resolvedPath, "utf8"));
  } catch {
    return null;
  }
}

export async function writeNightlyConfirmedNavStatus(
  payload,
  {
    portfolioRoot = defaultPortfolioRoot,
    statusPath = ""
  } = {}
) {
  const resolvedPath = statusPath || buildNightlyConfirmedNavStatusPath({ portfolioRoot });
  await mkdir(path.dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return resolvedPath;
}

function formatShanghaiDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function getShanghaiHour(date = new Date()) {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      hour12: false
    }).format(date)
  );
}

function shiftShanghaiDate(dateText, daysDelta) {
  const base = new Date(`${dateText}T12:00:00+08:00`);
  if (!Number.isFinite(base.getTime())) {
    return null;
  }
  base.setUTCDate(base.getUTCDate() + Number(daysDelta || 0));
  return formatShanghaiDate(base);
}

function normalizeAccountId(value) {
  return String(value ?? "").trim() || "main";
}

function normalizeSnapshotDate(value) {
  return String(value ?? "").trim() || null;
}

export function findNightlyConfirmedNavAccountRun({
  statusPayload,
  accountId,
  snapshotDate = null
} = {}) {
  const normalizedAccountId = normalizeAccountId(accountId);
  const normalizedSnapshotDate = normalizeSnapshotDate(snapshotDate);
  const accountRuns = Array.isArray(statusPayload?.accounts) ? statusPayload.accounts : [];
  const matchingRuns = accountRuns.filter(
    (item) => normalizeAccountId(item?.accountId) === normalizedAccountId
  );

  if (matchingRuns.length === 0) {
    return null;
  }

  if (normalizedSnapshotDate) {
    const exact = matchingRuns.filter(
      (item) => normalizeSnapshotDate(item?.snapshotDate) === normalizedSnapshotDate
    );
    if (exact.length > 0) {
      return exact.at(-1) ?? null;
    }
  }

  return matchingRuns.at(-1) ?? null;
}

export function resolveNightlyConfirmedNavReadiness({
  statusPayload = null,
  accountId,
  snapshotDate = null,
  now = new Date(),
  morningCutoffHour = 8,
  selfHealInFlight = false
} = {}) {
  const normalizedSnapshotDate = normalizeSnapshotDate(snapshotDate);
  const today = formatShanghaiDate(now);
  const hour = getShanghaiHour(now);
  const priorNightTargetDate = shiftShanghaiDate(today, -1);
  const effectiveTargetDate =
    hour >= morningCutoffHour && priorNightTargetDate
      ? normalizedSnapshotDate && normalizedSnapshotDate.localeCompare(priorNightTargetDate) < 0
        ? normalizedSnapshotDate
        : priorNightTargetDate
      : normalizedSnapshotDate;
  const accountRun = findNightlyConfirmedNavAccountRun({
    statusPayload,
    accountId,
    snapshotDate: effectiveTargetDate
  });
  const stats = accountRun?.stats ?? {};
  const normalLagCount =
    Number(stats?.normalLagFundCount ?? 0) + Number(stats?.holidayDelayFundCount ?? 0);
  const hardFailureCount =
    Number(stats?.lateMissingFundCount ?? 0) + Number(stats?.sourceMissingFundCount ?? 0);

  if (accountRun?.success === true) {
    return {
      state: "confirmed_nav_ready",
      shouldTriggerSelfHeal: false,
      targetDate: normalizeSnapshotDate(accountRun?.snapshotDate) ?? effectiveTargetDate,
      accountRun,
      reason: null
    };
  }

  if (selfHealInFlight) {
    return {
      state: "self_heal_running",
      shouldTriggerSelfHeal: false,
      targetDate: effectiveTargetDate,
      accountRun,
      reason: null
    };
  }

  const runType = String(accountRun?.runType ?? statusPayload?.runType ?? "").trim();
  if (accountRun?.success === false && runType === "self_heal_on_read") {
    return {
      state: "self_heal_failed",
      shouldTriggerSelfHeal: false,
      targetDate: normalizeSnapshotDate(accountRun?.snapshotDate) ?? effectiveTargetDate,
      accountRun,
      reason: String(accountRun?.error ?? statusPayload?.fatalError ?? "self_heal_failed").trim()
    };
  }

  const shouldTriggerSelfHeal = Boolean(
    effectiveTargetDate &&
      effectiveTargetDate.localeCompare(today) < 0 &&
      hour >= morningCutoffHour
  );

  return {
    state: "temporary_live_valuation",
    shouldTriggerSelfHeal,
    targetDate: effectiveTargetDate,
    accountRun,
    reason: accountRun?.success === false ? String(accountRun?.error ?? "").trim() || null : null
  };
}
