import { buildMarket, NEWS } from "./market.mjs";
import { PaperAccount } from "./exchange.mjs";
import { decide, positionSize } from "./strategy.mjs";
import { live } from "./jev.mjs";

const timeline = buildMarket(50);
const account = new PaperAccount(100000);
const startEquity = account.cash;
const jevCalls = { total: 0, escalated: 0, deepTraded: 0 };

console.log(`=== Jev 模拟盘回测 | 引擎: ${live() ? "LIVE API" : "MOCK (未配置 JEV_API_KEY)"} ===\n`);

for (const bar of timeline) {
  for (const n of bar.news) {
    jevCalls.total++;
    const decision = await decide(n.headline);
    if (decision.escalated) {
      jevCalls.escalated++;
      if (decision.action !== "skip") jevCalls.deepTraded++;
    }
    const price = bar.prices[decision.asset === "NONE" ? "BTC" : decision.asset] ?? bar.prices.BTC;
    const tag = decision.source === "deep" ? `${decision.action}*` : decision.action;
    console.log(`bar ${String(bar.bar).padStart(2)} [${tag.padEnd(7)}] ${decision.asset.padEnd(4)} ${n.headline.slice(0, 30)}… | ${decision.reason}`);

    if (decision.action === "buy") {
      const equity = account.equity(bar.prices);
      account.buy(decision.asset, price, positionSize(decision, account, price, equity), { bar: bar.bar, headline: n.headline });
    } else if (decision.action === "sell") {
      account.sell(decision.asset, price, positionSize(decision, account, price), { bar: bar.bar, headline: n.headline });
    }
    if (decision.action === "escalate") jevCalls.escalated++;
  }
}

const last = timeline[timeline.length - 1];
for (const [asset, qty] of Object.entries(account.positions)) {
  if (qty > 0) account.sell(asset, last.prices[asset], qty, { bar: last.bar, headline: "(close)" });
}
const equity = account.equity(last.prices);

const buys = account.trades.filter((t) => t.side === "buy" && t.headline !== "(close)");
const trueImpact = (t) => NEWS.find((n) => n.headline === t.headline && n.asset === t.asset)?.impact ?? 0;
const hits = buys.filter((t) => Math.sign(trueImpact(t)) > 0).length;

const bh = { BTC: startEquity / 2, ETH: startEquity / 2 };
for (const k of Object.keys(bh)) bh[k] = (bh[k] / timeline[0].prices[k]) * last.prices[k];
const bhEquity = bh.BTC + bh.ETH;

console.log(`\n--- 成交明细 (${account.trades.length} 笔) ---`);
for (const t of account.trades) {
  console.log(`bar ${String(t.bar).padStart(2)} ${t.side.toUpperCase().padEnd(4)} ${t.asset} @ ${t.price.toFixed(2)} qty ${t.qty.toFixed(6)}  ${t.headline === "(close)" ? "" : t.headline.slice(0, 26) + "…"}`);
}
console.log(`\n--- 结果 ---`);
console.log(`新闻信号: ${jevCalls.total} 条, System Two 复核 ${jevCalls.escalated} 条 (${((jevCalls.escalated / Math.max(1, jevCalls.total)) * 100).toFixed(0)}%), 其中转化交易 ${jevCalls.deepTraded} 条`);
console.log(`做多信号命中真实利好: ${hits}/${buys.length}`);
console.log(`策略期末权益: ${equity.toFixed(2)} USDC  (${((equity / startEquity - 1) * 100).toFixed(2)}%)`);
console.log(`买入持有基准:    ${bhEquity.toFixed(2)} USDC  (${((bhEquity / startEquity - 1) * 100).toFixed(2)}%)`);
