# 组合管理系统 — 架构深度分析报告

> 分析日期：2026-04-06
> 分析视角：机构级金融分析师
> 分析范围：portfolio/ 全部代码、配置、数据管线、风控体系

---

## 一、系统现状概览

本系统是一个**个人投资组合管理与风险分析平台**，追踪中国公募基金持仓（OTC）及部分交易所证券（Exchange），生成风险仪表板、市场简报、业绩归因、量化指标等投研产出。

### 技术栈

| 层级 | 技术选型 |
|------|----------|
| 数据存储 | SQLite (market_lake.db) + JSON 文件体系 |
| 量化计算 | Python (pandas, numpy, ta, akshare, yfinance) |
| 报告/管线/仪表板 | Node.js 18+ (零外部依赖，仅用 built-ins) |
| 状态管理 | 双账本架构：raw snapshot + execution ledger → materialized state |
| 测试 | Node.js built-in test runner, 57 个测试文件 |

### 数据流全景

```
┌─────────────────────────────────────────────────────────┐
│  DATA INGESTION (Python)                                │
│  AkShare / yfinance → market_lake.db (SQLite)           │
│  generate_cn_market_snapshot.py → cn_market_snapshots/  │
├─────────────────────────────────────────────────────────┤
│  SIGNAL GENERATION (Python)                             │
│  fund_signals_matrix / quant_metrics / macro_radar      │
│  correlation_matrix / index_valuation / regime_signals  │
├─────────────────────────────────────────────────────────┤
│  RESEARCH BRAIN (JavaScript)                            │
│  覆盖度守卫 → 数据质量 → 事件驱动 → 宏观雷达            │
│  → 决策就绪 → 可执行决策 → research_brain.json           │
├─────────────────────────────────────────────────────────┤
│  TRADE PLANNING (JavaScript)                            │
│  opportunity_pool → speculative_plan → next_trade_plan  │
├─────────────────────────────────────────────────────────┤
│  STATE MANAGEMENT (JavaScript)                          │
│  transaction → execution_ledger → portfolio_state.json  │
│  confirmed_nav_reconciler → nightly reconciliation      │
├─────────────────────────────────────────────────────────┤
│  OUTPUT LAYER                                           │
│  risk_dashboard / daily_brief / market_brief / pulse    │
│  live_dashboard (HTTP :8766/:8767) / Chrome plugin     │
└─────────────────────────────────────────────────────────┘
```

---

## 二、致命级缺陷 (P0 — 必须立即修复)

### 2.1 风险阻断形同虚设 — "只报告，不执行"

**涉及文件**: `portfolio_risk_state.mjs:456`, `generate_risk_dashboard.mjs`

`buildBlockingState()` 在检测到回撤触及硬止损线（12%）或结构违规时，仅生成 `reasons[]` 数组写入 `risk_dashboard.json`。但：

- **无推送告警**：没有 webhook、邮件、系统通知、短信
- **无交易熔断**：`record_manual_fund_trades.mjs` 的执行许可门虽然读取了 `research_brain.json` 的 `trade_permission`，但风控仪表板的 `blocking_state` 并未被纳入交易前检查的强制读取链
- **无自动化响应**：硬止损触发后，系统不会自动生成减仓指令或锁定交易

> **金融分析师视角**：这相当于风控系统只亮红灯但不断电。在真实的市场极端行情中（如 2015 年去杠杆、2020 年 3 月流动性危机），几分钟的延迟意味着数百万的回撤。机构的硬止损是**自动化执行**的，而非仅生成一份 JSON 报告。

**修复优先级**: 立即。建议在 `execution_permission_gate.mjs` 中增加对 `risk_dashboard.json` 中 `blocking_state` 的强制校验，同时在 `record_manual_fund_trades.mjs` 中增加熔断写入。

---

### 2.2 Python ↔ JavaScript 跨语言合约无运行时校验

**涉及文件**: `validate_python_output.mjs:228`

`validate_python_output.mjs` 已实现三种 Python 输出的 Schema 校验，但：

