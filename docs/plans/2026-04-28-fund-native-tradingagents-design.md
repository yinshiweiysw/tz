# TradingAgents 基金原生兼容模式设计

Date: 2026-04-28
Repo: `/Users/yinshiwei/codex/tz-main-simplified`
Branch: `codex/simplified-fund-os`

## 1. 背景

当前简化版基金系统已经形成三层主脑：

- `TradingAgents market/bucket brain`：判断市场、proxy、桶方向。
- `local fund truth / guardrails`：提供真实持仓、确认净值、收益、金额约束和只读边界。
- `fund-level live analyzer`：对深看候选基金生成基金级分析。

用户的长期目标是让 TradingAgents 主脑真正适配基金，而不是只分析 ETF proxy 后再由本地系统做轻适配。

本设计采用低改动版方案 3：**TradingAgents Fund-Native Compatibility Mode**。它不 fork 大改 TradingAgents 核心 graph，而是新增基金目标、基金研究上下文、基金化 prompt pack 与基金输出合同，让 TradingAgents 直接分析基金。

## 2. 设计目标

- TradingAgents 可以直接分析 `fund:<fundCode>`，例如 `fund:019736`。
- 分析对象从股票/ETF ticker 变为基金研究包。
- 输出从股票式 `BUY/HOLD/SELL` 改为基金申购/赎回/维持/深看语义。
- 结果接入 `/advice` 的 `详情`，并参与基金状态矩阵和全组合观察。
- 系统继续 `fund-only / read-only`：不写 ledger、不自动下单、不新增执行按钮。
- 首批只对深看候选、风险升级基金、用户手动点开的基金运行，不默认全量跑 24 只基金。

## 3. 非目标

- 不重写外部 TradingAgents 整个 graph。
- 不把 24 只基金每天全部跑 full graph。
- 不恢复旧 heavy workbench、shadow、promotion 主链。
- 不让 AI 修改份额、成本、收益、确认净值或交易账本。
- 不把股票盘中交易语言照搬到基金系统。

## 4. 总体架构

```text
fund:019736
  -> buildFundResearchContext()
  -> TradingAgents fund-native prompt pack
  -> fund_native_raw_snapshot
  -> fund_native_analysis_snapshot
  -> /api/trading-decision + /advice 详情
```

保留当前系统：

```text
TradingAgents market/bucket brain
+ local fund truth
+ local guardrails
+ /advice morning brain page
```

新增：

```text
TradingAgents fund-native compatibility mode
```

它通过基金研究上下文把基金资料、真实持仓、因子、同类关系和市场判断注入 TradingAgents。

## 5. FundResearchContext

`FundResearchContext` 是 TradingAgents 基金模式的唯一输入弹药包。它应由本地系统生成，避免 TradingAgents 绕过本地真值链。

建议字段：

```json
{
  "targetType": "fund",
  "fundCode": "019736",
  "fundName": "宝盈纳斯达克100指数发起(QDII)A人民币",
  "fundTemplate": "qdii_index_fund",
  "holding": {
    "amountCny": 12345,
    "holdingPnl": -321,
    "dayPnl": 12,
    "confirmationState": "normal_lag"
  },
  "researchProfile": {
    "manager": "...",
    "company": "...",
    "scale": "...",
    "fees": "...",
    "topHoldings": []
  },
  "factorContext": {
    "primaryFactor": "US_TECH",
    "secondaryFactors": ["US_SEMI"]
  },
  "peerContext": {
    "peerGroup": "美股科技",
    "representativeCandidate": true,
    "duplicateExposure": []
  },
  "marketContext": {
    "bucket": "GLB_MOM",
    "bucketVerdict": "维持",
    "marketDataTier": "reference_close",
    "proxySymbols": ["QQQ"]
  },
  "guardrails": {
    "reviewOnly": true,
    "canWriteLedger": false,
    "canGenerateOrder": false,
    "confirmedNavState": "late_missing"
  }
}
```

## 6. 原 TradingAgents 角色与基金语义映射

原始 TradingAgents 是股票交易委员会结构：

```text
Market / Social / News / Fundamentals Analysts
  -> Bull / Bear Researchers
  -> Research Manager
  -> Trader
  -> Aggressive / Conservative / Neutral Risk Analysts
  -> Portfolio Manager
```

基金模式不删除这些角色，而是替换角色语义和 prompt：

| 原角色 | 基金模式语义 | 主要变化 |
| --- | --- | --- |
| Market Analyst | Fund Style Analyst | 判断基金所属风格是否顺风，如美股科技、A 股成长、黄金、港股红利。 |
| Social Media Analyst | Theme Sentiment Analyst | 分析主题热度、同类资金偏好和拥挤度，不追公司社媒。 |
| News Analyst | Macro/Event Analyst | 把宏观和事件影响落到基金类型、地区和因子。 |
| Fundamentals Analyst | Fund Profile Analyst | 分析基金经理、基金公司、规模、费率、最新季报重仓、基金类型。 |
| Bull Researcher | Keep/Add Advocate | 论证维持、申购或继续观察的理由。 |
| Bear Researcher | Reduce/Replace Advocate | 论证部分赎回、清仓赎回、替换或暂停动作的理由。 |
| Research Manager | Fund Research Judge | 总结基金是否值得保留、深看或进入动作备选。 |
| Trader | Fund Allocation Reviewer | 输出基金申购/赎回/维持语义，不输出股票盘中执行语言。 |
| Aggressive Risk Analyst | Growth Allocation Risk View | 评估是否可以承担高波动或进攻仓位。 |
| Conservative Risk Analyst | Defense / NAV Confirmation View | 关注确认净值、QDII 滞后、亏损扩大、资料陈旧、现金防线。 |
| Neutral Risk Analyst | Balanced Allocation View | 评估仓位是否已足、是否重复暴露、是否只适合观察。 |
| Portfolio Manager | Fund Committee Decision | 输出基金委员会结论，全部保持 review-only。 |

