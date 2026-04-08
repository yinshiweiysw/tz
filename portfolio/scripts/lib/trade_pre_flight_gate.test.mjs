import test from "node:test";
import assert from "node:assert/strict";

import { evaluateTradePreFlight } from "./trade_pre_flight_gate.mjs";

function buildIpsConstraintsFixture() {
  return {
    drawdown: {
      re_evaluate_pct: 0.08,
      hard_stop_pct: 0.12
    },
    concentration: {
      single_fund_max_pct: 0.1,
      single_theme_max_pct: 0.15,
      high_correlation_max_pct: 0.25
    },
    cash_floor_pct: 0.15,
    rebalance_trigger_deviation_pp: 0.05
  };
}

function buildAssetMasterFixture() {
  return {
    fallback_bucket_key: "TACTICAL",
    global_constraints: {
      max_drawdown_limit: 0.15,
      absolute_equity_cap: 0.75
    },
    buckets: {
      A_CORE: { label: "A股核心", max: 0.3, risk_role: "core", is_equity_like: true },
      GLB_MOM: { label: "全球动量", max: 0.2, risk_role: "growth", is_equity_like: true },
      TACTICAL: {
        label: "战术刺客",
        max: 0.1,
        risk_role: "tactical",
        is_equity_like: true,
        buy_gate: "frozen"
      },
      HEDGE: { label: "黄金避险", max: 0.15, risk_role: "defensive", is_equity_like: true },
      CASH: { label: "现金防线", min: 0.15, max: 0.45, risk_role: "cash", is_equity_like: false }
    },
    bucket_mapping_rules: [
      {
        bucket_key: "A_CORE",
        category_equals: ["A股宽基", "A股主动"],
        name_patterns: ["沪深300", "量化"]
      },
      {
        bucket_key: "GLB_MOM",
        category_equals: ["美股指数/QDII", "美股科技/QDII"],
        name_patterns: ["标普500", "纳斯达克"]
      },
      {
        bucket_key: "HEDGE",
        category_equals: ["黄金"],
        name_patterns: ["黄金"]
      }
    ]
  };
}

test("blocks buy when tactical sleeve is frozen", () => {
  const result = evaluateTradePreFlight({
    portfolioState: {
      summary: {
        available_cash_cny: 50000,
        total_portfolio_assets_cny: 200000
      },
      positions: []
    },
    proposedTrades: [
      {
        type: "buy",
        fund_code: "513330",
        name: "恒生科技ETF",
        amount_cny: 5000,
        bucket_key: "TACTICAL"
      }
    ],
    assetMaster: buildAssetMasterFixture(),
    ipsConstraints: buildIpsConstraintsFixture(),
    portfolioRiskState: { current_drawdown_pct: 0.04 }
  });

  assert.equal(result.allowed, false);
  assert.match(result.blockingReasons[0], /buy_gate.*frozen/i);
});

test("blocks buy when projected cash would fall below cash floor", () => {
  const result = evaluateTradePreFlight({
    portfolioState: {
      summary: {
        available_cash_cny: 12000,
        total_portfolio_assets_cny: 100000
      },
      positions: []
    },
    proposedTrades: [
      {
        type: "buy",
        fund_code: "007339",
        name: "易方达沪深300ETF联接C",
        amount_cny: 5000,
        bucket_key: "A_CORE"
      }
    ],
    assetMaster: buildAssetMasterFixture(),
    ipsConstraints: buildIpsConstraintsFixture(),
    portfolioRiskState: { current_drawdown_pct: 0.04 }
  });

  assert.equal(result.allowed, false);
  assert.match(result.blockingReasons[0], /cash floor/i);
});

test("blocks buy when projected bucket weight breaches max", () => {
  const result = evaluateTradePreFlight({
    portfolioState: {
      summary: {
        available_cash_cny: 20000,
        total_portfolio_assets_cny: 100000
      },
      positions: [
        {
          name: "易方达沪深300ETF联接C",
          amount: 29000,
          category: "A股宽基",
          status: "active"
        }
      ]
    },
    proposedTrades: [
      {
        type: "buy",
        fund_code: "007339",
        name: "易方达沪深300ETF联接C",
        amount_cny: 3000,
        bucket_key: "A_CORE"
      }
    ],
    assetMaster: buildAssetMasterFixture(),
    ipsConstraints: buildIpsConstraintsFixture(),
    portfolioRiskState: { current_drawdown_pct: 0.04 }
  });

  assert.equal(result.allowed, false);
  assert.match(result.blockingReasons[0], /bucket max/i);
});

