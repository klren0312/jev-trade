// System-One strategy: one systemOne() call per headline answers 3 questions
// (material? how bullish? which asset?), then confidence gates the trade.

import { systemOne } from "./jev.mjs";

export const SENTIMENT_LEVELS = [
  "极度利空：恐慌性抛售预期",
  "偏利空：资金流出压力",
  "中性：无明显方向",
  "偏利好：资金流入意愿",
  "极度利好：强烈的上涨催化",
];

const MATERIAL_MIN = 0.5;    // below: ignore headline
const GRAY_ZONE = 0.68;      // below: escalate to System Two deep review
const CONF_MIN = 0.55;
export const DEFAULT_ASSETS = ["BTC", "ETH"];

export async function decide(headline, assets = DEFAULT_ASSETS, ctx = "") {
  const state = ctx ? `${headline}\n${ctx}` : headline;
  const answers = await systemOne(state, {
    material: {
      type: "noul",
      instructions: "Is this headline a market-moving event for crypto assets?",
    },
    sentiment: {
      type: "score",
      instructions: "How bullish or bearish is this headline for crypto?",
      criteria: SENTIMENT_LEVELS,
    },
    asset: {
      type: "choice",
      instructions: "Which crypto asset does this headline primarily affect?",
      criteria: Object.fromEntries([...assets.map((a) => [a, null]), ["NONE", null]]),
    },
  });

  const { material, sentiment, asset } = answers;
  answers.material = { ...material, confidence: material.confidence ?? Math.max(material.noul, 1 - material.noul) };
  const minConf = Math.min(answers.material.confidence, sentiment.confidence, asset.confidence);
  // live API: numeric score on the criteria index scale + legend; mock: score_index/score text
  const level = sentiment.score_index
    ?? (typeof sentiment.score === "number" ? Math.round(sentiment.score) : SENTIMENT_LEVELS.indexOf(sentiment.score));

  let action = "skip";
  let reason;
  if (material.noul < MATERIAL_MIN || asset.choice === "NONE") {
    reason = "not material";
  } else if (material.noul < GRAY_ZONE || minConf < CONF_MIN) {
    return await deepReview(headline, asset.choice, material, minConf, ctx);
  } else if (level >= 3) {
    action = "buy";
    reason = sentiment.legend?.[level] ?? String(sentiment.score);
  } else if (level <= 1) {
    action = "sell";
    reason = sentiment.legend?.[level] ?? String(sentiment.score);
  } else {
    reason = "neutral sentiment";
  }

  return { action, reason, asset: asset.choice, signals: answers, source: "fast" };
}

// Momentum path: a price move is not "news", so the news materiality gate
// always skips it. Ask Jev about the move itself instead.
//
// Gates come from the observed distribution, not from symmetry. Over 334 live
// momentum calls `cont` had p05=0.22, median=0.34, p95=0.40, max=0.47 and never
// once reached 0.6: the "the move runs on" leg is unreachable, and a fade leg
// mirrored at <=0.4 covered 96% of all calls — the book sold on every rally and
// never bought. So the fade leg sits in the extreme left tail.
export const MOMENTUM_GATES = { runOn: 0.6, fadeMax: 0.22 };

export async function decideMove(asset, changePct, ctx = "", gates = MOMENTUM_GATES) {
  const dir = changePct > 0 ? "上涨" : "下跌";
  const state = `${asset} 价格在过去几分钟内${dir} ${Math.abs(changePct).toFixed(2)}%。${ctx}`;
  const answers = await systemOne(state, {
    continuation: {
      type: "noul",
      instructions: `Will ${asset} keep ${changePct > 0 ? "rising" : "falling"} over the next hour because of this move?`,
    },
    strength: {
      type: "score",
      instructions: `How strong and meaningful is this ${dir} move as a trading signal?`,
      criteria: SENTIMENT_LEVELS,
    },
  });
  const cont = { ...answers.continuation, confidence: answers.continuation.confidence ?? Math.max(answers.continuation.noul, 1 - answers.continuation.noul) };
  const level = answers.strength.score_index
    ?? (typeof answers.strength.score === "number" ? Math.round(answers.strength.score) : SENTIMENT_LEVELS.indexOf(answers.strength.score));
  const conf = Math.min(cont.confidence, answers.strength.confidence);
  const action = momentumAction({ up: changePct > 0, cont: cont.noul, level, conf, ...gates });
  return {
    action,
    source: "momentum",
    asset,
    reason: `momentum: cont=${cont.noul.toFixed(2)} strength=${level}/4 conf=${conf.toFixed(2)}`,
    signals: { material: cont, sentiment: answers.strength, asset: { choice: asset } },
  };
}

