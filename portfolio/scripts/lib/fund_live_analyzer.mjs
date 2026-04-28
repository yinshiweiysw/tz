import { readJsonOrDefault, writeJsonAtomic } from "./atomic_json_state.mjs";
import { buildPortfolioPath } from "./account_root.mjs";
import { readManifestState, updateManifestCanonicalEntrypoints } from "./manifest_state.mjs";
import { loadTradingAgentsBridgeConfig } from "./tradingagents_bridge.mjs";
import { loadTradingDecisionSnapshot } from "./tradingagents_decision.mjs";
import { buildFundTradingAgentsContext } from "./fund_tradingagents_adapter.mjs";

const PROVIDER_ENV = {
  glm: "ZHIPU_API_KEY",
  deepseek: "DEEPSEEK_API_KEY"
};

const PROVIDER_PRESETS = {
  glm: {
    provider: "glm",
    model: "glm-5.1",
    backendUrl: "https://api.z.ai/api/paas/v4/",
    temperature: 0.2,
    maxTokens: 1200
  },
  deepseek: {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    backendUrl: "https://api.deepseek.com",
    temperature: 0.2,
    maxTokens: 1200
  }
};

function trimText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeProviderName(value) {
  return String(value ?? "").trim().toLowerCase() || null;
}

function buildChatCompletionsUrl(baseUrl) {
  const base = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  return `${base}/chat/completions`;
}

function resolveApiKey(provider, env = process.env) {
  const envName = PROVIDER_ENV[normalizeProviderName(provider)];
  if (!envName) {
    return null;
  }
  return trimText(env?.[envName]);
}

function providerAttemptFromConfig(item = {}) {
  const provider = normalizeProviderName(item?.llmProvider ?? item?.provider);
  if (!provider) {
    return null;
  }
  const preset = PROVIDER_PRESETS[provider] ?? { provider };
  return {
    ...preset,
    ...item,
    provider,
    model: trimText(item?.fundAnalysisModel) ??
      trimText(item?.deepThinkModel) ??
      trimText(item?.quickThinkModel) ??
      preset.model,
    backendUrl: trimText(item?.backendUrl) ?? preset.backendUrl
  };
}

export function resolveFundAnalyzerProviderAttempts(bridgeConfig = {}) {
  const chain = bridgeConfig?.providerChain;
  const configured = [];
  if (chain?.primary) {
    configured.push(chain.primary);
  }
  if (Array.isArray(chain?.fallback)) {
    configured.push(...chain.fallback);
  } else if (chain?.fallback) {
    configured.push(chain.fallback);
  }
  if (configured.length === 0) {
    configured.push(bridgeConfig?.providerDefaults ?? { llmProvider: "glm" });
  }

  const attempts = [];
  const seen = new Set();
  for (const item of configured) {
    const attempt = providerAttemptFromConfig(item);
    if (!attempt || seen.has(attempt.provider)) {
      continue;
    }
    seen.add(attempt.provider);
    attempts.push(attempt);
  }
  return attempts;
}

