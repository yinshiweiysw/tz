import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  analyzeStockSentiment,
  getHotBoards,
  getHotStocks,
  getIndustryReportDetail,
  getIndustryResearchReports,
  getLongTigerRank,
  getMarketTelegraph,
  searchBoardByNaturalLanguage,
  searchEtfByNaturalLanguage,
  getStockKline,
  getStockNotices,
  getStockQuote,
  getStockResearchReports
} from "./providers/stock.js";
import {
  getFundBaseInfo,
  getFundManagers,
  getFundNetValueHistory,
  getFundPositionDetails,
  getFundQuotes,
  getFundWatchlistQuotes,
  searchFunds
} from "./providers/fund.js";

function asJsonContent(payload) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ],
    structuredContent: payload
  };
}

async function runTool(handler) {
  try {
    const payload = await handler();
    return asJsonContent(payload);
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: error instanceof Error ? error.message : String(error)
        }
      ]
    };
  }
}

const server = new McpServer({
  name: "market-mcp",
  version: "0.1.0"
});

server.tool(
  "stock_quote",
  "Get realtime stock quote data using the go-stock project's Eastmoney-style market data logic.",
  {
    stockCode: z
      .string()
      .describe("Stock code like 600519.SH, 000001.SZ, 00700.HK, hkHSI, hkHSCEI, hkHSTECH, usINX, usNDX, hf_ES, hf_NQ, hf_XAU, znb_NKY, znb_KOSPI, or AU9999.SGE")
  },
  ({ stockCode }) => runTool(() => getStockQuote(stockCode))
);

server.tool(
  "stock_kline",
  "Get stock K-line / candlestick data using the go-stock project's Eastmoney-compatible logic.",
  {
    stockCode: z.string().describe("Stock code like 600519.SH, 000001.SZ, sh600519, sz000001, or 00700.HK"),
    klineType: z
      .string()
      .optional()
      .describe("K-line type: 101 day, 102 week, 103 month, or minute values like 1, 5, 15, 30, 60, 120"),
    limit: z.number().int().min(1).max(500).optional().describe("Number of candles to fetch"),
    adjustFlag: z.string().optional().describe("Adjustment flag: 0 none, qfq/1 forward-adjusted, hfq/2 backward-adjusted")
  },
  ({ stockCode, klineType, limit, adjustFlag }) =>
    runTool(() => getStockKline(stockCode, klineType, limit, adjustFlag))
);

server.tool(
  "market_telegraph",
  "Get the latest market telegraph/news feed derived from go-stock's CLS market news integration.",
  {
    limit: z.number().int().min(1).max(100).optional().describe("Max number of telegraph items")
  },
  ({ limit }) => runTool(() => getMarketTelegraph(limit))
);

server.tool(
  "stock_notices",
  "Get listed-company notices/announcements using go-stock's Eastmoney notice logic.",
  {
    stockList: z.string().describe("One or more stock codes separated by commas, such as 600519.SH,000001.SZ")
  },
  ({ stockList }) => runTool(() => getStockNotices(stockList))
);

server.tool(
  "stock_research_reports",
  "Get Eastmoney stock research reports using the same upstream used by go-stock.",
  {
    stockCode: z.string().describe("Stock code such as 600519.SH, 000001.SZ, sh600519, or sz000001"),
    days: z.number().int().min(1).max(3650).optional().describe("Lookback days")
  },
  ({ stockCode, days }) => runTool(() => getStockResearchReports(stockCode, days))
);

server.tool(
  "stock_industry_reports",
  "Get industry research report list using the same upstream used by go-stock.",
  {
    industryCode: z.string().optional().describe("Optional industry code. Leave empty to fetch recent industry reports."),
    days: z.number().int().min(1).max(3650).optional().describe("Lookback days")
  },
  ({ industryCode, days }) => runTool(() => getIndustryResearchReports(industryCode, days))
);

server.tool(
  "stock_industry_report_detail",
  "Get full text/plain content for a specific industry report using Eastmoney infoCode.",
  {
    infoCode: z.string().describe("Industry report infoCode returned by stock_industry_reports")
  },
  ({ infoCode }) => runTool(() => getIndustryReportDetail(infoCode))
);

server.tool(
  "stock_hot_boards",
  "Get hot board/sector rankings derived from go-stock's board ranking integrations.",
  {
    boardType: z
      .enum(["industry", "concept", "moneyflow"])
      .optional()
      .describe("industry uses QQ rank, concept uses Sina concept flow, moneyflow uses Sina board capital flow"),
    sort: z.string().optional().describe("Sort flag. For industry: 0 desc / 1 asc. For concept: fenlei flag like 0 or 1."),
    metric: z.string().optional().describe("Ranking metric. For industry default averatio. For concept/moneyflow examples: netamount, r3_net"),
    limit: z.number().int().min(1).max(100).optional().describe("Max number of rows")
  },
  ({ boardType, sort, metric, limit }) => runTool(() => getHotBoards({ boardType, sort, metric, limit }))
);

