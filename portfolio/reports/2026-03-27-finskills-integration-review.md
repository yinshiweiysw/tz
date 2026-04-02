# 金融技能集成评估

日期：2026-03-27

## 结论

`finskills` 更适合当作方法库和模板库，不适合整套替换当前系统；`finance-skills` 和 `Awesome-finance-skills` 里也有少数值得吸收的模块，但同样不应整仓照搬。

对你当前这套以基金主骨架、风险仪表盘、市场日报、交易卡片为核心的系统，最值得吸收的是：

1. `portfolio-health-check`
2. `risk-adjusted-return-optimizer`
3. `alphaear-signal-tracker`
4. `sector-rotation-detector`
5. `hormuz-strait`

`high-dividend-strategy`、`alphaear-news`、`alphaear-sentiment`、`suitability-report-generator` 值得继续保留在第二梯队；`findata-toolkit-cn`、`yfinance-data`、`alphaear-stock` 不建议作为主数据层替换现有 `market-mcp`。

## 评估对象

- 仓库：`/Users/yinshiwei/codex/tz/finskills`
- 重点查看：
  - `/Users/yinshiwei/codex/tz/finskills/China-market/portfolio-health-check/SKILL.md`
  - `/Users/yinshiwei/codex/tz/finskills/China-market/sector-rotation-detector/SKILL.md`
  - `/Users/yinshiwei/codex/tz/finskills/China-market/high-dividend-strategy/SKILL.md`
  - `/Users/yinshiwei/codex/tz/finskills/China-market/findata-toolkit-cn/SKILL.md`

## 值得吸收的部分

### 1. portfolio-health-check

最值得先吸收。

原因：

- 和你当前系统最贴近，天然对应现有的 `risk_dashboard.json`、周度评分、组合复盘。
- 它把组合诊断拆成了集中度、相关性聚集、因子暴露、压力测试、流动性等多个维度，框架比当前版本更完整。
- 里面对 A 股特有问题的提醒很实用，比如：
  - 涨跌停导致的流动性风险
  - 白酒/新能源产业链这类“看似分散、实则高相关”的聚集风险
  - 高股息持有期税率和调仓成本

最适合并入当前系统的位置：

- `risk_dashboard.json`
- 周评分 `scorecards/weekly`
- 单次大仓复盘模板

建议吸收方式：

- 不装成独立 skill。
- 把其中的“诊断维度”和“红灯阈值”提炼成你自己的风险规则。

### 2. sector-rotation-detector

值得作为第二优先级吸收。

原因：

- 你现在已经有 `market_pulses`、`market_briefs` 和板块观察清单，但还缺一层更系统的“宏观 -> 行业轮动”框架。
- 这个 skill 的优点是把行业判断放在：
  - 货币政策
  - 通胀
  - 经济增长
  - 就业与消费
  - 政策导向
  这些宏观支柱里看，而不是只看当天涨跌榜。
- 它很适合升级你现有的板块分析模块，让“今天板块为什么涨”进一步变成“未来 6-12 个月哪些行业更值得超配/低配”。

最适合并入当前系统的位置：

- `market_briefs`
- 单独新增 `sector_reports/`
- A 股观察清单和买入触发条件的上游逻辑层

建议吸收方式：

- 吸收分析框架，不直接照搬输出模板。
- 保留你现在的实盘导向，缩短时间维度，优先服务 `1-8 周` 的配置与交易，而不是只做 `6-12 个月` 宏观报告。

### 3. high-dividend-strategy

值得吸收，但优先级排在前两个后面。

原因：

- 你已经把 `红利低波 / 银行 / 防守仓` 放进了主骨架，这个 skill 刚好能补上“为什么选红利、怎么判断红利质量”的方法层。
- 它在红利股分析里比较强调：
  - 分红可持续性
  - 自由现金流覆盖
  - 股息率陷阱
  - 国企分红改革
- 这些都比单纯看股息率更有用，尤其适合你后面扩展“防守仓候选池”。

最适合并入当前系统的位置：

- 防守仓候选筛选
- `A股银行 / 红利 / A股央企红利` 对比研究
- 红利相关周度专题

建议吸收方式：

- 不必把个股分红分析做得太重。
- 更适合改造成“防守仓基金/指数路线比较器”。

## 暂不建议作为主数据层替换的部分

