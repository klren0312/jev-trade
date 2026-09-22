import { test } from "node:test";
import assert from "node:assert/strict";

import { riskKind, RISK_DEFAULTS, RISK_FULL_EXIT } from "../src/risk.mjs";
import { PaperAccount } from "../src/exchange.mjs";
import { positionSize } from "../src/strategy.mjs";

const t = RISK_DEFAULTS;
const kind = (facts) => riskKind(facts, t);

test("stop wins over every other rule", () => {
  // losing badly while also overdue for a review and past a trailing give-back
  const g = kind({ pnlPct: -3.2, peakPnlPct: 4, giveBackPct: 7, heldMs: 60 * 60000 });
  assert.equal(g, "stop");
  assert.equal(kind({ pnlPct: -t.stopPct, peakPnlPct: 0, giveBackPct: 0, heldMs: 0 }), "stop");
  assert.ok(RISK_FULL_EXIT.has("stop"));
});

test("take-profit, trailing and review in order", () => {
  assert.equal(kind({ pnlPct: t.tpPct, peakPnlPct: 6, giveBackPct: 0, heldMs: 0 }), "take-profit");
  assert.equal(kind({ pnlPct: 3, peakPnlPct: 5, giveBackPct: t.trailPct, heldMs: 0 }), "trailing");
  assert.equal(kind({ pnlPct: 1, peakPnlPct: 1, giveBackPct: 0, heldMs: t.reviewMs }), "review");
});

test("trailing needs arming first", () => {
  assert.equal(kind({ pnlPct: 1, peakPnlPct: t.trailArmPct - 0.1, giveBackPct: 5, heldMs: 0 }), null);
  assert.equal(kind({ pnlPct: 1, peakPnlPct: t.trailArmPct, giveBackPct: t.trailPct - 0.01, heldMs: 0 }), null);
});

test("no rule without data; no unknown kinds", () => {
  assert.equal(kind({ pnlPct: null, peakPnlPct: 9, giveBackPct: 9, heldMs: 9e9 }), null);
  assert.equal(kind({ pnlPct: 0.5, peakPnlPct: 0.5, giveBackPct: 0, heldMs: null }), null);
  // heldMs missing (legacy state) must not fire review
  assert.equal(kind({ pnlPct: 0.5, peakPnlPct: 0.5, giveBackPct: 0 }), null);
});

test("thresholds are injectable", () => {
  assert.equal(riskKind({ pnlPct: -1, peakPnlPct: -1, giveBackPct: 0, heldMs: 0 }, { ...t, stopPct: 0.5 }), "stop");
  assert.equal(riskKind({ pnlPct: -1, peakPnlPct: -1, giveBackPct: 0, heldMs: 0 }, { ...t, stopPct: 1.5 }), null);
  assert.equal(riskKind({ pnlPct: 0.5, peakPnlPct: 0.5, giveBackPct: 0, heldMs: 1000 }, { ...t, reviewMs: 500 }), "review");
});

test("account tracks weighted cost, peak and entry time", () => {
  const a = new PaperAccount(5000);
  a.buy("APT", 1.0, 300, { bar: 1, headline: "h" });
  assert.equal(a.positions.APT, 300);
  assert.equal(a.cost.APT, 1.0);
  assert.ok(a.entryAt.APT);
  a.buy("APT", 3.0, 300, { bar: 2, headline: "h" });
  assert.equal(a.cost.APT, 1.5); // (300@1 + 100@3) / 400
  assert.equal(a.peak.APT, 3.0);
  a.markToMarket("APT", 2.8);
  assert.equal(a.peak.APT, 3.0);
  a.markToMarket("APT", 4.0);
  assert.equal(a.peak.APT, 4.0);

  const entry = a.entryAt.APT;
  a.sell("APT", 4.0, 100, { bar: 3, headline: "h" });
  assert.equal(a.cost.APT, 1.5); // partial sell keeps the average entry
  assert.equal(a.entryAt.APT, entry);
  a.sell("APT", 4.0, 99999, { bar: 4, headline: "h" });
  assert.deepEqual(a.positions, {});
  assert.ok(!a.cost.APT && !a.peak.APT && !a.entryAt.APT);
});

