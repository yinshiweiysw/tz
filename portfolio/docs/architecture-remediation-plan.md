# 投资操作系统架构缺陷修复计划

> 生成日期: 2026-04-06
> 范围: `/Users/yinshiwei/codex/tz/portfolio/`
> 状态: 待执行

## Context

对 `/Users/yinshiwei/codex/tz/portfolio/` 投资管理系统进行了全面架构审计，发现 15 项缺陷（4 项致命、4 项严重、4 项中等、3 项长期）。当前系统处于部分降级状态（`portfolio_state.json` 和 `latest.json` 缺失，`ledger/` 目录未创建，夜盘 NAV 自修复失败）。本计划将问题整理为 5 个阶段、18 个独立可执行任务，每个任务可由 AI Agent 独立完成。

---

## Phase 1: 止血（P0 致命修复）

> 修复可能导致错误交易决策或系统崩溃的问题。任务 1.1-1.4 可并行执行，1.5 依赖 1.4。

### Task 1.1: 统一回撤限制配置

**问题**: `ips_constraints.json` hard_stop = 12%（执行阻断用），`asset_master.json` max_drawdown_limit = 15%（仪表盘显示用）。`trade_pre_flight_gate.mjs:241-243` 用 `hardStopPct ?? assetMaster.max_drawdown_limit`，但 hardStopPct 永远非 null（默认 0.12），所以 0.15 是死代码。仪表盘显示"限制 15%"但实际 12% 就阻断。

**修改文件**:

| 文件 | 操作 |
|------|------|
| `portfolio/config/asset_master.json` | 删除 `global_constraints.max_drawdown_limit`，仅保留 `absolute_equity_cap` |
| `portfolio/scripts/lib/trade_pre_flight_gate.mjs` | L241-243：移除对 assetMaster 的 fallback，仅用 `ipsConstraints.drawdown.hardStopPct` |
| `portfolio/scripts/serve_funds_live_dashboard.mjs` | L1728：改为读取 `ips_constraints.json` 或从 riskState.max_drawdown_limit_pct 获取 |
| `portfolio/scripts/lib/portfolio_risk_state.mjs` | 确认 drawdownLimit 来源一致 |
| 对应 test 文件 | 更新断言中引用 0.15 的地方 |

**验证**: `node --test portfolio/scripts/lib/trade_pre_flight_gate.test.mjs portfolio/scripts/lib/portfolio_risk_state.test.mjs` 全部通过；grep 确认无残留 `max_drawdown_limit` 引用。

---

### Task 1.2: 节假日数据外置化 + 2027 扩容

**问题**: 港股/美股节假日在 `market_schedule_guard.mjs:7-70` 硬编码，仅覆盖 2025-2026。2027 年起所有日期被误判为交易日，影响基金确认策略、NAV 对账、市场脉冲。

**修改文件**:

| 文件 | 操作 |
|------|------|
| `portfolio/config/holidays_hk_us.json` | **新建**：从硬编码迁移到此文件，结构 `{ "HK": { "2025": [...], "2026": [...], "2027": [...] }, "US": { ... } }` |
| `portfolio/scripts/lib/market_schedule_guard.mjs` | 删除 L7-70 硬编码常量，改为 `readJsonOrDefault` 加载 JSON 文件；添加查询年份超出范围时 `console.warn` |
| `funds/holiday.json` | 添加 2027 年 A 股节假日数据 |
| `portfolio/scripts/lib/market_schedule_guard.test.mjs` | 添加：2027 年日期测试、超出范围年份警告测试 |

**验证**: `node --test portfolio/scripts/lib/market_schedule_guard.test.mjs` 全部通过；`isTradingDateForMarket({market:'HK', date:'2027-01-01'})` 返回 false；查询 2030 年日期时 emit warn。

---

### Task 1.3: 统一 normalizeName 实现

**问题**: 8 个不同的 `normalizeName` 函数，行为不一致。最严重的是 `trade_pre_flight_gate.mjs` 只做 `.trim().toLowerCase()`，而 `portfolio_risk_state.mjs` 做完整的中国基金名清洗。导致同一基金在不同模块中归一化结果不同。