function extractJsonObject(text) {
  const source = String(text ?? "").trim();
  if (!source) {
    return null;
  }
  try {
    return JSON.parse(source);
  } catch {
    // Continue to fenced/embedded JSON extraction.
  }
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      // Fall through.
    }
  }
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(source.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeVerdict(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (["continue_hold", "downgrade_watch", "reduce_risk_candidate", "replace_candidate", "needs_manual_review"].includes(text)) {
    return text;
  }
  if (/替换/.test(text)) return "replace_candidate";
  if (/减|降风险|降低/.test(text)) return "reduce_risk_candidate";
  if (/降级|观察/.test(text)) return "downgrade_watch";
  if (/持有|继续/.test(text)) return "continue_hold";
  return "needs_manual_review";
}

function normalizeRiskLevel(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (["low", "medium", "high"].includes(text)) return text;
  if (/高/.test(text)) return "high";
  if (/低/.test(text)) return "low";
  return "medium";
}

function compactList(value, limit = 4) {
  if (Array.isArray(value)) {
    return value.map((item) => trimText(item)).filter(Boolean).slice(0, limit);
  }
  const text = trimText(value);
  return text ? [text] : [];
}

function pushUnique(list, value, limit = 6) {
  const text = trimText(value);
  if (!text || list.includes(text) || list.length >= limit) {
    return list;
  }
  return [...list, text];
}

function countBy(items, keyFn) {
  return asArray(items).reduce((acc, item) => {
    const key = trimText(keyFn(item)) ?? "unknown";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}

export function buildFundLiveAnalysisSummary(snapshot = {}) {
  const analyses = asArray(snapshot?.analyses);
  const successRows = analyses.filter((item) => item?.status === "success");
  const highRiskRows = analyses.filter((item) => String(item?.riskLevel ?? "").toLowerCase() === "high");
  const providers = [...new Set(successRows.map((item) => trimText(item?.provider)).filter(Boolean))];
  const status = trimText(snapshot?.status) ?? (analyses.length > 0 ? "partial" : "missing");
  const readyCount = successRows.length;
  const totalCount = Number.isFinite(Number(snapshot?.count)) ? Number(snapshot.count) : analyses.length;
  const coverageLabel = totalCount > 0 ? `${readyCount}/${totalCount}` : "0/0";
  const providerLabel = providers.length > 0 ? providers.join(" / ") : "--";
  const verdictCounts = countBy(successRows, (item) => item?.verdict);
  const riskCounts = countBy(successRows, (item) => item?.riskLevel);
  return {
    status,
    statusLabel:
      status === "ready"
        ? "基金级 live 已完成"
        : status === "partial"
          ? "基金级 live 部分完成"
          : status === "blocked"
            ? "基金级 live 失败"
            : status === "fixture"
              ? "基金级 fixture"
              : "基金级 live 未运行",
    scope: trimText(snapshot?.scope) ?? "deep_dive",
    readyCount,
    totalCount,
    coverageLabel,
    successRate: totalCount > 0 ? readyCount / totalCount : 0,
    providerLabel,
    highRiskCount: highRiskRows.length,
    verdictCounts,
    riskCounts,
    generatedAt: snapshot?.generatedAt ?? null,
    headline:
      totalCount > 0
        ? `基金级 live 分析 ${coverageLabel}；高风险 ${highRiskRows.length} 只；来源 ${providerLabel}。`
        : "基金级 live 分析尚未运行。"
  };
}

export function buildFundLivePortfolioConclusion(snapshot = {}) {
  const analyses = asArray(snapshot?.analyses);
  const successRows = analyses.filter((item) => item?.status === "success");
  const highRiskRows = successRows.filter((item) => String(item?.riskLevel ?? "").toLowerCase() === "high");
  const reduceRows = successRows.filter((item) => item?.verdict === "reduce_risk_candidate");
  const watchRows = successRows.filter((item) => item?.verdict === "downgrade_watch" || item?.verdict === "needs_manual_review");
  const topRiskFunds = [...highRiskRows, ...reduceRows]
    .filter((item, index, rows) => rows.findIndex((row) => row?.fundCode === item?.fundCode) === index)
    .slice(0, 5)
    .map((item) => ({
      fundCode: item?.fundCode ?? null,
      fundName: item?.fundName ?? null,
      verdict: item?.verdict ?? null,
      verdictLabel: item?.verdictLabel ?? null,
      riskLevel: item?.riskLevel ?? null,
      headline: item?.headline ?? null
    }));
  const total = Number.isFinite(Number(snapshot?.count)) ? Number(snapshot.count) : analyses.length;
  const ready = successRows.length;
  const scope = trimText(snapshot?.scope) ?? "deep_dive";
  return {
    scope,
    coverageLabel: total > 0 ? `${ready}/${total}` : "0/0",
    oneLine:
      ready === 0
        ? "基金级 live 主脑尚未形成可用结论。"
        : highRiskRows.length > 0
          ? `基金级 live 主脑已完成 ${ready}/${total}；${highRiskRows.length} 只高风险，优先复核 ${highRiskRows.slice(0, 3).map((item) => item.fundName || item.fundCode).join(" / ")}。`
          : `基金级 live 主脑已完成 ${ready}/${total}；当前没有高风险基金。`,
    riskLine:
      highRiskRows.length > 0
        ? `高风险 ${highRiskRows.length} 只，减风险候选 ${reduceRows.length} 只。`
        : "当前基金级 live 结论没有高风险标签。",
    actionLine:
      reduceRows.length > 0
        ? `先复核 ${reduceRows.slice(0, 3).map((item) => item.fundName || item.fundCode).join(" / ")}；这仍是只读复核，不是订单。`
        : watchRows.length > 0
          ? `主要是观察/人工复核队列 ${watchRows.length} 只，暂不直接生成动作。`
          : "没有基金级减风险候选。",
    topRiskFunds,
    nextReviewFocus: topRiskFunds.map((item) =>
      `${item.fundCode ?? "--"} ${item.verdictLabel ?? item.verdict ?? "复核"}：${item.headline ?? "等待细化"}`
    )
  };
}

function resolveResearchQualityGuardrail(context = {}) {
  const quality = context?.researchProfile?.quality ?? {};
  const status = trimText(quality?.status);
  const oneLine = trimText(quality?.oneLine) ?? trimText(quality?.statusLabel);
  switch (status) {
    case "ready":
      return { status, oneLine, confidenceCap: null, note: null };
    case "stale":
      return {
        status,
        oneLine,
        confidenceCap: 0.62,
        note: `资料完整度限制：${oneLine ?? "重仓资料陈旧"}，不能按最新底层持仓做强归因。`
      };
    case "partial":
      return {
        status,
        oneLine,
        confidenceCap: 0.72,
        note: `资料完整度限制：${oneLine ?? "只有部分资料"}，结论主要按主题、代理资产和本地持仓风险判断。`
      };
    case "inferred":
    case "missing":
      return {
        status,
        oneLine,
        confidenceCap: 0.58,
        note: `资料完整度限制：${oneLine ?? "基金资料不足"}，不能做基金经理、行业穿透或重仓股归因。`
      };
    default:
      return { status: status ?? "unknown", oneLine, confidenceCap: null, note: null };
  }
}

function applyResearchQualityGuardrail(payload = {}, context = {}) {
  const guardrail = resolveResearchQualityGuardrail(context);
  if (!guardrail.note && guardrail.confidenceCap === null) {
    return {
      ...payload,
      researchQualityGuardrail: guardrail
    };
  }
  const parsedConfidence = Number.isFinite(Number(payload.confidence)) ? Number(payload.confidence) : null;
  const cappedConfidence =
    parsedConfidence !== null && guardrail.confidenceCap !== null
      ? Math.min(parsedConfidence, guardrail.confidenceCap)
      : parsedConfidence;
  const uncertainty = pushUnique(
    compactList(payload.uncertainty, 5),
    guardrail.note,
    6
  );
  const reasons = pushUnique(
    compactList(payload.reasons, 5),
    guardrail.status === "stale" ? "基金重仓资料陈旧，结论已降低置信度。" : null,
    5
  );
  const boundarySuffix = guardrail.note ? ` ${guardrail.note}` : "";
  return {
    ...payload,
    reasons,
    confidence: cappedConfidence === null ? null : Math.round(cappedConfidence * 100) / 100,
    uncertainty,
    actionBoundary: `${trimText(payload.actionBoundary) ?? "只读复核结论，不构成订单。"}${boundarySuffix}`,
    researchQualityGuardrail: guardrail
  };
}

function normalizeAnalysisPayload(parsed = {}, context = {}, providerAttempt = {}) {
  return applyResearchQualityGuardrail({
    fundCode: context?.fundCode ?? null,
    fundName: context?.fundName ?? null,
    provider: providerAttempt.provider ?? null,
    model: providerAttempt.model ?? null,
    status: "success",
    verdict: normalizeVerdict(parsed?.verdict),
    verdictLabel: trimText(parsed?.verdictLabel) ?? trimText(parsed?.verdict_label) ?? null,
    riskLevel: normalizeRiskLevel(parsed?.riskLevel ?? parsed?.risk_level),
    headline: trimText(parsed?.headline) ?? trimText(parsed?.summary) ?? "基金级 live 分析完成。",
    reasons: compactList(parsed?.reasons, 5),
    watchPoints: compactList(parsed?.watchPoints ?? parsed?.watch_points, 5),
    actionBoundary: trimText(parsed?.actionBoundary ?? parsed?.action_boundary) ?? "只读复核结论，不构成订单。",
    confidence: Number.isFinite(Number(parsed?.confidence)) ? Number(parsed.confidence) : null,
    peerRead: trimText(parsed?.peerRead ?? parsed?.peer_read) ?? null,
    uncertainty: compactList(parsed?.uncertainty ?? parsed?.uncertainties, 4)
  }, context);
}

function templateInstructionForContext(context = {}) {
  const template = trimText(context?.researchProfile?.analysisTemplate);
  const embedded = trimText(context?.researchProfile?.templateInstruction);
  if (embedded) {
    return embedded;
  }
  switch (template) {
    case "qdii_fof_fund":
      return "QDII/FOF：优先分析底层基金透明度、跨市场净值滞后、汇率/海外交易日、与同类 QDII 暴露重复。";
    case "qdii_index_fund":
      return "QDII/指数：优先分析跟踪指数、代理 ETF、QDII 净值滞后、费率/申赎限制和同指数重复暴露。";
    case "qdii_active_fund":
      return "QDII/主动/主题：优先分析海外主题代理、基金经理/组合风格、跨市场净值滞后、汇率影响和同类 QDII 重复暴露。";
    case "qdii_commodity_fund":
      return "QDII/商品：优先分析商品/黄金对冲角色、海外交易日与汇率滞后、HEDGE 桶仓位上限；不要按权益进攻仓处理。";
    case "index_fund":
      return "指数基金：优先分析跟踪标的、指数风格、费率/跟踪误差和同标的重复，不做主动选股归因。";
    case "active_equity_fund":
      return "主动权益：优先分析基金经理/公司、行业穿透、风格漂移和回撤；资料缺失时降低置信度。";
    case "defensive_fund":
      return "防守/固收：优先分析流动性、久期/信用、回撤和现金替代角色，默认不参与进攻动作。";
    default:
      return "通用基金：先识别基金类型，再结合资料层、代理资产、持仓和组合约束判断。";
  }
}

function buildFundLivePrompt(context = {}) {
  return [
    "你是一个基金交易分析师。请基于给定 JSON 上下文，分析这只中国公募基金在当前组合里的状态。",
    "你不是下单系统。只能输出只读复核结论，不能生成订单，不能修改账本。",
    "请特别区分：代理资产方向、基金资料层、基金本身净值滞后、用户持仓成本、组合目标仓位、同类基金重复暴露。",
    "如果 researchProfile.lookthrough.status 为 not_loaded，不得编造基金经理、重仓股或行业穿透；必须把它列入 uncertainty。",
    "如果 researchProfile 已提供基金类型、主题、行业或重仓，请优先用于基金级判断，而不是只按股票/ETF代理资产下结论。",
    "如果 researchProfile.quality.status 不是 ready，必须降低 confidence，并把资料限制写入 uncertainty；重仓陈旧/仅主题穿透时，不得做强底层持仓归因。",
    `本基金分析模板：${templateInstructionForContext(context)}`,
    "必须输出严格 JSON，不要 Markdown，不要额外解释。",
    "JSON schema:",
    JSON.stringify({
      verdict: "continue_hold | downgrade_watch | reduce_risk_candidate | replace_candidate | needs_manual_review",
      verdictLabel: "中文短标签",
      riskLevel: "low | medium | high",
      headline: "一句话结论，40字以内",
      reasons: ["最多5条原因"],
      watchPoints: ["今天/下次复核看什么"],
      peerRead: "同类基金/重复暴露判断",
      actionBoundary: "为什么这不是订单",
      confidence: 0.0,
      uncertainty: ["不确定项"]
    }),
    "基金上下文 JSON:",
    JSON.stringify(context, null, 2)
  ].join("\n");
}

async function callProviderForFund({
  context,
  providerAttempt,
  apiKey,
  fetchFn = globalThis.fetch,
  timeoutMs = 60_000
} = {}) {
  if (typeof fetchFn !== "function") {
    throw new Error("fetch is not available");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(buildChatCompletionsUrl(providerAttempt.backendUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: providerAttempt.model,
        messages: [
          {
            role: "system",
            content: "你是基金交易分析师，输出严格 JSON。"
          },
          {
            role: "user",
            content: buildFundLivePrompt(context)
          }
        ],
        temperature: Number(providerAttempt.temperature ?? 0.2),
        max_tokens: Number(providerAttempt.maxTokens ?? providerAttempt.max_tokens ?? 1200),
        thinking: { type: "disabled" },
        stream: false
      }),
      signal: controller.signal
    });
    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`provider_http_${response.status}:${providerAttempt.provider}`);
    }
    const envelope = JSON.parse(responseText);
    const content = envelope?.choices?.[0]?.message?.content ?? envelope?.choices?.[0]?.text ?? "";
    const parsed = extractJsonObject(content);
    if (!parsed) {
      throw new Error(`provider_json_parse_failed:${providerAttempt.provider}`);
    }
    return normalizeAnalysisPayload(parsed, context, providerAttempt);
  } finally {
    clearTimeout(timer);
  }
}

