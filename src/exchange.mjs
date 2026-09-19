// Paper-trading account: market orders, fee, mark-to-market equity.

const FEE_BPS = 10;

export class PaperAccount {
  constructor(cash = 100000, startCash = cash) {
    this.cash = cash;
    this.startCash = startCash;
    this.positions = {};
    this.trades = [];
    this.cost = {}; // avg entry per asset, for stop-loss / take-profit maths
    this.peak = {}; // highest price seen since entry
    this.entryAt = {}; // ms timestamp of opening the current lot
  }

  buy(asset, price, usdNotional, meta) {
    const notional = Math.min(usdNotional, this.cash / (1 + FEE_BPS / 10000));
    if (notional < 1) return null;
    const qty = notional / price;
    const fee = notional * FEE_BPS / 10000;
    // notional was capped by the cash line above; clamp so float drift can't show -1e-14 cash
    this.cash = Math.max(0, this.cash - notional - fee);
    const prev = this.positions[asset] ?? 0;
    this.positions[asset] = prev + qty;
    this.cost[asset] = ((this.cost[asset] ?? 0) * prev + price * qty) / (prev + qty);
    this.peak[asset] = Math.max(this.peak[asset] ?? 0, price);
    if (!prev) this.entryAt[asset] = Date.now();
    const trade = { side: "buy", asset, price, qty, fee, bar: meta.bar, headline: meta.headline };
    this.trades.push(trade);
    return trade;
  }

  sell(asset, price, qty, meta) {
    const held = this.positions[asset] ?? 0;
    const actual = Math.min(qty, held);
    if (actual <= 0) return null;
    const notional = actual * price;
    const fee = notional * FEE_BPS / 10000;
    this.cash += notional - fee;
    this.positions[asset] = held - actual;
    if (this.positions[asset] <= 1e-12) {
      delete this.positions[asset]; delete this.cost[asset]; delete this.peak[asset]; delete this.entryAt[asset];
    }
    const trade = { side: "sell", asset, price, qty: actual, fee, bar: meta.bar, headline: meta.headline };
    this.trades.push(trade);
    return trade;
  }

  markToMarket(asset, price) {
    if ((this.positions[asset] ?? 0) > 0) this.peak[asset] = Math.max(this.peak[asset] ?? price, price);
  }

  equity(prices) {
    return this.cash + Object.entries(this.positions)
      .reduce((sum, [asset, qty]) => sum + qty * prices[asset], 0);
  }

  serialize() {
    return {
      cash: this.cash, startCash: this.startCash, positions: this.positions,
      trades: this.trades.slice(-500), cost: this.cost, peak: this.peak, entryAt: this.entryAt,
    };
  }

  static restore(s = {}) {
    const a = new PaperAccount(s.cash ?? 100000, s.startCash ?? s.cash ?? 100000);
    a.positions = s.positions ?? {};
    a.trades = s.trades ?? [];
    a.cost = s.cost ?? {};
    a.peak = s.peak ?? {};
    a.entryAt = s.entryAt ?? {};
    for (const [asset, qty] of Object.entries(a.positions)) {
      if (qty > 0 && a.cost[asset] == null) a.cost[asset] = replayCost(a.trades, asset) ?? undefined;
      if (a.cost[asset] == null) delete a.cost[asset];
    }
    return a;
  }
}

// States written before cost tracking existed: rebuild the average entry from the trade log.
function replayCost(trades, asset) {
  let qty = 0, cost = 0;
  for (const t of trades) {
    if (t.asset !== asset) continue;
    if (t.side === "buy") { cost = (cost * qty + t.price * t.qty) / (qty + t.qty); qty += t.qty; }
    else qty -= t.qty;
  }
  return qty > 0 ? cost : null;
}