### findata-toolkit-cn

它本身不错，但我不建议直接替换现有 `market-mcp`。

原因：

- 当前 `market-mcp` 已经覆盖了你最常用的核心需求：
  - 指数和跨市场行情
  - CME 期货
  - 黄金
  - A 股板块热度
  - 基金估值和持仓
- `findata-toolkit-cn` 主要依赖 AKShare，偏向脚本型、离线型工具集，更适合作为补充数据层。
- 如果同时把它设成主数据源，会让系统出现双口径维护成本。

更适合的定位：

- 备用工具箱
- 宏观数据增强
- 北向资金、A 股财务和个股级补充分析

## 不建议整套照搬的原因

1. 你当前系统已经围绕“基金主骨架 + 例外短线 + 风险仪表盘 + 自动化日报”搭好了。
2. `finskills` 更偏 Claude Skills 风格的分析框架集合，不是直接为你这套日更交易系统设计的。
3. 整套引入会带来规则重复、数据口径分裂和流程冗余。

## 推荐集成顺序

### 第一阶段

先吸收 `portfolio-health-check`。

目标：

- 升级风险仪表盘
- 升级周评分
- 升级组合诊断语言

### 第二阶段

吸收 `sector-rotation-detector`。

目标：

- 给板块日报增加“宏观驱动”和“轮动框架”
- 让板块分析从当日热度走向结构判断

### 第三阶段

吸收 `high-dividend-strategy`。

目标：

- 强化防守仓研究
- 构建红利/银行/央企红利的选择框架

### 第四阶段

把 `findata-toolkit-cn` 当作补充数据工具箱，而不是主数据层。

## 对当前系统的直接建议

当前最适合马上落地的两件事：

1. 在 `risk_dashboard.json` 里补“相关性聚集”和“压力情景”字段。
2. 新增一个轻量的 `sector_rotation_report`，把宏观和板块观察连接起来。

## 第二批技能补充评估

本次额外查看：

- `/Users/yinshiwei/codex/tz/finskills/China-market/risk-adjusted-return-optimizer/SKILL.md`
- `/Users/yinshiwei/codex/tz/finskills/China-market/suitability-report-generator/SKILL.md`
- `/Users/yinshiwei/codex/tz/finskills/China-market/event-driven-detector/SKILL.md`
- `/Users/yinshiwei/codex/tz/finskills/China-market/quant-factor-screener/SKILL.md`
- `/Users/yinshiwei/codex/tz/finskills/China-market/sentiment-reality-gap/SKILL.md`

### 4. risk-adjusted-return-optimizer

值得吸收，而且优先级较高。

原因：

- 它和你现在的“六类仓位目标金额表”天然衔接。
- 里面对：
  - 战略资产配置
  - 核心-卫星结构
  - 再平衡规则
  - 账户约束条件
  的整理很完整。
- 它尤其适合增强：
  - `bucket-targets-and-mapping`
  - `next-trade-generator`
  - 每月结构复核

建议吸收方式：

- 不直接按传统均值方差优化去做实盘决策。
- 更适合提炼其中的“仓位边界、再平衡偏差阈值、核心-卫星结构”。

结论：

- `值得吸收`
- 综合优先级可排在 `portfolio-health-check` 之后，和 `sector-rotation-detector` 接近

### 5. suitability-report-generator

值得吸收，但更偏文档层，不是主交易引擎核心。

原因：

- 你现在已经有 `trade_cards`、`hypotheses`、`daily journals`，这类 skill 很适合增强“为什么这样做”的记录质量。
- 它对：
  - 风险披露
  - 假设与局限
  - 适配当前账户状态
  的表达非常完整。

最适合并入当前系统的位置：

- `trade_cards`
- 大额调仓说明
- 重要交易前的“为什么适合现在的账户”

建议吸收方式：

- 不必做成正式合规报告。
- 更适合改造成“交易理由 + 风险披露”模板层。

结论：

- `值得吸收`
- 但优先级低于风险、轮动、仓位结构模块

### 6. event-driven-detector

适合保留为例外层工具，不适合进入主骨架。

原因：

- 你的系统主骨架目前是基金为主，事件驱动更多属于个股/题材/特殊催化策略。
- 它的确能增强短线非基金例外层，但不适合成为主系统默认模块。

适合的用途：

