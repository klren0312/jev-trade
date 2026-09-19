// Auto news source: poll public RSS feeds, dedupe, hand fresh headlines to the strategy.

const FEEDS = [
  { name: "cointelegraph", url: "https://cointelegraph.com/rss", max: 8 },
];

const strip = (s) => s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]*>/g, "").trim();

function parseItems(xml) {
  const out = [];
  for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const title = item.match(/<title>([\s\S]*?)<\/title>/);
    const link = item.match(/<link>([\s\S]*?)<\/link>/);
    const date = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    if (title) out.push({ title: strip(title[1]), link: strip(link?.[1] ?? ""), date: strip(date?.[1] ?? "") });
  }
  return out;
}

export function createNewsPoller({ intervalMs = 60000, onNews } = {}) {
  let seen = new Set();
  let primed = false;

  async function tick() {
    for (const feed of FEEDS) {
      try {
        const res = await fetch(feed.url, { headers: { "user-agent": "jev-trade/0.1 (paper-trading research)" } });
        if (!res.ok) continue;
        const items = parseItems(await res.text()).slice(0, feed.max);
        for (const it of items) {
          const key = it.link || it.title;
          if (seen.has(key)) continue;
          seen.add(key);
          if (primed) onNews?.({ ...it, source: feed.name }); // first pass only builds the seen-set, don't trade old news
        }
      } catch (e) { console.error(`[news] ${feed.name}: ${e.message}`); }
    }
    primed = true;
    if (seen.size > 2000) seen = new Set([...seen].slice(-1000));
  }

  tick();
  const timer = setInterval(tick, intervalMs);
  return { stop: () => clearInterval(timer) };
}
