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

/** 从 .env 透传到 PM2 子进程（避免部分环境下子进程未继承连接池 / 硅基流动相关变量） */
const ORACLE_FORWARD_KEYS = [
  "PORT",
  "ORACLE_USER",
  "ORACLE_PASSWORD",
  "ORACLE_CONNECT_STRING",
  "ORACLE_PROBEWEB_USER",
  "ORACLE_PROBEWEB_PASSWORD",
  "ORACLE_POOL_MIN",
  "ORACLE_POOL_MAX",
  "ORACLE_POOL_INCREMENT",
  "ORACLE_PROBEWEB_POOL_MIN",
  "ORACLE_PROBEWEB_POOL_MAX",
  "ORACLE_PROBEWEB_POOL_INCREMENT",
  "ORACLE_QUEUE_TIMEOUT",
  "ORACLE_CALL_TIMEOUT_MS",
  "ORACLE_SLOW_QUERY_LOG_MS",
  "ORACLE_PROBEWEB_CONNECT_STRING",
  "ORACLE_INSTANT_CLIENT_LIB_DIR",
  "ORACLE_SKIP_LEGACY_CLIENT_11",
  "ORACLE_CLIENT_CONFIG_DIR",
  "ORACLE_HOME",
  "TNS_ADMIN",
  "SILICONFLOW_API_KEY",
  "SILICONFLOW_MODEL",
  "SILICONFLOW_API_BASE",
  "SILICONFLOW_FETCH_TIMEOUT_MS",
  "SILICONFLOW_TLS_INSECURE",
  "SILICONFLOW_TLS_STRICT",
  "NODE_EXTRA_CA_CERTS",
  // AI Agent (POST /api/v4/agent/chat) server-side key override
  "AGENT_API_KEY",
  "AGENT_API_BASE",
  "AGENT_MODEL",
  "AGENT_STREAM_TIMEOUT_MS",
];

function forwardEnvFromProcess(keys) {
  const o = {};
  for (const k of keys) {
    const v = process.env[k];
    if (v !== undefined && v !== "") o[k] = v;
  }
  return o;
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
        ...forwardEnvFromProcess(ORACLE_FORWARD_KEYS),
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