server.tool(
  "stock_long_tiger",
  "Get daily Long Tiger List / 龙虎榜 details using the same Eastmoney upstream used by go-stock.",
  {
    date: z.string().describe("Trade date in YYYY-MM-DD format")
  },
  ({ date }) => runTool(() => getLongTigerRank(date))
);

server.tool(
  "stock_board_search",
  "Natural-language board/concept search using the same Eastmoney smart-tag endpoint used by go-stock. Requires qgqp_b_id fingerprint.",
  {
    words: z.string().describe("Natural-language board/concept query"),
    pageSize: z.number().int().min(1).max(5000).optional().describe("Max number of rows"),
    fingerprint: z
      .string()
      .optional()
      .describe("Eastmoney qgqp_b_id fingerprint. Optional if MARKET_MCP_QGQP_B_ID is already set.")
  },
  ({ words, pageSize, fingerprint }) => runTool(() => searchBoardByNaturalLanguage(words, pageSize, fingerprint))
);

server.tool(
  "stock_etf_search",
  "Natural-language ETF screening using the same Eastmoney smart-tag endpoint used by go-stock. Requires qgqp_b_id fingerprint.",
  {
    words: z.string().describe("Natural-language ETF query"),
    pageSize: z.number().int().min(1).max(5000).optional().describe("Max number of rows"),
    fingerprint: z
      .string()
      .optional()
      .describe("Eastmoney qgqp_b_id fingerprint. Optional if MARKET_MCP_QGQP_B_ID is already set.")
  },
  ({ words, pageSize, fingerprint }) => runTool(() => searchEtfByNaturalLanguage(words, pageSize, fingerprint))
);

server.tool(
  "stock_hot_stocks",
  "Get hot stock list from Xueqiu using the same upstream used by go-stock.",
  {
    limit: z.number().int().min(1).max(100).optional().describe("Max number of stocks"),
    marketType: z
      .string()
      .optional()
      .describe("Xueqiu market type, e.g. 10 for CN, 11 for HK, 12 for US depending on upstream support")
  },
  ({ limit, marketType }) => runTool(() => getHotStocks(limit, marketType))
);

server.tool(
  "stock_sentiment",
  "Run stock-market sentiment analysis using a lightweight sentiment dictionary derived from go-stock.",
  {
    text: z.string().describe("Chinese stock-market related text to analyze")
  },
  ({ text }) => runTool(() => analyzeStockSentiment(text))
);

server.tool(
  "fund_search",
  "Search funds by code, pinyin, or Chinese name using the same upstream endpoint used by the funds project.",
  {
    keyword: z.string().describe("Fund search keyword")
  },
  ({ keyword }) => runTool(() => searchFunds(keyword))
);

server.tool(
  "fund_quotes",
  "Get realtime fund valuation/quote data using the same Eastmoney mobile API used by the funds project.",
  {
    fundCodes: z
      .union([z.string(), z.array(z.string())])
      .describe("Comma-separated fund codes or an array of fund codes")
  },
  ({ fundCodes }) => runTool(() => getFundQuotes(fundCodes))
);

server.tool(
  "fund_watchlist_quotes",
  "Get realtime valuation for a local fund watchlist file and aggregate approximate daily PnL for the tracked amounts.",
  {
    configPath: z
      .string()
      .optional()
      .describe("Optional local JSON path. Defaults to /Users/yinshiwei/codex/tz/portfolio/fund-watchlist.json")
  },
  ({ configPath }) => runTool(() => getFundWatchlistQuotes(configPath))
);

server.tool(
  "fund_positions",
  "Get a fund's stock holding details using the same API used by the funds project.",
  {
    fundCode: z.string().describe("Fund code")
  },
  ({ fundCode }) => runTool(() => getFundPositionDetails(fundCode))
);

server.tool(
  "fund_base_info",
  "Get base information for a fund using the same API used by the funds project.",
  {
    fundCode: z.string().describe("Fund code")
  },
  ({ fundCode }) => runTool(() => getFundBaseInfo(fundCode))
);

server.tool(
  "fund_managers",
  "Get fund manager list and manager details using the same APIs used by the funds project.",
  {
    fundCode: z.string().describe("Fund code")
  },
  ({ fundCode }) => runTool(() => getFundManagers(fundCode))
);

server.tool(
  "fund_net_value_history",
  "Get fund net value or yield chart data using the same Eastmoney endpoints used by the funds project.",
  {
    fundCode: z.string().describe("Fund code"),
    chartType: z
      .enum(["net", "yield"])
      .optional()
      .describe("net for net-value chart, yield for yield chart")
  },
  ({ fundCode, chartType }) => runTool(() => getFundNetValueHistory(fundCode, chartType))
);

const transport = new StdioServerTransport();
await server.connect(transport);
