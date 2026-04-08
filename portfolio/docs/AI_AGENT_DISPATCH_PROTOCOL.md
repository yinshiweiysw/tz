# AI Agent Dispatch Protocol

更新时间：2026-04-08

## 目标

这份文档是新 AI-agent / 新线程接入 `portfolio` 系统的统一调度协议。

目标只有一个：

- 用户输入一句自然语言后，agent 必须立刻知道当前系统骨架是什么、先读哪些状态、该调用哪些脚本、最终应该输出什么。

这不是介绍性文档，而是执行协议。新 agent 不应绕开它直接“凭感觉分析”。

---

## 系统一句话定义

当前系统是一个按以下链路运行的量化辅助交易系统：

`原始快照 / 手工交易 -> 主状态账本 -> 宏观与行情数据 -> 信号路由 -> 交易计划 -> 执行/对账 -> 看板与报告`

其中：

- 主状态源：`state/portfolio_state.json`
- 兼容视图：`latest.json`
- 研究分析统一入口：`scripts/generate_dialogue_analysis_contract.mjs`
- 交易建议统一入口：`scripts/generate_next_trade_plan.mjs`
- 实盘金额/股数计划统一入口：`scripts/trade_generator.py`

---

## 不可违背的硬规则

1. 所有投资类 agent 在输出建议前必须读取 `data/agent_runtime_context.json` 与 `data/strategy_decision_contract.json`。
2. `state/portfolio_state.json` 是主状态，`latest.json` 只是兼容视图，不能把 `latest.json` 当唯一真实源。
3. 用户问“分析当前行情 / 今天该不该交易 / 现在怎么看”时，必须先走 `dialogue_analysis_contract`，不能只看当日涨跌。
4. 用户问“该买什么 / 该卖什么 / 给我执行清单”时，必须先走 `generate_signals.py -> generate_next_trade_plan.mjs`；只有需要落到可执行金额或股数时，才继续走 `trade_generator.py`。
5. 用户口头报告已成交交易时，必须先写交易流水和账本，再讨论新的仓位建议；不能只在回答里口头更新。
6. 看板问题必须区分四层：
   - 账本层
   - 确认净值层
   - 盘中估值/实时行情层
   - 前端展示层
7. 读路径默认只读。除非用户明确要求修复/重算，否则不要在读取面板或分析时偷偷改状态。
8. 实时行情分析必须补最新新闻与最新行情，不能只依赖库里旧报告。
9. `AI_AGENT_DISPATCH_PROTOCOL.md` 与 `data/agent_bootstrap_context.json.intentRouting` 必须保持一一对应；后者是机器入口，前者是人工解释层。
10. 新增或删除意图时，只能先改共享 registry，再同步更新本协议文档；禁止文档和代码各维护一份不同版本。

---

## 新线程启动顺序

任何新线程第一次进入系统，必须按下面顺序读取：

1. [state-manifest.json](/Users/yinshiwei/codex/tz/portfolio/state-manifest.json)
2. [agent_runtime_context.json](/Users/yinshiwei/codex/tz/portfolio/data/agent_runtime_context.json)
3. [strategy_decision_contract.json](/Users/yinshiwei/codex/tz/portfolio/data/strategy_decision_contract.json)
4. [agent_bootstrap_context.json](/Users/yinshiwei/codex/tz/portfolio/data/agent_bootstrap_context.json)
5. [AI_AGENT_DISPATCH_PROTOCOL.md](/Users/yinshiwei/codex/tz/portfolio/docs/AI_AGENT_DISPATCH_PROTOCOL.md)
6. [portfolio_state.json](/Users/yinshiwei/codex/tz/portfolio/state/portfolio_state.json)
7. [OPERATING_PROTOCOL.md](/Users/yinshiwei/codex/tz/portfolio/OPERATING_PROTOCOL.md)
8. [README.md](/Users/yinshiwei/codex/tz/portfolio/README.md)
9. 最新 canonical 产物：
   - `latest_trade_plan_v4_json`
   - `latest_trade_plan_v4_report`
   - `latest_market_brief`
   - `latest_daily_brief`
   - `latest_morning_market_pulse` / `latest_noon_market_pulse` / `latest_close_market_pulse`

