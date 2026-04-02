# Nightly Confirmed NAV Auto-Reconcile Design

## Goal

为基金面板补齐“夜间确认净值自动回写”闭环：白天继续展示实时估值，晚上自动按确认净值重算所有基金账户的持仓金额、持有收益、昨日收益与总资产，并在自动任务失败时具备兜底和自愈能力。

## Problem

当前系统已经具备单账户的夜间确认净值重算脚本 [`reconcile_confirmed_nav.mjs`](/Users/yinshiwei/codex/tz/portfolio/scripts/reconcile_confirmed_nav.mjs)，但它仍是手工入口，尚未形成真正可依赖的日常闭环。这带来三个问题：

1. 如果当晚没人手动运行，账本会停留在日内估值口径，第二天的“最准持有收益”和“最准总资产”不会自动落账。
2. 如果只依赖一个定时任务，一旦该任务当晚失败，错误会继续延续到后续查看与分析环节。
3. 当前基金 dashboard 已具备实时估值展示能力，但“实时估值”和“收盘确认净值”的状态切换还没有统一的系统级保障。

## Requirements

### Functional

1. 每晚 22:30 自动扫描 `main` 与所有 `portfolio_users/*` 账户，逐个执行确认净值回写。
2. 每晚 23:15 再执行一次同样的批量回写，作为兜底补跑。
3. 如果某个账户在前一晚未完成确认净值回写，则次日首次读取主账本的入口应自动触发一次补跑。
4. 自动任务必须生成状态文件，明确记录每个账户的成功/失败、更新时间和核心统计。
5. 主面板必须能识别“当前为已确认净值口径”还是“仍为临时估值口径”，避免无声漂移。

### Reliability

1. 单账户失败不得阻断其他账户的回写。
2. 夜间任务必须幂等，允许重复执行，不得重复叠加收益。
3. 兜底补跑和次日自愈补跑都必须复用同一套核心逻辑，避免口径分裂。

### Scope

本次只补齐“场外基金确认净值回写闭环”。不处理：

- 场内证券结算
- 更广义的日报/早报/交易计划自动刷新
- 外部 cron 或 launchd 集成

## Options Considered

### Option A: 新增批量夜间结算脚本 + 双重自动任务 + 次日自愈

新增一个批量入口脚本，自动扫描所有账户，逐个调用现有确认净值链路，并在 dashboard 等主入口读取时检查是否缺少上次夜间结算结果，缺失时自动补跑。

优点：

- 改动集中，复用现有 `reconcile_confirmed_nav.mjs`
- 失败隔离清晰
- 支持双重调度和次日自愈
- 不把“正式结算”耦合进展示服务主刷新流程

缺点：

- 需要新增批量脚本和状态文件
- 需要为读取入口加入一次状态检查

### Option B: 将批量扫描逻辑直接并入 `reconcile_confirmed_nav.mjs`

让现有脚本同时承担“单账户手动修复”和“夜间批量入口”职责。

优点：

- 文件更少

缺点：

- 单账户修复入口和夜间批量结算入口语义混杂
- 后续维护时更容易互相影响

### Option C: 把夜间确认净值逻辑挂进 dashboard 服务后台定时器

优点：

- 表面上省去单独批量脚本

缺点：

- 只要 dashboard 服务没跑，夜间结算就会漏执行
- 展示层和正式账本结算耦合过深
- 失败边界不清晰

## Chosen Approach

采用 Option A。

这条链路拆成四层：

1. `reconcile_confirmed_nav.mjs`
   继续保留为单账户、可手工执行的原子结算脚本。
2. `run_nightly_confirmed_nav.mjs`
   新增批量入口，负责自动扫描所有账户、逐个执行、汇总状态。
3. `nightly_confirmed_nav_status.json`
   新增状态文件，记录最近一次夜间结算结果。
4. 主入口自愈检查
   基金 dashboard 在读取主账本时先检查“昨晚确认净值是否成功完成”；若未完成，则后台触发单次补跑并刷新状态。

## Architecture

### 1. Batch Runner

新增脚本：

- `/Users/yinshiwei/codex/tz/portfolio/scripts/run_nightly_confirmed_nav.mjs`

职责：

- 扫描 `main`
- 扫描 `/Users/yinshiwei/codex/tz/portfolio_users/*`
- 对每个账户构造 `portfolioRoot`
- 逐个运行确认净值回写
- 收集执行结果
- 写入总状态文件

它不自己重新实现结算逻辑，而是直接复用现有单账户入口，确保夜间结算与手工修复完全同口径。

### 2. Status File

新增状态文件：

- `/Users/yinshiwei/codex/tz/portfolio/data/nightly_confirmed_nav_status.json`

