import { buildPortfolioPath } from "./account_root.mjs";

export function buildAgentIntentRegistry(portfolioRoot) {
  const script = (name) => buildPortfolioPath(portfolioRoot, "scripts", name);
  const tradingDecisionReads = [
    "state/portfolio_state.json",
    "config/asset_master.json",
    "config/tradingagents_bridge.json",
    "data/trading_decision_snapshot.json",
    "data/trading_advice_snapshot.json"
  ];
  const tradingDecisionGuardrails = [
    "不要把 TradingAgents 决策直接转成真实订单",
    "不要写 execution_ledger.json",
    "不要绕过本地基金护栏"
  ];

  return {
    "打开基金面板": {
      primaryScript: script("open_funds_live_dashboard.mjs"),
      routePath: "/",
      requiredReads: [
        "state/portfolio_state.json",
        "data/dashboard_state.json",
        "data/live_funds_snapshot.json"
      ],
      forbiddenBehaviors: ["不要把外部建议写回持仓真相", "不要在 GET 路径上写回 repo 状态"]
    },
    "刷新基金状态": {
      primaryScript: script("refresh_account_sidecars.mjs"),
      requiredReads: [
        "state-manifest.json",
        "state/portfolio_state.json",
        "data/nightly_confirmed_nav_status.json"
      ],
      forbiddenBehaviors: ["不要跳过确认净值状态", "不要直接手改 live_funds_snapshot.json"]
    },
    "记录基金交易": {
      primaryScript: script("record_manual_fund_trades.mjs"),
      requiredReads: [
        "state/portfolio_state.json",
        "ledger/execution_ledger.json"
      ],
      forbiddenBehaviors: ["不要只在回答里口头更新仓位", "不要直接手改 latest.json 作为唯一写入"]
    },
    "生成交易建议": {
      primaryScript: script("run_tradingagents_decision_cycle.mjs"),
      routePath: "/advice",
      requiredReads: tradingDecisionReads,
      forbiddenBehaviors: tradingDecisionGuardrails
    },
    "今天该不该交易": {
      primaryScript: script("run_tradingagents_decision_cycle.mjs"),
      routePath: "/advice",
      requiredReads: tradingDecisionReads,
      forbiddenBehaviors: tradingDecisionGuardrails
    },
    "给我执行清单": {
      primaryScript: script("run_tradingagents_decision_cycle.mjs"),
      routePath: "/advice",
      requiredReads: tradingDecisionReads,
      forbiddenBehaviors: tradingDecisionGuardrails
    },
    "看看风险灯": {
      primaryScript: script("run_tradingagents_decision_cycle.mjs"),
      routePath: "/advice",
      requiredReads: tradingDecisionReads,
      forbiddenBehaviors: tradingDecisionGuardrails
    },
    "查看主链决策": {
      primaryScript: script("run_tradingagents_decision_cycle.mjs"),
      routePath: "/advice",
      requiredReads: tradingDecisionReads,
      forbiddenBehaviors: tradingDecisionGuardrails
    },
    "打开市场专题": {
      primaryScript: script("open_funds_live_dashboard.mjs"),
      routePath: "/market",
      requiredReads: [
        "state-manifest.json",
        "latest_market_brief",
        "latest_market_pulse",
        "latest_daily_brief"
      ],
      forbiddenBehaviors: ["不要把旧 Research 页面当成主入口", "不要把报告全文直接塞进基金面板首页"]
    }
  };
}
