# 2026-03-27 金融技能吸收矩阵

## 已吸收 / 待吸收 / 不建议吸收 三栏总表

| 模块/Skill | 状态 | 当前结论 | 已落地或建议位置 |
| --- | --- | --- | --- |
| `portfolio-health-check` | 已吸收 | 已吸收为当前骨架的高价值模块，用来增强组合风险诊断、相关性聚集和压力测试 | `risk_dashboard.json`、周评分、风险提醒 |
| `risk-adjusted-return-optimizer` | 已吸收 | 已吸收为当前骨架的高价值模块，用来增强六类仓位目标、再平衡阈值和下一笔交易生成器 | `INVESTMENT_POLICY_STATEMENT.md`、`DECISION_TREE.md`、`next-trade-generator` |
| `AkShare` | 待吸收 | 对 A 股、基金、宏观和北向等中国市场数据很有价值，适合做补充工具箱，不宜直接替代现有主数据层 | 中国市场补充数据层、板块/资金/财务扩展 |
| `alphaear-signal-tracker` | 待吸收 | 和当前 `hypotheses.md` 高度契合，最适合把静态假设记录升级为强化、弱化、证伪跟踪 | `hypotheses.md`、`daily_briefs`、周评分 |
| `sector-rotation-detector` | 待吸收 | 很值得做，但优先级排在风控与再平衡之后；更适合做宏观到板块的上层逻辑 | `market_briefs`、未来的 `sector_reports/` |
| `hormuz-strait` | 待吸收 | 对中东、油价、黄金和港股风险场景非常实用，但更适合事件型监控而不是日常主模块 | `market_briefs`、`hypotheses.md`、风险事件快报 |
| `FinGPT` | 待吸收 | 最有价值的是情绪分析和金融文本方法论，但模型部署较重，更适合吸收思路而不是整套落地 | 情绪层、新闻评分、报告草稿 |
| `high-dividend-strategy` | 待吸收 | 有价值，适合强化防守仓研究，但现在只做了方向性吸收，尚未做成正式模块 | 防守仓候选筛选、红利/银行/央企红利对比 |
| `alphaear-news` | 待吸收 | 可作为市场快报的补充新闻聚合层，但不宜替代当前主新闻链路 | `market_pulses`、`market_briefs` 的补充信源 |
| `alphaear-sentiment` | 待吸收 | 适合未来与 `sentiment-reality-gap` 合并成新闻情绪评分层 | 新闻情绪标签、情绪-现实偏差过滤 |
| `suitability-report-generator` | 待吸收 | 更偏文档层，适合增强大额调仓说明和交易卡片的风险披露 | `trade_cards`、大额调仓说明、交易理由模板 |
| `stock-correlation` | 待吸收 | 对主题暴露和相关性研究有帮助，但更适合研究层，不是基金主骨架眼下最缺的能力 | 主题暴露专题、相关性专题研究 |
| `alphaear-reporter` | 待吸收 | 可增强市场日报和交易卡片的结构化表达，但优先级低于信号跟踪与事件监控 | `market_briefs`、`trade_cards` |
| `Twelve Data MCP` | 待吸收 | 适合作为全球行情和技术指标的第二数据源，但不建议与现有主链并行堆太多供应商 | 全球市场补充数据源、技术指标补充 |
| `Alpha Vantage MCP` | 待吸收 | 官方 MCP 成熟度较高，适合补技术指标与美股数据，但仍应是补充层而不是主链 | 技术指标、海外市场补充 |
| `EODHD MCP` | 待吸收 | 更偏历史财报、分红和内幕交易等补充字段，适合财务深挖，不适合做主行情层 | 历史财报、分红、内幕交易补充 |
| `event-driven-detector` | 待吸收 | 适合做短线非基金例外层工具，但不该优先并入主骨架 | 事件驱动专题、非基金短线例外层 |
| `sentiment-reality-gap` | 待吸收 | 适合做“逆向抄底前过滤器”，但不宜直接进入主加仓逻辑 | 左侧抄底审查、错杀 vs 陷阱过滤 |
| `quant-factor-screener` | 待吸收 | 方法论有价值，但更适合研究层，不适合当前日常主流程 | 研究专题、长期量化观察层 |
| `findata-toolkit-cn` | 不建议吸收为主层 | 不建议替换现有 `market-mcp`，否则会形成双数据口径 | 保留为补充数据工具箱 |
| `OpenBB` | 不建议当前吸收为主层 | 平台能力很强，也自带 MCP 路径，但对当前系统而言过重、重叠面太大，更适合以后单独做研究工作台 | 独立研究平台、全球市场探索工作台 |
| `yfinance-data` | 不建议吸收为主层 | 与现有 `market-mcp` 和本地脚本链路重叠，更适合作为美股/财报补充工具 | 备用数据层 |
| `alphaear-stock` | 不建议吸收为主层 | 与现有 A/H/US 行情查询能力重复 | 备用个股查询 |
| `alphaear-search` | 不建议吸收为主层 | 搜索能力已由 `web` 和现有市场脚本承担 | 辅助检索 |
| `alphaear-predictor` | 不建议当前吸收 | 依赖重、容易制造“伪精确”预期，不适合当前实盘主骨架 | 研究储备 |
| `alphaear-deepear-lite` | 不建议当前吸收 | 外部黑盒信号更适合观察，不宜直接进入主决策链 | 外部观察面板 |
| `options-payoff` | 暂不相关 | 只有在你明确开始做期权时才值得接入 | 期权专项工具 |
| `CrewAI / LangGraph 金融模板` | 暂不作为金融技能吸收 | 它们是编排框架，不是金融能力本身；只有在你明确要拆成多角色团队时才值得上 | 将来多智能体编排层 |
| `twitter-reader` / `telegram-reader` / `discord-reader` | 备用 | 只有在你明确要做社区舆情监控时才值得接入，且 setup 成本较高 | 社区舆情专项 |

