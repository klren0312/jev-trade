// Coin list handling: what the operator types -> a Binance symbol, and what changes.
// Pure (no network) so the parsing rules are unit-testable; live validation of a
// symbol against exchangeInfo lives in feed.mjs.

export const DEFAULT_QUOTE = "USDT";
export const DEFAULT_ASSET = "APT";

// A short list worth one click on the dashboard; typing any other Binance base
// asset works too — validation is the real gate, not this list.
export const QUICK_PICKS = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "APT", "TON", "LINK", "AVAX", "NEAR", "SUI", "OP", "ARB"];

// "apt" / "APT-USDT" / "APT/USDT" / "APTUSDT" -> "APTUSDT"
export function toSymbol(input, quote = DEFAULT_QUOTE) {
  const t = String(input).toUpperCase().replace(/[\s/_-]+/g, "");
  if (!/^[A-Z0-9]{1,12}$/.test(t)) return null;
  return t.endsWith(quote) ? t : t + quote;
}

// "1.00000000" -> 0, "0.00100000" -> 3. Prices are only ever a tick multiple,
// so tickSize decides how many decimals the UI needs to show.
export function decimalsFromTick(tickSize) {
  const s = String(tickSize ?? "");
  if (!/^\d*\.\d+$/.test(s)) return 2;
  const frac = s.split(".")[1].replace(/0+$/, "");
  return Math.max(0, frac.length);
}

// Accepts "BTC,ETH" / "BTC ETH" / ["btc","apt/usdt"]. Returns base names.
export function parseAssets(input, quote = DEFAULT_QUOTE) {
  const tokens = (Array.isArray(input) ? input.join(",") : String(input ?? "")).split(/[\s,;，、]+/);
  const out = [];
  for (const raw of tokens) {
    const sym = toSymbol(raw, quote);
    if (!sym) continue;
    const base = sym.slice(0, -quote.length);
    if (base && !out.includes(base)) out.push(base);
  }
  return out;
}

export function diffAssets(current = [], wanted = []) {
  return {
    add: wanted.filter((a) => !current.includes(a)),
    remove: current.filter((a) => !wanted.includes(a)),
  };
}