function buildContextsFromDecision({ decisionSnapshot = {}, scope = "deep_dive", limit = 4 } = {}) {
  const fundAnalyses = asArray(decisionSnapshot?.fundAnalyses);
  const portfolioAnalysis = decisionSnapshot?.portfolioAnalysis ?? {};
  const bucketActions = asArray(decisionSnapshot?.bucketActions);
  if (scope === "all") {
    return fundAnalyses.slice(0, limit).map((item) => buildFundTradingAgentsContext({
      candidate: item,
      fundAnalyses,
      bucketActions,
      portfolioAnalysis,
      decisionSnapshot
    }));
  }
  const adapterContexts = asArray(
    decisionSnapshot?.fundTradingAgentsAdapter?.contexts ??
    portfolioAnalysis?.fundTradingAgentsAdapter?.contexts
  );
  if (adapterContexts.length > 0) {
    return adapterContexts.slice(0, limit);
  }
  return asArray(decisionSnapshot?.deepDiveCandidates ?? portfolioAnalysis?.deepDiveCandidates)
    .slice(0, limit)
    .map((item) => buildFundTradingAgentsContext({
      candidate: item,
      fundAnalyses,
      bucketActions,
      portfolioAnalysis,
      decisionSnapshot
    }));
}

export function resolveFundLiveAnalysisPath(portfolioRoot, manifest = {}) {
  return (
    trimText(manifest?.canonical_entrypoints?.latest_fund_live_analysis_snapshot) ??
    buildPortfolioPath(portfolioRoot, "data", "fund_live_analysis_snapshot.json")
  );
}