如果只是快速判断当前系统运行状态，最低读取集是：

1. [state-manifest.json](/Users/yinshiwei/codex/tz/portfolio/state-manifest.json)
2. [agent_runtime_context.json](/Users/yinshiwei/codex/tz/portfolio/data/agent_runtime_context.json)
3. [strategy_decision_contract.json](/Users/yinshiwei/codex/tz/portfolio/data/strategy_decision_contract.json)
4. [portfolio_state.json](/Users/yinshiwei/codex/tz/portfolio/state/portfolio_state.json)
5. [AI_AGENT_DISPATCH_PROTOCOL.md](/Users/yinshiwei/codex/tz/portfolio/docs/AI_AGENT_DISPATCH_PROTOCOL.md)

---

## 核心状态与职责

### 1. 状态层

- `snapshots/latest_raw.json`
  外部平台/插件原始快照，只保留原始口径
- `ledger/execution_ledger.json`
  已登记交易、待确认买入、待到账卖出等执行流水
- `state/portfolio_state.json`
  当前组合主状态，所有分析/风控/计划优先读取
- `latest.json`
  兼容旧脚本和旧面板的物化视图
- `account_context.json`
  总资产、现金、资金范围等补充上下文

### 2. 数据层

- `data/market_lake.db`
  本地行情库
- `data/macro_state.json`
  宏观状态
- `signals/regime_router_signals.json`
  资产级信号输出
- `data/trade_plan_v4.json`
  下一步交易计划

### 3. 研究与报告层

- `data/dialogue_analysis_contract.json`
  对话分析合同的最新输出
- `market_pulses/*.md`
  早报 / 午报 / 晚报
- `market_briefs/*.md`
  市场日报
- `daily_briefs/*.md`
  组合日报

---

## 自然语言意图路由

| 用户意图 | 标准任务名 | 必读状态 | 必调脚本 | 标准输出 |
| --- | --- | --- | --- | --- |
| 分析当前行情 | `market_analysis` | `state-manifest`、`portfolio_state` | `generate_dialogue_analysis_contract.mjs` | 当前主驱动、A/H/美/黄金状态、组合影响、风险点 |
| 今天该不该交易 | `trade_decision` | `portfolio_state`、`macro_state`、`signals` | `generate_signals.py`、`generate_next_trade_plan.mjs` | 是否允许交易、买什么、不买什么、原因 |
| 给我执行清单 | `trade_execution_plan` | `portfolio_state`、`trade_plan_v4` | `trade_generator.py` | 金额级/股数级指令 |
| 我刚买了/卖了/转换了 | `manual_trade_record` | `portfolio_state`、`execution_ledger` | `record_manual_fund_trades.mjs` 或 `ledger_sync.py` | 交易登记结果、账本更新结果 |
| 看看我现在持仓 | `portfolio_status` | `portfolio_state`、`risk_dashboard` | 可选 `generate_risk_dashboard.mjs` | 当前总资产、分类仓位、主要盈亏与缺口 |
| 打开基金面板 | `open_funds_dashboard` | 健康状态、基金看板状态 | `open_funds_live_dashboard.mjs` | 浏览器看板或可读降级原因 |
| 基金面板为什么不对 | `funds_dashboard_debug` | `portfolio_state`、`latest`、确认净值状态 | `serve_funds_live_dashboard.mjs` 健康接口、必要时物化脚本 | 问题定位到状态层/确认层/展示层 |
| 刷新市场数据 | `data_refresh` | `asset_master`、`market_lake.db` | `core_data_ingestion.py`、`generate_macro_state.py` | 数据刷新结果与缺口 |
| 做回测 | `backtest` | `market_lake.db`、配置文件 | `run_portfolio_backtest.py` 或 `backtest_engine.py` | 收益曲线、CAGR、回撤、夏普 |
| 收盘后生成日报 | `report_generation` | `portfolio_state`、研究主脑、市场数据 | `generate_market_pulse.mjs`、`generate_daily_brief.mjs`、`generate_market_brief.mjs` | Markdown 报告 |

---

## 标准执行配方

### A. 用户说：“分析当前行情”

必须执行：

