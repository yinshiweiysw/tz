import { mkdir, readFile, writeFile } from "node:fs/promises";
import { buildPortfolioPath, resolveAccountId, resolvePortfolioRoot } from "./lib/account_root.mjs";
import { updateManifestCanonicalEntrypoints } from "./lib/manifest_state.mjs";
import { loadCanonicalPortfolioState, readJsonOrNull } from "./lib/portfolio_state_view.mjs";

const args = process.argv.slice(2);

function parseArgs(argv) {
  const result = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    result[token.slice(2)] = argv[index + 1] ?? "";
    index += 1;
  }

  return result;
}

function resolveDate(dateArg) {
  if (dateArg) {
    return dateArg;
  }

  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function round(value, digits = 2) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Number(numeric.toFixed(digits)) : null;
}

function signed(value, digits = 2, suffix = "") {
  const rounded = round(value, digits);
  if (!Number.isFinite(rounded)) {
    return `--${suffix}`;
  }

  return `${rounded > 0 ? "+" : ""}${rounded}${suffix}`;
}

function sortDescending(items, field) {
  return items
    .slice()
    .sort((left, right) => Number(right?.[field] ?? 0) - Number(left?.[field] ?? 0));
}

function sortAscending(items, field) {
  return items
    .slice()
    .sort((left, right) => Number(left?.[field] ?? 0) - Number(right?.[field] ?? 0));
}

function isHeldBucket(item) {
  return Number(item?.portfolio_weight_pct ?? 0) > 0;
}

function buildMarkdownLines(performanceAttribution) {
  const brinson = performanceAttribution.brinson_summary ?? {};
  const allocationLaggers = performanceAttribution.allocation_ranking?.laggards ?? [];
  const selectionChampions =
    performanceAttribution.selection_ranking?.invested_champions ??
    performanceAttribution.selection_ranking?.champions ??
    [];
  const selectionLaggers =
    performanceAttribution.selection_ranking?.invested_laggards ??
    performanceAttribution.selection_ranking?.laggards ??
    [];
  const unheldOpportunityCosts =
    performanceAttribution.selection_ranking?.unheld_opportunity_costs ?? [];
  const unheldAvoidedDrawdowns =
    performanceAttribution.selection_ranking?.unheld_avoided_drawdowns ?? [];
  const leaders = performanceAttribution.leaders ?? {};
  const lines = [];

  lines.push(
    `- Brinson 摘要：组合 Active Effect ${signed(brinson.total_active_effect_pct, 4, "%")}，其中 Allocation ${signed(
      brinson.total_allocation_effect_pct,
      4,
      "%"
    )}，Selection ${signed(brinson.total_selection_effect_pct, 4, "%")}，Interaction ${signed(
      brinson.total_interaction_effect_pct,
      4,
      "%"
    )}。`
  );

  if (allocationLaggers.length > 0) {
    lines.push("- 配置超额拖累榜：");
    for (const item of allocationLaggers) {
      lines.push(
        `- ${item.bucket_label}：Allocation ${signed(item.allocation_effect_pct, 4, "%")}，当前权重 ${item.portfolio_weight_pct ?? "--"}%，基准 ${item.benchmark_weight_pct ?? "--"}%。`
      );
    }
  } else {
    lines.push("- 配置超额拖累榜：暂无明显配置失误桶。");
  }

  if (selectionChampions.length > 0) {
    lines.push("- 选股超额冠军榜（仅统计已持有仓位桶）：");
    for (const item of selectionChampions) {
      lines.push(
        `- ${item.bucket_label}：Selection ${signed(item.selection_effect_pct, 4, "%")}，组合收益 ${signed(
          item.portfolio_return_pct,
          4,
          "%"
        )}，基准收益 ${signed(item.benchmark_return_pct, 4, "%")}。`
      );
    }
  } else {
    lines.push("- 选股超额冠军榜（仅统计已持有仓位桶）：暂无已持有仓位桶跑赢各自基准。");
  }

  if (selectionLaggers.length > 0) {
    lines.push("- 选股超额拖油瓶（仅统计已持有仓位桶）：");
    for (const item of selectionLaggers) {
      lines.push(
        `- ${item.bucket_label}：Selection ${signed(item.selection_effect_pct, 4, "%")}，组合收益 ${signed(
          item.portfolio_return_pct,
          4,
          "%"
        )}，基准收益 ${signed(item.benchmark_return_pct, 4, "%")}。`
      );
    }
  } else {
    lines.push("- 选股超额拖油瓶（仅统计已持有仓位桶）：暂无已持有仓位桶明显跑输各自基准。");
  }

  if (unheldOpportunityCosts.length > 0) {
    lines.push("- 未持有桶机会成本提示：");
    for (const item of unheldOpportunityCosts) {
      lines.push(
        `- ${item.bucket_label}：当前未持有，但其基准收益 ${signed(
          item.benchmark_return_pct,
          4,
          "%"
        )}，相对形成 ${signed(item.selection_effect_pct, 4, "%")} 的缺席拖累。此项属于机会成本，不视为真实选股失误。`
      );
    }
  }

  if (unheldAvoidedDrawdowns.length > 0) {
    lines.push("- 未持有桶回避效果：");
    for (const item of unheldAvoidedDrawdowns) {
      lines.push(
        `- ${item.bucket_label}：当前未持有，其基准收益 ${signed(
          item.benchmark_return_pct,
          4,
          "%"
        )}，因此相对获得 ${signed(item.selection_effect_pct, 4, "%")} 的回避收益。此项属于缺席收益，不视为真实选股 Alpha。`
      );
    }
  }

  lines.push(`- 配置失误罪魁：${leaders.allocation_culprit?.commentary ?? "暂无明显配置级错误。"} `);
  lines.push(`- 选股冠军：${leaders.selection_champion?.commentary ?? "暂无已持有仓位桶形成稳定正向选股贡献。"} `);
  lines.push(`- 选股拖油瓶：${leaders.selection_dragger?.commentary ?? "暂无已持有仓位桶形成明显负向选股拖累。"} `);

  return lines.map((line) => line.trimEnd());
}

