# AI Agent Dispatch Protocol

更新时间：2026-04-24

## 目标

这份协议只服务当前的**简化版基金操作系统**。

当前主产品不再是重型 workbench，也不再把自研交易主脑当成默认入口。新的系统边界非常明确：

- 本地系统负责基金账本、份额、成本、确认净值、收益和展示面板
- `TradingAgents` 负责交易主脑，输出主链决策、风险灯和执行清单
- 页面主入口固定为：
  - `基金面板`
  - `交易主脑`
  - `市场/专题`

## 一句话定义

当前系统是一个：

> 以 `portfolio_state.json` 为持仓真相、以基金面板为默认入口、以 TradingAgents 决策快照为交易主脑的基金操作系统。

## 不可违背的硬规则

1. `state/portfolio_state.json` 仍是持仓与收益真相，任何决策层都不能覆盖它。
2. `TradingAgents` 输出只能进入 `data/trading_decision_snapshot.json` / `data/trading_advice_snapshot.json` 一类只读决策产物，不能直接写交易账本。
3. 用户报告“我刚买了/卖了/转换了”时，必须先记账，再谈后续建议。
4. 看基金面板问题时，先查账本层、确认净值层、展示层，不要先怀疑建议层。
5. `基金面板`、`交易主脑`、`市场/专题` 是当前唯一主产品入口；旧 workbench / shadow / promotion 不再属于主协议。
6. `CASH` 统一表示“现金 + 债券 + 低波防守承载桶”，不再拆成两套主语义。
7. 读路径默认只读；除非显式运行刷新或桥接脚本，不要在 GET 请求里写 repo 状态。

## 新主入口

| 用户意图 | 标准任务名 | 必读状态 | 必调脚本 | 标准输出 |
| --- | --- | --- | --- | --- |
| 打开基金面板 | `open_funds_dashboard` | `state/portfolio_state.json`、`data/dashboard_state.json` | `open_funds_live_dashboard.mjs` | 打开 `/`，展示基金面板 |
| 刷新基金状态 | `refresh_funds_state` | `state-manifest.json`、`state/portfolio_state.json`、`data/nightly_confirmed_nav_status.json` | `refresh_account_sidecars.mjs` | 刷新基金面板读模型与确认状态 |
| 记录基金交易 | `record_fund_trade` | `state/portfolio_state.json`、`ledger/execution_ledger.json` | `record_manual_fund_trades.mjs` | 交易登记结果、账本更新结果 |
| 生成交易建议 | `generate_trading_advice` | `state/portfolio_state.json`、`config/asset_master.json`、`config/tradingagents_bridge.json`、`data/trading_decision_snapshot.json` | `run_tradingagents_decision_cycle.mjs` | TradingAgents 主链决策、风险灯与执行清单 |
| 今天该不该交易 | `should_trade_today` | `state/portfolio_state.json`、`data/trading_decision_snapshot.json` | `run_tradingagents_decision_cycle.mjs` | 返回 today verdict 与风险灯 |
| 给我执行清单 | `get_execution_checklist` | `state/portfolio_state.json`、`data/trading_decision_snapshot.json` | `run_tradingagents_decision_cycle.mjs` | 返回真实动作 / 观察线 / blocked |
| 看看风险灯 | `get_risk_light` | `data/trading_decision_snapshot.json` | `run_tradingagents_decision_cycle.mjs` | 返回 risk light 与主判断 |
| 查看主链决策 | `get_trading_brain_decision` | `data/trading_decision_snapshot.json` | `run_tradingagents_decision_cycle.mjs` | 打开 `/advice` 或输出主链决策摘要 |
| 打开市场专题 | `open_market_topics` | `state-manifest.json`、最新报告入口 | `open_funds_live_dashboard.mjs` | 打开 `/market`，展示市场摘要和专题 |

## 标准读取顺序

任何新线程第一次进入系统，最低读取集改成：

1. `state-manifest.json`
2. `state/portfolio_state.json`
3. `data/dashboard_state.json`
4. `data/trading_decision_snapshot.json`（如存在）
5. `data/trading_advice_snapshot.json`（如存在）
6. 本协议文件

如果用户的问题是市场阅读或专题摘要，再补：

7. `latest_market_brief`
8. 最新 `market_pulse`
9. `latest_daily_brief`
10. `high_impact_event_calendar`

## 标准执行配方

### A. 用户说：“打开基金面板”

执行：

```bash
node /Users/yinshiwei/codex/tz-main-simplified/portfolio/scripts/open_funds_live_dashboard.mjs
```

默认打开 `/`。

### B. 用户说：“刷新基金状态”

执行：

```bash
node /Users/yinshiwei/codex/tz-main-simplified/portfolio/scripts/refresh_account_sidecars.mjs --user main --scopes live_funds_snapshot,nightly_confirmed_nav_status,dashboard_state
```

输出必须说明：

- 基金快照是否刷新
- 确认净值状态是否刷新
- dashboard_state 是否刷新

### C. 用户说：“记录基金交易”

执行：

```bash
node /Users/yinshiwei/codex/tz-main-simplified/portfolio/scripts/record_manual_fund_trades.mjs ...
```

先记账，再刷新基金状态。

### D. 用户说：“生成交易建议”

执行：

```bash
node /Users/yinshiwei/codex/tz-main-simplified/portfolio/scripts/run_tradingagents_decision_cycle.mjs --mode live --user main
```

当前默认直接跑 `glm live`；若 provider 调用失败，允许显式降级为 fallback，但必须写出原因。

输出必须区分：

- 今天该不该交易
- 风险灯
- 真实动作 / 观察线 / 被拦建议
- 当前是否为 `live` 还是 `fallback`

### E. 用户说：“今天该不该交易 / 给我执行清单 / 看看风险灯 / 查看主链决策”

执行：

```bash
node /Users/yinshiwei/codex/tz-main-simplified/portfolio/scripts/run_tradingagents_decision_cycle.mjs --mode live --user main
```

然后读取：

- `data/trading_decision_snapshot.json`
- `/advice`

### F. 用户说：“打开市场专题”

执行：

```bash
node /Users/yinshiwei/codex/tz-main-simplified/portfolio/scripts/open_funds_live_dashboard.mjs
```

然后打开 `/market`。

该页只消费已有报告与事件日历，不再调用重型 research / shadow 主链。

## Legacy Note

以下旧入口不再属于当前主协议：

- `分析当前行情`
- shadow / factor fusion / promotion gate 类入口

这些能力如仍存在，只能视为 legacy，不再作为当前产品主路径。