1. 读取：
   - [state-manifest.json](/Users/yinshiwei/codex/tz/portfolio/state-manifest.json)
   - [portfolio_state.json](/Users/yinshiwei/codex/tz/portfolio/state/portfolio_state.json)
2. 运行：

```bash
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_dialogue_analysis_contract.mjs --user main --refresh auto
```

3. 读取输出：
   - `data/dialogue_analysis_contract.json`
4. 补实时数据：
   - 最新行情
   - 最新新闻/事件驱动
   - 必要时市场时钟守卫
5. 输出格式必须包含：
   - 当前主驱动
   - A 股 / 港股 / 美股 / 黄金 各自状态
   - 当前组合受影响最大的桶
   - 今天是否支持交易
   - 若支持，只给金额级动作
   - 若不支持，写明阻断原因

禁止行为：

- 只看某个指数涨跌幅就下结论
- 只看用户仓位，不看新闻和驱动
- 直接从旧报告抄结论，不做实时校验

### B. 用户说：“今天该不该交易”

必须执行：

```bash
python3 /Users/yinshiwei/codex/tz/portfolio/scripts/generate_signals.py --user main
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_next_trade_plan.mjs --user main
```

如用户进一步要求“给我实盘买卖金额/股数”，继续执行：

```bash
python3 /Users/yinshiwei/codex/tz/portfolio/scripts/trade_generator.py --user main
```

输出必须区分：

- 主系统计划
- 战术/博弈计划
- 被抑制的交易
- 阻断交易的原因

### C. 用户说：“我刚买了/卖了/转换了”

场外基金/统一口头登记优先用：

```bash
node /Users/yinshiwei/codex/tz/portfolio/scripts/record_manual_fund_trades.mjs --date YYYY-MM-DD --buy "007339:8000||001917:2000" --submitted-before-cutoff true --raw-includes-trade true
```

卖出示例：

```bash
node /Users/yinshiwei/codex/tz/portfolio/scripts/record_manual_fund_trades.mjs --date YYYY-MM-DD --sell "022502:5000" --sell-cash-arrived false
```

该脚本会自动完成：

1. 写 `transactions`
2. 并入 `execution_ledger.json`
3. 重算 `portfolio_state.json` 与 `latest.json`
4. 写回 `journal/daily`

如果是日终真实成交回写，优先用：

```bash
python3 /Users/yinshiwei/codex/tz/portfolio/scripts/ledger_sync.py
```

### D. 用户说：“打开基金面板”

执行：

```bash
node /Users/yinshiwei/codex/tz/portfolio/scripts/open_funds_live_dashboard.mjs --user main
```

该入口会先检查：

- `/api/live-funds/health`
- 看板状态是否 `ready` 或 `degraded`

如果不是可读状态，不应直接告诉用户“已打开成功”，而应返回阻断原因。

### E. 用户说：“基金面板为什么不对”

排查顺序固定为：

1. `state/portfolio_state.json` 是否新鲜
2. `latest.json` 是否只是兼容视图，不要误当主状态
3. `data/nightly_confirmed_nav_status.json` 是否处于：
   - `confirmed_nav_ready`
   - `partially_confirmed_normal_lag`
   - `late_missing`
   - `source_missing`
4. `/api/live-funds/health` 的 `state / reasons`
5. 再看前端展示逻辑

禁止直接跳到“前端 CSS/渲染问题”，先查状态契约。

### F. 用户说：“刷新市场数据 / 数据是不是旧了”

执行：

```bash
python3 /Users/yinshiwei/codex/tz/portfolio/scripts/core_data_ingestion.py
python3 /Users/yinshiwei/codex/tz/portfolio/scripts/generate_macro_state.py
python3 /Users/yinshiwei/codex/tz/portfolio/scripts/generate_signals.py --user main
```

如果只需要校验 SQLite schema，不拉远端：

```bash
python3 /Users/yinshiwei/codex/tz/portfolio/scripts/core_data_ingestion.py --bootstrap-schema-only
```

### G. 用户说：“生成早报 / 午报 / 收盘报告”

早报 / 午报 / 晚报：

```bash
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_pulse.mjs --date YYYY-MM-DD --session morning
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_pulse.mjs --date YYYY-MM-DD --session noon
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_pulse.mjs --date YYYY-MM-DD --session close
```