**涉及文件**（8 个本地实现）:

| 文件 | 当前行为 | 改为 |
|------|---------|------|
| `portfolio/scripts/lib/trade_pre_flight_gate.mjs` | `.trim().toLowerCase()` | import `normalizeFundNameSimple` |
| `portfolio/scripts/lib/portfolio_risk_state.mjs` | 完整中国基金名清洗 | import `normalizeFundName` |
| `portfolio/scripts/lib/manual_trade_recorder.mjs` | 与 fund_identity 相同逻辑 | import `normalizeFundName` |
| `portfolio/scripts/lib/speculative_engine.mjs` | 中等清洗（无 toLowerCase 后缀） | import `normalizeFundName` |
| `portfolio/scripts/generate_risk_dashboard.mjs` | 与 risk_state 相同 | import `normalizeFundName` |
| `portfolio/scripts/generate_speculative_plan.mjs` | 与 speculative_engine 相同 | import `normalizeFundName` |
| `portfolio/scripts/create_trade_card.mjs` | 与 speculative_engine 相同 | import `normalizeFundName` |
| `portfolio/scripts/serve_funds_live_dashboard.mjs` | 已委托给 `normalizeFundName` | 直接 import `normalizeFundName` |

**规范定义**（修改 `portfolio/scripts/lib/fund_identity.mjs`）:
- `normalizeFundName(name)` — 现有完整实现（去 QDII/ETF/联接/等后缀，toLowerCase）
- `normalizeFundNameSimple(name)` — **新增**，仅 `.trim().toLowerCase()`

**验证**: `grep -r "function normalizeName" portfolio/scripts/` 仅返回 `fund_identity.mjs`；全部 57 个测试通过。

---

### Task 1.4: 恢复缺失的状态文件

**问题**: 系统处于降级状态。`portfolio_state.json`、`latest.json`、`latest_raw.json` 仅存在 `.bak` 副本。`ledger/` 目录从未创建。`nightly_confirmed_nav_status.json` 显示自修复失败 (ENOENT)。

**操作**:

| 操作 | 详情 |
|------|------|
| 恢复 `portfolio/state/portfolio_state.json` | 从 `.bak-20260403-bond-fix` 复制，验证 JSON 有效性 |
| 恢复 `portfolio/snapshots/latest_raw.json` | 从 `.bak-20260403-bond-fix` 复制 |
| 恢复 `portfolio/latest.json` | 从 `.bak-20260403-bond-fix` 复制 |
| 创建 `portfolio/ledger/` 目录 | `mkdir -p` |
| 创建 `portfolio/ledger/execution_ledger.json` | 初始内容 `{"version":1,"entries":[]}` |

**验证**: `loadCanonicalPortfolioState()` 不再抛错；`listDiscoveredPortfolioAccounts()` 返回 main 账户。

---

### Task 1.5: 添加跨文件事务安全网

**问题**: 交易记录依次写入 transactions/ → ledger/ → state/ → risk_dashboard/，进程崩溃导致状态不一致。现有 `atomic_json_state.mjs` 仅提供单文件原子性。

**新建文件**: `portfolio/scripts/lib/transaction_journal.mjs`

**设计**:
- 轻量级 Write-Ahead Intent Log，写入 `portfolio/transactions/.journal.jsonl`
- 每条记录: `{id, timestamp, phase: "intent"|"committed", operations: [{path, action}]}`
- 写入前先记 intent，全部完成后记 committed，失败记 rolled_back
- 提供 `recoverJournal()` 函数，检测未提交的 intent 并报告（不自动回滚）
- JSONL 格式，append-only，天然崩溃安全

**修改文件**:

| 文件 | 操作 |
|------|------|
| `portfolio/scripts/lib/manual_trade_recorder.mjs` | 多文件写入包裹在 transaction_journal 中 |
| `portfolio/scripts/lib/portfolio_state_materializer.mjs` | 状态物化写入包裹在 transaction_journal 中 |

