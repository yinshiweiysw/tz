# Agent Unified Entry Design

## Goal

让任何新 AI-agent / 新线程在进入 `portfolio` 系统时，不再自己扫描仓库猜状态，而是先读取两份统一机器入口：

1. `data/agent_runtime_context.json`
2. `data/strategy_decision_contract.json`

这样无论是行情分析、仓位分析还是交易建议，所有 agent 都从同一份事实层和同一份决策合同出发，减少上下文丢失和风格漂移。

## Current Problems

### 1. 新 agent 知道路由，不知道真实组合状态

当前 [agent_bootstrap_context.json](/Users/yinshiwei/codex/tz/portfolio/data/agent_bootstrap_context.json) 主要提供：

- 入口顺序
- canonical entrypoints
- health
- account summary
- intent routing

它不直接提供：

- 当前持仓清单
- 当前桶金额/权重/目标/缺口
- 当前主驱动
- 当前允许/禁止动作

结果是新 agent 知道“该调哪个脚本”，但不知道“你现在到底持有什么、缺什么、今天能做什么”。

### 2. 不同 agent 使用的数据面不同

不同线程可能分别读取：

- `state/portfolio_state.json`
- `latest.json`
- `data/dashboard_state.json`
- `data/research_brain.json`
- 某一份旧报告

入口不一致会直接导致建议不一致。

### 3. 不同模型会用自己的金融先验补空白

当系统没有给出统一的“今日允许动作”和“桶级动作边界”时，不同模型会基于各自偏好补全：

- 有的更保守
- 有的更趋势
- 有的更主观宏观

这会形成风格偏移，而不是系统策略本身的稳定表达。

## Objectives

### 1. 建立统一事实层

新增 `agent_runtime_context.json`，把当前账户最关键的运行时事实压缩成一个可直接消费的对象。

### 2. 建立统一策略合同层

新增 `strategy_decision_contract.json`，把当前策略 regime、风控边界、桶级动作偏好、执行上限统一成一份机器合同。

### 3. 强制所有 agent 先读统一入口

任何涉及：

- 行情分析
- 组合分析
- 交易决策
- 执行清单

的 agent 行为，都必须先读这两个对象，再决定是否继续调用更重的脚本。

## Non-Goals

- 不在第一阶段重写 `generate_signals.py`
- 不在第一阶段重写 `generate_next_trade_plan.mjs`
- 不在第一阶段重写 `trade_generator.py`
- 不在第一阶段重写 `generate_dialogue_analysis_contract.mjs`

第一阶段只修“统一入口”和“统一决策表达”，不动交易核心。

## Architecture

### Layer 1: Canonical State

保持现有层次：

- `state/portfolio_state.json`
- `data/dashboard_state.json`
- `data/research_brain.json`
- `/api/live-funds/health` 对应的健康状态

这些仍然是原始上游，不直接被所有 agent 逐一拼装。

### Layer 2: Agent Runtime Context

新增：

- `scripts/build_agent_runtime_context.mjs`
- `scripts/lib/agent_runtime_context.mjs`
- `data/agent_runtime_context.json`

它负责把：

- 账户资金摘要
- 当前持仓
- 桶视图
- 市场上下文
- 系统健康状态

统一整理成一个 agent 可直接读取的上下文对象。

### Layer 3: Strategy Decision Contract

新增：

- `scripts/build_strategy_decision_contract.mjs`
- `scripts/lib/strategy_decision_contract.mjs`
- `data/strategy_decision_contract.json`

它负责把：

- 当前 regime
- 当前交易许可
- 桶级动作偏好
- 风控边界
- 输出约束

统一表达成可被不同模型共同遵守的决策合同。

### Layer 4: Intent Routing

现有：

- [agent_intent_registry.mjs](/Users/yinshiwei/codex/tz/portfolio/scripts/lib/agent_intent_registry.mjs)
- [AI_AGENT_DISPATCH_PROTOCOL.md](/Users/yinshiwei/codex/tz/portfolio/docs/AI_AGENT_DISPATCH_PROTOCOL.md)

需要升级为：

- 每个意图先读 `agent_runtime_context.json`
- 再读 `strategy_decision_contract.json`
- 再执行对应主脚本

## Data Shape