## 已吸收

### 1. portfolio-health-check

已经真正吸收到系统里。

当前实际价值：

- 不只看单一持仓过重
- 已能识别“相关性聚集”
- 已能估算“有效投注数”
- 已加入压力测试情景

当前落地文件：

- `/Users/yinshiwei/codex/tz/portfolio/risk_dashboard.json`
- `/Users/yinshiwei/codex/tz/portfolio/scripts/generate_risk_dashboard.mjs`

### 2. risk-adjusted-return-optimizer

已经真正吸收到系统里。

当前实际价值：

- 六类仓位目标不再只是静态金额表
- 已有“月度复核 + 阈值触发再平衡”
- 已有“核心-卫星结构”
- 已有“再平衡优先模式”

当前落地文件：

- `/Users/yinshiwei/codex/tz/portfolio/INVESTMENT_POLICY_STATEMENT.md`
- `/Users/yinshiwei/codex/tz/portfolio/DECISION_TREE.md`
- `/Users/yinshiwei/codex/tz/portfolio/reports/2026-03-27-bucket-rebalancing-framework.md`
- `/Users/yinshiwei/codex/tz/portfolio/reports/2026-03-27-next-trade-generator.md`

## 待吸收

### 第一梯队

- `alphaear-signal-tracker`
- `sector-rotation-detector`
- `hormuz-strait`
- `high-dividend-strategy`
- `suitability-report-generator`

原因：

- 它们都能增强系统，而且和你现有结构能直接对接。
- 其中 `alphaear-signal-tracker` 最贴近已经存在的 `hypotheses.md`。
- `hormuz-strait` 虽然不是天天用，但在当前中东扰动背景下，边际价值很高。

最适合的吸收顺序：

1. `alphaear-signal-tracker`
2. `sector-rotation-detector`
3. `hormuz-strait`
4. `high-dividend-strategy`
5. `suitability-report-generator`

### 第二梯队

- `alphaear-news`
- `alphaear-sentiment`
- `stock-correlation`
- `alphaear-reporter`
- `event-driven-detector`
- `sentiment-reality-gap`
- `quant-factor-screener`

原因：

- 更偏补充层、例外层或研究层
- 会增加复杂度
- 不是当前基金主骨架最缺的能力

## 不建议吸收

### findata-toolkit-cn（作为主层）

不建议作为主数据底座吸收。

原因：

- 现有 `market-mcp` 已覆盖你的主需求
- 再并一个主数据层会让系统出现双口径
- 当前更适合作为备用数据工具箱，而不是主交易系统底座

### 其他当前不建议进入主链的模块

- `yfinance-data`、`alphaear-stock`、`alphaear-search`
  原因：与现有 `market-mcp`、`web` 和本地脚本链路功能重叠，容易带来双口径。
- `alphaear-predictor`、`alphaear-deepear-lite`
  原因：一个过重、一个偏黑盒，都不适合当前以纪律和结构修复为主的系统。
- `options-payoff`
  原因：你的系统当前仍以基金主骨架为核心，期权工具暂时没有直接落点。
- `twitter-reader`、`telegram-reader`、`discord-reader`
  原因：只有在你明确要做社区舆情层时才值得接入，而且环境搭建成本明显高于当前收益。

## 一句话结论

`已经吸收进来的，都是最能增强骨架稳定性和执行力的部分；下一批最值得继续吸收的是 alphaear-signal-tracker、sector-rotation-detector 和 hormuz-strait；其余多数更适合作为补充层、研究层或备用工具，而不是主链。`
