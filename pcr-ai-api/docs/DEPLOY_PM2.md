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

- **生产不要用 `npm install` 代替 `npm ci`**：除非你有意放宽锁文件；CI/正式环境通常用 `npm ci` 保证与 `package-lock.json` 一致。
- **`NODE_ENV`**：由 `ecosystem.config.cjs` 设为 `production`；不要用测试用的 dummy 开关冒充正式数据（见 `.env.example` 中 `YIELD_MONITOR_TRIGGERS_DUMMY` / `INFCONTROL_LAYER_BINS_DUMMY`）。
- **监听端口**：由环境变量 `PORT` 控制；防火墙 / 反向代理需与之一致。

更完整的 AI / Claude Code 调用说明见 [`AI_AGENT_API.md`](./AI_AGENT_API.md)；**v3** 完整 SQL 见 [`API_V3.md`](./API_V3.md)（改 SQL 后在本目录执行 `npm run docs:api-v3` 可再生成）。

## 6. 想用 dummy 联调却仍报 Oracle（如 NJS-116）

说明进程仍在走 **真实 Oracle**，**dummy 未生效**。Dummy 不会因为你「打算测试」而自动打开。

**常见误操作**：只在 **`.env.example`** 里写了 `INFCONTROL_LAYER_BINS_DUMMY=true`。该文件是模板，**运行时不会被加载**；必须把变量写在项目根目录的 **`.env`**（一般由 `copy .env.example .env` 得到）。修改 `.env` 后需重启 PM2。

**层控 BIN**（`/infcontrol-layer-bins`、**`/infcontrol-layer-bins/aggregate`**）仅在下列任一成立时使用内存数据：

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