建议结构：

```json
{
  "generatedAt": "2026-04-02T14:30:05.000Z",
  "runType": "scheduled_primary",
  "targetDate": "2026-04-02",
  "accounts": [
    {
      "accountId": "main",
      "portfolioRoot": "/Users/yinshiwei/codex/tz/portfolio",
      "success": true,
      "snapshotDate": "2026-04-02",
      "stats": {
        "updatedPositions": 16,
        "totalFundAssets": 307011.86,
        "totalDailyPnl": -1668.11,
        "totalHoldingPnl": -23458.38
      },
      "error": null,
      "finishedAt": "2026-04-02T14:30:07.000Z"
    }
  ],
  "successCount": 2,
  "failureCount": 0
}
```

### 3. Double Schedule

自动化层使用两个独立任务：

- 主任务：每日 22:30
- 兜底任务：每日 23:15

两者都执行同一个批量脚本，只是 `runType` 分别标识为：

- `scheduled_primary`
- `scheduled_fallback`

### 4. Self-Heal on Read

在基金 dashboard 主入口增加一个轻量检查：

- 当日第一次请求 `/api/live-funds`
- 如果当前时间已经晚于次日晨间阈值（例如 08:00）
- 且状态文件显示“上一交易日夜间确认净值未成功完成”

则后台自动触发一次补跑，并将本次运行标记为：

- `self_heal_on_read`

该补跑应该：

- 只做一次，避免每次刷新都重复触发
- 失败时写入状态文件
- 前端状态栏明确提示当前仍为临时估值口径

## Account Discovery

账户扫描规则：

1. 主账户固定为：
   - `/Users/yinshiwei/codex/tz/portfolio`
2. 子账户来自：
   - `/Users/yinshiwei/codex/tz/portfolio_users/*`
3. 仅纳入存在 `latest.json` 或 `snapshots/latest_raw.json` 的账户目录

## Failure Semantics

### Per-account failure

单账户失败时：

- 继续跑下一个账户
- 在状态文件里记录 `success: false` 和错误信息
- 不改动该账户现有账本

### Global failure

如果批量脚本本身异常退出：

- 仍应尽可能写一份失败状态文件
- 至少包含 `generatedAt`, `runType`, `targetDate`, `fatalError`

## Dashboard Behavior

基金 dashboard 需要识别三种口径状态：

1. `confirmed_nav_ready`
   - 昨晚确认净值已成功完成
2. `temporary_live_valuation`
   - 当前仍为临时日内估值口径
3. `self_heal_running` / `self_heal_failed`
   - 次日读取时正在补跑或补跑失败

主面板不需要显示复杂技术细节，但应至少在状态栏或顶部轻提示：

- `昨晚确认净值已完成`
- `当前为临时估值口径，系统正补跑确认净值`
- `昨晚确认净值未完成，请谨慎解读持有收益`

## Testing

### Unit

- 批量扫描所有账户时能正确生成账户列表
- 单账户失败不会中断其他账户
- 状态文件汇总字段正确
- 自愈判定逻辑能正确识别“需要补跑/不需要补跑”

### Integration

- 手工运行批量脚本后，`main` 与 `portfolio_users/wenge` 都能写出成功状态
- 构造一个失败账户样本时，状态文件能正确记录失败且其他账户仍成功
- dashboard 在状态文件缺失或过期时能正确给出“临时估值口径”提示

## Files to Add / Modify

### Create

- `/Users/yinshiwei/codex/tz/portfolio/scripts/run_nightly_confirmed_nav.mjs`
- `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/nightly_confirmed_nav_status.mjs`
- `/Users/yinshiwei/codex/tz/portfolio/scripts/lib/nightly_confirmed_nav_status.test.mjs`

### Modify

- `/Users/yinshiwei/codex/tz/portfolio/scripts/reconcile_confirmed_nav.mjs`
  - 仅在必要时导出可复用入口；不改变现有单账户 CLI 语义
- `/Users/yinshiwei/codex/tz/portfolio/scripts/serve_funds_live_dashboard.mjs`
  - 增加状态检查与自愈触发

### Automation

- 新增两个自动任务：
  - 每日 22:30 主任务
  - 每日 23:15 兜底任务

## Success Criteria

满足以下条件即可认为闭环完成：

1. 不需要人工每天手动跑确认净值回写。
2. 即使 22:30 任务失败，也有 23:15 兜底。
3. 即使两个夜间任务都失败，次日首次读取仍会自动补跑。
4. dashboard 能明确告诉用户当前看到的是“确认净值口径”还是“临时估值口径”。
5. 账本金额、持有收益、昨日收益不会因重复执行而累计漂移。