export async function loadFundLiveAnalysisSnapshot({ portfolioRoot, manifest = null } = {}) {
  const resolvedManifest = manifest ?? (await readManifestState(buildPortfolioPath(portfolioRoot, "state-manifest.json")));
  return readJsonOrDefault(resolveFundLiveAnalysisPath(portfolioRoot, resolvedManifest), null);
}

export async function persistFundLiveAnalysisSnapshot({ portfolioRoot, snapshot, manifest = null } = {}) {
  const manifestPath = buildPortfolioPath(portfolioRoot, "state-manifest.json");
  const resolvedManifest = manifest ?? (await readManifestState(manifestPath));
  const outputPath = resolveFundLiveAnalysisPath(portfolioRoot, resolvedManifest);
  await writeJsonAtomic(outputPath, snapshot);
  await updateManifestCanonicalEntrypoints({
    manifestPath,
    baseManifest: resolvedManifest,
    entries: {
      latest_fund_live_analysis_snapshot: outputPath
    }
  });
  return outputPath;
}

export async function runFundLiveAnalysis({
  portfolioRoot,
  accountId = "main",
  scope = "deep_dive",
  limit = null,
  mode = "live",
  bridgeConfig = null,
  env = process.env,
  fetchFn = globalThis.fetch,
  now = new Date()
} = {}) {
  const resolvedBridgeConfig = bridgeConfig ?? (await loadTradingAgentsBridgeConfig());
  const normalizedScope = scope === "all" ? "all" : "deep_dive";
  const effectiveLimit = Math.max(
    1,
    Number(limit) || (normalizedScope === "all" ? 24 : 4)
  );
  const decisionSnapshot = await loadTradingDecisionSnapshot({
    portfolioRoot,
    accountId,
    allowFixtureFallback: true,
    now
  });
  const contexts = buildContextsFromDecision({
    decisionSnapshot,
    scope: normalizedScope,
    limit: effectiveLimit
  });
  const providerAttempts = resolveFundAnalyzerProviderAttempts(resolvedBridgeConfig);
  const analyses = [];
  const providerAttempted = [];

  if (mode !== "live") {
    const snapshot = {
      generatedAt: now.toISOString(),
      asOf: decisionSnapshot?.asOf ?? null,
      accountId,
      mode: "fixture",
      source: "TradingAgents fund live analyzer",
      brainMode: "fund_live_analysis",
      status: "fixture",
      scope: normalizedScope,
      count: contexts.length,
      analyses: contexts.map((context) => ({
        fundCode: context.fundCode,
        fundName: context.fundName,
        provider: "fixture",
        model: "fixture",
        status: "success",
        verdict: "needs_manual_review",
        verdictLabel: "人工复核",
        riskLevel: "medium",
        headline: "fixture 基金分析，仅用于合同验证。",
        reasons: ["fixture 模式未调用 live provider"],
        watchPoints: context.analysisQuestions?.slice(0, 2) ?? [],
        actionBoundary: "只读复核，不构成订单。",
        confidence: null
      })),
      diagnostics: { providerAttempted: [] }
    };
    return {
      ...snapshot,
      summary: buildFundLiveAnalysisSummary(snapshot),
      portfolioConclusion: buildFundLivePortfolioConclusion(snapshot)
    };
  }

  for (const context of contexts) {
    let analysis = null;
    for (const providerAttempt of providerAttempts) {
      const apiKey = resolveApiKey(providerAttempt.provider, env);
      const attempt = {
        provider: providerAttempt.provider,
        model: providerAttempt.model,
        fundCode: context.fundCode,
        status: "pending",
        error: null
      };
      providerAttempted.push(attempt);
      if (!apiKey) {
        attempt.status = "missing_key";
        attempt.error = `Missing required API key: ${PROVIDER_ENV[providerAttempt.provider] ?? providerAttempt.provider}`;
        continue;
      }
      try {
        analysis = await callProviderForFund({
          context,
          providerAttempt,
          apiKey,
          fetchFn,
          timeoutMs: Number(providerAttempt.fundAnalysisTimeoutMs ?? 60_000)
        });
        attempt.status = "success";
        break;
      } catch (error) {
        attempt.status = "failed";
        attempt.error = String(error?.message ?? error);
      }
    }
    analyses.push(analysis ?? {
      fundCode: context.fundCode,
      fundName: context.fundName,
      provider: null,
      model: null,
      status: "failed",
      verdict: "needs_manual_review",
      verdictLabel: "live 分析失败",
      riskLevel: "medium",
      headline: "基金级 live 分析暂不可用。",
      reasons: ["provider 未返回可用基金级结论"],
      watchPoints: context.analysisQuestions?.slice(0, 2) ?? [],
      actionBoundary: "失败结果不构成订单。",
      confidence: null
    });
  }

  const successCount = analyses.filter((item) => item.status === "success").length;
  const snapshot = {
    generatedAt: now.toISOString(),
    asOf: decisionSnapshot?.asOf ?? null,
    accountId,
    mode: "live",
    source: "TradingAgents fund live analyzer",
    brainMode: "fund_live_analysis",
    status: successCount === analyses.length ? "ready" : successCount > 0 ? "partial" : "blocked",
    scope: normalizedScope,
    count: analyses.length,
    successCount,
    analyses,
    diagnostics: {
      providerAttempted,
      decisionStatus: decisionSnapshot?.status ?? null,
      decisionProviderMode: decisionSnapshot?.providerMode ?? null,
      adapterMode: decisionSnapshot?.fundTradingAgentsAdapter?.adapterMode ?? null
    }
  };
  return {
    ...snapshot,
    summary: buildFundLiveAnalysisSummary(snapshot),
    portfolioConclusion: buildFundLivePortfolioConclusion(snapshot)
  };
}