**验证**: 新建 `transaction_journal.test.mjs`；模拟崩溃场景验证恢复检测。

**依赖**: Task 1.4

---

## Phase 2: 夯实基础（技术债务清理）

> 所有任务可并行执行。

### Task 2.1: 提取共享工具函数

**问题**: `round()` 在 21 个文件中重复定义。`portfolio_state_materializer.mjs:22` 已 export round 但无人 import。`research_data_quality.mjs` 的 round 对 non-finite 返回 null 而非 0。

**新建文件**: `portfolio/scripts/lib/format_utils.mjs`

```js
export function round(value, digits = 2) { ... }       // 20 个文件统一用这个
export function roundOrNull(value, digits = 2) { ... }  // research_data_quality 用这个
```

**修改文件**: 21 个包含本地 `round()` 定义的文件 → 删除本地定义，改为 import。`portfolio_state_materializer.mjs` 改为 re-export。

**验证**: `grep "function round" portfolio/scripts/` 零结果（排除 test 文件）；全部 57 测试通过。

---

### Task 2.2: 消除硬编码工作区路径

**问题**: `account_root.mjs:4` 硬编码 `workspaceRoot = "/Users/yinshiwei/codex/tz"`。

**修改文件**: `portfolio/scripts/lib/account_root.mjs`
- 改为 `new URL("../..", import.meta.url)` 从文件位置推导
- 保留 `PORTFOLIO_ROOT` 环境变量覆盖优先

**验证**: `account_root.test.mjs` 通过；`PORTFOLIO_ROOT` 覆盖仍然生效。

---

### Task 2.3: Python-JS 接口契约

**问题**: 8 个 Python 脚本产出 JSON 被 JS 消费，无 schema 验证。格式变更静默破坏下游。

**新建文件**: `portfolio/scripts/lib/validate_python_output.mjs`
- 为 3 个最关键的 Python 输出定义 schema 契约：`signals_matrix.json`、`cn_market_snapshot`、`quant_metrics_engine.json`
- 返回 `{valid: true}` 或 `{valid: false, errors: [...]}`
- 不 throw，仅 warn

**修改文件**:
- 8 个 Python 脚本：输出添加 `_meta: {schema_version, generated_at, source_script}`
- 3 个关键 JS 消费方：调用验证器

**验证**: 新建 test 文件验证验证器能捕获缺失字段。

---

### Task 2.4: 关键 JSON 文件 schema 版本追踪

**问题**: JSON 格式变更无迁移机制，仅靠手动 `.bak` 文件。

**新建文件**: `portfolio/scripts/lib/schema_migrations.mjs`
- 定义迁移注册表: `SCHEMA_MIGRATIONS = { "portfolio_state": { 1: { to: 2, migrate: fn } } }`
- 读取时检查版本，落后则按序执行迁移，写回原子更新

**注意**: `asset_master.json` 已有 `schema_version: 4`，`ips_constraints.json` 已有 `version: 1`，沿用此模式。

**验证**: 测试创建 schema_version 0 的 portfolio_state，验证自动迁移到最新版。

**依赖**: Task 1.4

---

## Phase 3: 运维可靠性

### Task 3.1: 外部告警框架

**问题**: 零告警基础设施。hard_stop 回撤、现金击穿、自修复失败仅写入 JSON。

**新建文件**: `portfolio/scripts/lib/alert_dispatcher.mjs`

- 配置: `portfolio/config/alert_config.json`（webhook_url、enabled、min_severity、dedup_window_minutes）
- 两个通道: (1) JSONL 本地日志 `portfolio/data/alerts.jsonl` (2) Webhook POST
- 告警级别: `info` / `warning` / `critical`
- 去重: 相同告警在 dedup window 内不重复发送
- 零依赖: 用 Node.js 18+ 内置 `fetch()`

**集成点**:

| 文件 | 触发条件 |
|------|---------|
| `portfolio/scripts/lib/portfolio_risk_state.mjs` | `blocking_state.blocked === true` |
| `portfolio/scripts/lib/nightly_confirmed_nav_status.mjs` | 自修复失败 |
| `portfolio/scripts/lib/trade_pre_flight_gate.mjs` | 交易被阻断 |

**验证**: 新建 test 文件；模拟 hard_stop 触发告警；去重测试。

**依赖**: Task 1.1, 1.4

---

### Task 3.2: 主调度器与夜盘流水线

**问题**: 所有脚本手动触发，无调度。`nightly_confirmed_nav_status.json` 显示自修复失败但无人知晓。

**新建文件**:

| 文件 | 功能 |
|------|------|
| `portfolio/scripts/run_nightly_pipeline.mjs` | 夜盘编排：快照 → NAV 对账 → 物化状态 → 风控仪表盘 → 告警 |
| `portfolio/scripts/run_morning_check.mjs` | 早检：验证夜盘完成、触发自修复、发送状态告警 |

**设计**:
- 每步 try/catch 包裹，单步失败不阻塞后续步骤
- 支持 `--dry-run` 模式验证步骤序列
- 配置: `portfolio/config/pipeline_config.json`
- 提供 macOS launchd plist 示例和 cron 示例

**验证**: `node portfolio/scripts/run_nightly_pipeline.mjs --dry-run` 输出正确步骤序列。

**依赖**: Task 1.1, 1.2, 1.4, 3.1

---

### Task 3.3: 修复 nightly_confirmed_nav_status 非原子写入

**问题**: `nightly_confirmed_nav_status.mjs:31` 直接用 `writeFile` 而非 `writeJsonAtomic`，崩溃可导致状态文件损坏。

**修改文件**: `portfolio/scripts/lib/nightly_confirmed_nav_status.mjs`
- import `writeJsonAtomic` from `./atomic_json_state.mjs`
- L31 替换为 `writeJsonAtomic(resolvedPath, payload)`

**验证**: `nightly_confirmed_nav_status.test.mjs` 通过。

---

## Phase 4: 代码质量（单体拆分）

### Task 4.1: 从 materializer 提取持仓匹配逻辑

**问题**: `portfolio_state_materializer.mjs` 1511 行 / 53KB，职责过多。

**新建文件**: `portfolio/scripts/lib/position_matcher.mjs`
- 提取基金代码/名称解析、别名匹配逻辑（约 200-300 行）
- 导出: `matchPosition(state, fundCode, fundName)`

**修改文件**: `portfolio/scripts/lib/portfolio_state_materializer.mjs` → import position_matcher

**验证**: `portfolio_state_materializer.test.mjs` 全部通过；`position_matcher.test.mjs` 新测试通过。

**依赖**: Task 1.3（统一 normalizeName 确保匹配一致）

---

### Task 4.2: 拆分仪表盘文件

**问题**: `serve_funds_live_dashboard.mjs` ~150KB / 4622 行，HTTP 服务 + 渲染 + 数据转换全在一个文件。

**新建文件**:

| 文件 | 内容 |
|------|------|
| `portfolio/scripts/lib/dashboard_renderer.mjs` | HTML/表格渲染函数 |
| `portfolio/scripts/lib/dashboard_data_builder.mjs` | 数据聚合/转换函数 |

**修改文件**: `serve_funds_live_dashboard.mjs` → 仅保留 HTTP 服务器和编排逻辑

**验证**: 仪表盘渲染输出不变；主文件 < 1000 行。

**依赖**: Task 1.1, 2.1

---

### Task 4.3: 添加港股暴露追踪

**问题**: IPS 提到港股概念但 `asset_master.json` 无港股桶。港股敞口散落在 GLB_MOM 和 TACTICAL，无法执行港股集中度限制。

**修改文件**:

| 文件 | 操作 |
|------|------|
| `portfolio/config/asset_master.json` | 为每个 bucket 添加 `regions` 标签；新增 `region_constraints` 部分 |
| `portfolio/scripts/lib/portfolio_risk_state.mjs` | 新增 `buildRegionExposure()` 和区域超限检测 |
| `portfolio/scripts/lib/trade_pre_flight_gate.mjs` | 新增区域集中度前置检查 |

