# 正式环境：PM2 发布步骤

面向在生产机上用 **PM2** 常驻运行 **`dist/server.js`**（编译后的 Node，不用 `tsx`）。仓库根目录的 [`ecosystem.config.cjs`](../ecosystem.config.cjs) 已约定进程名 `pcr-ai-api`、`cwd` 为项目根、`NODE_ENV=production`。

## 1. 前置条件

- **Node.js**：`>=18.12.1`（见 `package.json` 的 `engines`）。
- **PM2**：全局安装一次即可，例如 `npm install -g pm2`。
- **Oracle**：正式接口依赖 **node-oracledb**；服务器需按 Oracle 文档安装 **Instant Client**，并配置环境变量（见根目录 [`.env.example`](../.env.example)）：
  - `ORACLE_USER` / `ORACLE_PASSWORD` / `ORACLE_CONNECT_STRING`
  - 产量监控端点另需 probeweb 相关变量（示例文件中已注释说明）
  - Linux 下常见：`ORACLE_INSTANT_CLIENT_LIB_DIR` 指向解压后的 instant client 目录（含 `libclntsh.so`）

## 2. 首次部署（干净目录）

在**服务器**上项目根目录执行（将分支 / 标签按你们规范替换）：

```bash
git clone <repo-url> pcr-ai-api
cd pcr-ai-api
git checkout <branch-or-tag>
```

1. **环境变量**：复制并编辑 `.env`（勿提交仓库），至少补齐 Oracle 与 `PORT`（未设置时进程内默认 **30008**，与 `.env.example` 中示例不同，以实际 `.env` 为准）。
2. **依赖（生产推荐锁文件安装）**：

   ```bash
   npm ci
   ```

3. **编译 TypeScript**：

   ```bash
   npm run build
   ```

   成功后会生成 `dist/`，入口为 `dist/server.js`（与 PM2 配置一致）。

4. **启动 PM2**：

   ```bash
   pm2 start ecosystem.config.cjs
   ```

也可一行等价组合（与 `ecosystem.config.cjs` 顶部注释一致）：

```bash
npm ci && npm run build && pm2 start ecosystem.config.cjs
```

### 可选：`package.json` 封装脚本

```bash
npm run pm2:start
```

等价于：`npm run build && pm2 start ecosystem.config.cjs`（**不含** `npm ci`，适合代码已在机器上且依赖未变的增量场景）。

## 3. 更新发布（已有目录）

在仓库根目录拉取新代码后：

```bash
git pull
npm ci
npm run build
pm2 reload ecosystem.config.cjs
```

`reload` 用于平滑重启同一应用配置；若进程尚未启动，改用 `pm2 start ecosystem.config.cjs`。

封装脚本：

```bash
npm run pm2:reload
```

等价于：`npm run build && pm2 reload ecosystem.config.cjs`（同样**不含** `npm ci`；若 `package-lock.json` 有变，请先手动执行 `npm ci`）。

## 4. 常用 PM2 运维命令

| 命令 | 说明 |
| --- | --- |
| `pm2 status` | 查看进程状态 |
| `pm2 logs pcr-ai-api` | 查看日志 |
| `pm2 reload ecosystem.config.cjs` | 按配置文件重载 |
| `pm2 restart pcr-ai-api` | 硬重启进程 |
| `pm2 delete pcr-ai-api` | 从 PM2 列表移除 |

开机自启（在部署机上执行一次，按 PM2 提示操作）：

```bash
pm2 save
pm2 startup
```

## 5. 注意事项

### 5.1 路由与 manifest（发布后仍 404 时先看这里）

- **`/api/v1`** 与 **`/api/v3`** 挂载**同一**路由表（见 `src/app.ts`）。业务 URL **推荐** **`/api/v3/...`**，旧集成仍可用 **`/api/v1/...`**。
- **`GET /api/v3/manifest`**：仅含 v3 列表/聚合、**`db/ping`**、**`/health`**；**`catalogScope`** 为 **`v3-surfaces-only`**；**`path` / `example`** 与 **`/api/v3`** 对齐（实现：`src/lib/rebaseApiManifest.ts`）。
- **`GET /api/v1/manifest`**：**全量**端点目录，**`catalogScope`** 为 **`full`**。
- 若 **`/api/v3/.../aggregate`** 返回 **404**，多为线上仍是**旧 `dist`**（未含当前路由）。在本机 **`npm run build`** 后 **`pm2 reload`**，并对照 **`GET …/api/v3/manifest`** 是否已列出该 **`path`**。

