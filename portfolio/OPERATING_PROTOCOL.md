# Portfolio Operating Protocol

这个文件用于保证后续任何一次新会话，即使没有上下文记忆，也能快速接回你的投资分析流程。

## 新会话启动顺序

1. 先读 [state-manifest.json](/Users/yinshiwei/codex/tz/portfolio/state-manifest.json)
2. 再读 [portfolio_state.json](/Users/yinshiwei/codex/tz/portfolio/state/portfolio_state.json)
3. 如需核对原始平台口径与执行因果，再读：
   - [latest_raw.json](/Users/yinshiwei/codex/tz/portfolio/snapshots/latest_raw.json)
   - [execution_ledger.json](/Users/yinshiwei/codex/tz/portfolio/ledger/execution_ledger.json)
4. 再读最新的交易与计划文件：
   - [2026-03-25.md](/Users/yinshiwei/codex/tz/portfolio/journal/daily/2026-03-25.md)
   - [2026-03-25-trade-sequence.md](/Users/yinshiwei/codex/tz/portfolio/reports/2026-03-25-trade-sequence.md)
   - [2026-03-25-next-buy-triggers.md](/Users/yinshiwei/codex/tz/portfolio/reports/2026-03-25-next-buy-triggers.md)
   - [2026-03-25-live-reallocation-table.md](/Users/yinshiwei/codex/tz/portfolio/reports/2026-03-25-live-reallocation-table.md)
5. 如果用户刚通过对话报告了交易或仓位变化，先读 transactions 目录中的手工流水文件
6. 做周度复盘时，再读 [SCORING_RUBRIC.md](/Users/yinshiwei/codex/tz/portfolio/scorecards/SCORING_RUBRIC.md)
7. 如果需要把新聊天/交易结论快速落盘，优先使用写回脚本与事件模板
8. 进行仓位和集中度检查时，优先读取 [risk_dashboard.json](/Users/yinshiwei/codex/tz/portfolio/risk_dashboard.json)
9. 对重要交易、结构调整和关键减仓，优先读取或新建 `trade_cards`
10. 对重要市场判断，优先读取或更新 [hypotheses.md](/Users/yinshiwei/codex/tz/portfolio/hypotheses.md)
11. 想快速了解当天全局时，优先读取 `daily_briefs`
12. 若想快速了解市场驱动与板块风格，再读 `market_briefs`

## 一致性规则

1. `state/portfolio_state.json` 始终是当前组合的主状态文件；`latest.json` 只是兼容视图
2. 原始平台/插件快照先写入 `snapshots/latest_raw.json`
3. 手工口头确认的交易，先写入 `transactions/YYYY-MM-DD-manual-*.json`，再沉淀到 `ledger/execution_ledger.json`
4. 写入层变更后，必须重算 `state/portfolio_state.json` 与 `latest.json`
5. 日常默认允许基于对话更新主状态；截图和平台明细主要用于定期校准、总资产对账和纠错
6. 默认以`基金交易`为主，交易决策窗口优先放在`开盘前`、`14:30-15:00确认窗口`与`收盘后`；午间快报主要用于观察，不默认触发盘中操作建议
7. 允许存在`短线非基金交易`，但它们默认属于例外层，不改变系统以基金配置、基金再平衡和基金风控为核心的原则
8. 分析结论通过 `reports/YYYY-MM-DD-*.md` 增量追加，不覆盖既有历史
9. 每个交易日的重要聊天、操作、结论都应同步沉淀到 `journal/daily/YYYY-MM-DD.md`
10. 每周单独生成一次 `scorecards/weekly/YYYY-Www-scorecard.md`
11. 当收到完整持仓截图或平台明细时，再做一次校准性更新：
   - `snapshots/latest_raw.json`
   - `state/portfolio_state.json`
   - `holdings/YYYY-MM-DD.json`
   - 当天新的分析报告
12. 如果当天发生了重要交易或结构调整，补建 `trade_cards/YYYY/YYYY-MM-DD-*.md`
13. 如果当天形成了新的核心市场判断，更新 `hypotheses.md`
14. 收盘后或晚间生成 `daily_briefs/YYYY-MM-DD-brief.md`
15. 收盘后或晚间生成 `market_briefs/YYYY-MM-DD-market.md`

## 每日更新流程

默认采用“对话优先”模式，不要求每天都给截图。

1. 用户通过对话报告新的买入、卖出、转换、现金变化或关键判断
2. 先把交易和关键结论写入 `transactions`、`journal/daily`、必要时写入 `trade_cards`
3. 优先更新 `snapshots/latest_raw.json` 或 `ledger/execution_ledger.json`，再物化 `state/portfolio_state.json`
4. 重新生成 `risk_dashboard.json` 与 `daily_briefs/YYYY-MM-DD-brief.md`
5. 盘前优先读取 `market_pulses/YYYY-MM-DD-morning.md` 做开盘前计划
6. 午间只做观察性判断，不默认给出盘中基金交易建议
7. 若当天需要执行基金单，默认在 `14:30-15:00` 作为确认窗口；只有当计划条件满足时，才把观察转成执行
8. 若出现短线非基金机会，可单独作为例外评估，但应与基金主骨架分开记录和复盘
9. 收盘后优先读取 `market_pulses/YYYY-MM-DD-close.md` 与 `market_briefs/YYYY-MM-DD-market.md`，输出次日操作建议
10. 如当天提供了截图或平台明细，再做校准性对账和修正

## 截图使用规则

截图不再是日更必需品，主要在以下场景使用：

1. 账户总资产、现金或持仓金额出现明显口径偏差时
2. 同一天发生多笔申赎、转换、到账，文字描述容易混淆时
3. 每周或每月做一次基线校准时
4. 需要修正历史识别错误时