test("buy cannot overspend cash and sell cannot exceed the lot", () => {
  const a = new PaperAccount(110);
  const b = a.buy("APT", 1, 1000, { bar: 1, headline: "h" });
  assert.ok(b.qty < 110);
  assert.ok(a.cash >= 0);
  assert.equal(a.sell("APT", 1, b.qty + 1, { bar: 2, headline: "h" }).qty, b.qty);
  assert.equal(a.sell("APT", 1, 1, { bar: 3, headline: "h" }), null);
});

test("serialize/restore round-trips risk bookkeeping", () => {
  const a = new PaperAccount(1000);
  a.buy("APT", 1.0, 400, { bar: 1, headline: "h" });
  a.markToMarket("APT", 1.4);
  const r = PaperAccount.restore(a.serialize());
  assert.equal(r.cost.APT, a.cost.APT);
  assert.equal(r.peak.APT, a.peak.APT);
  assert.equal(r.positions.APT, a.positions.APT);
  assert.equal(r.entryAt.APT, a.entryAt.APT);
  assert.equal(r.startCash, 1000);
});

test("legacy state without cost is rebuilt from the trade log", () => {
  const a = new PaperAccount(1000);
  a.buy("APT", 1.0, 300, { bar: 1, headline: "h" });
  a.buy("APT", 3.0, 300, { bar: 2, headline: "h" });
  const s = a.serialize();
  delete s.cost;
  delete s.entryAt;
  const r = PaperAccount.restore(s);
  // (300*1 + 100*3) / 400
  assert.equal(r.cost.APT, 1.5);
});

test("a full-exit rule decision sells the whole lot", () => {
  const a = new PaperAccount(1000);
  a.buy("APT", 1.0, 400, { bar: 1, headline: "h" });
  const qty = a.positions.APT;
  const decision = { action: "sell", source: "rule", asset: "APT", fraction: 1, signals: { material: { confidence: 1 } } };
  assert.equal(positionSize(decision, a, 0.8, a.equity({ APT: 0.8 })), qty);
  assert.equal(a.sell("APT", 0.8, positionSize(decision, a, 0.8, 800), { bar: 2, headline: "h" }).qty, qty);
  assert.deepEqual(a.positions, {});
});

test("risk decisions can size a partial exit", () => {
  const a = new PaperAccount(1000);
  a.buy("APT", 1.0, 400, { bar: 1, headline: "h" });
  const half = { action: "sell", source: "risk", asset: "APT", fraction: 0.5, signals: { material: { confidence: 1 } } };
  assert.equal(positionSize(half, a, 0.9, 900), a.positions.APT * 0.5);
  const legacy = { action: "sell", source: "fast", asset: "APT", signals: { material: { confidence: 1 } } };
  assert.ok(Math.abs(positionSize(legacy, a, 0.9, 900) - a.positions.APT * 0.4) < 1e-9);
  const deep = { action: "sell", source: "deep", asset: "APT", signals: { material: { confidence: 1 } } };
  assert.ok(Math.abs(positionSize(deep, a, 0.9, 900) - a.positions.APT * 0.2) < 1e-9);
});

// Regression: 40% trims decay a lot geometrically and never reach the 1e-12 floor, so
// the residue stayed a position forever, occupied a maxPositions slot, and blocked the
// coin from being bought again (measured on the server: SUI left holding 0.00003 units).
test("a trim that leaves dust closes the lot instead", () => {
  const a = new PaperAccount(100000);
  a.buy("APT", 1.0, 10000, { bar: 1, headline: "h" });
  a.sell("APT", 1.0, 9500, { bar: 2, headline: "h" }, 1000); // 500 USDC left < dust line
  assert.equal(a.positions.APT, undefined);
  assert.equal(a.cost.APT, undefined);
  assert.equal(a.entryAt.APT, undefined);
  assert.ok(Math.abs(a.cash - 99980) < 0.01, `cash ${a.cash}`); // both fees on the 10k lot

  // above the dust line the partial exit stays partial
  const b = new PaperAccount(100000);
  b.buy("APT", 1.0, 10000, { bar: 1, headline: "h" });
  b.sell("APT", 1.0, 8000, { bar: 2, headline: "h" }, 1000);
  assert.ok(b.positions.APT > 1999);
});