### 5.2 硅基流动：`Cannot find package 'undici'`

当前源码 **`src/lib/siliconflowChat.ts`** **不**依赖 npm 包 **`undici`**（严格 TLS 用 Node **`fetch`**，宽松 TLS 用 **`node:https`**）。若启动报错 **`imported from …/dist/lib/siliconflowChat.js`**，说明线上 **`dist/` 是旧构建**（仍 `import 'undici'`），而 **`package.json` 已无该依赖**。

在 **`pcr-ai-api`** 目录执行完整发布（勿只复制部分 `dist` 文件）：

```bash
cd /path/to/pcr-ai-api
git pull
npm ci
npm run build
pm2 reload ecosystem.config.cjs
```

`npm run build` 会在编译后运行 **`scripts/verify-dist-no-undici.mjs`**，若 `dist` 仍引用 `undici` 会直接失败。可用下面命令自检：

```bash
grep -E "from ['\"]undici['\"]" dist/lib/siliconflowChat.js && echo BAD || echo OK
```

**禁止**在 `package.json` 中重新加入 **`undici`** 依赖；出站实现仅允许 Node 内置 **`fetch`** / **`https`**（见 **`.cursor/rules/no-undici.mdc`**）。

### 5.3 硅基流动 API Key

密钥写在 **`src/lib/siliconflowChat.ts`** 的 **`SILICONFLOW_API_KEY`** 常量中，编译进 **`dist/`** 即可；**不必**在服务器 `.env` 或 PM2 里配置 **`SILICONFLOW_API_KEY`**。模型与 base URL 仍可通过 **`SILICONFLOW_MODEL`** / **`SILICONFLOW_API_BASE`** 覆盖（可选）。

- **生产不要用 `npm install` 代替 `npm ci`**：除非你有意放宽锁文件；CI/正式环境通常用 `npm ci` 保证与 `package-lock.json` 一致。
- **`NODE_ENV`**：由 `ecosystem.config.cjs` 设为 `production`；不要用测试用的 dummy 开关冒充正式数据（见 `.env.example` 中 `YIELD_MONITOR_TRIGGERS_DUMMY` / `INFCONTROL_LAYER_BINS_DUMMY`）。
- **监听端口**：由环境变量 `PORT` 控制；防火墙 / 反向代理需与之一致。

更完整的 AI / Claude Code 调用说明见 [`AI_AGENT_API.md`](./AI_AGENT_API.md)；**v3** 完整 SQL 见 [`API_V3.md`](./API_V3.md)（改 SQL 后在本目录执行 `npm run docs:api-v3` 可再生成）。

## 6. 想用 dummy 联调却仍报 Oracle（如 NJS-116）

说明进程仍在走 **真实 Oracle**，**dummy 未生效**。Dummy 不会因为你「打算测试」而自动打开。

**常见误操作**：只在 **`.env.example`** 里写了 `INFCONTROL_LAYER_BINS_DUMMY=true`。该文件是模板，**运行时不会被加载**；必须把变量写在项目根目录的 **`.env`**（一般由 `copy .env.example .env` 得到）。修改 `.env` 后需重启 PM2。

**层控 v3**（例如 **`GET /api/v3/infcontrol-layer-bins/v3`**、**`GET /api/v3/infcontrol-layer-bins/v3/aggregate`**；与 **`/api/v1/...`** 同路由）在下列任一成立且满足 **`listDummyRuntime`**（非 `dist`、非 `production`）时，可走 **`JBStart.xlsx`** 内存样本：

- 环境变量 **`INFCONTROL_LAYER_BINS_DUMMY=true`**（或 `1` / `yes`，大小写不敏感），或  
- **`NODE_ENV=test`**（一般不用于 PM2 正式进程）。

PM2 默认把 **`NODE_ENV=production`**（见 `ecosystem.config.cjs`），因此必须在项目根目录 **`.env`** 里增加一行并重启进程：

```env
INFCONTROL_LAYER_BINS_DUMMY=true
```

`src/server.ts` 使用 `dotenv`，会从**进程当前工作目录**（PM2 已设为项目根）加载 `.env`。修改后执行：

```bash
pm2 restart pcr-ai-api
```

再用浏览器或 curl 访问聚合接口，应返回 JSON 且**不再**触发 Oracle。

若要走真实库且报错 **NJS-116**，则需按 `detail` 提示配置 **Thick**（设置 `ORACLE_INSTANT_CLIENT_LIB_DIR` 等），与 dummy 无关。