- **零生产消费者**：没有任何 JS 脚本在实际读取 Python 输出时调用此校验器
- **无版本锁定**：`_meta.schema_version` 是可选的（`checkMeta` 允许缺失），意味着 Python 脚本可以自由修改输出结构而不被检测
- **仅浅层校验**：只检查顶层字段存在性，不校验嵌套对象结构

> **金融分析师视角**：量化指标（波动率、相关性、风险贡献）是整个风控体系的输入基础。如果 `calculate_quant_metrics.py` 修改了 `marginal_risk_contribution` 的字段名或结构，下游的 `generate_risk_dashboard.mjs` 会静默地使用 `undefined`，导致**风控指标为零**而无人知晓。

**修复优先级**: 立即。在 `generate_risk_dashboard.mjs`、`generate_performance_attribution.mjs`、`generate_daily_brief.mjs` 中集成校验，校验失败时阻断管线并告警。

---

### 2.3 确认净值对账失败无传播机制

**涉及文件**: `confirmed_nav_reconciler.mjs:396`, `run_nightly_confirmed_nav.mjs`

夜间 NAV 对账是**组合盈亏计算的唯一可靠来源**（而非盘中估值）。但：

- 对账失败（`late_missing` / `source_missing`）仅标记在 `nightly_confirmed_nav_status.json` 中
- `serve_funds_live_dashboard.mjs` 使用 `fund_confirmation_policy.mjs` 的分类结果来决定显示"确认净值"还是"估值"，但对账失败时**无告警推送**
- 如果对账流程在凌晨崩溃（Python venv 异常、AkShare API 不可用），次日开盘前无人知晓

> **金融分析师视角**：净值确认是 OTC 基金会计的基石。如果某个基金的确认净值缺失，当天的持仓盈亏将基于估值而非实际净值计算，导致**已实现/未实现利润分类错误**，直接影响：
> - 税务计算（赎回时的持有期判定）
> - 绩效归因（Brinson 分解的 selection effect）
> - 风险监控（回撤计算基于错误数据）

**修复优先级**: 本周内。增加对账失败告警（写入 manifest 并在次日首次 session 启动时检查），同时将 `coercePersistedTodayPnl` 中将无效值替换为 0 的逻辑改为 `null`（当前是 `coercePersistedTodayPnl` 返回 0 而非 null，这会**掩盖**数据质量问题）。

---

## 三、严重级缺陷 (P1 — 本迭代内修复)

### 3.1 八套 `normalizeName` 实现不一致

**涉及文件**:
- `portfolio_state_materializer.mjs` (variant A)
- `portfolio_risk_state.mjs` (variant B)
- `manual_trade_recorder.mjs` (variant C)
- `fund_identity.mjs` (variant D — canonical)
- `calculate_quant_metrics.py` (variant E)
- `generate_fund_signals_matrix.py` (variant F)
- `generate_risk_dashboard.mjs` (variant G)
- `confirmed_nav_reconciler.mjs` (variant H)

每个变体的清洗规则不同：
- 有的移除 "ETF发起" 前缀，有的不移除
- 有的做 `toLowerCase()`，有的保留原始大小写
- 有的处理括号 `()`，有的不处理

**后果**：同一个基金在不同模块中被识别为不同资产 → 持仓匹配失败 → 风险计算漏算 → 集中度检查失效。

> **金融分析师视角**：基金名称标准化是整个系统的"身份证系统"。如果同一个基金在不同模块中映射到不同的 identity，后果是：
> - 交易录入时匹配到错误的目标
> - 对账时无法找到对应确认净值
> - 风控仪表板低估实际集中度
> - 这是**数据层面的系统性风险**，远比代码 bug 更难发现和修复

**修复方案**: 以 `fund_identity.mjs` 为唯一权威来源（Single Source of Truth），其他所有模块必须通过 `applyCanonicalFundIdentity()` 进行标准化。删除所有本地 `normalizeName` 实现。

---

### 3.2 核心状态引擎过于庞大 — 可维护性危机

**涉及文件**: `portfolio_state_materializer.mjs` — 1511 行 / 53KB

