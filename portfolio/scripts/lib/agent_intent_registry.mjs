import { buildPortfolioPath } from "./account_root.mjs";

const SHARED_REQUIRED_READS = [
  "data/agent_runtime_context.json",
  "data/strategy_decision_contract.json"
];

export function buildAgentIntentRegistry(portfolioRoot) {
  const script = (name) => buildPortfolioPath(portfolioRoot, "scripts", name);

  return {
    分析当前行情: {
      primaryScript: script("generate_dialogue_analysis_contract.mjs"),
      requiredReads: ["state-manifest.json", ...SHARED_REQUIRED_READS, "state/portfolio_state.json"],
      forbiddenBehaviors: ["不要直接扫描整个仓库", "不要默认读取 working_view", "不要跳过实时新闻校验"],
      requiresExternalNewsRefresh: true,
      minimumNewsSources: 2
    },
    今天该不该交易: {
      primaryScript: script("generate_signals.py"),
      followupScript: script("generate_next_trade_plan.mjs"),
      requiredReads: [...SHARED_REQUIRED_READS, "state/portfolio_state.json", "signals/regime_router_signals.json"],
      forbiddenBehaviors: ["不要直接生成手工主观清单替代信号层"]
    },
    给我执行清单: {
      primaryScript: script("trade_generator.py"),
      requiredReads: [...SHARED_REQUIRED_READS, "state/portfolio_state.json", "config/asset_master.json", "data/trade_plan_v4.json"],
      forbiddenBehaviors: ["不要把报告文件当 source of truth"]
    },
    "我刚买了/卖了/转换了": {
      primaryScript: script("record_manual_fund_trades.mjs"),
      followupScript: script("ledger_sync.py"),
      requiredReads: [...SHARED_REQUIRED_READS, "ledger/execution_ledger.json", "state/portfolio_state.json"],
      forbiddenBehaviors: ["不要直接手改 latest.json 作为唯一写入"]
    },
    "看看我现在持仓": {
      primaryScript: script("generate_risk_dashboard.mjs"),
      requiredReads: [...SHARED_REQUIRED_READS, "state/portfolio_state.json", "risk_dashboard.json"],
      forbiddenBehaviors: ["不要默认读取 working_view", "不要把真钱现金和现金类基金混为 available cash"]
    },
    "打开基金面板": {
      primaryScript: script("open_funds_live_dashboard.mjs"),
      requiredReads: [...SHARED_REQUIRED_READS, "data/dashboard_state.json", "state/portfolio_state.json"],
      forbiddenBehaviors: ["不要只看首页 HTML 200 判断面板已可用"]
    },
    基金面板为什么不对: {
      primaryScript: script("serve_funds_live_dashboard.mjs"),
      followupScript: script("refresh_agent_entrypoints.mjs"),
      requiredReads: [...SHARED_REQUIRED_READS, "data/dashboard_state.json", "state/portfolio_state.json", "config/asset_master.json"],
      forbiddenBehaviors: ["不要在 GET 路径上写回 repo 状态"]
    },
    "刷新市场数据": {
      primaryScript: script("core_data_ingestion.py"),
      followupScript: script("generate_macro_state.py"),
      requiredReads: ["state-manifest.json", ...SHARED_REQUIRED_READS],
      forbiddenBehaviors: ["不要把临时数据库路径写回 manifest"]
    },
    做回测: {
      primaryScript: script("run_portfolio_backtest.py"),
      requiredReads: ["state-manifest.json", ...SHARED_REQUIRED_READS, "data/market_lake.db", "config/asset_master.json"],
      forbiddenBehaviors: ["不要跳过历史数据完整性检查"]
    },
    "收盘后生成日报": {
      primaryScript: script("generate_market_pulse.mjs"),
      followupScripts: [script("generate_daily_brief.mjs"), script("generate_market_brief.mjs")],
      requiredReads: [...SHARED_REQUIRED_READS, "state/portfolio_state.json", "data/market_lake.db"],
      forbiddenBehaviors: ["不要把旧报告直接当今日结论输出"]
    }
  };
}