const options = parseArgs(args);
const portfolioRoot = resolvePortfolioRoot(options);
const accountId = resolveAccountId(options);
const manifestPath = buildPortfolioPath(portfolioRoot, "state-manifest.json");
const quantMetricsPath = buildPortfolioPath(portfolioRoot, "data", "quant_metrics_engine.json");
const outputDir = buildPortfolioPath(portfolioRoot, "data");
const outputPath = buildPortfolioPath(outputDir, "performance_attribution.json");

await mkdir(outputDir, { recursive: true });

const manifest = await readJsonOrNull(manifestPath);
const portfolioStateView = await loadCanonicalPortfolioState({ portfolioRoot, manifest });
const [portfolioState, quantMetrics] = await Promise.all([
  Promise.resolve(portfolioStateView.payload ?? {}),
  JSON.parse(await readFile(quantMetricsPath, "utf8"))
]);

const reportDate = options.date || portfolioState.snapshot_date || resolveDate();
const brinson = quantMetrics?.brinson_attribution ?? {};
const bucketEffects = Array.isArray(brinson.bucket_effects) ? brinson.bucket_effects : [];
const allocationRanking = sortAscending(bucketEffects, "allocation_effect_pct");
const heldBucketEffects = bucketEffects.filter(isHeldBucket);
const unheldBucketEffects = bucketEffects.filter(
  (item) => !isHeldBucket(item) && Number(item?.benchmark_weight_pct ?? 0) > 0
);
const selectionRanking = sortDescending(heldBucketEffects, "selection_effect_pct");
const positiveSelection = selectionRanking.filter((item) => Number(item.selection_effect_pct ?? 0) > 0);
const negativeSelection = sortAscending(heldBucketEffects, "selection_effect_pct").filter(
  (item) => Number(item.selection_effect_pct ?? 0) < 0
);
const unheldOpportunityCosts = sortAscending(unheldBucketEffects, "selection_effect_pct").filter(
  (item) => Number(item.selection_effect_pct ?? 0) < 0
);
const unheldAvoidedDrawdowns = sortDescending(unheldBucketEffects, "selection_effect_pct").filter(
  (item) => Number(item.selection_effect_pct ?? 0) > 0
);
const worstAllocation = allocationRanking.find((item) => Number(item.allocation_effect_pct ?? 0) < 0) ?? null;
const bestSelection = positiveSelection[0] ?? null;
const worstSelection = negativeSelection[0] ?? null;