该文件承担了以下全部职责：
1. 目录引导与文件初始化
2. JSON 解析与校验
3. 同日交易反向剥离（avoid double counting）
4. 执行账本叠加（buy/sell/conversion）
5. 待确认买入跟踪
6. 持仓分类推断（`inferCategoryFromName` — 40 行硬编码）
7. 暴露汇总与现金分类账
8. 绩效快照计算
9. 兼容视图生成
10. 账本条目创建与追加

**问题**：
- 单文件 1500+ 行意味着任何修改都有意外副作用的风险
- 没有清晰的内部模块边界，测试只能做集成测试而无法做单元测试
- 10 个不同消费者依赖此文件的不同导出，任何重构都可能产生连锁反应

**修复方案**: 拆分为 5 个独立模块：
- `materializer_bootstrap.mjs` — 文件初始化与引导
- `materializer_position_matcher.mjs` — 持仓匹配与标准化
- `materializer_ledger_applicator.mjs` — 账本叠加逻辑
- `materializer_aggregator.mjs` — 汇总与分类账
- `materializer_orchestrator.mjs` — 端到端编排（对外暴露相同 API）

---

### 3.3 压力测试场景硬编码且不全面

**涉及文件**: `generate_risk_dashboard.mjs`

当前仅 3 个硬编码场景：

| 场景 | A_CORE | GLB_MOM | TACTICAL | HEDGE |
|------|--------|---------|----------|-------|
| 离岸成长降级 | -6% | -14% | -18% | +4% |
| 油价冲击滞胀 | -5% | -12% | -15% | -4% |
| 国内增长恐慌 | -8% | -6% | -9% | +2% |

**缺失的关键场景**：
- 美联储加息 100bp（对 QDII 美股基金影响巨大）
- 人民币单日大幅贬值 2%+（影响港股通和 QDII）
- 北向资金单日净流出超 200 亿（A股市场微观结构冲击）
- 中美关系急剧恶化（科技禁令升级 → 半导体/港股科技）
- 流动性危机（同业拆借利率飙升 → 债券基金赎回潮）
- 尾盘集中抛售（ETF 折价风险）

> **金融分析师视角**：3 个场景远远不够覆盖一个涉及 A 股、港股、美股、商品、QDII 的多元化组合的真实风险暴露。更关键的是，**冲击幅度是硬编码的**，不随市场状态动态调整。一个平静市场中 -18% 的战术性冲击测试，和 VIX 飙升到 50 时的同一测试，传达的信息完全不同。

**修复方案**: 将压力场景配置化（`config/stress_scenarios.json`），增加至 8-12 个场景，并引入条件触发（仅在特定市场状态下激活特定场景）。

---

### 3.4 无数据库迁移策略

**涉及文件**: `data/market_lake.db` (SQLite)

- 无 schema 版本管理
- 无迁移脚本
- `core_data_ingestion.py` 直接 `CREATE TABLE IF NOT EXISTS`
- 如果未来需要增加字段（如调整后收盘价 factor）、新建索引、或修改表结构，没有安全的变更路径

> **金融分析师视角**：市场数据库是量化计算的根基。如果 `daily_prices` 表结构被意外修改，所有 Python 量化脚本可能产出错误结果。在机构中，数据库 Schema 变更是需要严格审批和回滚机制的。

---

## 四、中等级缺陷 (P2 — 近期迭代修复)

### 4.1 辅助函数重复 — 技术债累积

| 函数名 | 重复出现位置 |
|--------|-------------|
| `normalizeName` | 8 个文件（详见 3.1） |
| `toFiniteNumber` | 4 个文件 |
| `compareDateStrings` | 4 个文件 |
| `toPositiveAmount` | 3 个文件 |
| `clone` / `JSON.parse(JSON.stringify())` | 3 个文件 |
| `roundOrNull` | 与 `round` 完全相同，存在于 2 个文件 |
| Telegraph 评分逻辑 | `generate_market_brief.mjs` + `generate_market_pulse.mjs` |
| `buildResearchGuardLines` | `generate_market_brief.mjs` + `generate_market_pulse.mjs` |

每次重复都意味着：
- 修复一个 bug 需要找到所有副本
- 各副本可能已产生分化（如 `normalizeName` 的 8 个变体）
- 测试覆盖不均匀

---

### 4.2 交易日志恢复机制未启用

**涉及文件**: `transaction_journal.mjs`

