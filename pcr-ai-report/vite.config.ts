import type { ServerResponse } from "node:http";
import type { ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

/**
 * 502：Node 连不上 target（内网未连 VPN、网关宕机、或本机没起 API）。
 * 终端会打 `[vite] proxy → …`；浏览器 502 响应体里也会写如何改 `VITE_DEV_PROXY_TARGET`。
 */
function devProxy(target: string): ProxyOptions {
  return {
    target,
    changeOrigin: true,
    /** AI Agent SSE 多轮工具 + Oracle 常超过 60s；与后端 AGENT_STREAM_TIMEOUT_MS 默认 150s 对齐 */
    timeout: 180_000,
    proxyTimeout: 180_000,
    configure(proxy) {
      proxy.on("error", (err, _req, res) => {
        const errno = err as NodeJS.ErrnoException;
        console.error(`[vite] proxy → ${target}:`, errno.code ?? errno.message);
        const r = res as ServerResponse | undefined;
        if (r && !r.headersSent) {
          r.writeHead(502, {
            "Content-Type": "text/plain; charset=utf-8",
          });
          r.end(
            `Vite proxy cannot reach:\n  ${target}\n\n` +
              `Fix: edit pcr-ai-report/.env.development — set VITE_DEV_PROXY_TARGET to a URL your PC can reach, e.g.\n` +
              `  VITE_DEV_PROXY_TARGET=http://127.0.0.1:30008\n` +
              `(local pcr-ai-api), then restart: npm run dev\n\n` +
              `Underlying error: ${errno.code ?? ""} ${errno.message}`.trim()
          );
        }
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target =
    env.VITE_DEV_PROXY_TARGET?.trim() || "http://10.192.130.89:30008";

  return {
    plugins: [react()],
    build: {
      // ECharts + reports in one bundle (~1.1 MB minified).
      chunkSizeWarningLimit: 1700,
    },
    server: {
      /** localhost 页面直打内网 IP 会被 Chrome Private Network Access 拦截；开发时走同源 + 代理 */
      proxy: {
        "/api": devProxy(target),
        "/health": devProxy(target),
      },
    },
  };
});