## 7. 基金动作语义

基金可以买入、卖出、止损、清仓，但它们应该是基金申购/赎回语义，而不是股票盘中交易语义。

允许的页面语义：

- 可考虑买入 / 追加申购
- 可考虑卖出一部分 / 部分赎回
- 可考虑退出 / 清仓赎回
- 可考虑止损减仓
- 先不动 / 维持
- 今日暂停动作
- 深看
- 可考虑替换

禁止或改写的股票式语言：

- 市价买入 / 市价卖出
- 开盘清仓
- 盘中止损
- 挂单
- 突破价买入
- 日内交易
- 按盘口执行

底层可以保留 `candidate` 表示“进入操作备选”，但页面应优先显示人话：`可考虑买入`、`可考虑卖出一部分`、`可考虑退出`。

## 8. 输出合同

基金模式主输出必须结构化，长论证只放到折叠证据中。

建议合同：

```json
{
  "fundCode": "019736",
  "fundName": "宝盈纳斯达克100指数发起(QDII)A人民币",
  "mode": "fund_native",
  "provider": "glm",
  "status": "ready",
  "template": "qdii_index_fund",
  "verdict": "部分赎回候选",
  "tradeDirection": "sell",
  "riskLight": "yellow",
  "confidence": 0.72,
  "oneLine": "纳指工具属性清晰，但当前高波亏损仓更适合复核风险而不是追增。",
  "styleEnvironment": {
    "label": "中性偏强",
    "reason": "美股科技方向仍可观察，但行情为前收参考。"
  },
  "fundQuality": {
    "label": "可用",
    "reason": "指数工具属性清晰，重仓穿透可用。"
  },
  "lookThrough": {
    "label": "暴露清晰",
    "reason": "主要暴露于美股大型科技。"
  },
  "peerRole": {
    "label": "代表候选",
    "reason": "可作为美股科技组核心观察基金之一。"
  },
  "riskReview": {
    "riskLight": "yellow",
    "notes": ["QDII 净值确认滞后", "高波亏损仓不宜机械补仓"]
  },
  "execution": {
    "executionIntent": "review_only",
    "fundExecutionStyle": "end_of_day_t1_review",
    "suggestedAmountRangeCny": { "min": 1000, "max": 3000 },
    "timingNote": "如执行，应在尾盘前复核，并按基金申购/赎回净值确认。"
  },
  "uncertainties": ["行情为前收参考", "确认净值存在滞后"],
  "rawEvidence": "..."
}
```

## 9. 运行策略

默认自动运行：

- 今日深看候选，最多 3-5 只。
- 风险升级基金。
- 用户手动打开详情的基金。

默认不运行：

- 债券、货基、现金防守类 full graph。
- 24 只基金全量 full graph。
- 资料不足且不在深看列表中的基金。

运行分层：

```text
fast path:
  基金状态矩阵继续用本地规则生成，页面秒开。

deep path:
  TradingAgents fund-native mode 后台运行，成功后更新详情。

fallback:
  fund-native mode 失败时，详情显示本地分析、已有 fund_live_analyzer 摘要和明确失败原因。
```

## 10. 与现有 fund_live_analyzer 的关系

现有 `fund_live_analyzer` 不删除。它可以作为：

1. fund-native graph 失败时的 fallback；
2. fund-native raw output 的摘要压缩器。

推荐定位是第二种：

```text
TradingAgents fund-native raw
  -> fund_live_analyzer summary/compressor
  -> /advice 详情
```

这样既复用已有能力，又避免双脑互相打架。

## 11. 页面呈现

`/advice` 保持晨会风格，不铺长文。

深看详情显示：

- 基金委员会结论
- 一句话原因
- 风格环境
- 基金质量
- 持仓穿透
- 同类角色
- 风险复核
- 可考虑动作与金额区间
- 动作边界
- 不确定项
- 折叠原始证据

基金状态矩阵显示：

- `基金主脑已跑`
- `等待主脑`
- `资料不足`
- `沿用上次`
- `降级观察`

## 12. 错误与降级

必须显式展示：

- provider 缺 key
- provider 429
- timeout
- graph 失败
- fund profile missing / stale / partial
- confirmed NAV degraded
- market data reference_close

失败时不能伪装为 live 成功。页面可以展示本地观察，但必须标注：`基金原生主脑未完成，当前为降级观察`。

## 13. 验收标准

第一版成功标准：

- `/advice` 的深看基金详情显示 fund-native TradingAgents 结果。
- 输出分角色：风格环境、基金质量、持仓穿透、同类角色、风险复核、基金委员会结论。
- 页面使用基金申购/赎回/尾盘复核语言，不出现股票盘中执行语言。
- 所有交易输出都是 review-only，不写 ledger、不生成订单。
- 失败时显示 provider / graph / timeout 诊断。
- 默认只对深看候选或手动基金运行，不阻塞首页和 `/advice` 基础渲染。

## 14. 推荐实施阶段

### Phase 1: Context + Contract

- 新增 `FundResearchContext` builder。
- 新增 fund-native output contract。
- 用 fixture 验证基金输入和输出结构。

### Phase 2: Prompt Pack + Runner

- 新增 fund-native prompt pack。
- 新增 `run_fund_native_tradingagents.mjs`。
- 首批跑深看候选。

### Phase 3: UI Integration

- `/advice` 详情优先展示 fund-native result。
- 显示运行状态和失败原因。
- 保留本地分析 fallback。

### Phase 4: Reliability

- 加 cache、history、timeout、provider health。
- 接入上次/本次变化追踪。
- 优化同类代表基金和替换建议。
