// Rule-driven entries — the mirror image of the hard stop.
// Measured on the live model, the "will this move continue" answer sits at median 0.34
// across 334 tape events and never reached the 0.6 gate, while the news materiality gate
// never saw 0.5, so an absolute Jev threshold keeps the book permanently flat. These
// rules read the same tape facts the model is shown and open positions on their own.
//
// Thresholds come from a 4-day 1m replay over 5 pairs (n≈100 signals each, one signal
// per 90 min per coin). The earlier "falling knife" leg (RSI oversold *and* price in the
// bottom 35% of the 24h range) produced 0.95 signals/coin/day at -0.14% after 30 min:
// both rare and loss-making. Short-term oversold nearly always happens *inside* an
// up-range day, so the leg became a pullback-in-strength buy at 4.9 signals/day +0.32%.

export const ENTRY_DEFAULTS = {
  pullRsi: 34,          // 强势回调：RSI14 ≤ 34
  pullRangePosMin: 50,  // 且仍站在 24 小时区间的上半部（趋势未破）
  pullDrop30: 0.8,      // 且近 30 分钟回撤 ≥ 0.8%
  breakoutRise60: 1.0,  // 突破：近 1 小时涨幅 ≥ 1%
  breakoutVolRatio: 1.4, // 且量能放大 ≥ 1.4 倍
  breakoutRangePos: 65, // 且处在 24 小时区间的上沿
  breakoutRsiMax: 70,   // 但还没到极度追高的地步
  buyPct: 0.10,         // 单笔名义额 = 权益的 10%
  maxPositions: 3,      // 最多同时持有 3 个币种
};

// Precedence: a pullback inside an uptrend is the setup we trust more, so a coin that
// satisfies both legs is treated as the pullback.
export function entryKind(f, t = ENTRY_DEFAULTS) {
  if (f.held || f.rsi14 == null || f.rangePos == null) return null; // indicators not warmed up
  const pullback = f.rsi14 <= t.pullRsi
    && f.rangePos >= t.pullRangePosMin
    && (f.pct30 ?? 0) <= -t.pullDrop30;
  if (pullback) return "pullback";
  const breakout = (f.pct60 ?? 0) >= t.breakoutRise60
    && (f.volRatio ?? 0) >= t.breakoutVolRatio
    && f.rangePos >= t.breakoutRangePos
    && f.rsi14 <= t.breakoutRsiMax;
  return breakout ? "breakout" : null;
}

// Breakouts are bought smaller: that side bleeds when the move fades.
export function entryNotional(kind, equity, t = ENTRY_DEFAULTS) {
  return equity > 0 ? equity * t.buyPct * (kind === "breakout" ? 0.75 : 1) : 0;
}
