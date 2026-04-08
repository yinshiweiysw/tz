import test from "node:test";
import assert from "node:assert/strict";

import { buildPortfolioRiskState } from "./portfolio_risk_state.mjs";

function buildAssetMasterFixture() {
  return {
    themes: {
      CN_CORE_BETA: { label: "A股核心Beta" },
      US_GROWTH: { label: "美股成长" }
    },
    global_constraints: {
      max_drawdown_limit: 0.15
    },
    bucket_mapping_rules: [
      {
        bucket_key: "A_CORE",
        category_equals: ["A股宽基"],
        name_patterns: ["沪深300"]
      },
      {
        bucket_key: "GLB_MOM",
        category_equals: ["美股指数/QDII"],
        name_patterns: ["标普500", "纳斯达克"]
      },
      {
        bucket_key: "HEDGE",
        category_equals: ["黄金"],
        name_patterns: ["黄金"]
      }
    ],
    assets: [
      {
        symbol: "007339",
        name: "易方达沪深300ETF联接C",
        bucket: "A_CORE",
        theme_key: "CN_CORE_BETA"
      },
      {
        symbol: "006075",
        name: "博时标普500ETF联接(QDII)C",
        bucket: "GLB_MOM",
        theme_key: "US_GROWTH"
      },
      {
        symbol: "019118",
        name: "景顺长城纳斯达克科技市值加权ETF联接(QDII)E",
        bucket: "GLB_MOM",
        theme_key: "US_GROWTH"
      }
    ],
    theme_mapping_rules: [
      {
        theme_key: "US_GROWTH",
        category_equals: ["美股指数/QDII", "美股科技/QDII"],
        name_patterns: ["标普500", "纳斯达克"]
      }
    ],
    buckets: {
      A_CORE: { label: "A股核心", risk_role: "core" },
      GLB_MOM: { label: "全球动量", risk_role: "growth" },
      HEDGE: { label: "黄金避险", risk_role: "defensive" },
      CASH: { label: "现金防线", risk_role: "cash" }
    }
  };
}

test("buildPortfolioRiskState computes weighted portfolio drawdown from matched active positions", () => {
  const result = buildPortfolioRiskState({
    positions: [
      { name: "易方达沪深300ETF联接C", fund_code: "007339", amount: 20000, status: "active", category: "A股宽基" },
      { name: "博时标普500ETF联接(QDII)C", fund_code: "006075", amount: 10000, status: "active", category: "美股指数/QDII" }
    ],
    signalMatrix: {
      signals: {
        "007339": {
          name: "易方达沪深300ETF联接C",
          indicators: {
            current_drawdown_60d_percent: -6,
            max_drawdown_60d_percent: -11
          }
        },
        "006075": {
          name: "博时标普500ETF联接(QDII)C",
          indicators: {
            current_drawdown_60d_percent: -18,
            max_drawdown_60d_percent: -24
          }
        }
      }
    },
    assetMaster: buildAssetMasterFixture()
  });

  assert.equal(result.matched_position_count, 2);
  assert.equal(result.weighted_current_drawdown_60d_percent, -10);
  assert.equal(result.current_drawdown_pct, 0.1);
  assert.equal(result.breached_max_drawdown_limit, false);
});

test("buildPortfolioRiskState flags breach when weighted drawdown exceeds configured limit", () => {
  const result = buildPortfolioRiskState({
    positions: [
      { name: "博时标普500ETF联接(QDII)C", fund_code: "006075", amount: 30000, status: "active", category: "美股指数/QDII" }
    ],
    signalMatrix: {
      signals: {
        "006075": {
          name: "博时标普500ETF联接(QDII)C",
          indicators: {
            current_drawdown_60d_percent: -18,
            max_drawdown_60d_percent: -24
          }
        }
      }
    },
    assetMaster: buildAssetMasterFixture()
  });

  assert.equal(result.current_drawdown_pct, 0.18);
  assert.equal(result.breached_max_drawdown_limit, true);
});

test("buildPortfolioRiskState ignores positive drawdown values and aggregates downside exposure only", () => {
  const result = buildPortfolioRiskState({
    positions: [
      { name: "易方达沪深300ETF联接C", fund_code: "007339", amount: 10000, status: "active", category: "A股宽基" },
      { name: "博时标普500ETF联接(QDII)C", fund_code: "006075", amount: 10000, status: "active", category: "美股指数/QDII" }
    ],
    signalMatrix: {
      signals: {
        "007339": {
          name: "易方达沪深300ETF联接C",
          indicators: {
            current_drawdown_60d_percent: 20,
            max_drawdown_60d_percent: 20
          }
        },
        "006075": {
          name: "博时标普500ETF联接(QDII)C",
          indicators: {
            current_drawdown_60d_percent: -10,
            max_drawdown_60d_percent: -10
          }
        }
      }
    },
    assetMaster: buildAssetMasterFixture()
  });

  assert.equal(result.weighted_current_drawdown_60d_percent, -10);
  assert.equal(result.current_drawdown_pct, 0.1);
});

