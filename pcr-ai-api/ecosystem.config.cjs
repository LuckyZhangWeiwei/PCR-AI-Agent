/**
 * PM2：用 Node 跑编译产物，不要用 ts-node（生产环境不必安装 ts-node）。
 *
 * 正式环境发布步骤（前置条件、systemd 自启等）见文档：docs/DEPLOY_PM2.md
 *
 * 部署：
 *   npm ci && npm run build && pm2 start ecosystem.config.cjs
 * 更新：
 *   git pull && npm ci && npm run build && pm2 reload ecosystem.config.cjs
 *
 * 从项目根目录读取 .env，并传入子进程（避免仅依赖 dotenv 时 PM2 下未生效）。
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

/** 仅当为 1/true/yes 时启用内存 Dummy；否则显式传 false，确保正式环境默认走 Oracle */
function dummyEnv(raw) {
  const v = raw?.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return "true";
  return "false";
}

module.exports = {
  apps: [
    {
      name: "pcr-ai-api",
      cwd: __dirname,
      script: "dist/server.js",
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        ...(process.env.PORT ? { PORT: process.env.PORT } : {}),
        YIELD_MONITOR_TRIGGERS_DUMMY: dummyEnv(
          process.env.YIELD_MONITOR_TRIGGERS_DUMMY
        ),
        INFCONTROL_LAYER_BINS_DUMMY: dummyEnv(
          process.env.INFCONTROL_LAYER_BINS_DUMMY
        ),
      },
    },
  ],
};
