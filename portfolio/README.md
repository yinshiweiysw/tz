# Portfolio Tracking

这个目录用于持续保存你的持仓快照与分析结果。

## 目录结构

- `state-manifest.json`
  无记忆续跑时的统一入口文件
- `data/agent_runtime_context.json`
  新 agent 的统一事实层入口，包含资金、持仓、桶缺口、市场上下文与系统健康状态
- `data/strategy_decision_contract.json`
  新 agent 的统一决策合同入口，包含 regime、交易许可、桶级动作边界与执行护栏
- `snapshots/latest_raw.json`
  原始平台/插件快照，只保留外部世界的原始口径
- `ledger/execution_ledger.json`
  手工确认交易、待确认买入、卖出回笼等执行流水
- `state/portfolio_state.json`
  当前策略主状态；分析、风控、日报默认优先读取这里
- `latest.json`
  兼容物化视图；仅为旧脚本/旧面板保留
- `OPERATING_PROTOCOL.md`
  日常更新与一致性规则
- `docs/AI_AGENT_DISPATCH_PROTOCOL.md`
  新 AI-agent / 新线程的统一调度协议；定义“用户一句话 -> 读取哪些状态 -> 调用哪些脚本 -> 输出什么”
- `journal/daily/YYYY-MM-DD.md`
  每日重要交易与聊天纪要
- `scorecards/SCORING_RUBRIC.md`
  每周评分标准
- `scorecards/weekly/YYYY-Www-scorecard.md`
  每周复盘评分
- `trade_cards/YYYY/YYYY-MM-DD-*.md`
  重要交易的决策卡片
- `hypotheses.md`
  当前重要市场判断与失效条件追踪
- `daily_briefs/YYYY-MM-DD-brief.md`
  每日一页组合简报
- `market_briefs/YYYY-MM-DD-market.md`
  每日一页市场简报
- `market_pulses/YYYY-MM-DD-{morning|noon|close}.md`
  金融早报 / 午报 / 晚报；其中早报用于开盘前计划，午报用于观察，晚报用于次日计划
- `cn_market_snapshots/YYYY-MM-DD-cn-snapshot.json`
  AkShare 中国市场补充快照，只用于 A 股广度、北向、宏观、板块资金流与 sector rotation 核验
- `holdings/YYYY-MM-DD.json`
  每日持仓归档
- `transactions/YYYY-MM-DD-*.json`
  手工交易与截图识别交易流水
- `reports/YYYY-MM-DD-*.md`
  每日分析报告
- `templates/*.md`
  日报/周报模板
- `scripts/ensure_daily_journal.mjs`
  新的一天自动生成当日纪要骨架
- `scripts/daily_writeback.mjs`
  将重要交易/聊天结论按统一格式写入当日日志事件流
- `scripts/record_manual_fund_trades.mjs`
  一键登记口头确认的基金买入 / 卖出 / 转换，自动写 `transactions`、并入 `execution_ledger.json`、重算主状态并补 journaling
- `scripts/merge_confirmed_trades_into_latest.mjs`
  将已明确确认的手工交易写入 `execution_ledger.json`，并重算 `portfolio_state.json` / `latest.json`
- `scripts/create_trade_card.mjs`
  生成重要交易的决策卡片
- `templates/hypothesis-template.md`
  假设跟踪模板
- `templates/daily-brief-template.md`
  日报模板
- `templates/market-brief-template.md`
  市场日报模板
- `templates/market-pulse-template.md`
  金融早报 / 午报 / 晚报模板
- `risk_dashboard.json`
  当前持仓、主题集中度、风险提示的统一仪表盘
- `account_context.json`
  用户口头申报的现金和总资产近似上下文
- `scripts/generate_risk_dashboard.mjs`
  生成风险仪表盘
- `scripts/generate_next_trade_plan.mjs`
  基于当前仓位桶缺口与市场环境，生成“下一笔交易”建议
- `scripts/generate_market_pulse.mjs`
  生成金融早报 / 午报 / 晚报
- `scripts/generate_cn_market_snapshot.py`
  生成 AkShare 中国市场补充层快照，不改动主行情底座
- `fund-watchlist.json`
  核心基金实时净值观察名单
- `funds-plugin-import.json`
  可直接导入 Chrome `自选基金助手` 插件的配置文件
- `plugin_sync_status.json`
  最近一次尝试同步 Chrome 插件的状态与报错信息

