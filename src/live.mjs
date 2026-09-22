// Live paper trading REPL: real-time Binance prices + Jev signals on news you type.
//   node src/live.mjs
// Type a news headline to get a Jev signal and trade it at market. Commands: p / h / q.

import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createFeed, snapshot, stats24h, klines, symbolInfo } from "./feed.mjs";
import { PaperAccount } from "./exchange.mjs";
import { decide, decideMove, decideRisk, positionSize, MOMENTUM_GATES } from "./strategy.mjs";
import { rsi, volRatio, ampPct, rangePos, slopePct } from "./price.mjs";
import { riskKind, RISK_FULL_EXIT, RISK_DEFAULTS } from "./risk.mjs";
import { entryKind, entryNotional, ENTRY_DEFAULTS } from "./entry.mjs";
import { parseAssets, toSymbol, diffAssets, decimalsFromTick, DEFAULT_QUOTE, DEFAULT_ASSET, QUICK_PICKS } from "./assets.mjs";
import { live } from "./jev.mjs";
import { startDashboard } from "./dashboard.mjs";
import { createNewsPoller } from "./news.mjs";

const bus = new EventEmitter();
bus.setMaxListeners(0);
const EVENTS_KEEP = 120; // in-memory feed is capped lower for the UI; the file keeps a longer tail
const events = [];

const QUOTE = (process.env.JEV_QUOTE || DEFAULT_QUOTE).toUpperCase();
// Under pm2 (and any piped/redirected stdin) there is no TTY: readline would hit
// EOF at once and its close handler would tear down the price feed, leaving a
// process that looks alive but is blind. So the REPL is opt-in on a real terminal.
const INTERACTIVE = Boolean(process.stdin.isTTY) && process.env.JEV_NO_REPL !== "1";
// The watchlist is mutable: setAssets() rewrites these in place, so every reader
// (scans, Jev prompts, dashboard) sees the current list without a restart.
const ASSETS = []; // base names, e.g. "APT"
const SYMBOLS = {}; // asset -> pair, e.g. "APTUSDT"
const PAIR_OF = {}; // pair -> asset, for inbound price callbacks
const prices = {}; // deliberately kept for pairs dropped from the watchlist while still held
const open = {};
const meta = {}; // asset -> { dec, minNotional }
const cooldown = {}, riskCooldown = {}, entryCooldown = {}, rearmAt = {};

// Account and decision feed survive restarts: state is rewritten atomically
// after every decision/fill, never on a price tick (that would hammer the disk).
const STATE_FILE = process.env.JEV_STATE_FILE || ".paper_state.json";
let saved = null;
try {
  if (existsSync(STATE_FILE)) saved = JSON.parse(readFileSync(STATE_FILE, "utf8"));
} catch (e) { console.error(`[state] 状态文件不可读，使用新账户: ${e.message}`); }
const account = saved?.account
  ? PaperAccount.restore(saved.account)
  : new PaperAccount(Number(process.env.JEV_START_CASH || 100000));
if (Array.isArray(saved?.events)) events.push(...saved.events.slice(0, EVENTS_KEEP));

// A dropped-but-still-held coin can briefly have no price; never let that turn
// equity (and therefore sizing) into NaN.
const equityNow = () => account.equity(Object.fromEntries(Object.entries(prices).filter(([, p]) => p > 0)));

function positionView() {
  return Object.fromEntries(Object.entries(account.positions)
    .filter(([, q]) => q > 0)
    .map(([a, q]) => [a, {
      qty: q, cost: account.cost[a] ?? null, peak: account.peak[a] ?? null,
      px: prices[a] ?? null, // null while a dropped coin's first quote is in flight
      pnlPct: account.cost[a] && prices[a] ? (prices[a] / account.cost[a] - 1) * 100 : null,
    }]));
}

