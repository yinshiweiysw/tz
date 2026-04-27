# Simplified Fund OS + TradingAgents Bridge Implementation Plan

**Goal:** 把当前系统从重型 workbench + 自研交易主脑，迁移成“基金操作系统 + 外部 TradingAgents 建议层”的简化产品。默认入口恢复为基金面板，交易分析改为外部建议接入，本地只保留账本真相、约束和人工确认能力。

**Architecture:** 采用保守迁移：保留当前复杂分支作为备份，从 `main` 拉干净 worktree，在新工作树中逐步恢复基金面板主入口、冻结旧交易链、接入外部 TradingAgents JSON bridge，再补一个最小交易建议页和一个轻量市场/专题页。

**Tech Stack:** 现有 Node.js `.mjs` 服务脚本 + 本地 fund ledger / NAV pipeline + 外部独立 Python 环境中的 TradingAgents + JSON bridge

---

## File Structure

### New worktree target

建议新工作树路径固定为：

- `/Users/yinshiwei/codex/tz-main-simplified`

这样当前脏工作树继续保留为备份，不互相覆盖。

### Local repo areas to keep as primary

- `/Users/yinshiwei/codex/tz-main-simplified/portfolio/scripts/record_manual_fund_trades.mjs`
- `/Users/yinshiwei/codex/tz-main-simplified/portfolio/scripts/reconcile_confirmed_nav.mjs`
- `/Users/yinshiwei/codex/tz-main-simplified/portfolio/scripts/refresh_account_sidecars.mjs`
- `/Users/yinshiwei/codex/tz-main-simplified/portfolio/scripts/serve_funds_live_dashboard.mjs`
- `/Users/yinshiwei/codex/tz-main-simplified/portfolio/scripts/open_funds_live_dashboard.mjs`
- `/Users/yinshiwei/codex/tz-main-simplified/portfolio/scripts/lib/holding_cost_basis.mjs`
- `/Users/yinshiwei/codex/tz-main-simplified/portfolio/scripts/lib/confirmed_nav_reconciler.mjs`
- `/Users/yinshiwei/codex/tz-main-simplified/portfolio/scripts/lib/portfolio_state_materializer.mjs`

### Local repo areas to demote from the mainline

- `/Users/yinshiwei/codex/tz-main-simplified/portfolio/scripts/run_portfolio_decision_cycle.mjs`
- `/Users/yinshiwei/codex/tz-main-simplified/portfolio/scripts/generate_next_trade_plan.mjs`
- `/Users/yinshiwei/codex/tz-main-simplified/portfolio/scripts/build_strategy_decision_contract.mjs`
- `/Users/yinshiwei/codex/tz-main-simplified/portfolio/scripts/build_agent_runtime_context.mjs`
- `/Users/yinshiwei/codex/tz-main-simplified/portfolio/scripts/generate_dialogue_analysis_contract.mjs`
- `/Users/yinshiwei/codex/tz-main-simplified/portfolio/scripts/factor_fusion_engine.py`
- `/Users/yinshiwei/codex/tz-main-simplified/portfolio/scripts/backtest_fusion_engine.py`
- `/Users/yinshiwei/codex/tz-main-simplified/portfolio/scripts/run_factor_fusion_shadow_cycle.mjs`

### External repo target

TradingAgents 单独部署路径建议固定为：

- `/Users/yinshiwei/codex/external/TradingAgents`

---

## Phase 0: Freeze Direction And Create A Clean Base

**Files:**
- Documentation only in current repo
- Git worktree creation from local `main`

- [ ] Confirm the new simplified design is the approved target and treat the current heavy workbench branch as backup, not as the rebuild base.
- [ ] Create a clean worktree from local `main`, for example:
  - `git worktree add /Users/yinshiwei/codex/tz-main-simplified main`
- [ ] Verify the new worktree opens cleanly and does not inherit the current branch's dirty state.
- [ ] Record the chosen migration rule in the new worktree docs: keep the current branch for reference, but do not cherry-pick large UI/workbench chains blindly.

**Success check:** we have one stable backup and one clean rebuild base.

## Phase 1: Restore The Original Fund Panel As The Product Center

