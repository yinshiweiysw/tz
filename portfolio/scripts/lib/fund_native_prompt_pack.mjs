function stringifyContext(context = {}) {
  return JSON.stringify(context, null, 2);
}

export function buildFundNativeMessages({ context = {} } = {}) {
  const system = "你是 TradingAgents 的基金原生兼容模式。你保留原 TradingAgents 多角色交易委员会结构，但分析对象是中国基金，不是股票。你必须使用基金申购/赎回/尾盘复核语言，所有输出都是 review_only，不写账本、不生成订单。";

  const rolePack = `
请按以下 TradingAgents 基金化角色完成分析，并最后只输出一个 JSON 对象：

1. Fund Style Analyst：判断基金所属风格/地区/因子环境是否顺风，例如 A 股成长、美股科技、黄金、港股红利、债券防守。
2. Theme Sentiment Analyst：判断主题热度、同类拥挤度、资金偏好和重复暴露。
3. Macro/Event Analyst：判断宏观、市场事件、QDII 时区/汇率/前收参考对基金的影响。
4. Fund Profile Analyst：分析基金经理、基金公司、规模、费率、类型、最新季报重仓；指数基金不要胡乱评价基金经理能力。
5. Keep/Add Advocate：论证维持、可考虑买入、追加申购或继续观察的理由。
6. Reduce/Replace Advocate：论证可考虑卖出一部分、清仓赎回、替换或暂停动作的理由。
7. Fund Research Judge：总结基金是否值得继续留在组合、进入深看或进入动作备选。
8. Fund Allocation Reviewer：把结论转成基金配置动作，只能使用：可考虑买入、先不动、深看、可考虑卖出一部分、可考虑退出、可考虑替换、今日暂停动作。
9. Growth Allocation Risk View：评估高波进攻仓位能否承担。
10. Defense / NAV Confirmation View：评估确认净值、QDII 滞后、资料陈旧、亏损扩大和现金防线。
11. Balanced Allocation View：评估仓位是否已足、是否重复暴露、是否只适合观察。
12. Fund Committee Decision：输出最终基金委员会结论。

禁止使用股票盘中执行语言：市价、开盘清仓、盘中止损、挂单、盘口、日内交易。可以使用基金语言：申购、追加申购、部分赎回、清仓赎回、止损式减仓、尾盘前复核、T+1/T+2 确认。

输出必须是 JSON：
{
  "verdict": "申购候选|维持|深看|部分赎回候选|清仓赎回候选|替换候选|暂停动作",
  "riskLight": "green|yellow|red",
  "confidence": 0.0,
  "oneLine": "一句话结论",
  "styleEnvironment": { "label": "...", "reason": "..." },
  "fundQuality": { "label": "...", "reason": "..." },
  "lookThrough": { "label": "...", "reason": "..." },
  "peerRole": { "label": "...", "reason": "..." },
  "riskReview": { "riskLight": "green|yellow|red", "notes": ["..."] },
  "execution": { "suggestedAmountRangeCny": null, "timingNote": "尾盘前复核，按基金净值确认" },
  "uncertainties": ["..."],
  "rawEvidence": "保留各角色要点的 Markdown 摘要"
}`;

  const user = `基金研究上下文如下：\n\n${context.promptContext ?? stringifyContext(context)}\n\n完整结构化上下文：\n${stringifyContext(context)}`;

  return [
    { role: "system", content: system },
    { role: "user", content: `${rolePack}\n\n${user}` }
  ];
}
