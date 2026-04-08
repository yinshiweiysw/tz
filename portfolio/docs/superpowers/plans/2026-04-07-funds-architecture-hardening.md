## Summary

按用户已批准的“基金系统架构硬化与长期稳定化修复计划”执行。本轮目标不是继续补丁式修 UI，而是先把状态入口、现金语义、dashboard 读模型和 agent 启动链硬化，再回到展示层。

## Scope

本轮覆盖：

1. `state-manifest.json` canonical path 修正与校验
2. `agent_bootstrap_context.json` 与生成脚本
3. `portfolio_state` / `cash_ledger` 现金语义拆分
4. `asset_master.json` 中 `CASH` 桶展示语义重定义与 `position_limits`
5. `dashboard_state.json` 产品读模型
6. funds dashboard GET 路径只读化

本轮不覆盖：

1. 8767 场内 dashboard 的完整重构
2. 全部研究报告链的统一重构
3. 全量前端视觉重做

## Files

- `state-manifest.json`
  - 修正 canonical entrypoints，新增 bootstrap/dashboard state keys
- `config/asset_master.json`
  - `CASH` 标签改为“流动性防线”，补资产级 `position_limits`
- `scripts/lib/manifest_state.mjs`
  - 增加 canonical path 规范化/修复逻辑
- `scripts/bootstrap_agent_context.mjs`
  - 新建 agent 启动上下文生成脚本
- `scripts/build_dashboard_state.mjs`
  - 新建 dashboard 产品读模型构建脚本
- `scripts/lib/portfolio_state_materializer.mjs`
  - 产出新的现金语义字段
- `scripts/lib/dashboard_accounting_summary.mjs`
  - 汇总层接入新的现金字段
- `scripts/refresh_account_sidecars.mjs`
  - 显式刷新 `agent_bootstrap_context.json` 与 `dashboard_state.json`
- `scripts/serve_funds_live_dashboard.mjs`
  - GET 路径改为只读 `dashboard_state.json`，不再写回 repo state
- `scripts/open_funds_live_dashboard.mjs`
  - 启动前读取健康检查/只读状态
- 测试文件
  - `scripts/lib/manifest_state.test.mjs`
  - `scripts/lib/portfolio_state_materializer.test.mjs`
  - `scripts/lib/dashboard_accounting_summary.test.mjs`
  - `scripts/serve_funds_live_dashboard.test.mjs`
  - `scripts/open_funds_live_dashboard.test.mjs`
  - `scripts/bootstrap_agent_context.test.mjs`
  - `scripts/build_dashboard_state.test.mjs`

## Task Order

### Task 1. 锁住失败测试

先补以下测试并确认红灯：

1. manifest 会把临时 `market_lake_db` 修回 canonical repo DB
2. bootstrap context 能输出 canonical path、intent route、健康摘要
3. materializer 会拆出：
   - `settled_cash_cny`
   - `trade_available_cash_cny`
   - `cash_like_fund_assets_cny`
   - `liquidity_sleeve_assets_cny`
4. dashboard accounting summary 优先读取新现金字段
5. funds dashboard GET 请求不再触发：
   - `materializeLatestMarkToMarket`
   - `persistLiveSnapshot`
6. dashboard state builder 能生成 `accounting` / `observation` / `presentation`

### Task 2. 实现 P0

1. 修 `manifest_state`
2. 新增 `bootstrap_agent_context.mjs`
3. 更新 `state-manifest.json`
4. 在 materializer 中写入现金拆分字段
5. 更新 `asset_master.json`

### Task 3. 实现 P1

1. 新增 `build_dashboard_state.mjs`
2. 让 `refresh_account_sidecars.mjs` 写 `dashboard_state.json`
3. 让 funds dashboard 只读 `dashboard_state.json`
4. 删除 GET 路径中的 repo state 写入

### Task 4. 回归与护栏

1. 补 manifest/dashboard/bootstrap 的契约测试
2. 跑定向 node test
3. 生成一次 `agent_bootstrap_context.json`
4. 生成一次 `dashboard_state.json`
5. 用实际 `main` 账户做 smoke check

## Test Commands

```bash
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/manifest_state.test.mjs
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/portfolio_state_materializer.test.mjs
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/lib/dashboard_accounting_summary.test.mjs
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.test.mjs
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/open_funds_live_dashboard.test.mjs
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/bootstrap_agent_context.test.mjs
node --test /Users/yinshiwei/codex/tz/portfolio/scripts/build_dashboard_state.test.mjs
```

## Success Criteria

1. 新线程只读 manifest + bootstrap context + portfolio_state 即可知道：
   - 当前主状态
   - canonical paths
   - 可用命令
   - 每类意图应调脚本
2. funds dashboard 不再把债券基金当“可用现金”
3. funds dashboard GET 请求不再改写任何 repo-tracked 状态
4. `state-manifest.json` 不再指向 temp/空库
5. `dashboard_state.json` 成为稳定产品读模型