`recoverJournal()` 已实现但：
- **零调用者**：没有任何启动流程或健康检查调用此函数
- 无日志轮转：`.journal.jsonl` 会无限增长
- 事务 rollback 仅记录日志，不实际回滚已写入的文件

> 这意味着如果 `record_manual_fund_trades.mjs` 在写入交易文件后、更新 manifest 之前崩溃，系统将处于不一致状态且**永远无法自动恢复**。

---

### 4.3 跨仓库依赖 — 脆弱的耦合

**涉及文件**: `funds_plugin_payload.mjs`

```javascript
import { getFundWatchlistQuotes } from "../../../market-mcp/src/providers/fund.js";
```

- 相对路径跨越 3 层目录进入另一个项目
- `market-mcp` 的任何重构都会直接破坏此导入
- 无接口契约或版本锁定

类似问题也存在于报告脚本中对 `market-mcp` 的依赖（`getStockQuote`, `getHotBoards`, `getMarketTelegraph` 等）。

---

### 4.4 硬编码的绝对路径

| 文件 | 硬编码内容 |
|------|-----------|
| 所有 Python 脚本 | `VENV_PYTHON = Path("/Users/yinshiwei/codex/tz/.venv-akshare/bin/python3")` |
| `account_root.py` / `.mjs` | `WORKSPACE_ROOT = /Users/yinshiwei/codex/tz` |
| `serve_exchange_live_dashboard.mjs` | 账户标签映射 `"main"` → `"主账户"` |

系统**无法在另一台机器上运行**，也无法通过 CI/CD 流水线测试。

---

### 4.5 可变状态滥用

**涉及文件**: `portfolio_state_materializer.mjs`, `confirmed_nav_reconciler.mjs`

核心引擎大量使用原地突变（in-place mutation）：
- `Object.assign(position, canonicalPosition)` 直接修改输入对象
- `applyBuy` / `applySell` 修改传入的 position 对象
- 在单线程 Node.js 中暂时安全，但使数据流追踪困难
- 如果未来引入缓存或共享引用，将产生难以调试的 bug

---

## 五、长期架构风险 (P3 — 持续关注)

### 5.1 文件系统作为唯一持久层 — 可扩展性天花板

整个系统基于 JSON 文件 + SQLite：

- **并发安全**：多进程同时写入同一 JSON 文件时存在竞态条件（虽然 `writeJsonAtomic` 通过 temp+rename 缓解了部分问题，但跨文件的原子性无法保证）
- **查询能力**：无法对历史状态进行高效查询（如"过去 30 天的回撤变化趋势"）
- **备份策略**：JSON 文件的增量备份需要自行实现
- **存储效率**：`research_brain.json` 已达 217KB，且每天生成新快照

> **金融分析师视角**：对于个人组合管理，文件系统足够了。但如果未来需要：
> - 多账户并发操作
> - 历史回测与绩效分析
> - 审计追踪
> - 与券商 API 集成
>
> 文件系统将成为瓶颈。建议中期考虑将核心状态（portfolio_state, execution_ledger）迁移到 SQLite，与 market_lake.db 统一。

---

### 5.2 无 CI/CD 与自动化质量门

- 无 `package.json`：没有脚本入口、依赖声明、测试命令
- 无 GitHub Actions 或任何 CI 配置
- 测试（57 个）需要手动运行 `node --test`
- 无代码覆盖率统计
- 无 linting 配置

---

### 5.3 报告模板硬编码 — 扩展成本高

所有报告（daily_brief, market_brief, market_pulse）的格式、章节顺序、评分逻辑均硬编码在脚本中：

- 添加一个新的报告章节需要修改多个 500+ 行的脚本
- 模板文件（`templates/`）存在但与实际生成逻辑分离
- 无法在不修改代码的情况下调整报告结构

---

### 5.4 Research Brain 复杂度过高

Research Brain 子系统包含 **14 个独立模块**：

```
research_brain_render → research_coverage_guard → research_data_quality
→ research_event_driver → research_freshness_guard → research_flow_macro_radar
→ research_market_snapshot → research_session → research_snapshot_builder
→ research_actionable_decision → research_decision_readiness
→ research_story_filter + dialogue_analysis_contract
```