**Files:**
- Modify: `/Users/yinshiwei/codex/tz-main-simplified/portfolio/scripts/serve_funds_live_dashboard.mjs`
- Modify: `/Users/yinshiwei/codex/tz-main-simplified/portfolio/scripts/open_funds_live_dashboard.mjs`
- Modify: any minimal rendering helpers required by the original fund panel
- Tests: existing funds dashboard tests in the clean worktree

- [ ] Make the original-style fund panel the default homepage again.
- [ ] Ensure the page is display-first rather than analysis-first.
- [ ] Keep the panel focused on:
  - holdings
  - units
  - cost basis
  - holding PnL
  - estimate / confirmation status
  - bucket summary
- [ ] Remove heavy homepage sections that turned the product into a workbench.
- [ ] Keep merged `CASH` semantics if already required by the user's current portfolio logic.
- [ ] Confirm the panel can stand alone as the main product without depending on shadow, research, or trade-plan pages.

**Success check:** opening the app returns to a fund-panel-first experience.

## Phase 2: Freeze The Old Trading Engine Into Legacy Mode

**Files:**
- Modify: lightweight routing / launcher / navigation code in the clean worktree
- Optional: add legacy documentation file

- [ ] Remove the heavy trading-engine pages from the default product navigation.
- [ ] Mark old engine entrypoints as `legacy` in docs and, if needed, in code comments or route names.
- [ ] Ensure legacy modules are not called by the default page load path.
- [ ] Keep the source code intact for now; do not mass-delete it during the first migration pass.
- [ ] Add a short internal note documenting which old artifacts are no longer canonical for the simplified product.

**Success check:** the simplified app no longer depends on decision-cycle / factor-fusion / shadow chains to render its main flows.

## Phase 3: Stand Up TradingAgents As An External Service Layer

**Files:**
- External repo only:
  - `/Users/yinshiwei/codex/external/TradingAgents`
- Local repo documentation / config only as needed

- [ ] Clone TradingAgents into the external path.
- [ ] Create its isolated Python environment.
- [ ] Install dependencies and verify a baseline example can run.
- [ ] Decide the minimal invocation shape we need for phase 1:
  - input universe
  - output JSON path
  - run cadence
- [ ] Do not let TradingAgents write into the local repo's canonical fund state.
- [ ] Document the exact command used to produce a raw suggestion snapshot.

**Success check:** TradingAgents can run independently and emit a raw suggestion payload.

## Phase 4: Build A Thin Local JSON Bridge

**Files:**
- Create: `/Users/yinshiwei/codex/tz-main-simplified/portfolio/scripts/run_tradingagents_bridge.mjs`
- Create: `/Users/yinshiwei/codex/tz-main-simplified/portfolio/scripts/lib/tradingagents_bridge.mjs`
- Create: `/Users/yinshiwei/codex/tz-main-simplified/portfolio/scripts/lib/tradingagents_mapping.mjs`
- Create: `/Users/yinshiwei/codex/tz-main-simplified/portfolio/scripts/lib/tradingagents_guardrails.mjs`
- Create tests for the above bridge helpers

- [ ] Define the raw external JSON contract and the local bridged JSON contract.
- [ ] Implement bucket -> proxy symbol mappings for phase 1 buckets:
  - `A_CORE`
  - `GLB_MOM`
  - `TACTICAL`
- [ ] Implement rating mapping:
  - `BUY` -> `增配`
  - `OVERWEIGHT` -> `偏增配`
  - `HOLD` -> `维持`
  - `UNDERWEIGHT` -> `减配`
  - `SELL` -> `显著减配 / 退出候选`
- [ ] Add minimum guardrails:
  - no live execution
  - no fund suggestion without mapping
  - stale suggestion tagging
  - advisory-only status when market input quality is weak
- [ ] Output one stable bridged JSON file that the UI can read.

**Success check:** local repo can consume a TradingAgents raw snapshot and produce a fund-readable suggestion snapshot.

## Phase 5: Add A Minimal `交易建议` Page

