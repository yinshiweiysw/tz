import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";

import { buildMarketTopicsPayload } from "./market_topics.mjs";

test("buildMarketTopicsPayload aggregates latest reports and key events", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "market-topics-"));
  await Promise.all([
    mkdir(path.join(portfolioRoot, "data"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "market_briefs"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "market_pulses"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "daily_briefs"), { recursive: true })
  ]);

  const marketBriefPath = path.join(portfolioRoot, "market_briefs", "2026-04-24-market-brief.md");
  const pulsePath = path.join(portfolioRoot, "market_pulses", "2026-04-24-noon-pulse.md");
  const dailyBriefPath = path.join(portfolioRoot, "daily_briefs", "2026-04-24-daily-brief.md");
  const eventPath = path.join(portfolioRoot, "data", "high_impact_event_calendar.json");
  const syncStatusPath = path.join(portfolioRoot, "data", "market_topics_sync_status.json");

  await writeFile(
    path.join(portfolioRoot, "state-manifest.json"),
    `${JSON.stringify(
      {
        canonical_entrypoints: {
          latest_market_brief: marketBriefPath,
          latest_noon_market_pulse: pulsePath,
          latest_daily_brief: dailyBriefPath,
          high_impact_event_calendar: eventPath,
          market_topics_sync_status: syncStatusPath
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    marketBriefPath,
    "# 2026-04-24 市场日报\n\nA 股成长方向继续偏强，市场更像结构轮动。\n\n- 科技成长偏强\n- 红利和防守偏中性\n",
    "utf8"
  );
  await writeFile(
    pulsePath,
    "# 2026-04-24 午盘脉冲\n\n盘中热点集中在通信设备和电子。\n\n- 通信设备领涨\n- 电子链延续强势\n",
    "utf8"
  );
  await writeFile(
    dailyBriefPath,
    "# 2026-04-24 组合日报\n\n组合今日以观察为主。\n",
    "utf8"
  );
  await writeFile(
    eventPath,
    `${JSON.stringify(
      {
        events: [
          {
            eventId: "us-cpi-2026-04",
            title: "US CPI",
            scheduledAt: "2026-04-25T20:30:00+08:00",
            importance: "high"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(syncStatusPath, "{\"status\":\"synced\",\"entryCount\":3}\n", "utf8");

  const payload = await buildMarketTopicsPayload({
    portfolioRoot,
    accountId: "main",
    now: new Date("2026-04-24T12:30:00+08:00")
  });

  assert.equal(payload.accountId, "main");
  assert.match(payload.headline, /盘中热点|结构轮动|偏强/);
  assert.equal(payload.reports.length, 3);
  assert.equal(payload.primaryAsOfLabel, "今日报告 · 2026-04-24");
  assert.equal(payload.syncStatus.status, "synced");
  assert.equal(payload.reports.every((item) => item.stalenessLabel === "same_day"), true);
  assert.equal(payload.keyEvents[0].eventId, "us-cpi-2026-04");
  assert.equal(
    payload.themeHighlights.some((item) => /科技成长偏强|通信设备领涨/.test(item.text)),
    true
  );
});

test("buildMarketTopicsPayload labels carried-forward previous-trading-day reports and prefers latest as-of", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "market-topics-stale-"));
  await Promise.all([
    mkdir(path.join(portfolioRoot, "market_briefs"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "market_pulses"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "daily_briefs"), { recursive: true })
  ]);

  const morningPath = path.join(portfolioRoot, "market_pulses", "2026-04-24-morning.md");
  const closePath = path.join(portfolioRoot, "market_pulses", "2026-04-23-close.md");
  const briefPath = path.join(portfolioRoot, "market_briefs", "2026-04-24-market.md");
  await writeFile(
    path.join(portfolioRoot, "state-manifest.json"),
    `${JSON.stringify(
      {
        canonical_entrypoints: {
          latest_morning_market_pulse: morningPath,
          latest_close_market_pulse: closePath,
          latest_market_brief: briefPath
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(morningPath, "# 2026-04-24 早盘脉冲\n\n## 一句话结论\n\n- 早盘成长方向占优。\n", "utf8");
  await writeFile(closePath, "# 2026-04-23 收盘脉冲\n\n## 一句话结论\n\n- 昨日收盘偏防守。\n", "utf8");
  await writeFile(briefPath, "# 2026-04-24 市场日报\n\n## Active Market Driver\n\n- 主线：AI 硬件链强于大盘。\n", "utf8");

  const payload = await buildMarketTopicsPayload({
    portfolioRoot,
    accountId: "main",
    now: new Date("2026-04-27T09:30:00+08:00")
  });

  assert.equal(payload.asOf, "2026-04-24");
  assert.equal(payload.primaryAsOfLabel, "沿用上一交易日 · 2026-04-24");
  assert.equal(payload.reports[0].asOf, "2026-04-24");
  assert.equal(payload.reports[0].stalenessLabel, "carry_forward_previous_trading_day");
  assert.match(payload.headline, /早盘成长|AI 硬件/);
});

test("buildMarketTopicsPayload prefers market mainline and sector-strength sections over runtime boilerplate", async () => {
  const portfolioRoot = await mkdtemp(path.join(os.tmpdir(), "market-topics-structured-"));
  await Promise.all([
    mkdir(path.join(portfolioRoot, "market_briefs"), { recursive: true }),
    mkdir(path.join(portfolioRoot, "market_pulses"), { recursive: true })
  ]);

  const marketBriefPath = path.join(portfolioRoot, "market_briefs", "2026-04-24-market-brief.md");
  const pulsePath = path.join(portfolioRoot, "market_pulses", "2026-04-24-close-pulse.md");

  await writeFile(
    path.join(portfolioRoot, "state-manifest.json"),
    `${JSON.stringify(
      {
        canonical_entrypoints: {
          latest_market_brief: marketBriefPath,
          latest_close_market_pulse: pulsePath
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    marketBriefPath,
    [
      "# 2026-04-24 市场日报",
      "",
      "- 账户：main",
      "- 视图口径：canonical_view（默认正式口径）",
      "",
      "## Active Market Driver",
      "",
      "- 主线：中东停火预期重估全球风险偏好",
      "- 预期差：风险偏好修复还没走完。",
      "",
      "## 市场温度补充",
      "",
      "- 市场定性：A股整体偏震荡；港股高波资产仍偏弱",
      "- 驱动线索：地缘与油价仍是关键观察变量"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    pulsePath,
    [
      "# 2026-04-24 收盘市场脉冲",
      "",
      "- 数据时点：北京时间 2026-04-24 15:36 左右。",
      "",
      "## 一句话结论",
      "",
      "- 今天收盘更像半导体修复，不是全面 risk-on。",
      "",
      "## 2. 收盘跨资产",
      "",
      "- A股：科创和半导体强于大盘。",
      "- 港股：港股科技靠芯片链反弹。",
      "",
      "## 3. 强弱主题",
      "",
      "- 最强：半导体、锂电。",
      "- 最弱：电力、影视院线。",
      "- 结构结论：成长内部轮动，资金没有全面扩散。"
    ].join("\n"),
    "utf8"
  );

  const payload = await buildMarketTopicsPayload({
    portfolioRoot,
    accountId: "main",
    now: new Date("2026-04-24T16:00:00+08:00")
  });

  assert.match(payload.headline, /半导体修复/);
  assert.equal(payload.summaryNote, "成长内部轮动，资金没有全面扩散。");
  assert.deepEqual(payload.themeHighlights.map((item) => item.label).slice(0, 5), [
    "主线",
    "最强",
    "最弱",
    "A股",
    "港股"
  ]);
  assert.equal(payload.themeHighlights[0].text, "中东停火预期重估全球风险偏好");
});
