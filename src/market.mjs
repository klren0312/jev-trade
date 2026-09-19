// Synthetic market: bar timeline with labelled news, price = random walk + news impact.

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// impact = total drift (bps) applied over the 8 bars after the news
export const NEWS = [
  { bar: 2,  headline: "SEC 批准现货比特币 ETF 期权交易，机构资金预期大幅流入", asset: "BTC", impact: 220 },
  { bar: 6,  headline: "某大型交易所热钱包出现异常提款记录，暂停全部提现", asset: "BTC", impact: -320 },
  { bar: 11, headline: "明星发布 meme 图片，内容与任何加密货币无关", asset: "NONE", impact: 0 },
  { bar: 14, headline: "美国 CPI 超预期回落，风险资产全线反弹", asset: "BTC", impact: 160 },
  { bar: 14, headline: "美国 CPI 超预期回落，以太坊生态全线反弹", asset: "ETH", impact: 190 },
  { bar: 19, headline: "某小监管部门通报开展虚拟货币广告合规抽查", asset: "NONE", impact: -10 },
  { bar: 23, headline: "鲸鱼地址向交易所转入 5 万枚 BTC，市场担忧集中抛压", asset: "BTC", impact: -180 },
  { bar: 27, headline: "以太坊 L2 汇总层完成重大升级，吞吐量提升十倍且手续费下降", asset: "ETH", impact: 260 },
  { bar: 31, headline: "社区争论 GIF 表情版权，与市场行情无关", asset: "NONE", impact: 0 },
  { bar: 34, headline: "Mt.Gox 遗产地址再次被激活，债权人赔付担忧升温", asset: "BTC", impact: -240 },
  { bar: 39, headline: "跨国支付公司宣布集成以太坊稳定币结算，采用利好", asset: "ETH", impact: 200 },
  { bar: 44, headline: "比特币矿工活跃度创新高，网络算力大幅上涨", asset: "BTC", impact: 140 },
];

export function buildMarket(bars = 50) {
  const rand = mulberry32(20260919);
  const start = { BTC: 65000, ETH: 3200 };
  const series = { BTC: [start.BTC], ETH: [start.ETH] };
  for (let b = 1; b <= bars; b++) {
    for (const asset of ["BTC", "ETH"]) {
      const newsDrift = NEWS.filter((n) => n.asset === asset && b > n.bar && b <= n.bar + 8)
        .reduce((s, n) => s + n.impact / 8, 0) / 10000;
      const noise = (rand() - 0.5) * 0.004;
      const prev = series[asset][series[asset].length - 1];
      series[asset].push(prev * (1 + newsDrift + noise));
    }
  }
  const timeline = [];
  for (let b = 0; b <= bars; b++) {
    timeline.push({
      bar: b,
      prices: { BTC: series.BTC[b], ETH: series.ETH[b] },
      news: NEWS.filter((n) => n.bar === b),
    });
  }
  return timeline;
}
