import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildPortfolioPath,
  resolveAccountId,
  resolvePortfolioRoot
} from "./lib/account_root.mjs";
import { buildDialogueAnalysisContract } from "./lib/dialogue_analysis_contract.mjs";
import { readManifestState } from "./lib/manifest_state.mjs";
import { readJsonOrNull } from "./lib/portfolio_state_view.mjs";
import { ensureReportContext, resolveScopedResearchBrainPath } from "./lib/report_context.mjs";
import { runResearchBrainBuild } from "./generate_research_brain.mjs";

function parseArgs(argv) {
  const result = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
      continue;
    }

    result[key] = next;
    index += 1;
  }

  return result;
}

function normalizeNow(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value;
  }

  if (value !== undefined && value !== null) {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) {
      return parsed;
    }
  }

  return new Date();
}

function normalizeSentence(value) {
  return String(value ?? "").trim().replace(/[。.!?]+$/u, "");
}

function buildResearchGuardLines(researchBrain) {
  if (!researchBrain) {
    return [
      "- 研究会话：--。",
      "- 决策状态：--。",
      "- 风险说明：研究主脑缺失，当前禁止输出高置信度对话结论。",
      "- 覆盖降级：研究覆盖未知域不完整，以下结论仅作低置信度参考。",
      "- 新鲜度/覆盖概览：freshness=--，coverage=--。"
    ];
  }

  const freshnessStatus = String(researchBrain?.freshness_guard?.overall_status ?? "--").trim() || "--";
  const coverageStatus = String(researchBrain?.coverage_guard?.overall_status ?? "--").trim() || "--";
  const session = String(researchBrain?.meta?.market_session ?? "--").trim() || "--";
  const readinessLevel = String(researchBrain?.decision_readiness?.level ?? "--").trim() || "--";
  const analysisAllowed = researchBrain?.decision_readiness?.analysis_allowed === true;
  const tradingAllowed = researchBrain?.decision_readiness?.trading_allowed === true;
  const reasons = Array.isArray(researchBrain?.decision_readiness?.reasons)
    ? researchBrain.decision_readiness.reasons.filter(Boolean)
    : [];
  const staleDependencies = Array.isArray(researchBrain?.freshness_guard?.stale_dependencies)
    ? researchBrain.freshness_guard.stale_dependencies
        .map((item) => item?.label ?? item?.key ?? null)
        .filter(Boolean)
    : [];
  const missingDependencies = Array.isArray(researchBrain?.freshness_guard?.missing_dependencies)
    ? researchBrain.freshness_guard.missing_dependencies
        .map((item) => item?.label ?? item?.key ?? null)
        .filter(Boolean)
    : [];
  const weakCoverageDomains = Array.isArray(researchBrain?.coverage_guard?.weak_domains)
    ? researchBrain.coverage_guard.weak_domains
        .map((item) => (typeof item === "string" ? item : item?.domain ?? item?.key ?? item?.label ?? null))
        .filter(Boolean)
    : [];

  return [
    `- 研究会话：${session}。`,
    `- 决策状态：${readinessLevel}（分析${analysisAllowed ? "可用" : "受限"}，交易${
      tradingAllowed ? "可执行" : "受限"
    }）。`,
    ...(reasons.length > 0
      ? reasons.map((reason) => `- 风险说明：${normalizeSentence(reason)}。`)
      : ["- 风险说明：无显式门禁风险。"]),
    ...(weakCoverageDomains.length > 0
      ? weakCoverageDomains.map(
          (domain) => `- 覆盖降级：${normalizeSentence(domain)} 域不完整，以下结论仅作低置信度参考。`
        )
      : ["- 覆盖降级：无。"]),
    `- 新鲜度/覆盖概览：freshness=${freshnessStatus}，coverage=${coverageStatus}。`,
    `- 数据缺口：stale=${staleDependencies.length > 0 ? staleDependencies.join("、") : "无"}；missing=${
      missingDependencies.length > 0 ? missingDependencies.join("、") : "无"
    }。`
  ];
}

function shouldRebuildResearchBrain({ refreshMode, freshness = {}, researchBrain }) {
  if (!researchBrain) {
    return true;
  }

  if (refreshMode === "never") {
    return false;
  }

  const staleKeys = Array.isArray(freshness?.staleKeys) ? freshness.staleKeys : [];
  const missingKeys = Array.isArray(freshness?.missingKeys) ? freshness.missingKeys : [];
  const refreshRecommendedKeys = Array.isArray(freshness?.refreshRecommendedKeys)
    ? freshness.refreshRecommendedKeys
    : [];

  return (
    staleKeys.includes("research_brain") ||
    missingKeys.includes("research_brain") ||
    refreshRecommendedKeys.includes("research_brain")
  );
}