// "Will this move continue?" is directional: the same answer means opposite trades
// on a rally and on a dump. Kept pure so the mapping is testable without the API.
export function momentumAction({ up, cont, level, conf, runOn = MOMENTUM_GATES.runOn, fadeMax = MOMENTUM_GATES.fadeMax }) {
  if (level < 3 || conf < CONF_MIN) return "skip";
  if (cont >= runOn) return up ? "buy" : "sell"; // the move runs on
  if (cont <= fadeMax) return up ? "sell" : "buy"; // the move is expected to fade
  return "skip";
}

// Risk path: an open position is itself a standing decision. Fed by price
// facts only (P&L vs entry, pullback from peak, holding time) — no news needed.
const SEVERITY_LEVELS = [
  "无关紧要：正常波动噪音",
  "轻微：可忽略的偏离",
  "中等：值得警惕的恶化",
  "严重：明显失控",
  "紧急：必须立刻处理",
];

export async function decideRisk(asset, facts, ctx = "") {
  const state = `当前持仓风险检查。${asset}：${facts}。${ctx}`;
  const answers = await systemOne(state, {
    exitNow: {
      type: "noul",
      instructions: `Should the position in ${asset} be closed now to manage risk?`,
    },
    severity: {
      type: "score",
      instructions: `How severe is the current risk situation of this ${asset} position?`,
      criteria: SEVERITY_LEVELS,
    },
  });
  const ex = { ...answers.exitNow, confidence: answers.exitNow.confidence ?? Math.max(answers.exitNow.noul, 1 - answers.exitNow.noul) };
  const level = answers.severity.score_index
    ?? (typeof answers.severity.score === "number" ? Math.round(answers.severity.score) : SEVERITY_LEVELS.indexOf(answers.severity.score));
  // The rule already tripped; Jev grades how serious it is. Measured behaviour: its
  // exitNow hovers near 0.5 even at -10%, so severity decides and exitNow sizes.
  const act = level >= 3;
  return {
    action: act ? "sell" : "skip",
    source: "risk",
    asset,
    fraction: act ? (level >= 4 || ex.noul >= 0.75 ? 1 : 0.5) : 0, // severe or insistent → full exit
    reason: `risk: severity=${level}/4 exit=${ex.noul.toFixed(2)}`,
    signals: { material: ex, sentiment: answers.severity, asset: { choice: asset } },
  };
}

// System Two: a slower, decomposed second Jev pass on gray-zone headlines.
const DIRECTNESS_LEVELS = [
  "几乎无直接影响：情绪噪音",
  "间接影响：宏观或关联资产传导",
  "较直接：行业监管、大型机构行为",
  "非常直接：针对该资产的重磅事实",
];

const idxOf = (q) => q.score_index ?? (typeof q.score === "number" ? Math.round(q.score) : -1);

async function deepReview(headline, asset, material, minConf, ctx = "") {
  const d = await systemOne(`市场事件：${headline}${ctx ? "\n" + ctx : ""}`, {
    bullish: { type: "noul", instructions: "Is this event a net bullish driver for crypto prices?" },
    bearish: { type: "noul", instructions: "Is this event a net bearish driver for crypto prices?" },
    directness: { type: "score", instructions: "How directly does this event impact crypto market prices?", criteria: DIRECTNESS_LEVELS },
    factual: { type: "noul", instructions: "Is the event reported as an established fact rather than a rumor or opinion?" },
  });
  const net = d.bullish.noul - d.bearish.noul;
  const power = ((idxOf(d.directness) + 1) / 4) * d.factual.noul;

  let action = "skip";
  if (power >= DEEP_POWER_MIN && net >= DEEP_NET_MIN) action = "buy";
  else if (power >= DEEP_POWER_MIN && net <= -DEEP_NET_MIN) action = "sell";

  return {
    action,
    source: "deep",
    asset,
    escalated: true,
    reason: `deep: net=${net.toFixed(2)} power=${power.toFixed(2)} (fast-path noul=${material.noul.toFixed(2)} conf=${minConf.toFixed(2)})`,
    signals: { material: { ...material, confidence: Math.min(1, power) }, sentiment: d, asset: { choice: asset } },
    deep: d,
  };
}

const DEEP_POWER_MIN = 0.4;
const DEEP_NET_MIN = 0.2;

export function positionSize(decision, account, price, equity) {
  const haircut = decision.source === "deep" ? 0.5 : 1; // act smaller on deliberated calls
  if (decision.action === "buy") {
    if (decision.notional != null) return decision.notional; // rule entries carry their own size
    const conf = decision.signals.material.confidence;
    return equity * (0.10 + 0.10 * conf) * haircut; // USD notional, 10-20% of equity
  }
  if (decision.action === "sell") {
    const frac = decision.fraction ?? 0.4 * haircut; // risk exits state their own fraction
    return (account.positions[decision.asset] ?? 0) * frac;
  }
  return 0;
}
