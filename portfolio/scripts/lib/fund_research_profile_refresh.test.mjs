import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  normalizeBaseInfo,
  normalizeManagers,
  parseF10Holdings,
  refreshFundResearchProfiles
} from "./fund_research_profile_refresh.mjs";

function response(payload) {
  return {
    ok: true,
    status: 200,
    text: async () => typeof payload === "string" ? payload : JSON.stringify(payload)
  };
}

test("normalizers extract fund size, fees, managers and f10 holdings", () => {
  const base = normalizeBaseInfo({
    Datas: {
      SHORTNAME: "宝盈纳斯达克100指数发起(QDII)A人民币",
      FTYPE: "指数型-海外股票",
      JJGS: "宝盈基金",
      JJJL: "蔡丹",
      ENDNAV: "568119670.83",
      FSRQ: "2026-04-24",
      SOURCERATE: "1.20%",
      RATE: "0.12%",
      SOURCEHRG: "1.00%",
      MINSG: "10",
      SGZT: "开放申购",
      SHZT: "开放赎回"
    }
  });
  const manager = normalizeManagers({
    Datas: [{ MGRID: "1", MGRNAME: "蔡丹", FEMPDATE: "2024-03-20", DAYS: 100 }]
  }, {
    Datas: [{ MGRNAME: "蔡丹", EDUCATION: "硕士", RESUME: "基金经理简介" }]
  });
  const holdings = parseF10Holdings(
    "截止至：<font class='px12'>2026-03-31</font><table><tr><td>1</td><td>NVDA</td><td>英伟达</td><td>--</td><td>--</td><td>资讯</td><td>8.20%</td><td>1</td><td>100</td></tr></table>"
  );

  assert.equal(base.fundCompany, "宝盈基金");
  assert.equal(base.fundSize.endNavYi, 5.68);
  assert.equal(base.fees.discountedSubscriptionRate, "0.12%");
  assert.equal(manager.primaryManager.name, "蔡丹");
  assert.equal(manager.primaryEducation, "硕士");
  assert.equal(holdings.asOf, "2026-03-31");
  assert.equal(holdings.holdings[0].name, "英伟达");
  assert.equal(holdings.holdings[0].weightPct, 8.2);
});

test("refreshFundResearchProfiles writes auto profiles from public fund data", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "fund-research-refresh-"));
  await Promise.all([
    mkdir(path.join(portfolioRoot, "state"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "config"), { recursive: true })
  ]);
  await writeFile(path.join(portfolioRoot, "state", "portfolio_state.json"), JSON.stringify({
    positions: [
      {
        code: "019736",
        name: "宝盈纳斯达克100指数发起(QDII)A人民币",
        amount: 10000,
        category: "美股科技/QDII"
      }
    ]
  }), "utf8");
  await writeFile(path.join(portfolioRoot, "config", "asset_master.json"), JSON.stringify({
    assets: [
      {
        symbol: "019736",
        name: "宝盈纳斯达克100指数发起(QDII)A人民币",
        market: "US",
        bucket: "GLB_MOM"
      }
    ]
  }), "utf8");

  const fetchFn = async (url) => {
    const text = String(url);
    if (text.includes("FundBaseTypeInformation")) {
      return response({ Datas: {
        SHORTNAME: "宝盈纳斯达克100指数发起(QDII)A人民币",
        FTYPE: "指数型-海外股票",
        JJGS: "宝盈基金",
        JJJL: "蔡丹",
        ENDNAV: "568119670.83",
        FSRQ: "2026-04-24",
        SOURCERATE: "1.20%",
        RATE: "0.12%",
        SGZT: "开放申购",
        SHZT: "开放赎回"
      } });
    }
    if (text.includes("FundManagerList")) {
      return response({ Datas: [{ MGRID: "1", MGRNAME: "蔡丹", FEMPDATE: "2024-03-20", DAYS: 100 }] });
    }
    if (text.includes("FundMangerDetail")) {
      return response({ Datas: [{ MGRID: "1", MGRNAME: "蔡丹", EDUCATION: "硕士", RESUME: "简介" }] });
    }
    if (text.includes("FundMNInverstPosition")) {
      return response({ Datas: { fundStocks: [
        { GPDM: "NVDA", GPJC: "英伟达", JZBL: "8.2", PCTNVCHGTYPE: "减持", PCTNVCHG: "-0.33", NEWTEXCH: "105" }
      ] } });
    }
    return response("var apidata={ content:\"\",arryear:[],curyear:2026};");
  };

  const result = await refreshFundResearchProfiles({
    portfolioRoot,
    fetchFn,
    now: new Date("2026-04-28T10:00:00+08:00")
  });
  const payload = JSON.parse(await readFile(result.outputPath, "utf8"));
  const profile = payload.profiles["019736"];

  assert.equal(payload.syncStatus.status, "ready");
  assert.equal(profile.fundCompany, "宝盈基金");
  assert.equal(profile.analysisTemplate, "qdii_index_fund");
  assert.equal(profile.manager.name, "蔡丹");
  assert.equal(profile.topHoldings[0].name, "英伟达");
  assert.equal(profile.holdingLookthroughStatus, "latest_quarter_holdings");
});

