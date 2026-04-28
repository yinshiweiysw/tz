import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildFundNativeContextsFromDecision } from "./fund_native_context.mjs";
import { normalizeFundNativeAnalysis } from "./fund_native_output.mjs";
import { buildFundNativeMessages } from "./fund_native_prompt_pack.mjs";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function listFromMaybe(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function trimText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function providerAttemptsFromConfig(config = {}) {
  const chain = config?.providerChain ?? {};
  return [...listFromMaybe(chain.primary), ...listFromMaybe(chain.fallback)].map((item) => ({
    provider: String(item.provider ?? item.llmProvider ?? "glm").toLowerCase(),
    backendUrl: item.backendUrl ?? item.baseUrl ?? "https://api.z.ai/api/paas/v4",
    model: item.deepThinkModel ?? item.quickThinkModel ?? item.model ?? "glm-5.1"
  }));
}

function apiKeyForProvider(provider, env = process.env) {
  if (provider === "deepseek") {
    return env.DEEPSEEK_API_KEY ?? env.DEEPSEEK_API_KEY_POOL?.split(",")?.[0] ?? null;
  }
  return env.ZHIPU_API_KEY ?? env.ZHIPU_API_KEY_POOL?.split(",")?.[0] ?? null;
}

function chatUrl(baseUrl) {
  const base = String(baseUrl ?? "").replace(/\/+$/, "");
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

function extractJsonObject(text) {
  const source = String(text ?? "").trim();
  try {
    return JSON.parse(source);
  } catch {
    const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return JSON.parse(fenced[1]);
    const start = source.indexOf("{");
    const end = source.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(source.slice(start, end + 1));
    throw new Error("fund_native_json_parse_failed");
  }
}

async function callProvider({ context, providerAttempt, apiKey, fetchFn = fetch, timeoutMs = 90000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(chatUrl(providerAttempt.backendUrl), {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: providerAttempt.model,
        messages: buildFundNativeMessages({ context }),
        temperature: 0.2
      })
    });
    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`provider_http_${response.status}:${responseText.slice(0, 200)}`);
    }
    const envelope = JSON.parse(responseText);
    const content = envelope?.choices?.[0]?.message?.content ?? envelope?.choices?.[0]?.text ?? "";
    return { rawText: content, parsed: extractJsonObject(content) };
  } finally {
    clearTimeout(timer);
  }
}

export function resolveFundNativeAnalysisPath(portfolioRoot) {
  return path.join(portfolioRoot, "data", "fund_native_analysis_snapshot.json");
}

export async function loadFundNativeAnalysisSnapshot({ portfolioRoot } = {}) {
  try {
    return JSON.parse(await readFile(resolveFundNativeAnalysisPath(portfolioRoot), "utf8"));
  } catch {
    return null;
  }
}

export async function persistFundNativeAnalysisSnapshot({ portfolioRoot, snapshot } = {}) {
  const outputPath = resolveFundNativeAnalysisPath(portfolioRoot);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  return outputPath;
}

export async function runFundNativeTradingAgents({
  decisionSnapshot = {},
  bridgeConfig = {},
  env = process.env,
  fetchFn = fetch,
  scope = "deep_dive",
  limit = 4,
  now = new Date()
} = {}) {
  const contexts = buildFundNativeContextsFromDecision({ decisionSnapshot, scope, limit });
  const providerAttempts = providerAttemptsFromConfig(bridgeConfig);
  const analyses = [];
  const providerAttempted = [];

  for (const context of contexts) {
    let completed = null;
    for (const providerAttempt of providerAttempts) {
      const apiKey = apiKeyForProvider(providerAttempt.provider, env);
      const attempt = {
        provider: providerAttempt.provider,
        model: providerAttempt.model,
        fundCode: context.fundCode,
        status: apiKey ? "attempted" : "missing_key"
      };
      providerAttempted.push(attempt);
      if (!apiKey) continue;
      try {
        const raw = await callProvider({ context, providerAttempt, apiKey, fetchFn });
        completed = normalizeFundNativeAnalysis({
          parsed: raw.parsed,
          context,
          provider: providerAttempt.provider,
          rawText: raw.rawText
        });
        attempt.status = "success";
        break;
      } catch (error) {
        attempt.status = "failed";
        attempt.error = trimText(error?.message) ?? "provider_failed";
      }
    }
    analyses.push(completed ?? {
      fundCode: context.fundCode,
      fundName: context.fundName,
      mode: "fund_native",
      status: "failed",
      verdict: "pause_action",
      verdictLabel: "今日暂停动作",
      oneLine: "基金原生 TradingAgents 未完成，当前为降级观察。",
      execution: { executionIntent: "review_only", fundExecutionStyle: "end_of_day_t1_review" }
    });
  }

  const successCount = analyses.filter((item) => item.status === "success").length;
  return {
    generatedAt: now.toISOString(),
    mode: "fund_native",
    source: "TradingAgents fund-native compatibility mode",
    status: contexts.length === 0 ? "empty" : successCount === contexts.length ? "ready" : successCount > 0 ? "partial" : "failed",
    scope,
    count: analyses.length,
    successCount,
    providerAttempted,
    analyses
  };
}

export const __private__ = {
  providerAttemptsFromConfig,
  extractJsonObject
};
