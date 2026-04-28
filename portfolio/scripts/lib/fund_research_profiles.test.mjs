import test from "node:test";
import assert from "node:assert/strict";

import { resolveFundResearchProfile } from "./fund_research_profiles.mjs";

test("resolveFundResearchProfile uses configured fund research without inventing unloaded holdings", () => {
  const profile = resolveFundResearchProfile({
    fundCode: "023764",
    fundName: "华夏恒生互联网科技业ETF联接(QDII)D",
    bucket: "TACTICAL",
    factorProfile: {
      primaryFactor: "CHINA_INTERNET",
      primaryFactorLabel: "中概/港股互联网",
      region: "HK"
    },
    researchProfilesConfig: {
      asOf: "2026-04-28",
      profiles: {
        "023764": {
          fundCompany: "华夏基金",
          fundType: "ETF联接基金/QDII",
          underlyingIndexOrTheme: "恒生互联网科技业",
          holdingLookthroughStatus: "theme_only",
          holdingsAsOf: "2026-03-31",
          topIndustries: ["港股互联网", "平台经济"],
          limitations: ["尚未加载最新季报重仓股。"]
        }
      }
    }
  });

  assert.equal(profile.source, "fund_research_profiles");
  assert.equal(profile.fundCompany, "华夏基金");
  assert.equal(profile.holdingsAsOf, "2026-03-31");
  assert.equal(profile.lookthrough.status, "theme_only");
  assert.deepEqual(profile.lookthrough.topIndustries.slice(0, 2), ["港股互联网", "平台经济"]);
  assert.deepEqual(profile.lookthrough.topHoldings, []);
  assert.match(profile.limitations.join(" "), /尚未加载/);
});

test("resolveFundResearchProfile infers a safe fallback profile when no research file exists", () => {
  const profile = resolveFundResearchProfile({
    fundCode: "019736",
    fundName: "宝盈纳斯达克100指数发起(QDII)A人民币",
    bucket: "GLB_MOM",
    position: { category: "美股科技/QDII" },
    factorProfile: {
      primaryFactor: "US_TECH",
      primaryFactorLabel: "美股科技",
      region: "US"
    }
  });

  assert.equal(profile.source, "inferred_local_metadata");
  assert.equal(profile.fundType, "指数/指数增强基金");
  assert.equal(profile.underlyingIndexOrTheme, "美股科技/纳斯达克");
  assert.equal(profile.lookthrough.status, "not_loaded");
  assert.match(profile.limitations.join(" "), /不得编造/);
});