- 后续你如果要专门看：
  - 国企改革
  - 回购增持
  - 指数调整
  - 分拆上市
  这类短线/事件机会时，再调用

结论：

- `保留为备用技能`
- `不优先集成`

### 7. quant-factor-screener

方法论有价值，但当前不建议优先集成。

原因：

- 你现在最重要的是先把骨架和执行纪律稳定下来，不是再引入一套新的复杂选股体系。
- 它更适合：
  - 做基金/指数路线背后的因子研究
  - 做长期量化专题
- 不太适合直接放进你现在的日常交易主流程

结论：

- `可作为研究储备`
- `当前不优先`

### 8. sentiment-reality-gap

适合作为“抄底前过滤器”，但不建议直接并入主系统。

原因：

- 你的过去问题里，最大的风险之一就是“跌多了就补”，所以这个 skill 的价值反而在于：
  - 帮你区分错杀和价值陷阱
  - 作为左侧/逆向前的二次验证
- 但它不应该成为你默认的加仓逻辑，否则容易把系统重新带回“逆向执念”

适合的用途：

- 当你特别想抄某个跌深方向时，用它做额外审查

结论：

- `适合做逆向过滤器`
- `不适合做主骨架常规模块`

## 其他仓库补充评估

本次额外查看：

- `/Users/yinshiwei/codex/tz/finance-skills/skills/hormuz-strait/SKILL.md`
- `/Users/yinshiwei/codex/tz/finance-skills/skills/stock-correlation/SKILL.md`
- `/Users/yinshiwei/codex/tz/finance-skills/skills/yfinance-data/SKILL.md`
- `/Users/yinshiwei/codex/tz/finance-skills/skills/options-payoff/SKILL.md`
- `/Users/yinshiwei/codex/tz/finance-skills/skills/twitter-reader/SKILL.md`
- `/Users/yinshiwei/codex/tz/finance-skills/skills/telegram-reader/SKILL.md`
- `/Users/yinshiwei/codex/tz/finance-skills/skills/discord-reader/SKILL.md`
- `/Users/yinshiwei/codex/tz/Awesome-finance-skills/skills/alphaear-news/SKILL.md`
- `/Users/yinshiwei/codex/tz/Awesome-finance-skills/skills/alphaear-sentiment/SKILL.md`
- `/Users/yinshiwei/codex/tz/Awesome-finance-skills/skills/alphaear-signal-tracker/SKILL.md`
- `/Users/yinshiwei/codex/tz/Awesome-finance-skills/skills/alphaear-reporter/SKILL.md`
- `/Users/yinshiwei/codex/tz/Awesome-finance-skills/skills/alphaear-search/SKILL.md`
- `/Users/yinshiwei/codex/tz/Awesome-finance-skills/skills/alphaear-stock/SKILL.md`
- `/Users/yinshiwei/codex/tz/Awesome-finance-skills/skills/alphaear-predictor/SKILL.md`
- `/Users/yinshiwei/codex/tz/Awesome-finance-skills/skills/alphaear-deepear-lite/SKILL.md`

### 9. alphaear-signal-tracker

这是当前最值得继续吸收的新增 skill。

原因：

- 你已经有 `hypotheses.md`，但现在还是静态记录，主要只有“进行中 / 已验证 / 已失效”三档。
- 这个 skill 的核心不是给新观点，而是把已有观点做成“强化 / 弱化 / 证伪”的动态演化链。
- 它和你现有的 `market_briefs`、`daily_briefs`、周评分之间天然有接口，不需要新造一套系统。

最适合并入当前系统的位置：

- `hypotheses.md`
- `daily_briefs`
- 周评分 `scorecards/weekly`

建议吸收方式：

- 不要整套照搬它的 agent workflow。
- 直接提炼成“每条假设每天至少判断一次：强化 / 弱化 / 证伪 / 不变”的轻量规则。

结论：

- `非常值得吸收`
- `综合优先级高于 sector-rotation-detector`

### 10. hormuz-strait

这是当前边际价值很高的事件型 skill。

原因：

- 你当前系统已经把中东、油价、黄金和港股科技修复写进了核心假设。
- `hormuz-strait` 直接提供霍尔木兹海峡通航、保险、油运和全球贸易影响，对你的黄金、商品、港股风险判断很对口。
- 它不是天天必用，但只要中东风险还在，它就比普通泛新闻更有针对性。

