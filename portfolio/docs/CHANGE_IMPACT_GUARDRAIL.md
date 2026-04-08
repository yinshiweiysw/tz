# Change Impact Guardrail

更新时间：2026-04-08

## 目标

每次涉及状态字段、金额/收益逻辑、估值/确认逻辑、看板 summary、agent runtime、signal / trade / risk 输出的改动，必须先完成一份“影响评估清单”，再实施。这个 guardrail 防止改动后画面挂了、老功能静默消失、或 agent 产生不一致建议。

## Impact Checklist

| 项目 | 说明 |
| --- | --- |
| `change_layer` | 本次改动触碰的层级（accounting、market_valuation、dashboard、analysis_risk、execution、agent_runtime、reporting） |
| `canonical_inputs` | 改动依赖的真值字段（如 `units`, `cost_basis_cny`, `latest_confirmed_nav`, `intraday_valuation`） |
| `affected_modules` | 涉及 canonical state、dashboard、agent context、signals/trading、reports/tests 等哪些模块 |
| `impact_decision` | 每个模块的决定：`must_update` / `compatible_no_change` / `regression_only` |
| `write_boundary_check` | 是否触碰真值写入、derived 的 state、GET 读路径、sidecar refresh 链 |
| `required_regressions` | 必须运行的回归清单（例如 bootstrap test、dashboard test、signals regression） |

## Policy

- 必须在实现前完成并审阅清单；未完成不得动手写代码。
- 所有相关回归必须执行后才能宣称“完成”。
- 如果旧功能会受影响，必须提前声明**保留/联改/废弃**，不能无声消失。

## Adoption

1. 新 agent 进入系统时（`agent_bootstrap_context`），必读这份 guardrail。
2. 所有未来的 design spec / plan 要把 guardrail checklist 作为准入条件。
3. 每个 commit message 应该提及是否遵守 guardrail，例如 `feat: ... (impact guardrail applied)`。