**Files:**
- Modify: `/Users/yinshiwei/codex/tz-main-simplified/portfolio/scripts/serve_funds_live_dashboard.mjs`
- Modify: minimal page render helpers in the clean worktree
- Create/modify tests around the new route or tab

- [ ] Add a small `交易建议` page or tab next to the fund panel.
- [ ] Keep the page read-only and compact.
- [ ] Render only these blocks:
  - latest suggestion time
  - bucket suggestions
  - mapped fund suggestions
  - blocked / filtered suggestions
  - short reason summaries
- [ ] Make the source boundary explicit:
  - `source = TradingAgents`
  - `status = advisory only`
- [ ] Do not render heavy internal trade-plan semantics.
- [ ] Do not write to the execution ledger from this page.

**Success check:** user can open one page and clearly see what the external engine suggests and what the local system allows to be considered.

## Phase 6: Add A Lightweight `市场/专题` Page

**Files:**
- Modify: minimal server-rendering layer in the clean worktree
- Optional: small helper for report aggregation

- [ ] Add a simple `市场/专题` page.
- [ ] Show only a few useful sections:
  - market summary
  - sector/theme highlights
  - key events
  - latest TradingAgents market stance summary
- [ ] Keep it brief and readable; this page is not a full workbench.
- [ ] Prefer summary cards or concise text blocks over large stacked engineering panels.

**Success check:** the system gains a lightweight market-reading page without recreating the abandoned heavy dashboard.

## Phase 7: Revalidate Core Ledger And PnL Truth

**Files:**
- Existing ledger / holdings / reconciliation tests in clean worktree
- Optional additions around comparison diagnostics

- [ ] Re-run holdings, cost-basis, and confirmed NAV tests.
- [ ] Verify newly converted funds, QDII funds, pending-profit funds, and reference-only funds still produce correct holding PnL semantics.
- [ ] Confirm that external suggestions never contaminate ledger truth.
- [ ] Keep `holdingPnl` derived only from local fund truth, not from suggestion-layer narratives.

**Success check:** the simplification does not damage the most important thing in the system: portfolio truth.

## Phase 8: Document The New Operating Model

**Files:**
- Create: `/Users/yinshiwei/codex/tz-main-simplified/portfolio/docs/plans/<date>-simplified-operating-model.md` or update README
- Modify: `/Users/yinshiwei/codex/tz-main-simplified/portfolio/README.md`

- [ ] Document the new product shape:
  - `基金面板`
  - `交易建议`
  - `市场/专题`
- [ ] Document what remains local truth vs what is external advice.
- [ ] Document how to refresh:
  - fund state
  - confirmed NAV
  - TradingAgents suggestion snapshot
- [ ] Document what is legacy and not part of the simplified mainline.

**Success check:** future maintenance has one short, clear operating guide.

---

## Verification Checklist

- [ ] The current heavy branch remains intact as backup.
- [ ] A clean `main` worktree exists for the simplified rebuild.
- [ ] The default app entry is again the original-style fund panel.
- [ ] The simplified app can run without decision-cycle / factor-fusion / shadow pipelines.
- [ ] TradingAgents runs from an external repo and produces a raw snapshot.
- [ ] The local bridge converts that raw snapshot into bucket/fund suggestion JSON.
- [ ] The `交易建议` page is read-only and advisory-only.
- [ ] The `市场/专题` page is lightweight and not a new heavy dashboard.
- [ ] Fund holdings / NAV / PnL truth still pass verification after simplification.

## Recommended Execution Order

1. Phase 0: create clean worktree from `main`
2. Phase 1: restore fund panel as default product
3. Phase 2: freeze old engine into legacy
4. Phase 3: stand up external TradingAgents
5. Phase 4: build the JSON bridge
6. Phase 5: add the minimal `交易建议` page
7. Phase 6: add the lightweight `市场/专题` page
8. Phase 7-8: revalidate ledger truth and document the operating model

## Notes

- This plan intentionally prefers deletion of complexity over feature parity.
- If a feature cannot justify its maintenance cost in the simplified product, it should stay in legacy.
- The success criterion is not “match the old workbench feature-for-feature”. The success criterion is “make the system useful, trustworthy, and maintainable again”.
