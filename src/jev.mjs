// Jev (TypeSafe System One) client — REST shape from docs.typesafe.ai / litellm passthrough.
// Key resolution: JEV_API_KEY env var, else a .jev_key file (single line) in cwd.
// Without a key: deterministic keyword-based mock, clearly marked.

import { readFileSync, existsSync } from "node:fs";

const API_BASE = process.env.JEV_API_BASE || "https://api.typesafe.ai/v1";
const MODEL = process.env.JEV_MODEL || "jev-latest";

function apiKey() {
  if (process.env.JEV_API_KEY) return process.env.JEV_API_KEY;
  if (existsSync(".jev_key")) return readFileSync(".jev_key", "utf8").trim();
  return null;
}

export const live = () => Boolean(apiKey());

export async function systemOne(state, questions) {
  const key = apiKey();
  if (!key) return mockSystemOne(state, questions);
  const res = await fetch(`${API_BASE}/systemone`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ model: MODEL, state, questions }),
  });
  if (!res.ok) throw new Error(`Jev API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.answers;
}

const POS = ["approve", "rally", "surge", "upgrade", "increase", "inflow", "adopt", "beat", "上涨", "获批", "利好", "增持", "流入", "升级", "创新高", "反弹", "批准", "提升", "集成", "超预期"];
const NEG = ["hack", "exploit", "crash", "suspend", "ban", "outflow", "lawsuit", "dump", "暴跌", "被盗", "清算", "利空", "暂停", "抛压", "诉讼", "异常", "担忧", "激活", "转入"];
const NEUTRAL_HINT = ["meme", "unrelated", "无关", "娱乐", "小范围", "flat"];

const count = (text, words) => words.reduce((n, w) => n + (text.toLowerCase().includes(w) ? 1 : 0), 0);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const softmax2 = (p, conf) => ({ yes: p, no: 1 - p, confidence: conf });

const ALIAS = { BTC: ["btc", "比特币"], ETH: ["eth", "以太坊"], APT: ["apt", "aptos"] };

function mentions(text, key) {
  const t = text.toLowerCase();
  return (ALIAS[key] ?? [key.toLowerCase()]).some((a) => t.includes(a));
}

function mockSystemOne(state, questions) {
  const pos = count(state, POS);
  const neg = count(state, NEG);
  const neutral = count(state, NEUTRAL_HINT) > 0;
  const strength = pos + neg;
  const bias = strength ? (pos - neg) / strength : 0;

  const answers = {};
  for (const [name, q] of Object.entries(questions)) {
    if (q.type === "noul") {
      const ins = (q.instructions || "").toLowerCase();
      let p;
      if (/bull|利好|上涨|正面/.test(ins)) p = clamp(0.5 + bias * 0.45, 0.03, 0.97);
      else if (/bear|利空|下跌|被盗|负面/.test(ins)) p = clamp(0.5 - bias * 0.45, 0.03, 0.97);
      else if (/fact|事实/.test(ins)) p = clamp(0.4 + strength * 0.2, 0, 0.95);
      else p = neutral ? 0.2 : clamp(0.1 + strength * 0.3, 0, 0.95);
      const conf = clamp(0.9 - Math.abs(p - 0.5) * 0.6, 0.5, 0.95);
      answers[name] = { type: "noul", noul: p, ...softmax2(p, conf) };
    } else if (q.type === "score") {
      const levels = q.criteria;
      const direct = /direct|直接/.test((q.instructions || "").toLowerCase());
      const idx = direct
        ? clamp(Math.round(strength), 0, levels.length - 1)
        : clamp(Math.round(((bias + 1) / 2) * (levels.length - 1)), 0, levels.length - 1);
      const cert = direct ? strength / 3 : Math.abs(bias);
      const conf = clamp(0.5 + cert * 0.45, 0.4, 0.95);
      const probabilities = levels.map((_, i) => (i === idx ? conf : (1 - conf) / (levels.length - 1)));
      answers[name] = { type: "score", score: levels[idx], score_index: idx, probabilities, confidence: conf };
    } else if (q.type === "choice") {
      const keys = Object.keys(q.criteria);
      const mentioned = keys.filter((k) => k.toUpperCase() !== "NONE" && mentions(state, k));
      const pick = mentioned.length === 1 ? mentioned[0]
        : strength === 0 || neutral ? "NONE"
        : mentioned[0] ?? keys[0];
      const conf = mentioned.length || pick === "NONE" ? 0.88 : 0.55;
      const probabilities = Object.fromEntries(keys.map((k) => [k, k === pick ? conf : (1 - conf) / (keys.length - 1)]));
      answers[name] = { type: "choice", choice: pick, probabilities, confidence: conf };
    }
  }
  return answers;
}