## 后续使用方式

以后默认可以只通过对话更新，不需要每天都给截图。我会：

1. 先记录你的买卖、转换、到账和关键判断
2. 先更新 `snapshots/latest_raw.json` 或 `ledger/execution_ledger.json`，再物化出 `state/portfolio_state.json`
3. 生成当天的日志、日报、风险检查和必要的交易卡片
4. 对比上一日变化
5. 结合市场数据给出新的组合分析和操作建议

同日 OTC 基金买入的硬规则：

1. 当天确认成交的基金买入，默认先写入 `transactions/YYYY-MM-DD-manual-buys.json`
2. 这类买入默认只从下一收益日起开始计收益；只有 `EXCHANGE` 场内成交才允许同日参与收益
3. 如果当日 `raw snapshot` 已经把这笔买入显示进持仓金额或现金变化，需要在交易流水里标记 `raw_snapshot_includes_trade: true`
4. materializer 会先把这部分从策略口径拆出，再按 `profit_effective_on` 挂入 `pending_profit_effective_positions`

统一交易登记入口当前支持三类动作：

1. `--buy`
   适用于口头确认的基金买入；OTC 默认次日才开始计收益
2. `--sell`
   适用于口头确认的基金卖出；默认按 `cash_arrived=false` 记为待到账，不直接加回可用现金
3. `--convert`
   当前按“已确认转换”语义处理，会立即把转换结果并入策略状态；若是同日 OTC 转换且平台尚未确认生效，暂时不要走这个入口
4. `--raw-includes-trade true`
   若平台快照已经提前把买入 / 卖出 / 转换反映进持仓或现金口径，打开这个开关；materializer 会先反卷回，再按 ledger 重建一次，避免双记

推荐的口头确认登记方式：

```bash
node /Users/yinshiwei/codex/tz/portfolio/scripts/record_manual_fund_trades.mjs \
  --date 2026-04-01 \
  --buy "007339:8000||021482:5000||001917:2000" \
  --submitted-before-cutoff true \
  --raw-includes-trade true
```

统一入口也支持卖出与转换：

```bash
node /Users/yinshiwei/codex/tz/portfolio/scripts/record_manual_fund_trades.mjs \
  --date 2026-04-01 \
  --sell "022502:5000||007339:4000" \
  --sell-cash-arrived false
```

```bash
node /Users/yinshiwei/codex/tz/portfolio/scripts/record_manual_fund_trades.mjs \
  --date 2026-04-01 \
  --convert "000218:29320.63->022502:29320.63"
```

默认行为：

1. 自动生成新的 `transactions/YYYY-MM-DD-manual-buys*.json` 或 `transactions/YYYY-MM-DD-manual-trades*.json`
2. 自动并入 `ledger/execution_ledger.json`
3. 自动重算 `state/portfolio_state.json` 与 `latest.json`
4. 自动在当天 `journal/daily` 追加一条成交登记事件

默认节奏：

1. `早报` 用于开盘前判断是否允许执行当日基金计划
2. `午报` 主要用于观察，不默认转化成盘中交易动作
3. 若当日确需执行基金单，默认在 `14:30-15:00` 做确认
4. `晚报 + 市场日报` 用于收盘后复盘和次日计划

## 双引擎研究与交易链路

当前系统已经拆成“研究发现层 + 左侧博弈袖仓 + 主系统交易计划”三段，不再只靠单一日报口头判断。

建议的生成顺序：

```bash
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_opportunity_pool.mjs --date 2026-04-01
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_speculative_plan.mjs --date 2026-04-01
node /Users/yinshiwei/codex/tz/portfolio/scripts/generate_next_trade_plan.mjs --date 2026-04-01
```

对应产物：

1. `data/opportunity_pool.json`
   只生成研究结论与候选主题，不直接改写持仓状态
2. `data/speculative_plan.json`
   左侧博弈系统的受限袖仓计划；若无预算或无触发，会显式输出空计划
3. `reports/YYYY-MM-DD-next-trade-plan-regime-v4.md`
   双轨交易预案，必须同时保留“主系统计划”和“博弈系统计划”两个标题

补充原则：

1. 整个系统骨架仍以`基金交易`为主
2. 可以做`短线非基金交易`，但它们默认属于例外层或战术层，不替代基金主骨架
3. 短线非基金交易应单独说明理由、仓位和退出条件，避免和基金配置逻辑混在一起
4. 基金的具体成交与确认规则仍以销售平台和产品公告为准，但主系统默认把 `14:30-15:00` 视为最适合做同日确认单的观察收口窗口

