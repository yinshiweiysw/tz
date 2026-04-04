import test from "node:test";
import assert from "node:assert/strict";

import {
  isNoisyInstitutionalStory,
  selectInstitutionalStories
} from "./research_story_filter.mjs";

test("isNoisyInstitutionalStory filters live-desk style headlines", () => {
  assert.equal(
    isNoisyInstitutionalStory({ title: "午评：三大指数震荡，盘面直播继续追踪" }),
    true
  );
  assert.equal(
    isNoisyInstitutionalStory({ title: "涨停分析：存储芯片概念午后快速拉升" }),
    true
  );
  assert.equal(
    isNoisyInstitutionalStory({ title: "央行官员就货币政策与通胀路径发表讲话" }),
    false
  );
});

test("selectInstitutionalStories keeps high-signal headlines and excludes noisy fillers", () => {
  const result = selectInstitutionalStories(
    [
      { title: "午评：创业板震荡，盘面直播更新中", content: "" },
      { title: "统计局公布制造业PMI，经济修复斜率边际改善", content: "" },
      { title: "涨停分析：多只题材股午后异动", content: "" },
      { title: "美联储官员称降息仍取决于通胀回落", content: "" }
    ],
    {
      limit: 3,
      focusKeywords: ["降息", "通胀", "PMI"],
      authoritativeKeywords: ["统计局", "美联储"]
    }
  );

  assert.equal(result.length, 2);
  assert.ok(result.every((item) => !/午评|盘面直播|涨停分析/.test(item.title)));
  assert.ok(result.some((item) => item.title.includes("统计局")));
});