function saveState() {
  const tmp = `${STATE_FILE}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({
      savedAt: new Date().toISOString(),
      account: account.serialize(),
      open,
      assets: ASSETS.slice(),
      events: events.slice(0, EVENTS_KEEP),
    }));
    renameSync(tmp, STATE_FILE);
  } catch (e) { console.error(`[state] 保存失败: ${e.message}`); }
}

if (saved?.account) {
  console.log(`[state] 恢复账户: cash ${account.cash.toFixed(2)}，${account.trades.length} 笔成交，` +
    `持仓 ${Object.entries(account.positions).filter(([, q]) => q > 0).map(([a, q]) => `${a} ${q.toFixed(4)}`).join(" ") || "无"}` +
    `${events.length ? `，决策流 ${events.length} 条` : ""}`);
} else {
  console.log(`[state] 新建账户 ${account.cash.toFixed(2)} USDC（状态文件 ${STATE_FILE}）`);
}

// Technical read of the tape, refreshed from 1m candles. This is what lets the
// system decide on price alone: trend, momentum, volume and range position.
const TECH_MS = Number(process.env.JEV_TECH_MS || 60000);
const tech = {}, d24 = {}; // asset -> 1m-candle read / 24h stats, null until fetched
function tapeSnapshot() {
  return Object.fromEntries(ASSETS.map((a) => [a, {
    px: prices[a],
    pct5: chgPct(a, 5),
    pct30: chgPct(a, 30),
    pct60: chgPct(a, 60),
    pct24: d24[a]?.pct24h ?? null,
    rangePos: d24[a] ? rangePos(prices[a], d24[a].high24h, d24[a].low24h) : null,
    ...(tech[a] ?? {}),
  }]));
}
async function refreshTech() {
  for (const a of ASSETS) {
    try {
      const bars = (await klines(SYMBOLS[a], "1m", 120)).slice(0, -1); // drop the forming bar
      const closes = bars.map((b) => b.c);
      seedHist(a, bars);
      tech[a] = {
        at: Date.now(),
        rsi14: rsi(closes),
        volRatio: volRatio(bars),
        amp14: ampPct(bars),
        slope15: slopePct(closes, 15),
        slope60: slopePct(closes, 60),
      };
    } catch (e) { console.error(`[tech] ${a} failed: ${e.message}`); }
  }
  try {
    const st = await stats24h(Object.values(SYMBOLS));
    for (const a of ASSETS) d24[a] = st[SYMBOLS[a]];
  } catch (e) { console.error(`[tech] 24h stats failed: ${e.message}`); }
}
// The first pass happens inside setAssets(), once the watchlist exists.
setInterval(refreshTech, TECH_MS).unref();

const hist = {}; // asset -> {t, p} samples within ~70 min
function pushHist(a, p) {
  const arr = hist[a] ??= []; const now = Date.now();
  arr.push({ t: now, p });
  while (arr.length && now - arr[0].t > 70 * 60000) arr.shift();
}
// A restart used to blind the 30/60-minute windows for an hour: chgPct() fell back to
// "change since boot", so the pullback leg read a false near-zero and the entry scanner
// sat idle. The 1m candles already fetched for RSI double as history backfill.
function seedHist(a, bars) {
  const arr = hist[a] ??= [];
  const first = arr.length ? arr[0].t : Infinity;
  const back = bars.filter((b) => b.t < first - 60000).map((b) => ({ t: b.t, p: b.c }));
  if (back.length) hist[a] = back.concat(arr);
  const cutoff = Date.now() - 70 * 60000;
  while (hist[a].length && hist[a][0].t < cutoff) hist[a].shift();
}
function chgPct(a, mins) {
  const arr = hist[a]; if (!arr?.length) return null;
  const now = Date.now(), target = now - mins * 60000;
  const base = arr.find((x) => x.t >= target);
  // oldest sample is newer than the window: no number is better than a wrong one
  if (!base) return null;
  return prices[a] ? (prices[a] / base.p - 1) * 100 : null;
}
const pct = (x, digits = 2) => (x === null || x === undefined ? "–" : (x >= 0 ? "+" : "") + x.toFixed(digits) + "%");
const decOf = (a) => meta[a]?.dec ?? (prices[a] >= 100 ? 2 : 4);
function tapeLine(a) {
  if (!prices[a]) return `${a}=等待报价`;
  const t = tech[a], st = d24[a];
  const rp = st ? rangePos(prices[a], st.high24h, st.low24h) : null;
  const parts = [
    `近5分${pct(chgPct(a, 5))}`, `近1时${pct(chgPct(a, 60))}`,
    st ? `24h${pct(st.pct24h, 1)}` : null,
    t ? `RSI14=${t.rsi14 === null ? "–" : t.rsi14.toFixed(0)}` : null,
    t ? `量比${t.volRatio === null ? "–" : t.volRatio.toFixed(2)}` : null,
    t ? `15分斜率${pct(t.slope15)}` : null,
    t ? `1分钟均幅${t.amp14 === null ? "–" : t.amp14.toFixed(2)}%` : null,
    rp === null ? null : `24h区间${rp.toFixed(0)}%`,
  ].filter(Boolean);
  return `${a}=${prices[a].toFixed(decOf(a))} ${parts.join(" ")}`;
}
function marketCtx() {
  return `[市场状态] ${new Date().toISOString().slice(0, 16)}Z ${ASSETS.map(tapeLine).join("；")}`;
}

let feed = null;
let feedPairs = [];
function onPrice(sym, px) {
  const a = PAIR_OF[sym];
  if (!a) return; // a pair we just unsubscribed from may still be in flight
  prices[a] = px;
  pushHist(a, px);
  account.markToMarket(a, px);
  renderTicker(a);
  bus.emit("evt", { type: "price", asset: a, price: px, equity: equityNow() });
}
function onStatus(s) { console.log(`[feed] ${s}`); bus.emit("evt", { type: "status", note: s }); }

// Subscribe to the watchlist plus anything we still hold: a coin dropped from the
// watchlist must keep quoting, or its stop-loss would run on a frozen price.
function heldOnly() {
  return Object.entries(account.positions).filter(([a, q]) => q > 0 && !SYMBOLS[a]).map(([a]) => a);
}
function syncFeed() {
  for (const p of Object.keys(PAIR_OF)) delete PAIR_OF[p];
  for (const a of ASSETS) PAIR_OF[SYMBOLS[a]] = a;
  const want = Object.values(SYMBOLS);
  for (const a of heldOnly()) {
    const pair = toSymbol(a, QUOTE);
    if (!want.includes(pair)) { want.push(pair); PAIR_OF[pair] = a; }
  }
  if (want.join() === feedPairs.join()) return;
  feedPairs = want;
  feed?.close();
  feed = createFeed(want, { onPrice, onStatus });
}

// Replace the watchlist at runtime: validate each pair against Binance, warm its
// price/24h/candle history, resubscribe the feed, then remember the choice.
// Positions in dropped coins are kept on purpose - risk rules still apply to them,
// they just stop generating entry signals.
async function setAssets(input, opts = {}) {
  const raw = Array.isArray(input) ? input.join(",") : String(input ?? "");
  const wanted = parseAssets(input, QUOTE);
  // Unparseable only when the caller actually sent something; an explicit empty
  // list is a valid state (watch nothing, keep managing open positions).
  if (!wanted.length && raw.trim()) return { assets: ASSETS.slice(), rejected: [{ asset: raw.trim().slice(0, 24), reason: "未识别到币种" }] };
  const { add, remove } = diffAssets(ASSETS, wanted);
  const rejected = [];
  for (const a of add) {
    const info = await symbolInfo(toSymbol(a, QUOTE));
    if (!info || info.base !== a) rejected.push({ asset: a, reason: `${toSymbol(a, QUOTE)} 在 Binance 不是可交易对` });
    else {
      meta[a] = { dec: decimalsFromTick(info.tickSize), minNotional: info.minNotional };
      if (prices[a] == null) prices[a] = 0;
    }
  }
  const kept = ASSETS.filter((a) => wanted.includes(a));
  const next = [...kept, ...add.filter((a) => meta[a])];
  for (const a of remove) {
    delete SYMBOLS[a]; delete hist[a]; delete tech[a]; delete d24[a]; delete cooldown[a]; delete riskCooldown[a];
    // keep pricing a coin we still hold; drop it once flat
    if (!(account.positions[a] > 0)) { delete prices[a]; delete open[a]; delete meta[a]; }
  }
  ASSETS.length = 0;
  for (const a of next) { ASSETS.push(a); SYMBOLS[a] = toSymbol(a, QUOTE); }
  if (add.length || remove.length) {
    const syms = Object.values(SYMBOLS);
    try {
      const snap = await snapshot(syms);
      for (const a of ASSETS) { if (snap[SYMBOLS[a]]) prices[a] = snap[SYMBOLS[a]]; open[a] ??= prices[a]; }
    } catch (e) { console.error(`[assets] 快照失败: ${e.message}`); }
    try {
      const st = await stats24h(syms);
      for (const a of ASSETS) d24[a] = st[SYMBOLS[a]] ?? null;
    } catch (e) { console.error(`[assets] 24h 统计失败: ${e.message}`); }
    await refreshTech();
  }
  syncFeed();
  if (opts.restoreOpen) for (const a of ASSETS) if (opts.restoreOpen[a]) open[a] = opts.restoreOpen[a]; // keep % baseline continuous
  if (!opts.quiet) {
    const bits = [
      add.filter((a) => meta[a]).length && `新增 ${add.filter((a) => meta[a]).join(" ")}`,
      remove.length && `移除 ${remove.join(" ")}`,
      rejected.length && `拒绝 ${rejected.map((r) => `${r.asset}(${r.reason})`).join(" ")}`,
    ].filter(Boolean);
    console.log(`[assets] ${ASSETS.join(" ") || "空"}${bits.length ? `（${bits.join("，")}）` : ""}`);
    saveState();
    bus.emit("evt", { type: "assets", assets: ASSETS.slice(), symbols: { ...SYMBOLS }, dec: Object.fromEntries(ASSETS.map((a) => [a, decOf(a)])), rejected });
  }
  return { assets: ASSETS.slice(), rejected };
}

// Precedence: explicit env > whatever was saved (an empty list is a real choice,
// not a missing value) > first-run default.
const initialAssets = process.env.JEV_ASSETS ?? (Array.isArray(saved?.assets) ? saved.assets.join(",") : DEFAULT_ASSET);
await setAssets(initialAssets, { quiet: true, restoreOpen: saved?.open });
console.log(`行情: Binance 实时（${QUOTE} 报价）| 币种: ${ASSETS.join(" ") || "无"} | 信号: ${live() ? "Jev LIVE API" : "Jev MOCK (设置 JEV_API_KEY 启用真实模型)"}`);
if (!saved?.account) saveState(); // a fresh start still needs its price baseline on disk
console.log(INTERACTIVE
  ? `直接输入新闻标题回车即触发信号交易；p=持仓 q=退出 c <币种>=换币（如 c BTC ETH）\n`
  : `[mode] 非交互运行（非 TTY 或 JEV_NO_REPL=1）：跳过 REPL，新闻走看板 POST /news 或自动新闻循环\n`);

function renderTicker(a) {
  if (!INTERACTIVE || !a || !prices[a]) return;
  const chg = open[a] ? ((prices[a] / open[a] - 1) * 100).toFixed(2) : "0.00";
  process.stdout.write(`\r${a} ${prices[a].toFixed(decOf(a))} (${chg}%) | 权益 ${equityNow().toFixed(2)}   `);
}

function logDecision(headline, decision) {
  const { action, reason, signals } = decision;
  if (decision.source === "momentum") {
    console.log(`\n  Jev momentum: cont=${signals.material.noul.toFixed(2)} strength=${signals.sentiment.score_index ?? signals.sentiment.score}/4`);
  } else if (decision.source === "risk") {
    console.log(`\n  Jev risk: exit=${signals.material.noul.toFixed(2)} severity=${signals.sentiment.score_index ?? signals.sentiment.score}/4 建议卖出比例 ${(decision.fraction * 100).toFixed(0)}%`);
  } else if (decision.source === "rule") {
    console.log(`\n  规则直接执行（未询问 Jev）`);
  } else if (decision.source === "entry") {
    console.log(`\n  规则直接建仓（未询问 Jev）`);
  } else if (decision.deep) {
    const d = decision.deep;
    console.log(`\n  Jev fast: material=${signals.material.noul.toFixed(2)} → 灰区，System Two 复核`);
    console.log(`  Jev deep: bull=${d.bullish.noul.toFixed(2)} bear=${d.bearish.noul.toFixed(2)} direct=${d.directness.score} fact=${d.factual.noul.toFixed(2)}`);
  } else if (decision.source === "deep") {
    console.log(`\n  Jev deep: ${reason}`);
  } else {
    const m = signals.material, s = signals.sentiment, c = signals.asset;
    console.log(`\n  Jev: material=${m.noul.toFixed(2)} conf=${m.confidence.toFixed(2)}` +
      ` | sentiment=${s.score_index ?? s.score}/4 conf=${s.confidence.toFixed(2)}` +
      ` | asset=${c.choice} conf=${c.confidence.toFixed(2)}`);
  }
  console.log(`  决策: ${action.toUpperCase()} (${reason})`);
}

function sigLine(decision) {
  const { signals } = decision;
  const f2 = (x) => Number(x).toFixed(2);
  if (decision.source === "momentum") return `cont=${f2(signals.material.noul)} str=${signals.sentiment.score_index ?? f2(signals.sentiment.score)}/4`;
  if (decision.source === "entry") return `规则 ${decision.kind} 买 ${(decision.notional / equityNow() * 100).toFixed(1)}%权益`;
  if (decision.source === "risk") return `exit=${f2(signals.material.noul)} sev=${signals.sentiment.score_index ?? f2(signals.sentiment.score)}/4 卖${(decision.fraction * 100).toFixed(0)}%`;
  if (decision.source === "rule") return `rule 卖${(decision.fraction * 100).toFixed(0)}%`;
  if (decision.deep) {
    const d = decision.deep;
    return `mat=${f2(signals.material.noul)}→deep bull=${f2(d.bullish.noul)} bear=${f2(d.bearish.noul)} dir=${d.directness.score} fact=${f2(d.factual.noul)}`;
  }
  const m = signals.material, s = signals.sentiment, c = signals.asset;
  return `mat=${f2(m.noul)} conf=${f2(m.confidence)} sent=${s.score_index ?? s.score}/4 asset=${c.choice}`;
}

function afterDecision(headline, decision, opts) {
  logDecision(headline, decision);
  const evt = { id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, ts: new Date().toISOString(), type: "decision", headline, auto: !!opts.auto, src: opts.source, action: decision.action, source: decision.source, asset: decision.asset, reason: decision.reason, sig: sigLine(decision) };
  events.unshift(evt);
  if (events.length > EVENTS_KEEP) events.length = EVENTS_KEEP;
  bus.emit("evt", evt);
  saveState();

  if (decision.action !== "buy" && decision.action !== "sell") return;
  const px = prices[decision.asset];
  if (!px) return console.log(`  无 ${decision.asset} 报价，跳过`);
  const dec = decOf(decision.asset);

  const tradeEvt = (id, note) => {
    evt.note = note; // persisted with the decision so restarts keep the fill annotation
    bus.emit("evt", { type: "trade", id, note, equity: equityNow(), positions: positionView() });
  };

  if (decision.action === "buy") {
    const notional = positionSize(decision, account, px, equityNow());
    const minNotional = meta[decision.asset]?.minNotional ?? 0;
    if (notional < minNotional) return console.log(`  名义额 ${notional.toFixed(2)} < Binance 最小 ${minNotional}，跳过`);
    const t = account.buy(decision.asset, px, notional, { bar: 0, headline });
    if (t) { console.log(`  成交: BUY ${t.qty.toFixed(6)} ${decision.asset} @ ${px.toFixed(dec)} 费用 ${t.fee.toFixed(2)}`); tradeEvt(evt.id, `BUY ${t.qty.toFixed(2)} @ ${px.toFixed(dec)}`); saveState(); }
  } else {
    const costBefore = account.cost[decision.asset] ?? px;
    const qty = positionSize(decision, account, px);
    const t = account.sell(decision.asset, px, qty, { bar: 0, headline }, dustUsd());
    if (t) {
      // A loss exit re-arms a cooldown: the pullback rule would otherwise keep buying the
      // same slide until the stop fires again.
      if (px < costBefore) rearmAt[decision.asset] = Date.now();
      console.log(`  成交: SELL ${t.qty.toFixed(6)} ${decision.asset} @ ${px.toFixed(dec)} 费用 ${t.fee.toFixed(2)}`); tradeEvt(evt.id, `SELL ${t.qty.toFixed(2)} @ ${px.toFixed(dec)}`); saveState();
    }
    else console.log(`  ${decision.asset} 无持仓，卖单跳过`);
  }
  syncFeed(); // a closed out-of-watchlist lot no longer needs a quote stream
}

async function onHeadline(headline, opts = {}) {
  const decision = await decide(headline, ASSETS, marketCtx());
  await afterDecision(headline, decision, opts);
}

function showPositions() {
  console.log(`\n  cash: ${account.cash.toFixed(2)} USDC`);
  const held = Object.keys(account.positions).filter((a) => account.positions[a] > 0);
  const listed = [...ASSETS, ...held.filter((a) => !ASSETS.includes(a))];
  for (const a of listed) {
    const q = account.positions[a] ?? 0;
    const note = ASSETS.includes(a) ? "" : "（已移出观察列表）";
    console.log(`  ${a}: ${q.toFixed(6)} ≈ ${(q * (prices[a] ?? 0)).toFixed(2)} USDC${note}`);
  }
  const eq = equityNow();
  console.log(`  equity: ${eq.toFixed(2)} USDC (起始 ${account.startCash.toFixed(2)}，${eq >= account.startCash ? "+" : ""}${((eq / account.startCash - 1) * 100).toFixed(2)}%，成交 ${account.trades.length} 笔)`);
  console.log(`  状态文件: ${STATE_FILE}\n`);
}

// The REPL only exists on a real terminal; q is the only path that closes the feed.
if (INTERACTIVE) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "新闻> " });
  rl.prompt();
  rl.on("line", async (raw) => {
    const line = raw.trim();
    if (line.toLowerCase() === "q" || line.toLowerCase() === "exit") { showPositions(); feed.close(); rl.close(); return; }
    if (line.toLowerCase() === "p") showPositions();
    else if (/^c(\s|$)/i.test(line)) { const r = await setAssets(line.replace(/^c\s*/i, "")); for (const x of r.rejected) console.log(`  拒绝 ${x.asset}: ${x.reason}`); }
    else if (line) await submit(line);
    if (rl.closed === true) return;
    console.log();
    renderTicker(ASSETS[0] ?? null);
    rl.prompt();
  });
  rl.on("close", () => feed.close());
}

const queue = [];
let processing = false;
function submitTask(task) {
  return new Promise((resolve) => { queue.push({ task, resolve }); pump(); });
}
function submit(headline, opts = {}) {
  return submitTask(async () => onHeadline(headline, opts));
}
async function pump() {
  if (processing) return;
  processing = true;
  while (queue.length) {
    const item = queue.shift();
    try { await item.task(); } catch (e) { console.error("decision failed:", e.message); }
    item.resolve();
  }
  processing = false;
}

// ---- price-driven decisions (no news required) -------------------------------
// Two independent loops: the entry scanner reads the tape for moves/overreach,
// the risk supervisor reads the open position against its own entry and peak.
const SCAN_MS = Number(process.env.JEV_SCAN_MS || 30000);
const COOLDOWN_MS = Number(process.env.JEV_COOLDOWN_MS || 20 * 60000);
const STOP_PCT = Number(process.env.JEV_STOP_PCT || RISK_DEFAULTS.stopPct);            // 浮亏 ≥2% 触发止损问询
const TRAIL_ARM_PCT = Number(process.env.JEV_TRAIL_ARM_PCT || RISK_DEFAULTS.trailArmPct); // 浮盈超过该值后启用移动止盈
const TRAIL_PCT = Number(process.env.JEV_TRAIL_PCT || RISK_DEFAULTS.trailPct);          // 从峰值回吐 1.5% 触发
const TP_PCT = Number(process.env.JEV_TP_PCT || RISK_DEFAULTS.tpPct);                   // 浮盈 ≥6% 触发止盈问询
const REVIEW_MS = Number(process.env.JEV_REVIEW_MS || RISK_DEFAULTS.reviewMs);          // 持仓定期复核
const RISK_COOLDOWN_MS = Number(process.env.JEV_RISK_COOLDOWN_MS || 10 * 60000);
const riskThresholds = { stopPct: STOP_PCT, tpPct: TP_PCT, trailArmPct: TRAIL_ARM_PCT, trailPct: TRAIL_PCT, reviewMs: REVIEW_MS };

// Rule entries: the same argument as the hard stop, turned around. Measured over 64
// tape events the live model's "will this move continue" topped out at 0.47 and no RSS
// headline cleared 0.5 materiality, so gating a buy on it leaves the book permanently
// empty. These thresholds were replayed against real 1m candles before being trusted.
const ENTRY_BUY_PCT = Number(process.env.JEV_ENTRY_BUY_PCT ?? ENTRY_DEFAULTS.buyPct);
const ENTRY_MAX_POSITIONS = Number(process.env.JEV_MAX_POSITIONS ?? ENTRY_DEFAULTS.maxPositions);
const ENTRY_COOLDOWN_MS = Number(process.env.JEV_ENTRY_COOLDOWN_MS || 30 * 60000);
const ENTRY_REARM_MS = Number(process.env.JEV_ENTRY_REARM_MS || 45 * 60000); // 刚在该币种止损后的冷静期
// Below 1% of equity a partially-sold lot is noise, not a position: it gets swept so
// the coin stops counting against maxPositions and can be bought again.
const ENTRY_DUST_PCT = Number(process.env.JEV_DUST_PCT ?? 0.01);
const entryThresholds = {
  pullRsi: Number(process.env.JEV_PULL_RSI ?? ENTRY_DEFAULTS.pullRsi),
  pullRangePosMin: Number(process.env.JEV_PULL_RANGE_POS ?? ENTRY_DEFAULTS.pullRangePosMin),
  pullDrop30: Number(process.env.JEV_PULL_DROP30 ?? ENTRY_DEFAULTS.pullDrop30),
  breakoutRise60: Number(process.env.JEV_BREAKOUT_RISE60 ?? ENTRY_DEFAULTS.breakoutRise60),
  breakoutVolRatio: Number(process.env.JEV_BREAKOUT_VOL_RATIO ?? ENTRY_DEFAULTS.breakoutVolRatio),
  breakoutRangePos: Number(process.env.JEV_BREAKOUT_RANGE_POS ?? ENTRY_DEFAULTS.breakoutRangePos),
  breakoutRsiMax: Number(process.env.JEV_BREAKOUT_RSI_MAX ?? ENTRY_DEFAULTS.breakoutRsiMax),
  buyPct: ENTRY_BUY_PCT,
  maxPositions: ENTRY_MAX_POSITIONS,
};

// Defaults are the measured distribution of the model's continuation answer
// (p05 0.22 / median 0.34 / max 0.47 over 334 calls), see strategy.mjs.
const momentumGates = {
  runOn: Number(process.env.JEV_CONT_MIN ?? MOMENTUM_GATES.runOn),
  fadeMax: Number(process.env.JEV_FADE_MAX ?? MOMENTUM_GATES.fadeMax),
};

function submitDecision(task) {
  submitTask(async () => {
    const decision = await task();
    await afterDecision(decision.__headline, decision, { auto: true, source: decision.source });
  });
}

function entryScan(now) {
  for (const a of ASSETS) {
    if (now - (cooldown[a] ?? 0) < COOLDOWN_MS) continue;
    const t = tech[a];
    const c5 = chgPct(a, 5), c30 = chgPct(a, 30);
    const hit = c5 !== null && Math.abs(c5) >= 0.8 ? `[行情异动] ${a} 近5分钟${c5 > 0 ? "急涨" : "急跌"} ${Math.abs(c5).toFixed(2)}%`
      : c30 !== null && Math.abs(c30) >= 1.5 ? `[行情异动] ${a} 近30分钟${c30 > 0 ? "急涨" : "急跌"} ${Math.abs(c30).toFixed(2)}%`
      : t?.rsi14 >= 72 || (t?.rsi14 <= 28 && t?.rsi14 !== null) ? `[超买/超卖] ${a} RSI14=${t.rsi14.toFixed(0)}，15分斜率${pct(t.slope15)}，量比${t.volRatio?.toFixed(2) ?? "–"}`
      : null;
    if (!hit) continue;
    cooldown[a] = now;
    const title = `${hit}，现价 ${prices[a].toFixed(decOf(a))}`;
    console.log(`\n[entry] ${title}`);
    const chg = c5 ?? c30 ?? t?.slope15 ?? 0;
    submitDecision(async () => ({ ...(await decideMove(a, chg, marketCtx(), momentumGates)), __headline: title }));
  }
}

// Open a position from tape facts alone. One lot per coin, a bounded number of lots
// in total, and a re-arm delay on a coin we just stopped out on so a slide does not
// get bought back in three equal pieces.
function heldUsd(a) { return (account.positions[a] ?? 0) * (prices[a] ?? account.cost[a] ?? 0); }
function isHeld(a) { return heldUsd(a) > dustUsd(); }
function dustUsd() { return equityNow() * ENTRY_DUST_PCT; }

function ruleEntryScan(now, tape) {
  let slots = entryThresholds.maxPositions
    - Object.keys(account.positions).filter((a) => isHeld(a)).length;
  if (slots <= 0) return;
  const equity = equityNow();
  for (const a of ASSETS) {
    if (slots <= 0) break;
    if (isHeld(a)) continue;
    if (now - (entryCooldown[a] ?? 0) < ENTRY_COOLDOWN_MS) continue;
    if (now - (rearmAt[a] ?? 0) < ENTRY_REARM_MS) continue;
    const f = tape[a];
    const kind = entryKind({ ...f, held: false }, entryThresholds);
    if (!kind) continue;
    const notional = entryNotional(kind, equity, entryThresholds);
    entryCooldown[a] = now; cooldown[a] = now; slots--;
    const facts = `RSI14=${f.rsi14?.toFixed(0) ?? "–"} 24h区间${f.rangePos?.toFixed(0) ?? "–"}% ` +
      `近30分${pct(f.pct30)} 近1时${pct(f.pct60)} 量比${f.volRatio?.toFixed(2) ?? "–"}`;
    const title = `[规则入场:${kind}] ${a} ${facts}，现价 ${prices[a].toFixed(decOf(a))}`;
    console.log(`\n[entry] ${title} → 买 ${notional.toFixed(2)} USDC`);
    submitDecision(async () => ({
      action: "buy", source: "entry", asset: a, kind, notional,
      reason: `规则入场 ${kind}（不经 Jev）：${facts}`,
      signals: { material: { noul: 1, confidence: 1 }, sentiment: {}, asset: { choice: a } },
      __headline: title,
    }));
  }
}

function riskScan(now) {
  for (const [a, qty] of Object.entries(account.positions)) {
    if (!(qty > 0) || !account.cost[a]) continue;
    if (now - (riskCooldown[a] ?? 0) < RISK_COOLDOWN_MS) continue;
    const cost = account.cost[a], peak = account.peak[a] ?? cost, px = prices[a];
    const pnl = (px / cost - 1) * 100, peakPnl = (peak / cost - 1) * 100;
    const giveBack = ((peak - px) / peak) * 100;
    const heldMs = account.entryAt[a] ? now - account.entryAt[a] : null;
    const heldMin = heldMs === null ? null : heldMs / 60000;
    const kind = riskKind({ pnlPct: pnl, peakPnlPct: peakPnl, giveBackPct: giveBack, heldMs }, riskThresholds);
    if (!kind) continue;
    riskCooldown[a] = now;
    const facts = `成本 ${cost.toFixed(decOf(a))}，现价 ${px.toFixed(decOf(a))}（浮动 ${pct(pnl)}），入场后最高 ${peak.toFixed(decOf(a))}（自峰值回吐 ${giveBack.toFixed(2)}%）` +
      `${heldMin === null ? "" : `，已持仓 ${heldMin.toFixed(0)} 分钟`}`;
    const title = `[持仓风控:${kind}] ${a} ${facts}`;
    console.log(`\n[risk] ${title}`);
    // A tripped rule asks "how bad is it"; a routine review asks "which way now".
    // The stop is the exception: measured behaviour showed Jev grading a -5% drawdown
    // as "轻微" and vetoing it, and a stop-loss a forecast can veto is not a stop-loss.
    if (RISK_FULL_EXIT.has(kind)) {
      submitDecision(async () => ({
        action: "sell", source: "rule", asset: a, fraction: 1,
        reason: `硬止损：浮动 ${pnl.toFixed(2)}% ≤ -${STOP_PCT}%（不经 Jev）`,
        signals: { material: { noul: 1, confidence: 1 }, sentiment: {}, asset: { choice: a } },
        __headline: title,
      }));
    } else if (kind === "review") {
      const c60 = chgPct(a, 60) ?? 0;
      submitDecision(async () => ({ ...(await decideMove(a, c60, `${marketCtx()}\n[持仓] ${facts}`, momentumGates)), __headline: `${title}，定时复核趋势（近1时${pct(c60)}）` }));
    } else {
      submitDecision(async () => ({ ...(await decideRisk(a, facts, marketCtx())), __headline: title }));
    }
  }
}

function priceScan() {
  const now = Date.now();
  const tape = tapeSnapshot();
  bus.emit("evt", { type: "tape", tape });
  ruleEntryScan(now, tape);
  entryScan(now);
  riskScan(now);
}
setInterval(priceScan, SCAN_MS).unref();
priceScan(); // push the first tape immediately so the dashboard has indicators

if (process.env.JEV_AUTO_NEWS === "1") {
  createNewsPoller({
    intervalMs: Number(process.env.JEV_NEWS_INTERVAL || 60000),
    onNews: (n) => { console.log(`\n[news:${n.source}] ${n.title}`); submit(n.title, { auto: true, source: n.source }); },
  });
  console.log("[news] 自动新闻循环已开启 (CoinTelegraph RSS)");
}
console.log(`[price] 纯行情决策已开启：每${SCAN_MS / 1000}s 扫描 5分±0.8%/30分±1.5%/RSI±(72,28) 入场，` +
  `建仓(规则) pullback RSI≤${entryThresholds.pullRsi}+区间≥${entryThresholds.pullRangePosMin}%+30分≤${-entryThresholds.pullDrop30}%` +
  ` / breakout 1时≥${entryThresholds.breakoutRise60}%+量比≥${entryThresholds.breakoutVolRatio}+区间≥${entryThresholds.breakoutRangePos}%，` +
  `单笔 ${entryThresholds.buyPct * 100}% 权益 × 最多 ${entryThresholds.maxPositions} 仓（碎仓<${(ENTRY_DUST_PCT * 100).toFixed(0)}%权益即清）；` +
  `动量闸 cont≥${momentumGates.runOn} 续势 / ≤${momentumGates.fadeMax} 反转；` +
  `风控 止损-${STOP_PCT}% 止盈+${TP_PCT}% 移动止盈回吐${TRAIL_PCT}% 持仓复核${REVIEW_MS / 60000}分；指标每${TECH_MS / 1000}s 刷新`);

function dashToken() {
  if (process.env.JEV_DASH_TOKEN) return process.env.JEV_DASH_TOKEN.trim();
  if (existsSync(".dash_token")) return readFileSync(".dash_token", "utf8").trim();
  const t = randomBytes(8).toString("hex");
  writeFileSync(".dash_token", t + "\n");
  return t;
}

if (process.env.JEV_DASH_PORT) {
  const token = dashToken();
  startDashboard({
    port: Number(process.env.JEV_DASH_PORT),
    token,
    bus,
    getState: () => {
      const equity = equityNow();
      return {
        prices, open, equity,
        startCash: account.startCash,
        pnlPct: (equity / account.startCash - 1) * 100,
        positions: positionView(),
        tape: tapeSnapshot(),
        assets: ASSETS.slice(),
        symbols: { ...SYMBOLS },
        quote: QUOTE,
        dec: Object.fromEntries(ASSETS.map((a) => [a, decOf(a)])),
        quickPicks: QUICK_PICKS,
        risk: { stopPct: STOP_PCT, tpPct: TP_PCT, trailPct: TRAIL_PCT, trailArm: TRAIL_ARM_PCT, reviewMin: REVIEW_MS / 60000 },
        entry: { ...entryThresholds },
        momentum: momentumGates,
        events: events.slice(0, 60),
      };
    },
    inject: (h) => { submit(h, { source: "web" }); },
    setAssets: (list) => setAssets(list),
  });
  console.log(`[dash] listening :${process.env.JEV_DASH_PORT} token=${token}`);
}
