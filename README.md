# Jev 模拟盘（jev-trade）

用真实的 Jev / TypeSafe「System One」推理 API + Binance 公共行情，跑一个**零依赖**的加密货币模拟盘（paper trading）：
新闻和市场波动都会触发信号，双系统（快思考 + 慢思考复核）做决策，规则层做风控，成交、权益和决策流全部落盘，并带一个 token 保护的网页看板。

> 只做模拟交易，不接任何真实下单通道。所有价格来自 Binance 公共行情，成交按市价 + 0.1% 手续费撮合。

## 快速开始

```bash
# Node 22+（用到全局 fetch / WebSocket / node:test），无 npm 依赖
echo "<你的 Jev API key>" > .jev_key     # 不写这个文件也能跑，会退化成关键词 mock
node src/live.mjs                        # REPL：输入新闻标题回车即触发决策
node --test                              # 风控规则 + 账簿单测
node src/backtest.mjs                    # 合成行情离线回测（不需要行情网络；有 .jev_key 时仍会调用 Jev）
```

REPL 里：直接输入标题 = 注入一条新闻；`p` 看持仓与权益；`c BTC ETH` 换币种（可多个）；`q` 退出。

## 币种配置（运行时可改，不用重启）

三种入口，互不冲突：

1. **看板**（推荐）：顶部币种条，`×` 移除，输入框加币种后回车/点「添加」；支持速选列表（BTC/ETH/SOL/…）。
2. **REPL**：`c BTC ETH SOL`（整表替换）、`c`（清空观察列表）。
3. **启动**：`JEV_ASSETS="BTC,ETH"`；不设置则沿用上次状态文件里保存的列表，首次运行默认 `APT`。

输入格式随意：`apt` / `APT-USDT` / `APT/USDT` / `PEPEUSDT` 都会被归一化，报价货币默认 USDT（`JEV_QUOTE` 可改）。新增币种会用 Binance `exchangeInfo` 校验是否为可交易对，并且用 `tickSize` 决定界面显示的小数位；非法币种会被拒绝并附原因，列表保持不变。

两个刻意的设计：

- **移出观察列表 ≠ 平仓**。移出的币种不再触发入场信号，但只要还持有，行情订阅、止损/止盈/移动止盈/复核照常工作（`prices`/`meta` 保留，`cost`/`peak` 在账簿里）。
- **观察列表可以为空**：此时不订阅行情，只管理已有持仓。

带看板和自动新闻的常驻跑法：

```bash
JEV_DASH_PORT=3000 JEV_AUTO_NEWS=1 JEV_NEWS_INTERVAL=45000 \
  node src/live.mjs < live.in > live.log 2>&1 &   # live.in 用 mkfifo 建，可随时 printf "标题\n" > live.in
```

看板：`http://<host>:3000/?t=<token>`，token 在 `.dash_token`（首次启动自动生成）。`/events` 是 SSE 推送，`POST /news?t=<token>` 注入新闻，`GET/POST /assets?t=<token>` 读写币种列表。

## 决策链路

```
新闻(RSS/输入)          行情扫描(每30s)             持仓风控扫描
     │                        │                          │
     ▼                        ▼                          ▼
  fast：一次 Jev 调用      momentum：动量续势判断     纯规则 riskKind()
  3 问：是否利好事件 /     (decideMove)               ├ stop → 直接清仓，不问 Jev
  多空 5 档 / 影响哪个币        │                      └ tp/trailing/review → Jev 打分
     │                         │                          │
  灰区(noul<0.68 或 conf<0.55) └───────┬──────────────────┘
     ▼                                 ▼
  deep：System Two 4 问            决策 {action, reason, asset, signals}
  bull/bear/直接性/事实性                 │
     │                                    ▼
     └────────────────────► positionSize() → PaperAccount 撮合 → 落盘 + SSE
```

四个决策来源：`fast`（新闻快思考）、`deep`（新闻慢思考复核）、`momentum`（纯行情）、`risk`/`rule`（持仓风控）。价格层每次决策都会带一段「市场状态」上下文：现价、近 5/30/60 分钟涨跌、24h 区间位置、RSI14、量比、15/60 分斜率、1 分钟均幅。

## 风控规则（硬规则，`src/risk.mjs`）

阈值全部可通过环境变量覆盖，默认值集中在 `RISK_DEFAULTS`：

| 规则 | 触发条件 | 之后怎样 |
| --- | --- | --- |
| `stop` | 浮动 ≤ **-2%** | **直接市价清仓，不询问 Jev** |
| `take-profit` | 浮动 ≥ **+6%** | 问 Jev 严重度，决定是否落袋 |
| `trailing` | 浮盈曾达 +2% 后自峰值回吐 1.5% | 问 Jev |
| `review` | 持仓满 15 分钟 | 问 Jev 趋势（动量问答） |

优先级：`stop` > `take-profit` > `trailing` > `review`。风控扫描本身 10 分钟冷却（`JEV_RISK_COOLDOWN_MS`）。
入场扫描：近 5 分钟 ±0.8%、近 30 分钟 ±1.5%、或 RSI14 ≥72/≤28，同一资产 20 分钟冷却。