这是一个"上帝对象"的分布式版本。每个模块都有清晰的职责，但：
- 模块间的依赖关系不透明
- `generate_research_brain.mjs` 需要协调 14 个模块的调用顺序
- 任何一个模块的输出格式变化都可能级联影响其他模块

---

## 六、风控体系专项评估

### 6.1 IPS 约束检查覆盖度

| 约束项 | 配置存在 | 运行时检查 | 交易前门控 | 阻断执行 |
|--------|---------|-----------|-----------|---------|
| 最大回撤 (8%/12%) | `ips_constraints.json` | `portfolio_risk_state.mjs` | 部分（通过 research_brain） | 仅 JSON 标记 |
| 单基金上限 (10%) | `ips_constraints.json` | `portfolio_risk_state.mjs` | `trade_pre_flight_gate.mjs` | 是 |
| 单主题上限 (15%) | `ips_constraints.json` | `portfolio_risk_state.mjs` | `trade_pre_flight_gate.mjs` | 是 |
| 高相关性上限 (25%) | `ips_constraints.json` | `portfolio_risk_state.mjs` | 未直接检查 | 仅 JSON 标记 |
| 现金下限 (15%) | `ips_constraints.json` | `portfolio_risk_state.mjs` | `trade_pre_flight_gate.mjs` | 是 |
| 投机上限 (15%) | `asset_master.json` | `speculative_engine.mjs` | 未门控 | 否 |
| 相关性共振 (0.6) | 硬编码 | `generate_risk_dashboard.mjs` | 未门控 | 否 |

**关键缺口**：
1. **高相关性组合**和**相关性共振**仅在报告中标记，不在交易前检查
2. **投机仓位上限**由 `speculative_engine.mjs` 自查，但不被 `execution_permission_gate.mjs` 强制执行
3. **最大回撤**的"硬止损"没有直接阻断交易的能力

---

### 6.2 估值警告机制

- 5 年估值百分位 > 85% 时触发估值警告
- 但警告**不影响交易执行**
- 无估值相关的仓位上限或减仓触发

> **金融分析师视角**：在 2021 年初的核心资产泡沫中，如果系统只有"警告"而没有自动限制追高仓位，行为金融学的 FOMO 效应会使警告无效。建议在估值百分位 > 90% 时，对相关 bucket 的买入增加额外摩擦（如要求二次确认或降低单次买入上限）。

---

## 七、数据质量与可靠性

### 7.1 数据源容错能力评估

| 数据源 | 容错机制 | 降级策略 | 数据质量标记 |
|--------|---------|---------|-------------|
| AkShare (A股) | try/except per section | stub snapshot | `status: "partial"` / `"dependency_missing"` |
| market_lake.db | 无校验 | 无 | 无 |
| 确认净值 | 每基金分类 | 使用估值替代 | `confirmed` / `late_missing` / `source_missing` |
| 实时行情 (MCP) | 超时 5s/6s | 静默失败 | 无 |
| Python 输出 | Schema 定义但未使用 | 无 | 无 |

**最大风险**：实时行情的静默失败。`funds_plugin_payload.mjs` 在行情获取失败时返回空数组 `{ items: [] }`，这意味着仪表板将显示**零持仓**而不显示错误。

---

### 7.2 时间处理不一致

系统涉及多个市场的交易日历：
- A 股：`trading_calendar.mjs` + `holiday.json`
- 港股：硬编码假期
- 美股：硬编码假期
- 基金确认：`fund_confirmation_policy.mjs` 的 `inferConfirmationProfile` 基于名称关键字推断

各市场的假期更新需要手动维护。如果某年新增了临时休市日（如台风、公共卫生事件），系统不会自动感知。

---

## 八、综合评价与改进路线图

### 系统优势

1. **双账本架构设计合理**：raw + ledger → materialized view 的分离，确保了状态的可追溯性和可重建性
2. **零外部 JS 依赖**：降低了供应链攻击风险和版本冲突
3. **测试覆盖面广**：57 个测试文件覆盖了几乎所有 lib 模块
4. **Research Brain 分层设计**：coverage → quality → event → decision 的递进式决策链路，概念清晰
5. **IPS 约束配置化**：`ips_constraints.json` 作为 SSOT，修改约束无需改代码
6. **原子写入机制**：`writeJsonAtomic` 的 temp+rename 模式有效防止了写中断导致的数据损坏

