// Price indicators computed from closed candles — the raw material for
// decisions that need no news at all.

export function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  if (!gain) return 0;
  if (!loss) return 100;
  return 100 - 100 / (1 + gain / loss);
}

export function volRatio(bars, lookback = 20) {
  if (bars.length < lookback + 1) return null;
  const last = bars[bars.length - 1].qv;
  const base = bars.slice(-1 - lookback, -1);
  const mean = base.reduce((s, b) => s + b.qv, 0) / base.length;
  return mean ? last / mean : null;
}

// Average 1m bar range as % of price: how much noise is normal right now.
export function ampPct(bars, period = 14) {
  const use = bars.slice(-period);
  if (!use.length) return null;
  const px = use[use.length - 1].c;
  return (use.reduce((s, b) => s + (b.h - b.l), 0) / use.length / px) * 100;
}

export function rangePos(px, high, low) {
  if (!(high > low)) return null;
  return ((px - low) / (high - low)) * 100;
}

export function slopePct(closes, mins) {
  if (closes.length < mins + 1) return null;
  const a = closes[closes.length - 1 - mins], b = closes[closes.length - 1];
  return a ? ((b / a - 1) * 100) : null;
}
