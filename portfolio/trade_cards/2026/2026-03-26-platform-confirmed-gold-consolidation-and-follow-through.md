# 2026-03-26 交易卡片：平台确认后的黄金并仓与补充买入

## 基本信息

- 日期：2026-03-26
- 方向：buy_and_conversion
- 状态：confirmed_by_platform_screenshot
- 仓位角色：structure_follow_through

## 标的与金额

- 工银瑞信黄金ETF联接C -> 国泰黄金ETF联接E，按约 29320.63 元并仓
- 永赢先锋半导体智选混合C 3000 元
- 国泰大宗商品配置(QDII-LOF-FOF)D 1000 元

## 核心逻辑

- 把黄金仓统一并到国泰黄金ETF联接E，减少同主题重复持仓
- 延续前一日建立账户骨架后的轻度跟随动作，不回到重仓追高
- 半导体和大宗商品仅作为小额补充，不改变组合主结构

## 为什么现在做

- 用户在 2026-03-26 提供平台流水截图，确认 2026-03-25 15:00 前提交的交易已进入 2026-03-26 收益口径
- 这使 latest.json 可以从对话预估升级到平台确认后的近似现况

## 失效条件

- 平台刷新后若黄金转换的最终确认金额与当前近似金额差异明显，需要回写修正
- 若半导体/大宗商品后续被用户确认撤单或未成交，需要回滚对应仓位

## 风险点

- 黄金转换金额当前按原工银黄金持仓金额近似处理，仍待平台最终确认
- 半导体属于新增主动风险暴露，虽然金额小，但会提高 A股主动仓位
- 日经225 卖出只有份额信息，当前仅记录为待到账备注

## 后续计划

- 等待下一次平台刷新或持仓更新后校准黄金转换结果
- 后续观察 2026-03-26 当日净值变化，确认这些仓位已正确进入 watchlist
- 继续保持港股高波主题不再扩张

## 关联文件

- /Users/yinshiwei/codex/tz/portfolio/latest.json
- /Users/yinshiwei/codex/tz/portfolio/transactions/2026-03-25-manual-platform-confirmation.json
- /Users/yinshiwei/codex/tz/portfolio/journal/daily/2026-03-26.md
- /Users/yinshiwei/codex/tz/portfolio/fund-watchlist.json