最适合并入当前系统的位置：

- `market_briefs`
- `hypotheses.md`
- 风险事件快报或特殊日报

建议吸收方式：

- 不要变成每天固定模块。
- 作为“中东风险模式”下的专项监控器，在风险升温时自动引用。

结论：

- `值得吸收`
- `优先级高于 high-dividend-strategy`

### 11. alphaear-news

适合作为新闻补充层，不适合替代主链。

原因：

- 它能聚合多源热点，对 `market_pulses` 和 `market_briefs` 的新闻层确实有帮助。
- 但它偏热度聚合，天然会比你现在强调的权威源链路更嘈杂。
- 适合当“第二视角”，不适合做唯一新闻入口。

最适合并入当前系统的位置：

- `market_pulses`
- `market_briefs`

结论：

- `值得保留为补充层`
- `不建议当主新闻底座`

### 12. alphaear-sentiment

适合未来和情绪模块合并。

原因：

- 你已经有 `sentiment-reality-gap` 这个待吸收方向，`alphaear-sentiment` 刚好能补“新闻情绪打分”这一步。
- 它的价值不在于直接告诉你买卖，而在于帮助你识别“市场情绪很热，但价格和资金未跟上”的错配。
- 现在单独接入价值一般，但和 `alphaear-news`、`sentiment-reality-gap` 组合后会更有意义。

结论：

- `值得保留`
- `优先级低于 signal-tracker 与 hormuz-strait`

### 13. stock-correlation

有价值，但更适合研究层。

原因：

- 你现在的风险仪表盘已经能做基金级的相关性聚集判断。
- `stock-correlation` 更适合做个股、产业链和主题共振研究，而不是当前基金主骨架的直接控制器。
- 如果后续你把组合中的基金映射到底层行业和代表股票，它会很有用；在那之前不必优先接入。

结论：

- `值得保留为研究工具`
- `当前不优先`

### 14. alphaear-reporter

适合强化输出，不适合作为核心引擎。

原因：

- 它和 `suitability-report-generator` 类似，能增强结构化表达。
- 你已经有 `trade_cards`、`market_briefs`、`daily_briefs`，所以它更像文档增强器，不是骨架核心。

结论：

- `可吸收`
- `优先级低于 signal / macro / event 相关模块`

## 当前不建议继续吸收的模块

### 主因是重复、过重或容易制造伪精确

- `yfinance-data`、`alphaear-stock`、`alphaear-search`
  原因：与现有 `market-mcp`、`web` 和本地脚本链路功能重叠，容易带来双口径。
- `alphaear-predictor`
  原因：依赖重，而且会把当前实盘系统往“预测模型”而不是“纪律和结构”上带。
- `alphaear-deepear-lite`
  原因：更像黑盒信号源，适合参考，不适合进入主决策链。
- `options-payoff`
  原因：当前系统仍以基金主骨架为核心，期权工具没有直接落点。
- `twitter-reader`、`telegram-reader`、`discord-reader`
  原因：只有在你明确要做社区舆情层时才值得接入，而且 setup 成本较高。

## 你新补充的 5 类候选结论

### 1. OpenBB

能力很强，但当前不建议作为主链吸收。

原因：

- 官方把它定位成开放数据平台，面向 Python、Workspace、Excel、REST 和 MCP 多端统一供数。
- 对全球市场、多数据源研究非常强，但对你当前这套基金主骨架系统来说，平台级能力明显大于当前需求。
- 如果现在直接接入，很容易和现有 `market-mcp`、日报脚本、手工规则层形成较大重叠。

更适合的定位：

- 以后单独做“研究工作台”
- 海外资产、财报和多市场横向比较时作为高级平台

结论：

- `不建议当前作为主链吸收`
- `以后可单独作为研究平台考虑`

### 2. FinGPT

值得吸收方法，不值得现在整套落地。

原因：

- 官方仓库最成熟的落点仍是金融情绪分析、多任务微调和报告摘要。
- 它确实适合情绪层和金融文本处理，但本地模型、LoRA、推理链路都偏重。
- 对你现在这套系统，真正高价值的是吸收它的“金融情绪分析方法”，而不是马上把模型链路搬进来。

更适合的定位：

- 新闻情绪评分
- 市场情绪 vs 价格表现偏差判断
- 报告草稿生成