**为什么止损不走模型**：实测 Jev 会把 −5% 的回撤判成「轻微」并否决卖出（`exitNow` 长期在 0.5 附近），而一个能被预测否决的止损不是止损。所以止损只由规则执行；其余风控仍让模型判断严重度，并按 `severity ≥ 3` 才卖、`≥ 4` 或 `exitNow ≥ 0.75` 清仓来配比例。

## 仓位与账簿

- 买入名义额 = 权益的 10%~20%（按置信度线性放大），`deep` 决策再乘 0.5 折扣；卖出比例默认 40%，风控决策自带 `fraction`。
- 手续费 10 bps，市价成交，现金不足自动缩量，卖单超过持仓自动截断。
- `PaperAccount` 额外记 加权成本 `cost`、入场后峰值 `peak`、开仓时间 `entryAt`（风控靠这三个算浮盈/回吐/持仓时长）。

## 持久化

`.paper_state.json`（`JEV_STATE_FILE`）= 账户（含最近 500 笔成交）+ 价格基准 + 最近 120 条决策流。
启动时立即写一次，之后**每次决策/成交后**原子重写（tmp + rename），行情 tick 不写盘。
重启会恢复账户、决策流和涨跌幅基准；旧格式状态缺 `cost` 时会从成交记录回放重建。
**想把模拟盘重置回初始资金：先删掉这个状态文件，再重启。**

## 模块

| 文件 | 职责 |
| --- | --- |
| `src/assets.mjs` | 币种输入解析、symbol 归一化、tickSize→显示位数、列表 diff（纯函数，可单测） |
| `src/live.mjs` | 常驻入口：行情订阅、REPL、新闻/行情/风控三条扫描循环、币种注册表、状态落盘、看板装配 |
| `src/jev.mjs` | Jev REST 客户端（`POST /v1/systemone`）+ 无 key 时的确定性 mock |
| `src/strategy.mjs` | `decide`/`deepReview`/`decideMove`/`decideRisk` + `positionSize` |
| `src/risk.mjs` | 纯规则引擎 `riskKind()`、默认阈值、全清仓集合（可单测，不依赖行情） |
| `src/exchange.mjs` | 模拟成交账簿、序列化/恢复 |
| `src/feed.mjs` | Binance WS miniTicker + REST 兜底 + `snapshot`/`stats24h`/`klines` |
| `src/price.mjs` | RSI、量比、振幅、区间位置、斜率 |
| `src/news.mjs` | CoinTelegraph RSS 轮询、去重、首屏 priming |
| `src/dashboard.mjs` | 零依赖 `node:http` 看板：SSE + token 保护的 `/news` |
| `src/market.mjs` `src/backtest.mjs` | 合成行情与离线回测 |
| `test/risk.test.mjs` `test/assets.test.mjs` | 规则优先级、账簿记账、全清仓 sizing、币种解析 |

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `JEV_API_KEY` | 读 `.jev_key` | Jev key；不设置则用 mock |
| `JEV_API_BASE` / `JEV_MODEL` | `https://api.typesafe.ai/v1` / `jev-latest` | 模型端点 |
| `JEV_ASSETS` | 无（沿用状态文件，首跑 `APT`） | 启动时的观察列表，逗号分隔；运行时用看板或 `c` 命令改 |
| `JEV_QUOTE` | `USDT` | 报价货币 |
| `JEV_START_CASH` | `100000` | 新账户初始 USDC |
| `JEV_STATE_FILE` | `.paper_state.json` | 状态文件路径 |
| `JEV_SCAN_MS` / `JEV_TECH_MS` | `30000` / `60000` | 决策扫描 / K 线指标刷新间隔 |
| `JEV_STOP_PCT` `JEV_TP_PCT` `JEV_TRAIL_ARM_PCT` `JEV_TRAIL_PCT` `JEV_REVIEW_MS` | `2` `6` `2` `1.5` `900000` | 风控阈值 |
| `JEV_COOLDOWN_MS` / `JEV_RISK_COOLDOWN_MS` | `1200000` / `600000` | 入场 / 风控冷却 |
| `JEV_DASH_PORT` / `JEV_DASH_TOKEN` | 关 / `.dash_token` | 看板端口与 token |
| `JEV_AUTO_NEWS` / `JEV_NEWS_INTERVAL` | 关 / `60000` | 自动新闻轮询 |

## 已知的现实约束

- 本机和目标服务器都只有 `data-api.binance.vision` / `data-stream.binance.vision` 可达，OKX、Coinbase、binance.com 会超时。
- 线上 Jev 与文档/mock 行为不一致：`score` 返回**数字**加 `legend` 映射（不是档位字符串）；`noul` **不返回 confidence**（代码用 `max(p, 1-p)` 推）；整体比关键词 mock 保守得多，把「某币涨了 x%」当作非事件（mat≈0.25）——所以行情决策走独立问答，不复用新闻的材料性闸门。
- 服务器（`/root/jev-trade`，CentOS 9）需显式用 nvm 里的 node 绝对路径；安全组只放通 3000。
- 生产上请轮换并重新写入 `.jev_key`，不要把它贴进任何命令行或聊天记录。