**验证**: 测试港股敞口 >20% 触发区域超限告警。

**依赖**: Task 1.1

---

## Phase 5: 长期基础设施

### Task 5.1: CI/CD 配置

**新建文件**:

| 文件 | 内容 |
|------|------|
| `package.json` | 仅 scripts 段：`test`, `test:lib`, `test:scripts` |
| `.github/workflows/test.yml` | GitHub Actions：checkout + Node 20+ + npm test |

**验证**: `npm test` 运行全部 57 测试并通过。

**依赖**: Phase 1-4 完成后执行

---

### Task 5.2: 情绪/行为检测器

**新建文件**: `portfolio/scripts/lib/emotion_detector.mjs`
- 启发式规则：追涨（涨 >3% 后 5 日内买入）、恐慌卖出（买后 10 日内跌 >5% 卖出）、报复交易（亏损卖出后 20 日内重新买入）
- 从 execution_ledger.json 读取交易历史
- 集成到 daily brief 生成

**验证**: 合成交易历史测试追涨/恐慌/报复信号检测。

**依赖**: Task 1.4, 2.4

---

### Task 5.3: 数据库可行性评估（研究任务）

**产出**: 设计文档，而非代码。

**内容**:
- 调研 `market_lake.db` 原始设计意图（阅读 Python 脚本引用）
- 评估 SQLite vs 现有 JSON 方案的利弊
- 如推荐引入：表结构设计、迁移策略、回退方案
- 关键考量：当前 JSON 方案已可用，引入数据库增加运维复杂度

**验证**: 设计文档完整覆盖 schema、迁移、风险评估、go/no-go 建议。

---

## 执行总览

```
Phase 1: 止血           ┃  5 tasks  ┃  1.1-1.4 并行, 1.5 依赖 1.4
Phase 2: 夯实基础        ┃  4 tasks  ┃  全部并行
Phase 3: 运维可靠性      ┃  3 tasks  ┃  3.3 独立; 3.1→3.2 顺序
Phase 4: 代码质量        ┃  3 tasks  ┃  全部并行（Phase 1-2 完成后）
Phase 5: 长期基础设施    ┃  3 tasks  ┃  全部并行（Phase 1-4 完成后）
━━━━━━━━━━━━━━━━━━━━━━━━━╋━━━━━━━━━━━╋━━━━━━━━━━━━━━━━━━━━━━━
合计                    ┃  18 tasks ┃
```

### 关键路径

```
1.4（恢复状态）→ 1.5（事务安全）→ 3.1（告警）→ 3.2（调度器）
```

### 快速见效（可随时独立执行）

> 1.1, 1.2, 1.3, 2.1, 2.2, 3.3

### 依赖关系图

```
1.1 ──────────────────────────────┬──→ 3.1 ──→ 3.2
1.2 ──────────────────────────────┤       ↑
1.3 ─────────────→ 4.1           │       │
1.4 ──→ 1.5 ──┬──→ 3.1           │       │
    ──→ 2.4 ──┤──→ 5.2           │       │
    ──────────┘                   │       │
2.1 ─────────────→ 4.2           │       │
2.2 （独立）                      │       │
2.3 （独立）                      │       │
3.3 （独立）                      │       │
4.3 ──→ 1.1                      │       │
5.1 （Phase 1-4 后）              │       │
5.3 （研究任务，独立）             │       │
                                  │       │
1.1, 1.2, 1.4 ───────────────────┘───────┘
```

### 风险与注意事项

1. **向后兼容**: 所有修改必须保持现有 API 接口不变，避免破坏下游消费方
2. **零外部依赖**: 不引入任何 npm 包，仅使用 Node.js 18+ 内置模块
3. **测试先行**: 每个任务完成后必须运行全部 57 个测试确认无回归
4. **渐进式迁移**: JSON schema 版本追踪确保格式变更可追溯、可回滚