test("blocks buy when projected equity exposure breaches absolute cap", () => {
  const assetMaster = buildAssetMasterFixture();
  assetMaster.buckets.A_CORE.max = 0.8;

  const result = evaluateTradePreFlight({
    portfolioState: {
      summary: {
        available_cash_cny: 30000,
        total_portfolio_assets_cny: 100000
      },
      positions: [
        {
          name: "核心仓",
          amount: 73000,
          category: "A股宽基",
          status: "active"
        }
      ]
    },
    proposedTrades: [
      {
        type: "buy",
        fund_code: "007339",
        name: "易方达沪深300ETF联接C",
        amount_cny: 4000,
        bucket_key: "A_CORE"
      }
    ],
    assetMaster,
    ipsConstraints: buildIpsConstraintsFixture(),
    portfolioRiskState: { current_drawdown_pct: 0.04 }
  });

  assert.equal(result.allowed, false);
  assert.match(result.blockingReasons[0], /equity cap/i);
});

test("blocks high beta buys when portfolio drawdown exceeds max limit", () => {
  const result = evaluateTradePreFlight({
    portfolioState: {
      summary: {
        available_cash_cny: 40000,
        total_portfolio_assets_cny: 100000
      },
      positions: []
    },
    proposedTrades: [
      {
        type: "buy",
        fund_code: "006075",
        name: "博时标普500ETF联接C",
        amount_cny: 5000,
        bucket_key: "GLB_MOM"
      }
    ],
    assetMaster: buildAssetMasterFixture(),
    ipsConstraints: buildIpsConstraintsFixture(),
    portfolioRiskState: { current_drawdown_pct: 0.18 }
  });

  assert.equal(result.allowed, false);
  assert.match(result.blockingReasons[0], /drawdown/i);
});

test("rejects sell when current holding is insufficient", () => {
  const result = evaluateTradePreFlight({
    portfolioState: {
      summary: {
        available_cash_cny: 40000,
        total_portfolio_assets_cny: 100000
      },
      positions: [
        {
          name: "易方达沪深300ETF联接C",
          amount: 3000,
          category: "A股宽基",
          status: "active",
          fund_code: "007339"
        }
      ]
    },
    proposedTrades: [
      {
        type: "sell",
        fund_code: "007339",
        name: "易方达沪深300ETF联接C",
        amount_cny: 5000,
        bucket_key: "A_CORE"
      }
    ],
    assetMaster: buildAssetMasterFixture(),
    ipsConstraints: buildIpsConstraintsFixture(),
    portfolioRiskState: { current_drawdown_pct: 0.02 }
  });

  assert.equal(result.allowed, false);
  assert.match(result.blockingReasons[0], /insufficient holding/i);
});

test("allows a compliant core buy", () => {
  const result = evaluateTradePreFlight({
    portfolioState: {
      summary: {
        available_cash_cny: 30000,
        total_portfolio_assets_cny: 100000
      },
      positions: [
        {
          name: "易方达沪深300ETF联接C",
          amount: 20000,
          category: "A股宽基",
          status: "active",
          fund_code: "007339"
        }
      ]
    },
    proposedTrades: [
      {
        type: "buy",
        fund_code: "001917",
        name: "招商量化精选股票A",
        amount_cny: 5000,
        bucket_key: "A_CORE"
      }
    ],
    assetMaster: buildAssetMasterFixture(),
    ipsConstraints: buildIpsConstraintsFixture(),
    portfolioRiskState: { current_drawdown_pct: 0.04 }
  });

  assert.equal(result.allowed, true);
  assert.deepEqual(result.blockingReasons, []);
});

test("blocks buy when projected single fund weight breaches ips single-fund max", () => {
  const result = evaluateTradePreFlight({
    portfolioState: {
      summary: {
        available_cash_cny: 30000,
        total_portfolio_assets_cny: 100000
      },
      positions: [
        {
          name: "易方达沪深300ETF联接C",
          amount: 9000,
          category: "A股宽基",
          status: "active",
          fund_code: "007339"
        }
      ]
    },
    proposedTrades: [
      {
        type: "buy",
        fund_code: "007339",
        name: "易方达沪深300ETF联接C",
        amount_cny: 2000,
        bucket_key: "A_CORE",
        theme_key: "CN_CORE"
      }
    ],
    assetMaster: buildAssetMasterFixture(),
    ipsConstraints: buildIpsConstraintsFixture(),
    portfolioRiskState: { current_drawdown_pct: 0.04 }
  });

  assert.equal(result.allowed, false);
  assert.match(result.blockingReasons.join(" | "), /single fund/i);
});

