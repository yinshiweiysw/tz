# Fund Units+NAV Canonical Design

## Goal

把当前基金系统从“`amount / holding_pnl / daily_pnl` 经常被当成底层真值”的模式，迁移到“`units + cost_basis + nav/valuation + effective_date` 才是唯一真值”的模式，同时不牺牲现有面板、AI-agent、交易建议和 QDII 生效规则。

本设计采用 **方案 B：三阶段兼容迁移**：

- 先立住 canonical truth
- 再切产品读模型
- 最后迁移分析、交易、报告

这样可以避免“大爆炸式切换”把基金面板、子账户、agent 上下文、信号引擎同时打坏。

## Why Change

当前系统存在 4 类根问题：

1. `amount`、`holding_pnl`、`summary.total_fund_assets` 在多个模块里被同时读写，容易漂移。
2. 基金面板、agent 分析、交易脚本对“当前金额”的定义不完全一致。
3. QDII / 港股 / 黄金等存在生效日、收盘时点、确认净值滞后的差异，容易把“观察值”和“账本值”混算。
4. AI-agent 改一个模块时，经常没有先评估联动影响，导致别的功能静默退化。

## Design Principles

### 1. 账户真值与市场真值分离

账户真值表示“我持有多少、成本多少、何时生效”：

- `units`
- `cost_basis_cny`
- `profit_effective_on`
- `settlement_rule`
- 交易、分红、转换、到账等事件

市场真值表示“市场当前给到什么净值/估值”：

- `confirmed_nav`
- `confirmed_nav_date`
- `intraday_valuation`
- `intraday_valuation_time`
- `quote_mode`

这两者不能混在一个字段里，也不能相互覆盖。

### 2. Derived 字段保留，但不再是 source of truth

以下字段继续保留，作为兼容输出：

- `amount`
- `holding_pnl`
- `holding_pnl_rate_pct`
- `daily_pnl`
- `summary.total_fund_assets`
- `summary.total_portfolio_assets_cny`

但它们只能由统一派生器生成，不允许再被多个脚本分别写成“真值”。

### 3. 页面读路径只读

基金面板、健康检查、agent 启动上下文、报告入口都只能读取 state / sidecar / dashboard products，不能在 GET 或读取路径里偷偷物化、补跑、改写 repo-tracked 文件。

### 4. AI-agent 必须先做变更影响评估

任何涉及：

- 状态字段
- 金额/收益逻辑
- 估值/确认逻辑
- dashboard summary
- agent runtime context
- signal / trade / risk outputs

的变更，都必须先产出 impact checklist，再允许实施。

## Canonical Data Contract

### Layer 1: Accounting Truth

主落点：`state/portfolio_state.json`

持久化真值字段：

- `units`
- `cost_basis_cny`
- `profit_effective_on`
- `settlement_rule`
- `latest_confirmed_nav`
- `latest_confirmed_nav_date`
- `last_buy_nav`
- `last_buy_trade_date`
- `pending_buy_events`
- `pending_sell_cash_events`
- `dividend_events`
- `conversion_events`

这层保证：即便 365 天不打开系统，只要后来重新拉到最新净值，仍然能重建正确金额和持有收益。

### Layer 2: Market Truth

主来源：基金 quote provider / nightly confirmed nav / live quote overlay

统一字段：

- `confirmed_nav`
- `confirmed_nav_date`
- `confirmed_nav_source`
- `intraday_valuation`
- `intraday_valuation_time`
- `intraday_change_pct`
- `quote_mode`
- `is_comparable_today`
- `stale_reason`

说明：

- `confirmed_nav` 用于确认口径、夜间对账、收益生效日
- `intraday_valuation` 用于白天观察，不直接改账本
- `quote_mode=close_reference` 只能做参考，不得覆盖账本金额

### Layer 3: Product Read Model

主落点：`data/dashboard_state.json`

结构固定为：

- `accounting`
- `observation`
- `presentation`

派生规则固定：

- `amount = units * selected_nav`
- `holding_pnl = amount - cost_basis_cny`
- `holding_pnl_rate_pct = holding_pnl / cost_basis_cny`
- `daily_pnl = units * comparable_nav_delta`

其中：

- `selected_nav` 可以是 `confirmed_nav` 或 `intraday_valuation`
- 但使用哪一种必须显式标记
- `displayDailyPnl` 只汇总“当日可比”的标的