结论：

- `值得吸收方法论`
- `不建议当前整套模型化接入`

### 3. CrewAI / LangGraph 金融模板

现在不应当把它们当成“金融 skill”吸收。

原因：

- CrewAI 和 LangGraph 本质上是多智能体编排框架，不是金融能力本身。
- 你当前系统已经有清晰的状态层、规则层、日报层和交易卡片层，问题不在“缺多 agent”，而在“把已有判断做得更稳定”。
- 如果现在为多角色而多角色，只会提高复杂度，而不会直接提升交易系统质量。

更适合的定位：

- 以后当你明确要拆出“数据采集 / 风险反驳 / 报告生成”三条并行链路时，再作为编排层考虑

结论：

- `当前不建议吸收`
- `它们是未来的架构层，不是眼下最缺的金融层`

### 4. MCP 数据供应商：Twelve Data / EODHD / Alpha Vantage

可以吸收，但只能选一个先做补充层。

原因：

- 这三类官方 MCP 都已经成熟到可以直接接入 Codex / Claude。
- Twelve Data 强在全球行情、技术指标、ETF、经济事件，覆盖面最全。
- Alpha Vantage 强在技术指标和海外市场数据，官方 MCP 也已经明确支持 Codex。
- EODHD 强在财报、分红、内幕交易、新闻情绪等补充字段，更偏财务深挖。
- 如果三家一起上，会立刻把系统带进多供应商并行维护的状态，收益不如复杂度增长快。

更适合的定位：

- `Twelve Data MCP`：全球市场和技术指标的第二数据源
- `Alpha Vantage MCP`：技术指标与海外市场补充
- `EODHD MCP`：财报、分红、内幕交易和新闻情绪补充

结论：

- `值得吸收，但只建议先选 1 家`
- `如果只选一家做通用补充，我更偏向 Twelve Data；如果偏财务深挖，则偏向 EODHD`

### 5. AkShare

这是你这批新增候选里，最值得吸收的中国市场补充工具。

原因：

- 官方仓库仍在持续更新，覆盖 A 股、基金、期货、宏观、北向、财务、板块等中国市场数据。
- 它和你当前系统的关系，不应该是替代 `market-mcp`，而应该是“补齐中国市场长尾数据”。
- 对你的系统最有现实价值的是：
  - 北向 / 资金流
  - A 股财务和财报
  - 更细的板块、宏观、日历与统计口径

更适合的定位：

- 中国市场补充工具箱
- A 股专题研究层
- 宏观和板块轮动层的数据后备

结论：

- `值得吸收`
- `优先级高于 OpenBB、FinGPT 和多智能体框架`

## 更新后的集成优先级

### 第一优先级

1. `portfolio-health-check`
2. `risk-adjusted-return-optimizer`
3. `alphaear-signal-tracker`
4. `sector-rotation-detector`
5. `hormuz-strait`

### 第二优先级

6. `high-dividend-strategy`
7. `alphaear-news`
8. `alphaear-sentiment`
9. `suitability-report-generator`

### 第三优先级

10. `stock-correlation`
11. `alphaear-reporter`
12. `event-driven-detector`
13. `sentiment-reality-gap`
14. `quant-factor-screener`
15. `findata-toolkit-cn`

## 对骨架增强最有价值的吸收路线

如果只从“增强整个骨架的可用性和强大性”出发，我会建议按这条路线做：

1. 用 `portfolio-health-check` 升级风险仪表盘和周评分。
2. 用 `risk-adjusted-return-optimizer` 升级六类仓位的目标比例、再平衡阈值和下一笔交易生成器。
3. 用 `alphaear-signal-tracker` 升级 `hypotheses.md`，把假设改成动态跟踪。
4. 用 `sector-rotation-detector` 升级市场日报和板块分析。
5. 用 `hormuz-strait` 在中东风险模式下补专项监控。
6. 用 `high-dividend-strategy` 强化防守仓路线。
7. 用 `suitability-report-generator` 和 `alphaear-reporter` 提高交易卡片和报告表达质量。

## 一句话总结

`真正值得继续吸收的不是更多数据源，而是更好的信号跟踪、行业轮动和事件监控；下一批最有价值的是 alphaear-signal-tracker、sector-rotation-detector 和 hormuz-strait。`