test("blocks buy when projected theme weight breaches ips single-theme max", () => {
  const result = evaluateTradePreFlight({
    portfolioState: {
      summary: {
        available_cash_cny: 40000,
        total_portfolio_assets_cny: 100000
      },
      positions: [
        {
          name: "博时标普500ETF联接(QDII)C",
          amount: 14000,
          category: "美股指数/QDII",
          status: "active",
          fund_code: "006075",
          theme_key: "GLOBAL_GROWTH"
        }
      ]
    },
    proposedTrades: [
      {
        type: "buy",
        fund_code: "017641",
        name: "摩根标普500指数(QDII)A",
        amount_cny: 2000,
        bucket_key: "GLB_MOM",
        theme_key: "GLOBAL_GROWTH"
      }
    ],
    assetMaster: buildAssetMasterFixture(),
    ipsConstraints: buildIpsConstraintsFixture(),
    portfolioRiskState: { current_drawdown_pct: 0.04 }
  });

  assert.equal(result.allowed, false);
  assert.match(result.blockingReasons.join(" | "), /theme/i);
});

test("blocks non-rebalance buy when rebalance priority mode is active", () => {
  const result = evaluateTradePreFlight({
    portfolioState: {
      summary: {
        available_cash_cny: 40000,
        total_portfolio_assets_cny: 100000
      },
      positions: [],
      rebalance_mode: "priority",
      rebalance_targets: {
        allowed_buy_bucket_keys: ["A_CORE"]
      }
    },
    proposedTrades: [
      {
        type: "buy",
        fund_code: "006075",
        name: "博时标普500ETF联接(QDII)C",
        amount_cny: 3000,
        bucket_key: "GLB_MOM"
      }
    ],
    assetMaster: buildAssetMasterFixture(),
    ipsConstraints: buildIpsConstraintsFixture(),
    portfolioRiskState: { current_drawdown_pct: 0.04 }
  });

  assert.equal(result.allowed, false);
  assert.match(result.blockingReasons.join(" | "), /rebalance priority/i);
});

test("single fund concentration breach is reported once even when fund has both code and name keys", () => {
  const result = evaluateTradePreFlight({
    portfolioState: {
      summary: {
        available_cash_cny: 30000,
        total_portfolio_assets_cny: 100000
      },
      positions: [
        {
          name: "易方达沪深300ETF联接C",
          amount: 9000,
          category: "A股宽基",
          status: "active",
          fund_code: "007339"
        }
      ]
    },
    proposedTrades: [
      {
        type: "buy",
        fund_code: "007339",
        name: "易方达沪深300ETF联接C",
        amount_cny: 2000,
        bucket_key: "A_CORE"
      }
    ],
    assetMaster: buildAssetMasterFixture(),
    ipsConstraints: buildIpsConstraintsFixture(),
    portfolioRiskState: { current_drawdown_pct: 0.04 }
  });

  const singleFundReasons = result.blockingReasons.filter((reason) => /single fund/i.test(reason));
  assert.equal(singleFundReasons.length, 1);
});

test("characterization: pending sell cash does not relax cash floor before settlement", () => {
  const result = evaluateTradePreFlight({
    portfolioState: {
      summary: {
        available_cash_cny: 15000,
        total_portfolio_assets_cny: 100000
      },
      positions: [
        {
          name: "易方达沪深300ETF联接C",
          amount: 85000,
          category: "A股宽基",
          status: "active",
          fund_code: "007339"
        }
      ]
    },
    proposedTrades: [
      {
        type: "sell",
        fund_code: "007339",
        name: "易方达沪深300ETF联接C",
        amount_cny: 10000,
        bucket_key: "A_CORE",
        cash_arrived: false
      },
      {
        type: "buy",
        fund_code: "518880",
        name: "黄金ETF联接",
        amount_cny: 5000,
        bucket_key: "HEDGE"
      }
    ],
    assetMaster: buildAssetMasterFixture(),
    ipsConstraints: buildIpsConstraintsFixture(),
    portfolioRiskState: { current_drawdown_pct: 0.01 }
  });

  assert.equal(result.allowed, false);
  assert.match(result.blockingReasons.join(" | "), /cash floor/i);
});

test("uses canonical trade_available_cash before compatibility available_cash alias", () => {
  const result = evaluateTradePreFlight({
    portfolioState: {
      summary: {
        trade_available_cash_cny: 10000,
        available_cash_cny: 90000,
        total_portfolio_assets_cny: 100000
      },
      positions: []
    },
    proposedTrades: [
      {
        type: "buy",
        fund_code: "007339",
        name: "易方达沪深300ETF联接C",
        amount_cny: 5000,
        bucket_key: "A_CORE"
      }
    ],
    assetMaster: buildAssetMasterFixture(),
    ipsConstraints: buildIpsConstraintsFixture(),
    portfolioRiskState: { current_drawdown_pct: 0.04 }
  });

  assert.equal(result.allowed, false);
  assert.match(result.blockingReasons.join(" | "), /cash floor/i);
  assert.equal(result.metadata.projected_available_cash_cny, 5000);
});