const performanceAttribution = {
  account_id: accountId,
  as_of: reportDate,
  snapshot_date: portfolioState.snapshot_date ?? reportDate,
  currency: portfolioState.currency ?? "CNY",
  source_files: {
    portfolio_snapshot: portfolioStateView.sourcePath,
    portfolio_snapshot_source_kind: portfolioStateView.sourceKind,
    quant_metrics_engine: quantMetricsPath
  },
  methodology: {
    attribution_model: "Brinson-Fachler",
    portfolio_return_source: brinson.portfolio_return_source ?? null,
    benchmark_return_source: brinson.benchmark_return_source ?? null,
    notes: [
      "Allocation Effect = (Wp - Wb) * (Rb - Rb_total)",
      "Selection Effect = Wb * (Rp - Rb)",
      "Interaction Effect = (Wp - Wb) * (Rp - Rb)"
    ]
  },
  portfolio_summary: {
    active_position_count: quantMetrics?.portfolio_snapshot?.active_position_count ?? null,
    market_value_cny: quantMetrics?.portfolio_snapshot?.total_market_value_cny ?? null,
    snapshot_date: quantMetrics?.portfolio_snapshot?.snapshot_date ?? portfolioState.snapshot_date ?? null,
    portfolio_annualized_volatility_pct:
      quantMetrics?.risk_model?.portfolio_annualized_volatility_pct ?? null
  },
  brinson_summary: {
    benchmark_total_return_pct: brinson.benchmark_total_return_pct ?? null,
    total_allocation_effect_pct: brinson.total_allocation_effect_pct ?? null,
    total_selection_effect_pct: brinson.total_selection_effect_pct ?? null,
    total_interaction_effect_pct: brinson.total_interaction_effect_pct ?? null,
    total_active_effect_pct: brinson.total_active_effect_pct ?? null
  },
  bucket_attribution: bucketEffects,
  allocation_ranking: {
    laggards: allocationRanking.slice(0, 3),
    leaders: sortDescending(bucketEffects, "allocation_effect_pct")
      .filter((item) => Number(item.allocation_effect_pct ?? 0) > 0)
      .slice(0, 3)
  },
  selection_ranking: {
    champions: positiveSelection.slice(0, 3),
    laggards: negativeSelection.slice(0, 3),
    invested_champions: positiveSelection.slice(0, 3),
    invested_laggards: negativeSelection.slice(0, 3),
    unheld_opportunity_costs: unheldOpportunityCosts.slice(0, 3),
    unheld_avoided_drawdowns: unheldAvoidedDrawdowns.slice(0, 3)
  },
  leaders: {
    allocation_culprit: worstAllocation
      ? {
          bucket_key: worstAllocation.bucket_key,
          bucket_label: worstAllocation.bucket_label,
          allocation_effect_pct: worstAllocation.allocation_effect_pct,
          commentary: `${worstAllocation.bucket_label} 的配置超额为 ${signed(
            worstAllocation.allocation_effect_pct,
            4,
            "%"
          )}，是当前最明显的配置失误来源。`
        }
      : null,
    selection_champion: bestSelection
      ? {
          bucket_key: bestSelection.bucket_key,
          bucket_label: bestSelection.bucket_label,
          selection_effect_pct: bestSelection.selection_effect_pct,
          commentary: `${bestSelection.bucket_label} 的选股超额为 ${signed(
            bestSelection.selection_effect_pct,
            4,
            "%"
          )}，是当前已持有仓位中最强的选股/结构质量贡献来源。`
        }
      : null,
    selection_dragger: worstSelection
      ? {
          bucket_key: worstSelection.bucket_key,
          bucket_label: worstSelection.bucket_label,
          selection_effect_pct: worstSelection.selection_effect_pct,
          commentary: `${worstSelection.bucket_label} 的选股超额为 ${signed(
            worstSelection.selection_effect_pct,
            4,
            "%"
          )}，是当前已持有仓位中最明显的跑输基准拖累项。`
        }
      : null
  }
};

