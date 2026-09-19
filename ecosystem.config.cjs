// pm2 进程定义：pm2 start ecosystem.config.cjs
// pm2 下 stdin 不是 TTY，live.mjs 会自动跳过 REPL（否则 readline 立即 EOF 并关掉行情源）；
// 因此新闻由看板 POST /news（带 ?t=token）或内置自动新闻循环注入。
const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "jev-trade",
      script: "src/live.mjs",
      cwd: __dirname,
      interpreter: process.execPath, // 固定用启动 pm2 的那个 node（服务器上为 nvm v24）
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      kill_timeout: 5000,
      merge_logs: true,
      time: true, // 每行日志带时间戳
      out_file: path.join(__dirname, "logs/out.log"),
      error_file: path.join(__dirname, "logs/err.log"),
      env: {
        JEV_NO_REPL: "1", // pm2 会分配 pty，stdin.isTTY 为真，必须显式关掉 REPL
        JEV_AUTO_NEWS: "1",
        JEV_NEWS_INTERVAL: "45000",
        JEV_DASH_PORT: "3000",
        // 密钥与口令仍走文件，不写进这里：.jev_key（Jev API）、.dash_token（看板）
        // 观察列表故意不写死：.paper_state.json 里保存的币种优先，
        // 这样看板上增删的币种能跨重启保留。
      },
    },
  ],
};
