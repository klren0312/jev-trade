// Live crypto prices from Binance public market data (no key needed).
// Primary: WebSocket miniTicker push. Fallback: REST polling every 5s.

const WS_BASE = "wss://data-stream.binance.vision/stream";
const API_BASE = "https://data-api.binance.vision/api/v3";
const REST_BASE = `${API_BASE}/ticker/price`;

// Trade rules for a pair, used to validate a coin the operator adds at runtime.
// null = unknown symbol or not trading, so the caller can reject it with a reason.
export async function symbolInfo(symbol) {
  let d;
  try {
    const res = await fetch(`${API_BASE}/exchangeInfo?symbol=${symbol}`);
    if (!res.ok) return null;
    d = await res.json();
  } catch { return null; }
  const s = d?.symbols?.[0];
  if (!s || s.status !== "TRADING") return null;
  const tick = s.filters?.find((f) => f.filterType === "PRICE_FILTER")?.tickSize;
  const minNotional = Number(s.filters?.find((f) => f.filterType === "NOTIONAL")?.minNotional || 0);
  return { symbol: s.symbol, base: s.baseAsset, quote: s.quoteAsset, tickSize: tick, minNotional };
}

export async function snapshot(symbols) {
  const out = {};
  await Promise.all(symbols.map(async (s) => {
    const res = await fetch(`${REST_BASE}?symbol=${s}`);
    if (!res.ok) throw new Error(`REST ${s}: ${res.status}`);
    out[s] = parseFloat((await res.json()).price);
  }));
  return out;
}

export async function stats24h(symbols) {
  const out = {};
  await Promise.all(symbols.map(async (s) => {
    const res = await fetch(`https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${s}`);
    if (!res.ok) throw new Error(`REST 24hr ${s}: ${res.status}`);
    const d = await res.json();
    out[s] = { open24h: parseFloat(d.openPrice), high24h: parseFloat(d.highPrice), low24h: parseFloat(d.lowPrice), pct24h: parseFloat(d.priceChangePercent) };
  }));
  return out;
}

// 1m candles for indicators. The final row is the still-forming bar; callers drop it.
export async function klines(symbol, interval = "1m", limit = 120) {
  const res = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  if (!res.ok) throw new Error(`REST klines ${symbol}: ${res.status}`);
  return (await res.json()).map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], qv: +k[7] }));
}

export function createFeed(symbols, { onPrice, onStatus }) {
  let ws = null, userClosed = false, pollTimer = null, wsDeadTimer = null;
  const streams = symbols.map((s) => `${s.toLowerCase()}@miniTicker`).join("/");
  // An empty watchlist must not spin on reconnect: Binance rejects a stream-less URL.
  if (!streams) { onStatus?.("no symbols"); return { close() {} }; }

  const stopPolling = () => { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } };

  const armWsWatchdog = () => {
    clearTimeout(wsDeadTimer);
    wsDeadTimer = setTimeout(() => {
      onStatus?.("ws-stale, falling back to REST");
      try { ws?.close(); } catch {}
      startPolling();
    }, 30000);
  };

  const startPolling = () => {
    if (pollTimer) return;
    onStatus?.("rest-polling");
    pollTimer = setInterval(() => {
      snapshot(symbols)
        .then((p) => Object.entries(p).forEach(([s, v]) => onPrice?.(s, v)))
        .catch(() => onStatus?.("poll failed"));
    }, 5000);
  };

  const connect = () => {
    if (userClosed) return;
    onStatus?.("ws-connecting");
    ws = new WebSocket(`${WS_BASE}?streams=${streams}`);
    ws.onopen = () => { onStatus?.("ws-live"); armWsWatchdog(); };
    ws.onmessage = (m) => {
      armWsWatchdog();
      try {
        const { data } = JSON.parse(m.data);
        stopPolling();
        onPrice?.(data.s, parseFloat(data.c));
      } catch {}
    };
    ws.onclose = () => {
      if (userClosed) return;
      startPolling();
      setTimeout(connect, 5000); // keep trying WS in background; it stops polling once alive
    };
    ws.onerror = () => ws.close();
  };

  connect();
  return { close() { userClosed = true; clearTimeout(wsDeadTimer); stopPolling(); try { ws?.close(); } catch {} } };
}