### Layer 4: Agent Read Model

主落点：

- `data/agent_runtime_context.json`
- `data/strategy_decision_contract.json`
- `data/agent_bootstrap_context.json`

要求：

- 新 agent 不再自己扫描仓库猜状态
- 所有分析、交易、执行建议先读统一事实层和统一决策合同
- `bootstrap` 中必须带有 change guardrails 和 required reads

## Change Impact Guardrail

新增系统级门禁：

### Required Checklist

每次改动前，AI-agent 必须明确：

1. `change_layer`
   - `accounting`
   - `market_valuation`
   - `dashboard`
   - `analysis_risk`
   - `execution`
   - `agent_runtime`
   - `reporting`

2. `canonical_inputs`
   - 本次改动依赖哪些真值字段

3. `affected_modules`
   - 至少覆盖 canonical state、dashboard、agent context、signals、trades、reports、tests

4. `impact_decision`
   - `must_update`
   - `compatible_no_change`
   - `regression_only`

5. `write_boundary_check`
   - 是否触碰 truth layer
   - 是否触碰 derived layer
   - 是否触碰 GET read path
   - 是否触碰 sidecar refresh chain

6. `required_regressions`
   - 未跑完不得宣称完成

### Rule

未做影响评估，不允许实施。

未跑联动回归，不允许宣称修复完成。

若旧功能将受到影响，必须显式声明：

- 保留
- 联改
- 废弃

不能静默消失。

## Phase Migration

### Phase 0: Change Guardrail First

先把变更影响门禁写入：

- `docs/AI_AGENT_DISPATCH_PROTOCOL.md`
- `data/agent_bootstrap_context.json`
- 独立 guardrail contract

目标是以后任何 agent 改动都必须先过联动评估。

### Phase A: Establish Canonical Truth

主改：

- `portfolio_state_materializer.mjs`
- `holding_cost_basis.mjs`
- `manual_trade_recorder.mjs`
- `confirmed_nav_reconciler.mjs`

目标：

- `units + cost_basis + effective_on` 成为唯一持仓真值
- 旧 `amount / pnl / summary` 降级为 derived-only
- 保留 QDII `T+2`、节假日、卖出到账规则

### Phase B: Freeze Dashboard Read Model

主改：

- `serve_funds_live_dashboard.mjs`
- `build_dashboard_state.mjs`
- `refresh_account_sidecars.mjs`

目标：

- 面板金额、持有收益、今日收益全部从 canonical truth + latest nav 派生
- `close_reference` 不再覆盖账本金额
- summary 明确区分 accounting vs observation

### Phase C: Migrate Agent Read Model

主改：

- `agent_runtime_context.mjs`
- `build_agent_runtime_context.mjs`
- `build_strategy_decision_contract.mjs`
- `bootstrap_agent_context.mjs`

目标：

- 新线程 agent 直接知道仓位、成本、真钱现金、流动性防线、观察收益
- 不再自行拼多个文件
- 不再把债券当可用现金

### Phase D: Migrate Signals / Trades / Risk

主改：

- `generate_signals.py`
- `trade_generator.py`
- `generate_risk_dashboard.mjs`
- `calculate_quant_metrics.py`

目标：

- 仓位权重、桶权重、集中度、归因都从 `units + latest nav` 现算
- 不再依赖容易漂移的旧 `amount`

### Phase E: Compatibility Cleanup

旧字段仍可输出给遗留报表和兼容脚本，但全部降级为 derived-only，不允许反向回写业务真值。

## Non-Goals

- 本轮不做基金面板的大改版 UI
- 本轮不在第一阶段重写整个 signal engine
- 本轮不把所有报告体系一起重构
- 本轮不移除旧字段，只移除它们的“真值地位”

## Success Criteria

达到以下条件，说明迁移成功：

1. 当前金额和持有收益可由 `units + latest nav` 稳定重建。
2. QDII 买入不会在错误日期提前计入收益。
3. dashboard 不再因为 reference quote 把金额覆盖错。
4. 新 AI-agent 进入系统后，不再需要自己扫描仓库猜当前状态。
5. 任意一次改动前，AI-agent 都必须先产出 impact checklist。
6. 旧功能若受影响，会被显式联改或回归，不再静默消失。