### `agent_runtime_context.json`

建议固定结构：

```json
{
  "generatedAt": "2026-04-08T06:30:00.000Z",
  "accountId": "main",
  "snapshotDate": "2026-04-08",
  "meta": {
    "marketSession": "intraday",
    "dataFreshnessSummary": "mixed"
  },
  "portfolio": {
    "totalPortfolioAssetsCny": 431720.08,
    "investedAssetsCny": 272103.78,
    "settledCashCny": 159616.30,
    "tradeAvailableCashCny": 159616.30,
    "cashLikeFundAssetsCny": 85132.56,
    "liquiditySleeveAssetsCny": 85132.56,
    "holdingProfitCny": -27980.79,
    "dailyPnlCny": 6803.17
  },
  "positions": [],
  "bucketView": [],
  "marketContext": {
    "topHeadlines": [],
    "crossAssetSnapshot": {},
    "dominantDrivers": [],
    "goldRegime": null,
    "riskTone": null
  },
  "systemState": {
    "dashboardHealth": {},
    "researchReadiness": {},
    "confirmedNavState": null,
    "blockedReason": null,
    "staleDependencies": []
  }
}
```

### `strategy_decision_contract.json`

建议固定结构：

```json
{
  "generatedAt": "2026-04-08T06:31:00.000Z",
  "accountId": "main",
  "contractVersion": 1,
  "basedOnRuntimeContextAt": "2026-04-08T06:30:00.000Z",
  "regime": {
    "marketRegime": "risk_on_rebound",
    "riskState": "partial_chase_only",
    "tradePermission": "limited",
    "overallStance": "do_not_full_rebalance_today"
  },
  "bucketPolicies": [],
  "executionGuardrails": {
    "maxTotalBuyTodayCny": 20000,
    "maxSingleBucketAddTodayCny": 15000,
    "restrictedActions": [],
    "cashFloorRules": []
  },
  "responsePolicy": {
    "requiredSections": [
      "main_driver",
      "portfolio_impact",
      "allowed_actions",
      "forbidden_actions",
      "amount_bounds"
    ]
  }
}
```

## Build Pipeline

### Refresh Order

统一刷新顺序：

1. `portfolio_state.json`
2. `dashboard_state.json`
3. `research_brain.json`
4. `agent_runtime_context.json`
5. `strategy_decision_contract.json`

### Allowed Triggers

只允许三类触发：

1. 显式刷新脚本
2. 交易写入后自动刷新
3. 定时 sidecar 刷新

禁止：

- 页面 GET 时偷偷生成
- 用户问问题时临时写回
- 不完整状态也强制落地

## Enforcement Rules

所有 agent 请求在给出建议前，必须完成：

1. 读取 `state-manifest.json`
2. 读取 `agent_runtime_context.json`
3. 读取 `strategy_decision_contract.json`
4. 校验 freshness 和 account identity

如果失败，只能返回：

- `entrypoint_state = blocked`
- `reason = runtime_context_stale | strategy_contract_missing | account_mismatch`
- `recommended_refresh_script = ...`

不能继续自由发挥式给建议。

## Why This Fixes Drift

### 1. 事实层统一

所有模型先看到的是同一份仓位、桶、现金、市场主驱动。

### 2. 策略边界统一

所有模型先看到的是同一份：

- 当前 regime
- 当前可做动作
- 当前禁止动作
- 当前金额边界

### 3. 输出骨架统一

不同模型最多表述不同，不再在底层动作方向上显著分叉。

## Phase Order

### Phase A

先构建 `agent_runtime_context.json`，解决“新 agent 不知道当前状态”。

### Phase B

再构建 `strategy_decision_contract.json`，解决“不同模型风格漂移”。

### Phase C

最后把 `state-manifest.json`、`AI_AGENT_DISPATCH_PROTOCOL.md`、`agent_intent_registry.mjs` 统一切换到新入口。

## Validation

落地后必须满足：

1. 新线程只读 manifest + runtime context + strategy contract，就能回答当前持仓和当前允许动作。
2. 不同 agent 在同一时刻给出的建议结构一致，金额边界一致。
3. 行情分析不能再脱离你的当前仓位。
4. 看板、研究、交易系统之间的入口语义一致。
