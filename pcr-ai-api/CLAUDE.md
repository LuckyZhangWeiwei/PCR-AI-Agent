# pcr-ai-api（Claude Code）

只读 **GET** JSON API，Oracle 主库 + probeweb。集成与端点说明以仓库文档为准：

| 优先阅读 | 内容 |
| --- | --- |
| [`docs/AI_AGENT_API.md`](docs/AI_AGENT_API.md) | **主文档**：manifest 流程、全部端点、**§5 Claude Code 使用建议**（可贴入系统提示）、§7 可复制 URL |
| [`docs/API_V3.md`](docs/API_V3.md) | **`/api/v1/infcontrol-layer-bins/v3`** 与 **`/api/v1/yield-monitor-triggers/v3`** 的完整 SQL（与 `dist` 一致） |
| [`docs/DEPLOY_PM2.md`](docs/DEPLOY_PM2.md) | 生产 PM2 / 环境变量 |

**常用命令**：`npm run dev`（开发）、`npm run build && npm start`（生产）、`npm run docs:api-v3`（改 `src/lib/apiV3ListSql.ts` 后刷新 `API_V3.md`）。

机器可读目录：`GET {baseUrl}/api/v1/manifest`（实现：`src/lib/apiManifest.ts`）。
