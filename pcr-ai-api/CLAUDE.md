# pcr-ai-api（Claude Code）

只读 **GET** JSON API，Oracle 主库 + probeweb。集成与端点说明以仓库文档为准：

| 优先阅读 | 内容 |
| --- | --- |
| [`docs/AI_AGENT_API.md`](docs/AI_AGENT_API.md) | **主文档**：**§0** 地图、**§4** Dummy、**§6** v1、**§7** v3 通俗、**§8** curl、**§5** Claude、**§9** 源码索引 |
| [`docs/API_V3.md`](docs/API_V3.md) | **v3 列表** SQL（`apiV3ListSql.ts`）；**v3 聚合** SQL见 `yieldMonitorTriggerV3Aggregate.ts`、`infcontrolLayerBinV3Aggregate.ts` |
| [`docs/DEPLOY_PM2.md`](docs/DEPLOY_PM2.md) | 生产 PM2 / 环境变量 |

**常用命令**：`npm run dev`（开发）、`npm run build && npm start`（生产）、`npm run docs:api-v3`（改 **`apiV3ListSql.ts`** 后刷新 **`API_V3.md`**）。

机器可读目录：`GET {baseUrl}/api/v1/manifest`（实现：`src/lib/apiManifest.ts`）。