## 每周更新流程

1. 读取 `state-manifest.json`
2. 读取 `state/portfolio_state.json`
3. 读取 `risk_dashboard.json`
4. 读取当周的 `journal/daily`、`transactions` 和 `reports`
5. 必要时核对 `ledger/execution_ledger.json`
6. 按 [SCORING_RUBRIC.md](/Users/yinshiwei/codex/tz/portfolio/scorecards/SCORING_RUBRIC.md) 生成周度评分
7. 写入 `scorecards/weekly/YYYY-Www-scorecard.md`
8. 必要时回看当周 `trade_cards`
9. 检查 `hypotheses.md` 中有哪些假设已验证或已失效
10. 回看当周的 `daily_briefs`

## 实时净值查看

本地 `market-mcp` 已提供：

- `fund_quotes`
- `fund_watchlist_quotes`

默认观察清单在 [fund-watchlist.json](/Users/yinshiwei/codex/tz/portfolio/fund-watchlist.json)，可用于快速查看你当前核心基金的实时估值和近似日内盈亏。

## Chrome 基金插件同步

如果需要把持仓同步到 Chrome 的 `自选基金助手 - 实时查看基金涨跌幅` 插件，优先使用：

- [generate_funds_plugin_import.mjs](/Users/yinshiwei/codex/tz/portfolio/scripts/generate_funds_plugin_import.mjs)
- [sync_funds_plugin_to_chrome.mjs](/Users/yinshiwei/codex/tz/portfolio/scripts/sync_funds_plugin_to_chrome.mjs)

执行原则：

1. 先根据当前 `fund-watchlist.json` 重生 `funds-plugin-import.json`
2. 再尝试直接同步到 Chrome 插件
3. 如果 Chrome 尚未开启 `允许 Apple 事件中的 JavaScript`，则改为读取 [plugin_sync_status.json](/Users/yinshiwei/codex/tz/portfolio/plugin_sync_status.json) 中的阻塞原因，并使用导入文件作为兜底

## 快速续跑脚本

- 每日纪要脚本：[ensure_daily_journal.mjs](/Users/yinshiwei/codex/tz/portfolio/scripts/ensure_daily_journal.mjs)
- 日度写回脚本：[daily_writeback.mjs](/Users/yinshiwei/codex/tz/portfolio/scripts/daily_writeback.mjs)
- 手工基金统一登记脚本：[record_manual_fund_trades.mjs](/Users/yinshiwei/codex/tz/portfolio/scripts/record_manual_fund_trades.mjs)
- 事件模板：[daily-event-template.md](/Users/yinshiwei/codex/tz/portfolio/templates/daily-event-template.md)
- 风险仪表盘脚本：[generate_risk_dashboard.mjs](/Users/yinshiwei/codex/tz/portfolio/scripts/generate_risk_dashboard.mjs)
- 主状态物化脚本：[materialize_portfolio_state.mjs](/Users/yinshiwei/codex/tz/portfolio/scripts/materialize_portfolio_state.mjs)
- 交易并回脚本：[merge_confirmed_trades_into_latest.mjs](/Users/yinshiwei/codex/tz/portfolio/scripts/merge_confirmed_trades_into_latest.mjs)
- 交易卡片脚本：[create_trade_card.mjs](/Users/yinshiwei/codex/tz/portfolio/scripts/create_trade_card.mjs)
- 插件导入文件脚本：[generate_funds_plugin_import.mjs](/Users/yinshiwei/codex/tz/portfolio/scripts/generate_funds_plugin_import.mjs)
- 插件直连同步脚本：[sync_funds_plugin_to_chrome.mjs](/Users/yinshiwei/codex/tz/portfolio/scripts/sync_funds_plugin_to_chrome.mjs)
- 交易卡片模板：[trade-card-template.md](/Users/yinshiwei/codex/tz/portfolio/templates/trade-card-template.md)
- 假设模板：[hypothesis-template.md](/Users/yinshiwei/codex/tz/portfolio/templates/hypothesis-template.md)
- 日报脚本：[generate_daily_brief.mjs](/Users/yinshiwei/codex/tz/portfolio/scripts/generate_daily_brief.mjs)
- 日报模板：[daily-brief-template.md](/Users/yinshiwei/codex/tz/portfolio/templates/daily-brief-template.md)
- 市场日报脚本：[generate_market_brief.mjs](/Users/yinshiwei/codex/tz/portfolio/scripts/generate_market_brief.mjs)
- 市场日报模板：[market-brief-template.md](/Users/yinshiwei/codex/tz/portfolio/templates/market-brief-template.md)

默认用途：

1. 新的一天开始时先确保当天纪要文件存在
2. 之后每次重要交易或关键聊天都往当日纪要里增量补充
3. 重要结论统一写到 `## 事件流` 下，避免散落在多个文件里
4. 每次新的持仓确认或手工交易后，重新生成 `risk_dashboard.json`
5. 对已经明确确认、无需继续等待截图的手工交易，可用并回脚本更新 `execution_ledger.json`，并重算主状态
6. 如果只是口头确认了基金买入 / 卖出 / 转换，优先用 `record_manual_fund_trades.mjs` 一步完成 `transactions -> ledger -> materialize -> journal`
7. 对重要交易额外生成 trade card，避免只留下流水不留逻辑
8. 对重要判断额外维护 hypotheses，避免把观点变成信仰
9. 每日收口时生成一页 daily brief，供新会话和日常快速阅读
10. 若只有对话没有截图，默认继续按 working state 运转；后续截图只用于校准，不阻塞日常分析
11. 若需要单独追踪市场主线、热点板块与次日风格，额外生成一页 market brief