performanceAttribution.markdown_lines = buildMarkdownLines(performanceAttribution);

await writeFile(outputPath, `${JSON.stringify(performanceAttribution, null, 2)}\n`, "utf8");

if (manifest?.canonical_entrypoints) {
  await updateManifestCanonicalEntrypoints({
    manifestPath,
    baseManifest: manifest,
    entries: {
      latest_performance_attribution: outputPath
    }
  });
}

const terminalLines = [
  "=== 📊 业绩归因分析 / Brinson Attribution ===",
  `Account: ${accountId}`,
  `As Of: ${reportDate}`,
  `Active Effect: ${signed(performanceAttribution.brinson_summary.total_active_effect_pct, 4, "%")}`,
  `Allocation Total: ${signed(performanceAttribution.brinson_summary.total_allocation_effect_pct, 4, "%")}`,
  `Selection Total: ${signed(performanceAttribution.brinson_summary.total_selection_effect_pct, 4, "%")}`,
  `Interaction Total: ${signed(performanceAttribution.brinson_summary.total_interaction_effect_pct, 4, "%")}`,
  "",
  "Allocation Laggards:",
  ...(performanceAttribution.allocation_ranking.laggards.length > 0
    ? performanceAttribution.allocation_ranking.laggards.map(
        (item, index) =>
          `${index + 1}. ${item.bucket_label} | Allocation ${signed(item.allocation_effect_pct, 4, "%")} | Weight Gap ${signed(item.weight_gap_pct, 4, "pct")}`
      )
    : ["1. 暂无明显配置失误桶"]),
  "",
  "Selection Champions (Held Buckets):",
  ...(performanceAttribution.selection_ranking.invested_champions.length > 0
    ? performanceAttribution.selection_ranking.invested_champions.map(
        (item, index) =>
          `${index + 1}. ${item.bucket_label} | Selection ${signed(item.selection_effect_pct, 4, "%")} | Rp ${signed(item.portfolio_return_pct, 4, "%")} vs Rb ${signed(item.benchmark_return_pct, 4, "%")}`
      )
    : ["1. 暂无已持有仓位桶形成明显正向选股贡献"]),
  "",
  "Selection Laggards (Held Buckets):",
  ...(performanceAttribution.selection_ranking.invested_laggards.length > 0
    ? performanceAttribution.selection_ranking.invested_laggards.map(
        (item, index) =>
          `${index + 1}. ${item.bucket_label} | Selection ${signed(item.selection_effect_pct, 4, "%")} | Rp ${signed(item.portfolio_return_pct, 4, "%")} vs Rb ${signed(item.benchmark_return_pct, 4, "%")}`
      )
    : ["1. 暂无已持有仓位桶形成明显负向选股拖累"]),
  "",
  "Unheld Opportunity Costs:",
  ...(performanceAttribution.selection_ranking.unheld_opportunity_costs.length > 0
    ? performanceAttribution.selection_ranking.unheld_opportunity_costs.map(
        (item, index) =>
          `${index + 1}. ${item.bucket_label} | Unheld Drag ${signed(item.selection_effect_pct, 4, "%")} | Benchmark ${signed(item.benchmark_return_pct, 4, "%")}`
      )
    : ["1. 暂无明显未持有机会成本"]),
  "",
  "Unheld Avoided Drawdowns:",
  ...(performanceAttribution.selection_ranking.unheld_avoided_drawdowns.length > 0
    ? performanceAttribution.selection_ranking.unheld_avoided_drawdowns.map(
        (item, index) =>
          `${index + 1}. ${item.bucket_label} | Unheld Benefit ${signed(item.selection_effect_pct, 4, "%")} | Benchmark ${signed(item.benchmark_return_pct, 4, "%")}`
      )
    : ["1. 暂无明显未持有回避收益"]),
  "",
  `Output: ${outputPath}`
];

console.log(terminalLines.join("\n"));
