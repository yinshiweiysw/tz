# 系统架构审计与问题整改报告

**版本**: 1.0
**日期**: 2026-04-03
**审计范围**: portfolio/ 全系统（IPS / 决策树 / 运营协议 / asset_master / 核心库模块 / 信号与交易链路）
**审计方法**: 逐文件代码审读 + IPS-代码一致性交叉比对 + 数据完整性链路追踪

---

## 目录

1. [审计摘要](#一审计摘要)
2. [核心发现：IPS 执行缺口](#二核心发现ips-执行缺口)
3. [发现一：IPS 规则在交易执行层几乎完全缺失](#一ips-规则在交易执行层几乎完全缺失)
4. [发现二：asset_master.json 与 IPS 存在结构性目标漂移](#二asset_masterjson-与-ips-存在结构性目标漂移)
5. [发现三：数据完整性链条存在多个断裂点](#三数据完整性链条存在多个断裂点)
6. [发现四：市场数据层鲁棒性不足](#四市场数据层鲁棒性不足)
7. [发现五：风险仪表盘是后视镜而非刹车](#五风险仪表盘是后视镜而非刹车)
8. [发现六：IPS 与实际持仓严重矛盾](#六ips-与实际持仓严重矛盾)
9. [问题整改意见](#七问题整改意见)
10. [附录：IPS 规则执行矩阵](#附录ips-规则执行矩阵)
11. [附录：文件级审计清单](#附录文件级审计清单)

---

## 一、审计摘要

本系统定位为"AI 辅助投资操作系统"，拥有完整的投资政策声明（IPS）、决策树、运营协议和三层架构蓝图。经过对全部核心代码的逐行审读，结论如下：

### 整体评价

| 维度 | 评分 | 说明 |
|------|:----:|------|
| 投资策略设计 | A | IPS 文档专业、决策树覆盖全面、双引擎架构思路清晰 |
| 数据获取与整合 | B | market-mcp 统一了多源数据，但容错和重试机制不足 |
| 状态管理与对账 | B- | 物化链路完整，但缺乏原子写入、去重和输入校验 |
| 风险监控与报告 | B+ | 风险仪表盘信息丰富，日报/周报体系完善 |
| **风控执行与阻断** | **D** | **IPS 规则几乎全部停留在"建议"层面，无交易前置门禁** |

### 核心判断

> **系统的 IPS 是一流的，报告系统是二流的，风控执行是三流的。**
>
> 当纪律最关键的时刻（恐惧、贪婪、回撤），系统无法替用户踩刹车——它只能在用户冲下悬崖后，在日报里写一段"建议您注意风险"。

---

## 二、核心发现：IPS 执行缺口

### IPS 规则执行矩阵

| IPS 规则 | 文档定义 | 配置定义 | 信号层检查 | 交易层阻断 | 看板告警 | **实际阻断能力** |
|---------|:-------:|:-------:|:---------:|:---------:|:-------:|:--------------:|
| 回撤 8-10% 重新评估结构 | 有 | 无 | 无 | 无 | 无 | **无** |
| 回撤 12% 禁止扩仓 | 有 | 无 | 无 | 无 | 无 | **无** |
| 单基金上限 8-10% | 有 | 无 | 无 | 无 | 25% 软警告（弱） | **无** |
| 单主题上限 12-15% | 有 | 无 | 无 | 无 | 无 | **完全无** |
| 高相关仓位合计上限 25% | 有 | 无 | 无 | 无 | rho>0.6 警告（弱） | **无** |
| 现金底线 15-30% | 有 | min:15% | 压缩（generate_signals.py） | 无 | 有 | **部分** |
| 左侧博弈上限 15% | 有 | max:15% | 预算控制 | 无 | 有 | **仅计划层** |
| 再平衡 5pp 偏差触发 | 有 | 无 | 无 | 无 | 桶 min/max | **无** |
| 情绪熔断（想回本/怕踏空） | 有 | 无 | 无 | 无 | 无 | **完全依赖自律** |
| ATR Kill Switch | 有 | 2/15 桶启用 | 有 | 有（强平） | N/A | **有（仅 2 桶）** |
| buy_gate: "frozen" | 有 | TACTICAL 冻结 | 无 | 无 | 仅展示 | **无** |
| 权益预算上限 75% | 有 | absolute_equity_cap | 压缩 | 无 | 有 | **信号层** |

**关键发现**：全系统 12 项核心 IPS 规则中，仅 1.5 项（ATR Kill Switch + 权益预算压缩）具备真正的交易阻断能力，其余均为事后观察或纯文档意图。

---

## 三、详细发现

### 一、IPS 规则在交易执行层几乎完全缺失

#### 1.1 回撤限制：完全无执行代码

**IPS 定义**（INVESTMENT_POLICY_STATEMENT.md 第 32-35 行）：
- 单次阶段性回撤超过 8%-10% 时，必须重新评估结构
- 组合从高点回撤超过 12%，禁止继续扩大高波动主题仓

**代码现状**：
- `generate_fund_signals_matrix.py` 第 290-302 行：计算 `max_drawdown_60d_percent` 用于展示，不触发动作
- `generate_risk_dashboard.mjs` 第 240-273 行：核心防守资产回撤 >10% 时添加文字警告，不阻断交易
- `backtest_engine.py` 第 756-759 行：仅在回测中检查 10% 阈值
- **无任何代码在实盘交易前检查当前回撤水平并据此阻断交易**

**风险**：用户在组合已经回撤 12% 的情况下，仍然可以毫无阻碍地通过 `manual_trade_recorder` 记录新的高波动主题买入。

#### 1.2 单基金上限：阈值过于宽松

**IPS 定义**：单只基金上限为总资产的 8%-10%。

**代码现状**：
- `generate_risk_dashboard.mjs` 第 715-716 行：检查单一持仓占 **已投资仓位**（非总资产）是否超过 **25%**
- 这个 25% 阈值远高于 IPS 的 8-10%
- 计算口径从"总资产"变成了"已投资资本"，进一步放松了约束
- 无任何交易前置检查

**影响**：一个占总资产 20% 的单基金持仓，在 IPS 下已严重超标，但在系统代码中不会触发任何告警。

#### 1.3 单主题上限：代码完全缺失

**IPS 定义**：恒生科技及港股互联网合计不超过总资产 10%-12%。

**代码现状**：搜索 `theme.*cap`、`港股.*上限`、`恒生.*limit` 均无命中。asset_master.json 不定义主题级别上限。无任何代码聚合同一主题下多只基金的合计权重。

#### 1.4 高相关仓位上限：概念混淆

**IPS 定义**：高相关仓位合计上限为总资产的 25%（基于权重的组合约束）。

**代码现状**：
- `generate_risk_dashboard.mjs` 第 375-460 行：计算统计相关系数 rho > 0.6 的基金对，发出文字警告
- 代码检查的是**统计相关性**（两个基金的收益相关程度），而非 IPS 定义的**权重聚合**（高相关资产的合计权重占比）
- 这是两个完全不同的概念

#### 1.5 情绪熔断：完全依赖人类自律

**IPS 定义**（第 46-52 行）：出现"想回本"、"怕踏空"、"影响睡眠"任一情况时，默认暂停主动加仓。

**代码现状**：零代码实现。"情绪控制"仅在 `SCORING_RUBRIC.md` 中作为人工周度评分项（15 分），决策树中作为自我提问。无行为指标代理、无交易频率监控。

#### 1.6 buy_gate: "frozen" 是空壳

**asset_master.json** 第 102 行定义 TACTICAL 桶 `"buy_gate": "frozen"`。

**代码现状**：搜索整个代码库，`buy_gate` 仅在 `serve_funds_live_dashboard.mjs` 的渲染层被读取并展示为标签。**无任何交易代码检查此字段**。用户可以毫无阻碍地通过 `manual_trade_recorder` 记录 TACTICAL 桶的新买入。

---

### 二、asset_master.json 与 IPS 存在结构性目标漂移

#### 2.1 仓位桶映射不一致

| IPS 仓位桶 | IPS 目标区间 | asset_master 对应桶 | asset_master 目标 | 偏差分析 |
|-----------|-------------|-------------------|-----------------|---------|
| 现金/机动仓 | 20-30% | CASH | 34% (min:15%, max:45%) | config 偏高 4pp |
| 防守仓 | 15-25% | **无直接对应** | — | **IPS 有，config 缺失** |
| 核心仓 | 15-20% | A_CORE | 22% (min:10%, max:30%) | config 偏高 2-7pp |
| 港股参与仓 | 10-15% | **无直接对应** | — | **IPS 有，config 缺失** |
| 战术仓 | 5-10% | TACTICAL | 6% (min:0%, max:10%) | 基本一致 |
| 对冲仓 | 10-15% | HEDGE | 12% (min:10%, max:15%) | 基本一致 |

#### 2.2 港股独立管理规则被架构架空间接违反

**IPS 第六节明确要求**："港股仓必须单独管理，不与 A 股核心仓混为一类。"

**asset_master.json 实际做法**：
- 港股互联网/QDII → 归入 `TACTICAL`（与半导体同桶）
- 港股红利 → 归入 `INCOME`（与 A 股红利同桶）
- 无独立的港股参与仓桶

**后果**：IPS 第九节的"恒生科技及港股互联网合计不超过总资产 10-12%"这条规则在代码架构层面就失去了可执行的基础——你无法聚合一个不存在的桶。

#### 2.3 防守仓定义模糊

IPS 的防守仓代表"红利低波、银行、公用事业、A股央企红利"，但在 asset_master 中：
- A股红利低波 → `INCOME`
- 港股红利 → `INCOME`
- 银行/公用事业 → 未在 assets 列表中出现
- IPS 中防守仓 15-25% 的目标在 config 中没有独立的桶来承载

---

### 三、数据完整性链条存在多个断裂点

#### 3.1 交易记录入口零校验

**涉及文件**：`portfolio/scripts/lib/manual_trade_recorder.mjs`

**问题清单**：

| 问题 | 影响 | 严重程度 |
|------|------|:-------:|
| 不检查买入金额是否超过可用现金 | 可以凭空创造负现金持仓 | **严重** |
| 不检查卖出份额是否超过当前持仓 | 可以卖出不存在的份额 | **严重** |
| 不检查交易后是否违反 IPS 约束 | 任何违规交易都能被记录 | **严重** |
| 不区分数据来源可信度 | 口头报告与平台确认同等对待 | **中等** |
| 名称归一化丢失份额类别 | "X基金A"和"X基金C"可能合并 | **中等** |
| 无原子写入（直接 writeFile） | 进程崩溃时文件损坏 | **中等** |
| `chooseManualTransactionFilePath` 无上限循环 | 文件系统异常时死循环 | **低** |

**数据污染链路**：一个错误输入 → `transactions/` → `ledger/execution_ledger.json` → `portfolio_state.json` → `latest.json` → `risk_dashboard.json` → `daily_brief` → **全链路污染，无法追溯源头**。

#### 3.2 状态物化器无防护

**涉及文件**：`portfolio/scripts/lib/portfolio_state_materializer.mjs`

| 问题 | 详细说明 | 严重程度 |
|------|---------|:-------:|
| Ledger 无去重 | 同一交易被记录两次会被双重应用 | **严重** |
| OTC 仓位仅靠 name 匹配 | 名称变更或用户输入错误时仓位混淆 | **严重** |
| 交易所卖出用当次均价算剩余金额（line 604） | 非成本价，下次对账时金额跳跃 | **中等** |
| nextBusinessDay 不查节假日 | 清明节前买入在清明节当天被计入 PnL | **中等** |
| readJson 无 try/catch | JSON 格式错误时整个物化崩溃 | **低** |

#### 3.3 基金确认策略纯靠名称猜测

**涉及文件**：`portfolio/scripts/lib/fund_confirmation_policy.mjs`

| 问题 | 说明 |
|------|------|
| Profile 推断用正则 `/QDII\|美股\|海外\|纳斯达克\|标普/` | "新兴市场QDII"可能主要持A股，"商品"A股基金被误判为QDII |
| 未来日期默认为"已确认" | 数据错误导致日期在未来时被静默接受 |
| 无日期格式校验 | "2026/04/03" 和 "04-03-2026" 会通过但匹配失败 |
| 无"初步净值"概念 | 部分平台在最终确认前发布预估值，当前代码直接跳过 |

#### 3.4 净值对账容差硬编码

**涉及文件**：`portfolio/scripts/lib/confirmed_nav_reconciler.mjs`

- 0.5% 容差不可配置（line 162）：QDII 基金 T+2 延迟可能导致实时价与确认净值持续超过 0.5%，系统始终回退到隐含份额计算
- 8 位小数取整不可配置（line 302）
- PnL 计算有两条数学上不等价的路径（line 175 vs line 178），当净值数据缺失时静默切换

---

### 四、市场数据层鲁棒性不足

#### 4.1 数据获取无容错机制

**涉及文件**：`portfolio/scripts/lib/report_market_fetch_guard.mjs`

| 缺失能力 | 说明 |
|---------|------|
| 无重试逻辑 | 单次失败即放弃，无 exponential backoff |
| 无熔断器 | 连续 N 次失败不会暂停后续请求 |
| 无速率限制 | 并行请求可能触发上游 API 限流 |
| 静默失败 | 返回 `{ok: false}` 而非抛异常，调用方忘记检查则使用 undefined |
| CME 超时硬编码 | 12秒超时仅对 `HF_ES`/`HF_NQ` 生效，新增期货代码使用默认值 |

#### 4.2 数据质量评估过于表面

**涉及文件**：`portfolio/scripts/lib/research_data_quality.mjs`

| 问题 | 说明 |
|------|------|
| 无数值合理性检查 | 北向资金单日 ±1000 亿不会触发告警 |
| 不区分数据源重要性 | 缺标普 500 行情与缺一个小商品行情同等对待 |
| 新鲜度仅二值 | 只有"过期/没过期"，无"即将过期"预警 |
| 软降级词硬编码 | `["暂不做强解释", "回零", "降级", "仅供参考"]` 上游改措辞则失效 |
| 置信度阈值不可配置 | high: 0.75 / medium: 0.45 固定值 |

#### 4.3 节假日数据会过期

**涉及文件**：`portfolio/scripts/lib/market_schedule_guard.mjs`

- 港股和美股节假日仅硬编码 2025-2026 年
- 2027 年 1 月起，所有非周末日被当作交易日
- `findLatestTradingDateOnOrBefore` 有 10 次尝试上限，春节 7+ 天假期可能不够

---

### 五、风险仪表盘是后视镜而非刹车

**涉及文件**：`portfolio/scripts/generate_risk_dashboard.mjs`

| 局限 | 说明 |
|------|------|
| 仅静态快照 | 只在生成时计算一次，无持续监控 |
| 不触发自动动作 | 告警只是文字，不关联任何执行逻辑 |
| 无推送通道 | 无 webhook / 邮件 / IM 通知，用户必须主动打开文件 |
| 回撤告警口径错误 | 10% 阈值仅检查核心防守资产，非组合整体回撤 |
| 集中度告警过松 | 25% 阈值（已投资资本口径）远宽松于 IPS 的 8-10%（总资产口径） |

**后果**：一个 12% 回撤的紧急情况，用户可能在收盘后看日报时才发现，此时已经来不及执行 IPS 规定的"禁止继续扩大高波动主题仓"。

---

### 六、IPS 与实际持仓严重矛盾

**数据来源**：`portfolio/account_context.json`（2026-04-01 用户截图确认）

| 指标 | 实际值 | IPS 要求 | 偏差 |
|------|--------|---------|------|
| 总资产 | ~442,428 CNY | — | — |
| 现金 | ~19,400 CNY | 20-30% (88,486 - 132,728 CNY) | **严重不足** |
| 现金占比 | ~4.4% | min 15% | **违反底线 10.6pp** |
| 仓位占比 | ~95.6% | max 80% (权益) | **超标 15.6pp** |
| 累计亏损 | -26,314 CNY | — | 约 -5.95% |

**当前状态**：
- 现金 4.4% 严重违反 IPS 现金底线 15% 和 asset_master CASH 桶 min 15%
- 仓位 95.6% 远超 asset_master 的 `absolute_equity_cap: 0.75`
- 系统无任何代码阻止这一状态的产生，也无任何自动化"再平衡优先模式"被触发
- 虽然当前处于 IPS 第十四条描述的"重建账户骨架"阶段，但系统不具备跟踪和执行这一过渡状态的能力

---

## 七、问题整改意见

### 整改原则

1. **先堵漏洞，再建能力**——优先让 IPS 从"建议"变成"约束"
2. **配置驱动**——所有阈值从代码中提取到可配置文件
3. **最小侵入**——优先在关键入口点（交易记录、状态物化）添加校验，不大规模重构
4. **渐进增强**——P0 立即修复，P1 短期补齐，P2/P3 中长期演进

---

### P0 — 必须立即修复（阻断级）

#### P0-1：交易前置风控门

**目标**：每次交易前强制检查 IPS 核心约束，违反时拒绝记录。

**方案**：

新建 `portfolio/scripts/lib/trade_pre_flight_gate.mjs`，作为所有交易记录的必经入口：

```
功能：
1. 读取当前 portfolio_state.json 和 risk_dashboard.json
2. 计算交易后的模拟组合状态
3. 检查以下约束：
   a. 交易后现金不低于 CASH 桶 min（当前 15%）
   b. 交易后单基金占比不超过总资产的 10%
   c. 交易后单主题（按 bucket 聚合）不超过 asset_master max_pct
   d. 交易后权益占比不超过 absolute_equity_cap（当前 75%）
   e. 如 portfolio_state 中记录了回撤状态，检查 8%/12% 阈值
   f. 如 TACTICAL 桶 buy_gate 为 frozen，拒绝新增买入
4. 返回 { approved: boolean, violations: string[] }
5. 在 manual_trade_recorder.mjs 的 buildManualTradeTransactionContent 入口调用
```

**修改文件**：
- 新建 `scripts/lib/trade_pre_flight_gate.mjs`
- 修改 `scripts/lib/manual_trade_recorder.mjs`：在 trade content 构建后、写入前调用 gate
- 修改 `scripts/record_manual_fund_trades.mjs`：同上

**验收标准**：
- 尝试记录一笔使现金低于 15% 的买入 → 被拒绝，输出违反项
- 尝试对 TACTICAL 桶新增买入 → 被拒绝，输出 buy_gate 冻结
- 测试文件：`scripts/lib/trade_pre_flight_gate.test.mjs`

#### P0-2：IPS 与 asset_master 同步

**目标**：消除两套标准并存的不一致。

**方案**：

方案 A（推荐）：以 IPS 为准，调整 asset_master.json：
1. 将 IPS 六桶结构完整映射到 asset_master
2. 新增 `HK_EQUITY` 桶（港股参与仓），将港股互联网/QDII 和港股科技/QDII 从 TACTICAL 移出
3. 新增 `DEFENSIVE` 桶（防守仓），将港股红利从 INCOME 移出（或将 INCOME 重命名为更精确的标签）
4. 将 CASH 桶 target 从 34% 调整为 25%（IPS 中值）
5. 将 A_CORE 桶 target 从 22% 调整为 17.5%（IPS 中值）
6. 在 asset_master 中新增 IPS 主题级别约束字段

方案 B：以 asset_master 为准，更新 IPS 文档。（不推荐，因为 IPS 的六桶结构更清晰）

**修改文件**：
- `portfolio/config/asset_master.json`
- `portfolio/INVESTMENT_POLICY_STATEMENT.md`（对应调整措辞）
- 所有引用 bucket key 的脚本（generate_signals.py, trade_generator.py, generate_risk_dashboard.mjs, dual_trade_plan_render.mjs 等）

**验收标准**：
- IPS 每个仓位桶在 asset_master 中有且仅有一个对应桶
- IPS 目标区间与 asset_master target/min/max 一致（允许取中值）
- 港股独立管理规则有对应的代码架构支撑

#### P0-3：Ledger 去重

**目标**：防止同一笔交易被重复应用。

**方案**：

1. 在 `execution_ledger.json` 的每条记录中增加 `trade_id` 字段（基于日期+标的+方向+金额的确定性哈希）
2. 在 `portfolio_state_materializer.mjs` 的 ledger 遍历中增加 idempotent check
3. 提供清理工具：检测并标记 ledger 中的重复记录

**修改文件**：
- `scripts/lib/portfolio_state_materializer.mjs`
- `scripts/lib/manual_trade_recorder.mjs`（生成 trade_id）
- 新建 `scripts/deduplicate_ledger.mjs`

**验收标准**：
- 同一笔交易写入两次，materializer 只应用一次
- 测试文件：`scripts/lib/portfolio_state_materializer.test.mjs` 新增去重用例

---

### P1 — 短期应补（1-2 周内）

#### P1-1：节假日表外置化

**目标**：消除硬编码过期风险。

**方案**：
1. 新建 `portfolio/config/market_holidays.json`，按市场（CN/HK/US）分年存储
2. `market_schedule_guard.mjs` 改为从此文件读取
3. 提供更新脚本 `scripts/update_market_holidays.mjs`
4. 增加 2027-2028 年节假日数据

**修改文件**：
- 新建 `config/market_holidays.json`
- 修改 `scripts/lib/market_schedule_guard.mjs`
- 新建 `scripts/update_market_holidays.mjs`

#### P1-2：原子写入

**目标**：消除进程崩溃导致文件损坏的风险。

**方案**：
1. 新建 `scripts/lib/atomic_write.mjs`，实现 write-to-temp-then-rename 模式
2. 全局替换所有 `writeFile` 调用为 `atomicWrite`
3. 重点替换：`manual_trade_recorder.mjs`, `portfolio_state_materializer.mjs`, `confirmed_nav_reconciler.mjs`

**修改文件**：
- 新建 `scripts/lib/atomic_write.mjs`
- 修改所有使用 `writeFile` 写入 JSON 的库文件

#### P1-3：交易来源分级

**目标**：让审计链可追溯。

**方案**：
1. 在 ledger 和 transactions 的 schema 中增加 `source_confidence` 字段
2. 分级：`platform_screenshot` > `platform_api` > `user_oral_confirmed` > `user_oral_unconfirmed`
3. `portfolio_state_materializer.mjs` 根据来源置信度差异化处理
4. `risk_dashboard.json` 标注哪些持仓数据来源置信度较低

**修改文件**：
- `scripts/lib/manual_trade_recorder.mjs`
- `scripts/lib/portfolio_state_materializer.mjs`
- `scripts/generate_risk_dashboard.mjs`

#### P1-4：回撤状态跟踪

**目标**：让系统知道当前组合处于什么回撤阶段。

**方案**：
1. 在 `portfolio_state.json` 中增加 `drawdown_status` 字段：
   ```json
   {
     "drawdown_status": {
       "from_peak_pct": -5.95,
       "peak_date": "2026-03-XX",
       "peak_value_cny": 470742,
       "current_regime": "normal",       // normal / re_evaluate / hard_stop
       "re_evaluate_triggered": false,    // >= 8%
       "hard_stop_triggered": false       // >= 12%
     }
   }
   ```
2. 在 `portfolio_state_materializer.mjs` 中计算此字段
3. P0-1 的 trade_pre_flight_gate 读取此字段，hard_stop 时拒绝高波动买入

**修改文件**：
- `scripts/lib/portfolio_state_materializer.mjs`
- `scripts/lib/trade_pre_flight_gate.mjs`（P0-1 产出）

#### P1-5：名称匹配加固

**目标**：防止 OTC 仓位和基金确认的名称误匹配。

**方案**：
1. OTC 仓位匹配增加 `symbol`（基金代码）优先于 `name` 的逻辑
2. 名称归一化不再剥离尾部的份额类别标识（A/C/D/E/H）
3. fund_confirmation_policy.mjs 增加 category 字段的权威判断（优先用 asset_master 的 category）
4. fund_identity.mjs 的迁移表增加条目时需附带 unit test

**修改文件**：
- `scripts/lib/portfolio_state_materializer.mjs`
- `scripts/lib/confirmed_nav_reconciler.mjs`
- `scripts/lib/fund_confirmation_policy.mjs`
- `scripts/lib/manual_trade_recorder.mjs`

---

### P2 — 中期改进（1-2 月内）

#### P2-1：实时风控推送

**方案**：
1. 新建 `scripts/lib/notification_dispatcher.mjs`，支持 webhook 通道
2. risk_dashboard 生成后检查是否存在 critical 级别告警
3. 存在时推送通知，包含：告警内容、当前回撤、违反的 IPS 规则
4. 用户可配置 webhook URL 和告警阈值

#### P2-2：相关性加权聚合检查

**方案**：
1. 在 risk_dashboard 中实现 IPS 定义的"高相关仓位合计上限 25%"
2. 按相关性矩阵 rho > 0.6 的阈值识别高相关组
3. 聚合同组内所有基金的权重之和
4. 超过 25% 时在 trade_pre_flight_gate 中阻断新增买入

#### P2-3：再平衡优先模式状态机

**方案**：
1. 在 `portfolio_state.json` 中增加 `rebalance_mode` 字段：`normal` / `priority`
2. 触发条件：任一桶偏离 target 5pp+ 或突破 min/max
3. 进入 priority 模式后的行为：
   - trade_pre_flight_gate 仅允许补缺口桶的买入
   - daily_brief 显著标注"再平衡优先模式已激活"
   - 周度 scorecard 评估再平衡执行情况

#### P2-4：数据获取容错增强

**方案**：
1. 在 `report_market_fetch_guard.mjs` 中增加：
   - 可配置重试次数（默认 2 次）和指数退避
   - 连续失败 N 次后的熔断器（暂停该源 5 分钟）
   - 全局并发限制（最多 3 个并行请求）
2. 在 `research_data_quality.mjs` 中增加：
   - 数值合理性检查（如北向资金日变化 > ±500 亿标记为异常）
   - 数据源重要性分级（核心指数 > 板块指数 > 个股）
   - "即将过期"预警区间

---

### P3 — 长期演进（季度级）

#### P3-1：配置驱动 IPS

**目标**：把 IPS 的数值规则从 markdown 提取为可执行的 JSON schema。

**方案**：
1. 新建 `config/ips_constraints.json`：
   ```json
   {
     "drawdown": { "re_evaluate_pct": 8, "hard_stop_pct": 12 },
     "concentration": {
       "single_fund_max_pct": 10,
       "single_theme_max_pct": 15,
       "high_correlation_max_pct": 25
     },
     "cash_floor_pct": 15,
     "speculative_cap_pct": 15,
     "rebalance_trigger_deviation_pp": 5,
     "new_direction_initial_pct": { "min": 3, "max": 5 }
   }
   ```
2. `trade_pre_flight_gate`、`generate_risk_dashboard`、`generate_signals.py` 全部从此文件读取阈值
3. IPS markdown 文档改为引用此配置文件，消除"文档-代码"双轨
4. 配置变更时自动 diff 并记录变更日志

#### P3-2：情绪行为指标代理

**方案**：
1. 基于客观行为指标构建情绪代理，替代主观自评：
   - 单日交易次数异常（>3 次/天）
   - 连续多日净买入同一主题
   - 回撤期间加仓频率上升
   - 计划外交易占比
2. 行为指标阈值触发"冷静期"（如 24 小时内不记录新交易）
3. 冷静期可通过显式确认解除

#### P3-3：对账自动化

**方案**：
1. 支持 broker API 自动拉取持仓快照（替代截图）
2. 增加银行流水导入和自动匹配
3. 人工确认仅需处理 API 无法覆盖的异常情况
4. 对账差异自动生成 exception report

---

### 整改路线图

```
Week 1-2  P0-1 交易前置风控门         ← 阻断级
Week 1-2  P0-2 IPS 与 asset_master 同步 ← 架构级
Week 1-2  P0-3 Ledger 去重             ← 数据完整性
─────────────────────────────────────
Week 3-4  P1-1 节假日表外置化
Week 3-4  P1-2 原子写入
Week 3-4  P1-3 交易来源分级
Week 3-4  P1-4 回撤状态跟踪
Week 3-4  P1-5 名称匹配加固
─────────────────────────────────────
Month 2   P2-1 实时风控推送
Month 2   P2-2 相关性加权聚合
Month 2   P2-3 再平衡状态机
Month 2   P2-4 数据获取容错增强
─────────────────────────────────────
Quarter+  P3-1 配置驱动 IPS
Quarter+  P3-2 情绪行为代理
Quarter+  P3-3 对账自动化
```

---

## 附录：IPS 规则执行矩阵

（见上方第三节完整矩阵，此处不重复。关键结论：12 项规则中仅 1.5 项具备实际阻断能力。）

---

## 附录：文件级审计清单

### 已审计文件

| 文件 | 审计结果 | 关键问题数 |
|------|---------|:---------:|
| `scripts/lib/confirmed_nav_reconciler.mjs` | 数据完整性风险 | 6 |
| `scripts/lib/manual_trade_recorder.mjs` | **零校验入口** | 7 |
| `scripts/lib/portfolio_state_materializer.mjs` | 无防护枢纽 | 6 |
| `scripts/lib/live_dashboard_today_pnl.mjs` | PnL 计算风险 | 4 |
| `scripts/lib/report_quality_scorecard.mjs` | 表面验证 | 3 |
| `scripts/lib/research_data_quality.mjs` | 过度乐观评估 | 5 |
| `scripts/lib/report_market_fetch_guard.mjs` | 无容错机制 | 5 |
| `scripts/lib/fund_confirmation_policy.mjs` | 名称猜测逻辑 | 4 |

### 未审计但建议审计的文件

| 文件 | 审计优先级 | 原因 |
|------|:---------:|------|
| `scripts/generate_signals.py` | P1 | 信号层是最强的执行层，需确认压缩逻辑正确性 |
| `scripts/trade_generator.py` | P1 | 交易计划生成，需确认 velocity 和 cash tracker |
| `scripts/generate_risk_dashboard.mjs` | P1 | 风险报告核心，需确认告警阈值与 IPS 对齐 |
| `scripts/lib/speculative_engine.mjs` | P2 | 已审计确认 15% 预算逻辑正确 |
| `scripts/lib/dual_trade_plan_render.mjs` | P2 | 双轨计划渲染，需确认冲突处理规则 |
| `scripts/backtest_engine.py` | P2 | 回测引擎，需确认回测假设合理性 |
| `market-mcp/src/providers/stock.js` | P2 | 数据源层，需确认多源容错 |
| `market-mcp/src/providers/fund.js` | P2 | 数据源层，需确认三源合并逻辑 |

---

*本报告基于 2026-04-03 的代码快照。系统处于活跃开发中，部分问题可能在后续迭代中已被修复。建议每季度进行一次架构审计。*