组合日报：

```bash
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_daily_brief.mjs --date YYYY-MM-DD --user main
```

交易建议日报：

```bash
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_next_trade_plan.mjs --user main
```

### H. 用户说：“做回测”

优先入口：

```bash
python3 /Users/yinshiwei/codex/tz/portfolio/scripts/run_portfolio_backtest.py
```

底层引擎与专题回测：

```bash
python3 /Users/yinshiwei/codex/tz/portfolio/scripts/backtest_engine.py
python3 /Users/yinshiwei/codex/tz/portfolio/scripts/macro_backtest.py
```

---

## 输出契约

### 1. 行情分析类回答必须包含

1. 当前主驱动
2. 实时验证
   - 行情
   - 新闻
   - 流动性/风险偏好
3. 对当前组合的影响
4. 今天是否适合交易
5. 若交易，给金额级动作
6. 数据新鲜度与不确定性

### 2. 交易建议类回答必须包含

1. 允许/不允许交易
2. 买什么
3. 不买什么
4. 每笔金额或股数
5. 触发逻辑
6. 阻断逻辑

### 3. 看板排障类回答必须包含

1. 问题所在层级
2. 当前状态文件/接口实际值
3. 为什么会出现该现象
4. 修复动作
5. 是否影响账本真实性

---

## 新线程可直接复制的启动模板

把下面这段直接给新 AI-agent 或新线程：

```text
你现在接入的是 /Users/yinshiwei/codex/tz/portfolio 量化辅助交易系统。

先严格按以下顺序读取：
1. /Users/yinshiwei/codex/tz/portfolio/state-manifest.json
2. /Users/yinshiwei/codex/tz/portfolio/data/agent_runtime_context.json
3. /Users/yinshiwei/codex/tz/portfolio/data/strategy_decision_contract.json
4. /Users/yinshiwei/codex/tz/portfolio/docs/AI_AGENT_DISPATCH_PROTOCOL.md
5. /Users/yinshiwei/codex/tz/portfolio/state/portfolio_state.json
6. /Users/yinshiwei/codex/tz/portfolio/OPERATING_PROTOCOL.md
7. /Users/yinshiwei/codex/tz/portfolio/README.md

读取后遵循以下规则：
1. state/portfolio_state.json 是主状态，latest.json 只是兼容视图。
2. 所有投资类 agent 在输出建议前必须读取：
   /Users/yinshiwei/codex/tz/portfolio/data/agent_runtime_context.json
   /Users/yinshiwei/codex/tz/portfolio/data/strategy_decision_contract.json
3. 用户问“分析当前行情/今天怎么看/该不该交易”时，必须先调用：
   node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_dialogue_analysis_contract.mjs --user main --refresh auto
4. 用户问“给我交易建议/执行清单”时，必须先调用：
   python3 /Users/yinshiwei/codex/tz/portfolio/scripts/generate_signals.py --user main
   node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_next_trade_plan.mjs --user main
   如需金额级/股数级指令，再调用：
   python3 /Users/yinshiwei/codex/tz/portfolio/scripts/trade_generator.py --user main
5. 用户口头确认已成交时，先写交易流水和账本，不要只口头更新：
   node /Users/yinshiwei/codex/tz/portfolio/scripts/record_manual_fund_trades.mjs ...
6. 用户问看板问题时，先查状态层、确认净值层、健康接口，再查前端。
7. 行情分析必须结合实时新闻和实时行情，不能只看本地旧报告。

你的第一步不是直接分析，而是先判断用户意图属于：
market_analysis / trade_decision / trade_execution_plan / manual_trade_record / portfolio_status / open_funds_dashboard / funds_dashboard_debug / data_refresh / backtest / report_generation

然后严格按 AI_AGENT_DISPATCH_PROTOCOL.md 中的路由执行。
```

---

## 维护原则

以后只要新增了新的主入口脚本、新的状态文件或新的执行链路，必须同步更新本文件。

否则新 agent 会重新退化成：

- 不知道主状态是谁
- 不知道读哪个文件
- 不知道用户一句话该调哪个脚本
- 不知道什么时候该读、什么时候该写

这份文档就是为避免这种漂移而存在。
