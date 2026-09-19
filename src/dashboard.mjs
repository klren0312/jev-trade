// Minimal zero-dep dashboard: SSE push + token-guarded API over node:http.

import http from "node:http";

export function startDashboard({ port, host = "0.0.0.0", token, bus, getState, inject, setAssets }) {
  const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const readBody = (req, limit = 4000) => new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > limit) req.destroy(); });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(PAGE); }
    if (url.searchParams.get("t") !== token) { res.writeHead(401); return res.end("unauthorized"); }

    if (url.pathname === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      send({ type: "snapshot", ...getState() });
      bus.on("evt", send);
      req.on("close", () => bus.off("evt", send));
      return;
    }

    if (url.pathname === "/assets") {
      const s = getState();
      if (req.method === "GET") return json(res, 200, { assets: s.assets, symbols: s.symbols, quote: s.quote, dec: s.dec, quickPicks: s.quickPicks });
      if (req.method === "POST") {
        try {
          const { assets, add, remove } = JSON.parse(await readBody(req));
          let wanted = assets ?? s.assets;
          if (add) wanted = [...wanted, ...(Array.isArray(add) ? add : [add])];
          if (remove) wanted = wanted.filter((a) => !(Array.isArray(remove) ? remove : [remove]).includes(a));
          const result = await setAssets(wanted);
          return json(res, result.rejected.length ? 422 : 200, result);
        } catch (e) { return json(res, 400, { error: e.message }); }
      }
      return json(res, 405, { error: "method not allowed" });
    }

    if (url.pathname === "/news" && req.method === "POST") {
      try {
        const { headline } = JSON.parse(await readBody(req));
        if (!String(headline).trim()) throw new Error("empty");
        inject(String(headline).trim());
        return json(res, 202, { ok: true });
      } catch { return json(res, 400, { error: "bad request" }); }
    }

    res.writeHead(404); res.end("not found");
  });
  server.listen(port, host);
  return server;
}

