// Position risk rules, kept pure so they can be unit-tested without a feed.
// Precedence matters: a stop must win even when take-profit/trailing also apply.

export const RISK_DEFAULTS = {
  stopPct: 2,      // 浮亏达到该百分比 → 硬止损（不经 Jev）
  tpPct: 6,        // 浮盈达到该百分比 → 请 Jev 评估是否落袋
  trailArmPct: 2,  // 浮盈先超过这个值，移动止盈才武装
  trailPct: 1.5,   // 从峰值回吐这个值 → 请 Jev 评估
  reviewMs: 15 * 60000,
};

// facts: { pnlPct, peakPnlPct, giveBackPct, heldMs }
export function riskKind(facts, t = RISK_DEFAULTS) {
  const { pnlPct, peakPnlPct, giveBackPct, heldMs } = facts;
  if (pnlPct == null) return null;
  if (pnlPct <= -t.stopPct) return "stop";
  if (pnlPct >= t.tpPct) return "take-profit";
  if (peakPnlPct >= t.trailArmPct && giveBackPct >= t.trailPct) return "trailing";
  if (heldMs != null && heldMs >= t.reviewMs) return "review";
  return null;
}

// How much of the lot the rule takes off the table. The stop is total by design:
// a partial stop still leaves the position exposed to the move it just flagged.
export const RISK_FULL_EXIT = new Set(["stop"]);
