function buildShanghaiDateTime(dateText, timeText) {
  return new Date(`${dateText}T${timeText}+08:00`);
}

const MARKET_PULSE_SESSION_CONFIG = {
  morning: {
    title: "金融早报",
    actionLabel: "开盘前计划",
    hint: "先看隔夜风险资产、期货和黄金，再决定今天是否允许按计划执行基金交易。",
    anchorTime: "08:30:00"
  },
  noon: {
    title: "金融午报",
    actionLabel: "午间观察",
    hint: "先看指数跌幅是否收敛、热点是否扩散；午间默认只观察，不把短线波动直接转化成交易动作。",
    anchorTime: "12:00:00"
  },
  close: {
    title: "金融晚报",
    actionLabel: "下一交易日判断",
    hint: "先看收盘结构和晚间外盘，再判断下一交易日是否允许开下一笔。",
    anchorTime: "16:00:00"
  }
};

export function buildMarketPulseSessionContext({ session = "close", dateText, now = null } = {}) {
  const normalizedSession = String(session ?? "close").trim().toLowerCase();
  const config = MARKET_PULSE_SESSION_CONFIG[normalizedSession] ?? MARKET_PULSE_SESSION_CONFIG.close;
  const referenceNow =
    now instanceof Date && Number.isFinite(now.getTime())
      ? now
      : buildShanghaiDateTime(dateText, config.anchorTime);

  return {
    session: normalizedSession in MARKET_PULSE_SESSION_CONFIG ? normalizedSession : "close",
    ...config,
    referenceNow
  };
}