### 系统成熟度评分

| 维度 | 评分 (1-10) | 说明 |
|------|------------|------|
| 功能完整性 | 8 | 覆盖了投研-交易-风控-报告的完整链路 |
| 数据可靠性 | 5 | Python 输出无校验，对账失败无传播，行情静默失败 |
| 风控执行力 | 4 | 检查完善但阻断能力不足，关键约束仅标记不执行 |
| 代码可维护性 | 5 | 核心模块过大，辅助函数大量重复，跨仓库耦合 |
| 可扩展性 | 4 | 硬编码路径，文件系统天花板，模板与逻辑耦合 |
| 测试充分性 | 7 | 模块级测试覆盖好，但缺少集成测试和端到端测试 |
| 运维成熟度 | 3 | 无 CI/CD，无监控告警，无自动恢复 |

### 分阶段改进路线图

#### Phase 0 — 紧急修复（1 周）
- [ ] **P0-1**: 风控阻断机制接入交易前门控
- [ ] **P0-2**: Python 输出校验器集成到 3 个关键消费者
- [ ] **P0-3**: 确认净值对账失败告警机制

#### Phase 1 — 消除重复与不一致（2 周）
- [ ] **P1-1**: 统一 `normalizeName` 为 `fund_identity.mjs` 单一实现
- [ ] **P1-2**: 提取共享辅助函数（`toFiniteNumber`, `compareDateStrings` 等）到 `format_utils.mjs` 或新建 `shared_helpers.mjs`
- [ ] **P1-3**: 消除 `telegraph scoring` 和 `buildResearchGuardLines` 的重复

#### Phase 2 — 核心模块重构（3 周）
- [ ] **P2-1**: 拆分 `portfolio_state_materializer.mjs` 为 5 个子模块
- [ ] **P2-2**: 压力场景配置化并扩展至 8-12 个
- [ ] **P2-3**: `validate_python_output.mjs` 增加深层嵌套校验
- [ ] **P2-4**: 交易日志恢复机制接入启动流程

#### Phase 3 — 基础设施增强（4 周）
- [ ] **P3-1**: 创建 `package.json`，标准化脚本入口和测试命令
- [ ] **P3-2**: 消除绝对路径硬编码（环境变量或相对路径）
- [ ] **P3-3**: 跨仓库依赖改为独立 npm 包或 workspace 引用
- [ ] **P3-4**: SQLite schema 版本管理与迁移框架
- [ ] **P3-5**: CI/CD 流水线（GitHub Actions：lint + test + validate）

#### Phase 4 — 风控体系升级（持续）
- [ ] **P4-1**: 高相关性和相关性共振接入交易前门控
- [ ] **P4-2**: 估值百分位 > 90% 时的买入摩擦机制
- [ ] **P4-3**: 硬止损触发时的自动减仓指令生成
- [ ] **P4-4**: 实时行情失败时的显式错误展示（替代静默返回空数据）

---

## 九、结论

本系统在**投研覆盖广度**和**架构设计理念**上达到了较高水平 — 双账本分离、递进式决策链路、IPS 约束配置化等设计体现了对机构级组合管理的深刻理解。

然而，系统在**执行层面的可靠性**上存在显著落差。最核心的问题是：**检查做了很多，执行很少**。风控约束、数据质量校验、对账失败处理，这些关键环节都停留在"检测并报告"阶段，而没有形成"检测 → 阻断 → 告警 → 恢复"的闭环。

对于一个管理真实资金的系统而言，**知道风险存在和阻止风险发生是两件完全不同的事情**。当前系统的风险不在于"不够聪明"，而在于"不够坚决"。

建议按照 Phase 0 → Phase 4 的路线图逐步推进，优先修复 P0 级别的风控执行缺口，然后消除数据不一致性，最后进行架构层面的重构升级。

---

*本报告基于 2026-04-06 的代码库快照分析生成。所有文件路径和行号基于该时间点的代码状态。*
