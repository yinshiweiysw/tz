function buildTimeoutError(timeoutMs) {
  const error = new Error(`Fetch timed out after ${timeoutMs}ms`);
  error.name = "TimeoutError";
  error.code = "FETCH_TIMEOUT";
  return error;
}

const CME_FUTURES_QUOTE_CODES = new Set(["HF_ES", "HF_NQ"]);
const CME_FUTURES_TIMEOUT_MS = 12_000;

export function resolveQuoteFetchTimeoutMs(code, defaultTimeoutMs) {
  const normalizedCode = String(code ?? "").trim().toUpperCase();
  if (CME_FUTURES_QUOTE_CODES.has(normalizedCode)) {
    return CME_FUTURES_TIMEOUT_MS;
  }

  return defaultTimeoutMs;
}

export async function runGuardedFetch({ source, label = source, timeoutMs, task }) {
  let timer = null;

  try {
    const data = await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(buildTimeoutError(timeoutMs)), timeoutMs);
        timer.unref?.();
      })
    ]);

    return {
      source,
      label,
      ok: true,
      status: "ok",
      data
    };
  } catch (error) {
    const message = error?.message ?? String(error);
    const status =
      error?.code === "FETCH_TIMEOUT" || /timed out/i.test(message) ? "timeout" : "error";

    return {
      source,
      label,
      ok: false,
      status,
      message
    };
  } finally {
    clearTimeout(timer);
  }
}

export function summarizeGuardedBatch({ source, label = source, results = [] }) {
  const failures = results.filter((item) => item?.ok !== true);
  if (failures.length === 0) {
    return {
      source,
      label,
      ok: true,
      status: "ok",
      count: results.length
    };
  }

  const failedLabels = failures
    .map((item) => item?.label ?? item?.source ?? null)
    .filter(Boolean)
    .join("、");
  const status = failures.some((item) => item?.status === "timeout") ? "timeout" : "error";

  return {
    source,
    label,
    ok: false,
    status,
    count: results.length,
    failedCount: failures.length,
    message: `${failures.length}/${results.length} 个请求异常：${failedLabels}`
  };
}

export function buildExternalSourceStatusLines(results = []) {
  const degraded = results.filter((item) => item?.ok === false);
  if (degraded.length === 0) {
    return [];
  }

  return [
    "## 外部行情源状态",
    "",
    ...degraded.map(
      (item) =>
        `- ⚠️ ${item.label ?? item.source}：${item.status}，已按降级口径生成报告（${item.message ?? "数据源异常"}）。`
    )
  ];
}