test("buildPortfolioRiskState ignores inactive or unmatched positions", () => {
  const result = buildPortfolioRiskState({
    positions: [
      { name: "未知基金", amount: 10000, status: "active", category: "未分类" },
      { name: "易方达沪深300ETF联接C", fund_code: "007339", amount: 5000, status: "pending_profit_effective", category: "A股宽基" }
    ],
    signalMatrix: {
      signals: {
        "007339": {
          name: "易方达沪深300ETF联接C",
          indicators: {
            current_drawdown_60d_percent: -6,
            max_drawdown_60d_percent: -11
          }
        }
      }
    },
    assetMaster: buildAssetMasterFixture()
  });

  assert.equal(result.matched_position_count, 0);
  assert.equal(result.current_drawdown_pct, null);
  assert.equal(result.breached_max_drawdown_limit, false);
});

test("buildPortfolioRiskState exposes standardized blocking fields and concentration breaches", () => {
  const result = buildPortfolioRiskState({
    positions: [
      {
        name: "易方达沪深300ETF联接C",
        fund_code: "007339",
        amount: 12000,
        status: "active",
        category: "A股宽基"
      },
      {
        name: "博时标普500ETF联接(QDII)C",
        fund_code: "006075",
        amount: 14000,
        status: "active",
        category: "美股指数/QDII"
      },
      {
        name: "景顺长城纳斯达克科技市值加权ETF联接(QDII)E",
        fund_code: "019118",
        amount: 12000,
        status: "active",
        category: "美股科技/QDII"
      }
    ],
    signalMatrix: {
      signals: {
        "007339": {
          name: "易方达沪深300ETF联接C",
          indicators: {
            current_drawdown_60d_percent: -5,
            max_drawdown_60d_percent: -11
          }
        },
        "006075": {
          name: "博时标普500ETF联接(QDII)C",
          indicators: {
            current_drawdown_60d_percent: -18,
            max_drawdown_60d_percent: -24
          }
        },
        "019118": {
          name: "景顺长城纳斯达克科技市值加权ETF联接(QDII)E",
          indicators: {
            current_drawdown_60d_percent: -18,
            max_drawdown_60d_percent: -24
          }
        }
      }
    },
    assetMaster: buildAssetMasterFixture(),
    totalAssetsCny: 100000,
    ipsConstraints: {
      drawdown: {
        re_evaluate_pct: 0.08,
        hard_stop_pct: 0.12
      },
      concentration: {
        single_fund_max_pct: 0.1,
        single_theme_max_pct: 0.15,
        high_correlation_max_pct: 0.25
      }
    },
    quantMetrics: {
      risk_model: {
        position_risk_contributions: [
          {
            symbol: "006075",
            name: "博时标普500ETF联接(QDII)C",
            bucket_key: "GLB_MOM",
            bucket_label: "全球动量",
            weight_pct: 14
          },
          {
            symbol: "019118",
            name: "景顺长城纳斯达克科技市值加权ETF联接(QDII)E",
            bucket_key: "GLB_MOM",
            bucket_label: "全球动量",
            weight_pct: 12
          }
        ]
      },
      matrices: {
        correlation_matrix: {
          symbols: ["006075", "019118"],
          matrix: {
            "006075": {
              "019118": 0.91
            },
            "019118": {
              "006075": 0.91
            }
          }
        }
      }
    }
  });

  assert.equal(result.drawdown_status.current_regime, "hard_stop");
  assert.equal(result.single_fund_breaches.length, 3);
  assert.equal(result.theme_breaches.length, 1);
  assert.equal(result.theme_breaches[0].theme_key, "US_GROWTH");
  assert.equal(result.correlation_cluster_breaches.length, 1);
  assert.equal(result.correlation_cluster_breaches[0].combined_weight_pct, 26);
  assert.equal(result.blocking_state.blocked, true);
});

test("buildPortfolioRiskState prefers asset position_limits over generic IPS single-fund limits", () => {
  const assetMaster = buildAssetMasterFixture();
  assetMaster.assets = [
    {
      symbol: "016482",
      name: "兴全恒信债券C",
      bucket: "CASH",
      theme_key: "BOND_CASH",
      position_limits: {
        max_pct_of_total_assets: 0.18
      }
    },
    {
      symbol: "023764",
      name: "华夏恒生互联网科技业ETF联接(QDII)D",
      bucket: "TACTICAL",
      theme_key: "HK_TECH",
      position_limits: {
        max_pct_of_total_assets: 0.1
      }
    }
  ];
  assetMaster.themes.BOND_CASH = { label: "债券现金管理" };
  assetMaster.themes.HK_TECH = { label: "港股互联网科技" };

  const result = buildPortfolioRiskState({
    positions: [
      {
        name: "兴全恒信债券C",
        fund_code: "016482",
        amount: 70000,
        status: "active",
        category: "偏债混合"
      },
      {
        name: "华夏恒生互联网科技业ETF联接(QDII)D",
        fund_code: "023764",
        amount: 72146.33,
        status: "active",
        category: "港股互联网/QDII"
      }
    ],
    signalMatrix: { signals: {} },
    assetMaster,
    totalAssetsCny: 445000,
    ipsConstraints: {
      concentration: {
        single_fund_max_pct: 0.1,
        single_theme_max_pct: 0.15,
        high_correlation_max_pct: 0.25
      }
    }
  });

  assert.equal(result.single_fund_breaches.length, 1);
  assert.equal(result.single_fund_breaches[0].fund_code, "023764");
  assert.equal(result.single_fund_breaches[0].max_pct, 10);
});