test("refreshFundResearchProfiles classifies QDII active and commodity funds separately", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "fund-research-template-"));
  await Promise.all([
    mkdir(path.join(portfolioRoot, "state"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "config"), { recursive: true })
  ]);
  await writeFile(path.join(portfolioRoot, "state", "portfolio_state.json"), JSON.stringify({
    positions: [
      {
        code: "017204",
        name: "华宝海外科技股票(QDII-LOF)C",
        amount: 10000,
        category: "海外科技/QDII"
      },
      {
        code: "025162",
        name: "国泰大宗商品(QDII-LOF)D",
        amount: 8000,
        category: "大宗商品/QDII"
      }
    ]
  }), "utf8");
  await writeFile(path.join(portfolioRoot, "config", "asset_master.json"), JSON.stringify({
    assets: [
      { symbol: "017204", name: "华宝海外科技股票(QDII-LOF)C", market: "US", bucket: "GLB_MOM" },
      { symbol: "025162", name: "国泰大宗商品(QDII-LOF)D", market: "GLB", bucket: "HEDGE" }
    ]
  }), "utf8");
  await writeFile(path.join(portfolioRoot, "config", "fund_research_profiles.json"), JSON.stringify({
    profiles: {
      "017204": {
        analysisTemplate: "qdii_fof_fund",
        dueDiligenceFocus: ["旧 FOF 焦点不应在模板变化后继续沿用"]
      },
      "025162": {
        sourceMode: "eastmoney_sync",
        analysisTemplate: "qdii_commodity_fund",
        dueDiligenceFocus: ["旧自动焦点不应在刷新后继续沿用"]
      }
    }
  }), "utf8");

  const baseByCode = {
    "017204": {
      SHORTNAME: "华宝海外科技股票(QDII-LOF)C",
      FTYPE: "QDII-普通股票",
      JJGS: "华宝基金",
      JJJL: "周晶,杨洋,赵启元",
      ENDNAV: "123000000.00",
      FSRQ: "2026-04-24"
    },
    "025162": {
      SHORTNAME: "国泰大宗商品(QDII-LOF)D",
      FTYPE: "QDII-商品",
      JJGS: "国泰基金",
      JJJL: "朱丹",
      ENDNAV: "456000000.00",
      FSRQ: "2026-04-24"
    }
  };

  const fetchFn = async (url) => {
    const text = String(url);
    const code = new URL(text).searchParams.get("FCODE") ?? new URL(text).searchParams.get("code");
    if (text.includes("FundBaseTypeInformation")) {
      return response({ Datas: baseByCode[code] });
    }
    if (text.includes("FundManagerList")) {
      return response({ Datas: [{ MGRID: "1", MGRNAME: baseByCode[code]?.JJJL, FEMPDATE: "2024-01-01", DAYS: 100 }] });
    }
    if (text.includes("FundMangerDetail")) {
      return response({ Datas: [{ MGRID: "1", MGRNAME: baseByCode[code]?.JJJL, EDUCATION: "硕士", RESUME: "简介" }] });
    }
    if (text.includes("FundMNInverstPosition") && code === "017204") {
      return response({ Datas: { fundStocks: [
        { GPDM: "NVDA", GPJC: "英伟达", JZBL: "0.08", NEWTEXCH: "105" }
      ] } });
    }
    if (text.includes("FundMNInverstPosition")) {
      return response({ Datas: { fundStocks: [] } });
    }
    return response("var apidata={ content:\"\",arryear:[],curyear:2026};");
  };

  const result = await refreshFundResearchProfiles({
    portfolioRoot,
    fetchFn,
    now: new Date("2026-04-28T10:00:00+08:00")
  });
  const profiles = result.payload.profiles;

  assert.equal(profiles["017204"].analysisTemplate, "qdii_active_fund");
  assert.equal(profiles["017204"].holdingLookthroughStatus, "latest_quarter_holdings");
  assert.doesNotMatch(profiles["017204"].dueDiligenceFocus.join(" "), /旧 FOF/);
  assert.match(profiles["017204"].dueDiligenceFocus.join(" "), /海外主题|基金经理|QDII/);
  assert.equal(profiles["025162"].analysisTemplate, "qdii_commodity_fund");
  assert.equal(profiles["025162"].holdingLookthroughStatus, "theme_only");
  assert.doesNotMatch(profiles["025162"].dueDiligenceFocus.join(" "), /旧自动焦点/);
  assert.match(profiles["025162"].dueDiligenceFocus.join(" "), /商品|黄金|对冲/);
});