const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Jev 模拟盘</title><style>
:root{color-scheme:dark}
body{margin:0;font:14px/1.6 ui-monospace,"Cascadia Mono",Consolas,monospace;background:#0b0f14;color:#d7e0ea}
header{display:flex;gap:14px;flex-wrap:wrap;padding:14px 18px;border-bottom:1px solid #1c2530}
.card{background:#121a24;border:1px solid #1f2d3d;border-radius:10px;padding:10px 16px;min-width:150px}
.card b{font-size:20px}.up{color:#3fd07a}.down{color:#ff6b6b}.dim{color:#6c7f95}
main{padding:18px;max-width:980px;margin:0 auto}
form{display:flex;gap:8px;margin-bottom:16px}
input{flex:1;background:#121a24;border:1px solid #2a3a4e;color:#d7e0ea;border-radius:8px;padding:9px 12px;font:inherit}
button{background:#2563eb;color:#fff;border:0;border-radius:8px;padding:9px 18px;font:inherit;cursor:pointer}
.row{display:flex;gap:10px;align-items:baseline;padding:9px 4px;border-bottom:1px solid #141c26}
.badge{padding:1px 9px;border-radius:99px;font-size:12px;background:#333;color:#aaa;flex:none}
.buy{background:#0c2f1e;color:#3fd07a}.sell{background:#33131a;color:#ff6b6b}
.skip{background:#1a222c;color:#6c7f95}.deep{outline:1px solid #3b82f6}
.sig{color:#6c7f95;font-size:12px;flex:none}
.hl{flex:1}.reason{color:#93a7bd;font-size:12px}
.tape{background:#0f1720;border:1px solid #1f2d3d;border-radius:10px;padding:10px 14px;margin-bottom:16px;line-height:1.9}
.coins{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px}
.chip{background:#16202c;border:1px solid #24384d;border-radius:99px;padding:3px 6px 3px 12px;font-size:13px}
.chip b{color:#7fb0ff}
.chip .x{cursor:pointer;color:#6c7f95;padding:0 6px}
.chip .x:hover{color:#ff6b6b}
.coinadd{display:flex;gap:6px;flex:1;min-width:220px}
.coinadd input{padding:5px 10px;font-size:13px}
.coinadd button{padding:5px 12px;font-size:13px}
.err{color:#ff6b6b;font-size:12px}
</style></head><body>
<header><div class="card"><div class="dim">权益 equity</div><b id="eq">–</b> USDC<div class="sig" id="pnl"></div></div><div id="cards" style="display:flex;gap:14px;flex-wrap:wrap"></div></header>
<main>
<div class="coins" id="coins"></div>
<div id="tape" class="tape"></div>
<form id="f"><input id="h" placeholder="输入新闻标题，回车触发 Jev 信号…" autocomplete="off"><button>注入</button></form>
<div id="feed"></div>
<datalist id="qp"></datalist>
</main>
<script>
const T=new URLSearchParams(location.search).get("t")||"";
let open={},cards={},feed=[],acct={},tape={},risk={},assets=[],dec={},qp=[],coinsErr="";
const $=(s)=>document.querySelector(s);
const decOf=(a)=>dec[a]!=null?dec[a]:(open[a]&&open[a].p<10?4:2);
function card(a){if(cards[a])return cards[a];const d=document.createElement("div");d.className="card";
d.innerHTML='<div class="dim">'+a+'</div><b>–</b><div class="sig chg"></div>',$("#cards").appendChild(d);cards[a]=d;return d}
function syncCards(){for(const a of Object.keys(cards))if(!assets.includes(a)){cards[a].remove();delete cards[a]}for(const a of assets)card(a)}
function fmt(x,n=2){return x==null?"–":Number(x).toFixed(n)}
function draw(){for(const a of assets){const c=open[a];if(!c||c.p==null)continue;const d=card(a);
const n=decOf(a);d.querySelector("b").textContent=fmt(c.p,n);const e=d.querySelector(".chg");
if(!c.open)continue;const chg=(c.p/c.open-1)*100;
e.textContent=(chg>=0?"+":"")+chg.toFixed(2)+"%";e.className="sig chg "+(chg>=0?"up":"down")}}
function drawCoins(){const chips=assets.map(a=>'<span class="chip"><b>'+a+'</b><span class="x" data-a="'+a+'" title="移除">×</span></span>').join("");
$("#coins").innerHTML=chips+'<form class="coinadd" id="addf"><input id="add" list="qp" placeholder="加币种，如 SOL 或 PEPEUSDT" autocomplete="off"><button>添加</button></form>'+(coinsErr?'<span class="err">'+coinsErr+'</span>':'');
$("#qp").innerHTML=qp.filter(a=>!assets.includes(a)).map(a=>'<option value="'+a+'">').join("");
$("#addf").onsubmit=async(ev)=>{ev.preventDefault();const v=$("#add").value.trim();if(!v)return;$("#add").value="";await postAssets({add:v})};
for(const el of document.querySelectorAll(".chip .x"))el.onclick=()=>postAssets({remove:el.dataset.a})}
async function postAssets(body){coinsErr="";
try{const r=await fetch("/assets?t="+T,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
const j=await r.json();if(j.rejected&&j.rejected.length)coinsErr="拒绝："+j.rejected.map(x=>x.asset+"（"+x.reason+"）").join("；")}
catch(e){coinsErr="请求失败"}drawCoins()}
function drawFeed(){$("#feed").innerHTML=feed.map(e=>{const cls=e.action==="buy"?"buy":e.action==="sell"?"sell":"skip";
const ts=e.ts?new Date(e.ts).toISOString().slice(5,16).replace("T"," "):"";
return '<div class="row"><span class="badge '+cls+(e.source==="deep"?" deep":"")+'">'+e.action.toUpperCase()+(e.source==="deep"?"*":"")+'</span>'+
'<span class="sig">'+(ts?ts+" · ":"")+e.sig+'</span><span class="hl">'+(e.auto&&e.src?'['+e.src+'] ':'')+e.asset+' · '+e.headline.replace(/</g,"&lt;")+'</span><span class="reason">'+e.reason+(e.note?' | '+e.note:'')+'</span></div>'}).join("")}
function price(a,p){open[a]=open[a]||{};open[a].p=p;tape[a]=tape[a]||{};tape[a].px=p;drawTape();draw()}
function drawEq(){if(acct.start==null)return;const p=(acct.eq/acct.start-1)*100;
const pos=Object.entries(acct.positions||{}).map(([a,q])=>a+" "+Number(q.qty).toFixed(a==="BTC"?5:2)).join(" ");
$("#pnl").innerHTML='<span class="'+(p>=0?"up":"down")+'">'+(p>=0?"+":"")+p.toFixed(2)+"%</span> · 起始 "+fmt(acct.start)+(pos?" · 持仓 "+pos:" · 空仓")}
function drawTape(){const R=risk||{};const rows=Object.entries(tape).map(([a,t])=>{
const q=(acct.positions||{})[a];const f=(x,n=2)=>x==null?"–":((x>=0?"+":"")+Number(x).toFixed(n)+"%");const n=decOf(a);
return '<span class="sig"><b class="dim">'+a+'</b> 价格 '+(t.px==null?"–":fmt(t.px,n))+' 成本 '+(q&&q.cost!=null?fmt(q.cost,n):"–")+' 浮动 <span class="'+(q&&q.pnlPct>=0?"up":"down")+'">'+(q?f(q.pnlPct):"–")+'</span>'+
' · RSI14 '+(t.rsi14==null?"–":Number(t.rsi14).toFixed(0))+' · 量比 '+(t.volRatio==null?"–":Number(t.volRatio).toFixed(2))+
' · 5分 '+f(t.pct5)+' · 30分 '+f(t.pct30)+' · 1时 '+f(t.pct60)+' · 24h '+f(t.pct24,1)+' · 区间 '+(t.rangePos==null?"–":Number(t.rangePos).toFixed(0)+"%")+'</span>'}).join("<br>");
$("#tape").innerHTML=(rows||"")+'<div class="sig dim">风控阈值：止损 -'+fmt(R.stopPct)+'% · 移动止盈 回吐 '+fmt(R.trailPct)+'%（浮盈≥'+fmt(R.trailArm??R.trailArmPct)+'% 后激活）· 止盈 +'+fmt(R.tpPct)+'% · 持仓复核 每 '+fmt(R.reviewMin,0)+' 分</div>'}
new EventSource("/events?t="+T).onmessage=(m)=>{const e=JSON.parse(m.data);
if(e.type==="snapshot"){e.assets&&(assets=e.assets);e.dec&&(dec=e.dec);e.quickPicks&&(qp=e.quickPicks);syncCards();
e.prices&&Object.entries(e.prices).forEach(([a,p])=>price(a,p));
e.open&&Object.entries(e.open).forEach(([a,p])=>{open[a]=open[a]||{};open[a].open=p});draw();
acct={eq:e.equity,start:e.startCash,positions:e.positions};risk=e.risk||{};tape=e.tape||tape;
$("#eq").textContent=fmt(e.equity);drawEq();drawTape();drawCoins();feed=e.events||[];drawFeed();return}
if(e.type==="price"){price(e.asset,e.price);acct.eq=e.equity;$("#eq").textContent=fmt(e.equity);drawEq();return}
if(e.type==="tape"){tape={...tape,...e.tape};drawTape();return}
if(e.type==="assets"){assets=e.assets||assets;if(e.dec)dec=e.dec;syncCards();draw();drawCoins();drawTape();return}
if(e.type==="decision"){const i=feed.findIndex(x=>x.id===e.id);if(i>=0)feed[i]=e;else{feed.unshift(e);feed=feed.slice(0,60)}drawFeed();return}
if(e.type==="trade"){const i=feed.findIndex(x=>x.id===e.id);if(i>=0){feed[i].note=e.note;drawFeed()}
if(e.equity!=null){acct.eq=e.equity;acct.positions=e.positions;drawEq();drawTape()}}};
$("#f").onsubmit=async(ev)=>{ev.preventDefault();const v=$("#h").value.trim();if(!v)return;$("#h").value="";
await fetch("/news?t="+T,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({headline:v})})};
</script></body></html>`;