async function loadAgentEntryArtifacts(portfolioRoot, manifest = null) {
  const effectiveManifest =
    manifest ?? (await readManifestState(buildPortfolioPath(portfolioRoot, "state-manifest.json")));
  const canonical = effectiveManifest?.canonical_entrypoints ?? {};
  const runtimeContextPath =
    canonical.agent_runtime_context ??
    buildPortfolioPath(portfolioRoot, "data", "agent_runtime_context.json");
  const strategyDecisionContractPath =
    canonical.strategy_decision_contract ??
    buildPortfolioPath(portfolioRoot, "data", "strategy_decision_contract.json");
  const agentBootstrapContextPath =
    canonical.latest_agent_bootstrap_context ??
    buildPortfolioPath(portfolioRoot, "data", "agent_bootstrap_context.json");

  const [agentRuntimeContext, strategyDecisionContract, agentBootstrapContext] =
    await Promise.all([
      readJsonOrNull(runtimeContextPath),
      readJsonOrNull(strategyDecisionContractPath),
      readJsonOrNull(agentBootstrapContextPath)
    ]);

  return {
    runtimeContextPath,
    strategyDecisionContractPath,
    agentBootstrapContextPath,
    agentRuntimeContext: agentRuntimeContext ?? {},
    strategyDecisionContract: strategyDecisionContract ?? {},
    agentBootstrapContext: agentBootstrapContext ?? {}
  };
}

export async function runDialogueAnalysisContractBuild(rawOptions = {}, dependencies = {}) {
  const portfolioRoot = resolvePortfolioRoot(rawOptions);
  const accountId = resolveAccountId(rawOptions);
  const now = normalizeNow(rawOptions.now);
  const ensureContext = dependencies.ensureReportContext ?? ensureReportContext;
  const buildResearchBrain = dependencies.runResearchBrainBuild ?? runResearchBrainBuild;
  const contextOptions = { ...rawOptions };

  if (
    !Object.prototype.hasOwnProperty.call(contextOptions, "refresh") &&
    !Object.prototype.hasOwnProperty.call(contextOptions, "refresh-mode") &&
    !Object.prototype.hasOwnProperty.call(contextOptions, "refresh_mode")
  ) {
    contextOptions.refresh = "auto";
  }

  const context = await ensureContext({
    portfolioRoot,
    options: contextOptions,
    includePerformanceAttribution: false
  });

  let researchBrain = context?.payloads?.researchBrain ?? null;
  let rebuiltResearchBrain = false;
  const researchBrainOutputPath = resolveScopedResearchBrainPath({
    portfolioRoot,
    options: contextOptions,
    anchorDate:
      String(context?.payloads?.latest?.snapshot_date ?? "").trim() ||
      String(context?.payloads?.researchBrain?.meta?.trade_date ?? "").trim() ||
      null
  });

  if (
    shouldRebuildResearchBrain({
      refreshMode: context?.refresh?.mode ?? "auto",
      freshness: context?.freshness ?? {},
      researchBrain
    })
  ) {
    const buildResult = await buildResearchBrain({
      ...contextOptions,
      portfolioRoot,
      now,
      ...(researchBrainOutputPath ? { output: researchBrainOutputPath } : {})
    });
    researchBrain = buildResult?.output ?? null;
    rebuiltResearchBrain = Boolean(researchBrain);
  }

  if (!researchBrain) {
    throw new Error("Dialogue analysis contract requires a valid research_brain payload.");
  }

  const agentEntryArtifacts = await loadAgentEntryArtifacts(portfolioRoot, context?.manifest ?? null);

  const contract = buildDialogueAnalysisContract({
    researchBrain,
    cnMarketSnapshot: context?.payloads?.cnMarketSnapshot ?? {},
    opportunityPool: context?.payloads?.opportunityPool ?? {},
    speculativePlan: context?.payloads?.speculativePlan ?? {},
    tradePlan: context?.payloads?.tradePlan ?? {},
    researchGuardLines: buildResearchGuardLines(researchBrain),
    agentRuntimeContext: agentEntryArtifacts.agentRuntimeContext,
    strategyDecisionContract: agentEntryArtifacts.strategyDecisionContract,
    agentBootstrapContext: agentEntryArtifacts.agentBootstrapContext
  });

  const outputPath = String(rawOptions.output ?? "").trim() ||
    buildPortfolioPath(portfolioRoot, "data", "dialogue_analysis_contract.json");

  const payload = {
    generated_at: now.toISOString(),
    account_id: accountId,
    portfolio_root: portfolioRoot,
    rebuilt_research_brain: rebuiltResearchBrain,
    refresh: context?.refresh ?? {
      mode: "unknown",
      triggered: false,
      refreshedTargets: [],
      skippedTargets: [],
      errors: []
    },
    agent_entry_artifacts: {
      runtime_context_path: agentEntryArtifacts.runtimeContextPath,
      strategy_decision_contract_path: agentEntryArtifacts.strategyDecisionContractPath,
      bootstrap_context_path: agentEntryArtifacts.agentBootstrapContextPath
    },
    contract
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  return {
    outputPath,
    payload,
    contract,
    rebuiltResearchBrain
  };
}

const isDirectExecution =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  const result = await runDialogueAnalysisContractBuild(parseArgs(process.argv.slice(2)));
  console.log(
    JSON.stringify({
      accountId: result.payload.account_id,
      outputPath: result.outputPath,
      rebuiltResearchBrain: result.rebuiltResearchBrain,
      refreshTriggered: result.payload.refresh?.triggered ?? false
    })
  );
}
