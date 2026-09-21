import { test } from "node:test";
import assert from "node:assert/strict";

import { entryKind, entryNotional, ENTRY_DEFAULTS } from "../src/entry.mjs";
import { momentumAction, positionSize } from "../src/strategy.mjs";

const t = ENTRY_DEFAULTS;
const kind = (f) => entryKind(f, t);

test("dip: oversold at the bottom of the 24h range after a real drop", () => {
  assert.equal(kind({ rsi14: 28, rangePos: 18, pct30: -1.6, pct60: -2.2, volRatio: 1.0, held: false }), "dip");
  // each leg alone is not enough
  assert.equal(kind({ rsi14: 28, rangePos: 80, pct30: -1.6, pct60: -2.2, volRatio: 1.0, held: false }), null);
  assert.equal(kind({ rsi14: 28, rangePos: 18, pct30: -0.4, pct60: -2.2, volRatio: 1.0, held: false }), null);
  assert.equal(kind({ rsi14: 55, rangePos: 18, pct30: -1.6, pct60: -2.2, volRatio: 1.0, held: false }), null);
});

test("breakout: strength with volume, without chasing extreme overbought", () => {
  assert.equal(kind({ rsi14: 61, rangePos: 88, pct30: 0.6, pct60: 1.4, volRatio: 1.9, held: false }), "breakout");
  assert.equal(kind({ rsi14: 61, rangePos: 88, pct30: 0.6, pct60: 1.4, volRatio: 1.1, held: false }), null); // no volume
  assert.equal(kind({ rsi14: 61, rangePos: 40, pct30: 0.6, pct60: 1.4, volRatio: 1.9, held: false }), null); // mid-range
  assert.equal(kind({ rsi14: 78, rangePos: 88, pct30: 0.6, pct60: 1.4, volRatio: 1.9, held: false }), null); // already blown out
});

test("no entry while holding, and none before the indicators exist", () => {
  const open = { rsi14: 20, rangePos: 5, pct30: -3, pct60: -3, volRatio: 2, held: true };
  assert.equal(kind(open), null);
  assert.equal(kind({ rsi14: null, rangePos: 50, pct30: -3, pct60: -3, volRatio: 2, held: false }), null);
  assert.equal(kind({ rsi14: 20, rangePos: null, pct30: -3, pct60: -3, volRatio: 2, held: false }), null);
  assert.equal(kind({ rsi14: undefined, rangePos: undefined, held: false }), null);
});

test("thresholds are injectable", () => {
  const f = { rsi14: 45, rangePos: 50, pct30: -0.5, pct60: 0, volRatio: 0.9, held: false };
  assert.equal(kind(f), null);
  assert.equal(entryKind(f, { ...t, dipRsi: 50, dipRangePos: 60, dipDrop30: 0.4 }), "dip");
});

test("breakouts are sized smaller than dips", () => {
  assert.equal(entryNotional("dip", 100000, t), 10000);
  assert.equal(entryNotional("breakout", 100000, t), 7500);
  assert.equal(entryNotional("dip", 0, t), 0);
  assert.equal(entryNotional("dip", 100000, { ...t, buyPct: 0.05 }), 5000);
});

test("an entry decision sizes from its own notional, not from confidence", () => {
  const account = { positions: { APT: 0 }, cost: {}, peak: {} };
  const d = { action: "buy", asset: "APT", source: "entry", notional: 9000, signals: { material: { confidence: 1 } } };
  assert.equal(positionSize(d, account, 1, 100000), 9000);
  // without one, the confidence-scaled band still applies
  assert.equal(positionSize({ ...d, notional: undefined }, account, 1, 100000), 20000);
});

// Regression: the old mapping ignored which way the tape had moved, so a dump the
// model expected to continue would have been bought.
test("continuation reads the direction", () => {
  const ok = { level: 3, conf: 0.7 };
  assert.equal(momentumAction({ ...ok, up: true, cont: 0.8 }), "buy");
  assert.equal(momentumAction({ ...ok, up: false, cont: 0.8 }), "sell");
  assert.equal(momentumAction({ ...ok, up: false, cont: 0.2 }), "buy"); // a fade is a rebound bet
  assert.equal(momentumAction({ ...ok, up: true, cont: 0.2 }), "sell");
  assert.equal(momentumAction({ ...ok, up: true, cont: 0.5 }), "skip");
});

test("a weak or low-confidence move never trades", () => {
  assert.equal(momentumAction({ up: true, cont: 0.9, level: 2, conf: 0.9 }), "skip");
  assert.equal(momentumAction({ up: true, cont: 0.9, level: 4, conf: 0.5 }), "skip");
  assert.equal(momentumAction({ up: false, cont: 0.1, level: 4, conf: 0.99 }), "buy");
});