截图现在主要用于：

1. 定期校准总资产和现金
2. 修正识别或口头描述偏差
3. 在同一天交易很多、信息较乱时快速对账

## 无记忆续跑

如果后续是一个全新的 Codex 会话，没有任何上下文记忆，优先按下面顺序读取：

1. `state-manifest.json`
2. `data/agent_runtime_context.json`
3. `data/strategy_decision_contract.json`
4. `docs/AI_AGENT_DISPATCH_PROTOCOL.md`
5. `state/portfolio_state.json`
6. `OPERATING_PROTOCOL.md`
5. 当天最新的 `journal/daily`
6. 当天最新的 `transactions` 与 `reports`
7. 如需核对写入因果链，再读 `ledger/execution_ledger.json` 与 `snapshots/latest_raw.json`
8. 如需快速判断仓位风险，再读 `risk_dashboard.json`
9. 如需知道一笔重要交易为什么成立，再读对应的 `trade_cards`
10. 如需知道当前到底在赌什么、什么时候算错，再读 `hypotheses.md`
11. 如需最快速进入状态，先读当天的 `daily_briefs`
12. 如需先判断市场主线和风格，再读当天的 `market_briefs`

## 实时净值

`market-mcp` 已支持实时基金估值查询：

- `fund_quotes`
- `fund_watchlist_quotes`

默认观察名单位于 `fund-watchlist.json`，后续可持续按你的真实持仓更新。

## AkShare 中国市场补充层

AkShare 在这套系统里的定位是“中国市场补充层”，不是主数据底座。

主要用途：

1. 北向资金核验
2. A 股市场宽度与成交额分布补充
3. 国内宏观周期与风格验证
4. 板块资金流与强弱对照
5. sector rotation 验证

不建议它直接接管：

1. `state/portfolio_state.json`
2. `risk_dashboard.json`
3. 基金估值主链
4. 跨市场行情主入口

生成命令：

```bash
python3 /Users/yinshiwei/codex/tz/portfolio/scripts/generate_cn_market_snapshot.py --date 2026-03-27
```

当前机器已通过本地 `/.venv-akshare` 运行该脚本；即使你从系统 `python3` 启动，脚本也会自动尝试切换到这个虚拟环境。

如果依赖缺失，脚本会退回骨架模式并保留主链不变。

## Chrome 插件同步

已经提供两层能力：

1. `scripts/generate_funds_plugin_import.mjs`
   自动根据当前观察名单重生 `funds-plugin-import.json`
2. `scripts/sync_funds_plugin_to_chrome.mjs`
   尝试直接把最新持仓写入 Chrome 的 `自选基金助手 - 实时查看基金涨跌幅` 插件

当前机器上，第二层还受 Chrome 一个一次性开关限制：

- 需要在 Chrome 菜单栏中打开：
  `查看` -> `开发者` -> `允许 Apple 事件中的 JavaScript`

当前这台机器已经打开该开关并完成过一次成功同步；后续自动任务会继续复用这条链路。若未来 Chrome 权限重置，脚本仍会自动更新导入文件并把阻塞原因写入 `plugin_sync_status.json`。

## 周度评分

每周评分以 `SCORING_RUBRIC.md` 为标准，重点看：

1. 风险纪律
2. 执行纪律
3. 结构健康
4. 情绪控制
5. 复盘一致性

## 风险仪表盘与仓位框架

`risk_dashboard.json` 目前会同时给出两层口径：

1. `canonical_view`
   只使用 `state/portfolio_state.json` 主档案
2. `working_view`
   在主档案基础上，额外计入口头确认的手工交易；截图仅在需要时用于后续校准

这样可以避免把未确认交易直接污染主档案，同时又不会忽略你已经执行的动作。

当前仓位分析默认遵循 `INVESTMENT_POLICY_STATEMENT.md` 中的六类框架：

1. `现金/机动仓`
2. `防守仓`
3. `核心仓`
4. `港股参与仓`
5. `战术仓`
6. `对冲仓`

## 当前版本说明

当前首份底稿建立于 `2026-03-25`，来源为：

- `IMG_0896.PNG`
- `IMG_0897.PNG`
- `IMG_0898.PNG`
- `IMG_0899.PNG`
- `IMG_0900.PNG`
