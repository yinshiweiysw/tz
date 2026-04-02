# market-mcp

统一 MCP 服务，把两个项目里更适合服务化的能力整理成一套工具：

- `go-stock`：用于股票行情、K 线、公告、个股研报、行业研报、热门板块、龙虎榜、ETF/板块筛选、市场电报、情绪分析
- `funds`：用于基金搜索、实时估值、持仓明细、基金资料、基金经理、净值曲线

其中指数与关键市场工具现在额外支持：

- `hf_ES`：CME 官方延时报价的 E-mini S&P 500 Futures
- `hf_NQ`：CME 官方延时报价的 E-mini Nasdaq-100 Futures
- `AU9999.SGE`：上金所 Au99.99

## 设计说明

这版实现没有直接把 `go-stock` 的桌面应用和 `funds` 的浏览器扩展整仓塞进 MCP。

原因是：

- `go-stock` 当前仓库是 `Wails + Go` 桌面应用，直接嵌入需要额外处理桌面依赖与本地数据库初始化。
- `funds` 当前仓库是 `Vue 2 + Chrome Extension`，核心数据能力实际上来自 Eastmoney 接口。
- 当前机器的 Go 工具链是 `1.22.2`，而 `go-stock/go.mod` 写的是 `go 1.26`，直接当依赖编译风险很高。

所以这里采用的是“按原项目的数据逻辑提炼为 MCP”的做法：

- 股票工具遵循 `go-stock` 当前使用的上游接口和字段风格。
- 基金工具遵循 `funds` 当前使用的 Eastmoney 接口。

## 安装

```bash
cd /Users/yinshiwei/codex/tz/market-mcp
npm install
```

## 启动

```bash
cd /Users/yinshiwei/codex/tz/market-mcp
npm start
```

## CME 延时报价依赖

如果你要使用 `hf_ES`、`hf_NQ` 这两个 CME 官方延时报价源，本机需要有一个 Chrome 兼容浏览器。

- 默认优先查找 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
- 如果路径不同，可以设置环境变量 `MARKET_MCP_CHROME_EXECUTABLE`

之所以这样处理，是因为 CME 官方网页接口会拦截普通脚本直连；当前实现改为通过本地 Chrome 会话获取官方延时报价。

## 工具列表

- `stock_quote`
- `stock_kline`
- `market_telegraph`
- `stock_notices`
- `stock_research_reports`
- `stock_industry_reports`
- `stock_industry_report_detail`
- `stock_hot_boards`
- `stock_long_tiger`
- `stock_board_search`
- `stock_etf_search`
- `stock_hot_stocks`
- `stock_sentiment`
- `fund_search`
- `fund_quotes`
- `fund_watchlist_quotes`
- `fund_positions`
- `fund_base_info`
- `fund_managers`
- `fund_net_value_history`

## 组合净值观察

如果你想直接看本地维护的基金观察名单，而不是每次手动输入代码，现在可以直接使用：

- `fund_watchlist_quotes`

默认读取：

- `/Users/yinshiwei/codex/tz/portfolio/fund-watchlist.json`

它会返回：

- 当前监控基金数量
- 监控总金额
- 各基金最新净值/估值
- 基于观察金额的近似日内盈亏

## 后续可扩展

- `stock_board_search` 和 `stock_etf_search` 依赖东财 `qgqp_b_id` 指纹，调用时可显式传 `fingerprint`，也可以预先设置环境变量 `MARKET_MCP_QGQP_B_ID`。
- 为 `stock_*` 和 `fund_*` 工具补充更稳定的 schema 与格式化结果。
- 如果后面你要把 `go-stock` 的本地配置、AI 模型配置也纳入 MCP，再单独补配置层和鉴权层会更稳。
