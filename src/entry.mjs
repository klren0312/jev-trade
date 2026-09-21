// Rule-driven entries — the mirror image of the hard stop.
// Measured on the live model, a "will this move continue" answer tops out around
// 0.47 across 64 tape events while the news materiality gate never saw 0.5, so an
// absolute Jev threshold keeps the book permanently flat. These rules read the same
// tape facts the model is shown and are allowed to open a position on their own.

export const ENTRY_DEFAULTS = {
  dipRsi: 34,          // 超卖：RSI14 ≤ 34
  dipRangePos: 35,     // 且处在 24 小时区间的下沿 35% 以内
  dipDrop30: 1.0,      // 且近 30 分钟跌幅 ≥ 1%
  breakoutRise60: 1.0, // 突破：近 1 小时涨幅 ≥ 1%
  breakoutVolRatio: 1.4, // 且量能放大 ≥ 1.4 倍
  breakoutRangePos: 65, // 且处在 24 小时区间的上沿
  breakoutRsiMax: 70,   // 但还没到极度追高的地步
  buyPct: 0.10,        // 单笔名义额 = 权益的 10%
  maxPositions: 3,     // 最多同时持有 3 个币种
};

// Precedence: buying weakness at the bottom of the range is the setup we trust more,
// so a coin that somehow satisfies both is treated as the dip.
export function entryKind(f, t = ENTRY_DEFAULTS) {
  if (f.held || f.rsi14 == null || f.rangePos == null) return null; // indicators not warmed up
  const dip = f.rsi14 <= t.dipRsi
    && f.rangePos <= t.dipRangePos
    && (f.pct30 ?? 0) <= -t.dipDrop30;
  if (dip) return "dip";
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
