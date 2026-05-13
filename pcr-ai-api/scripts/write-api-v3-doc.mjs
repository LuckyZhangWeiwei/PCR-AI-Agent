import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const apiV3 = await import(
  pathToFileURL(join(root, "../dist/lib/apiV3ListSql.js")).href
);
const { buildInfcontrolLayerBinsV3Sql, buildYieldMonitorTriggersV3Sql } =
  apiV3;

const ic = buildInfcontrolLayerBinsV3Sql("");
const y = buildYieldMonitorTriggersV3Sql("");
const icEx = buildInfcontrolLayerBinsV3Sql(
  "UPPER(TRIM(t1.DEVICE)) = UPPER(:ic3_device) AND t2.TESTEND >= :ic3_testend_lo"
);
const yEx = buildYieldMonitorTriggersV3Sql(
  "WHERE UPPER(TRIM(t.DEVICE)) = UPPER(:v3_device) AND t.TIME_STAMP >= :v3_ts_lo"
);

const md = `# API v3（层控 / 产量监控）

本文档记录 **v3** 路由的**原始 SQL 模板**（与当前编译产物 \`dist/lib/apiV3ListSql.js\` 一致）。**HTTP 前缀**推荐 **/api/v3**（与 **/api/v1** 同路由器；manifest 行为见 [**AI_AGENT_API.md**](./AI_AGENT_API.md) 文首表、**§6.2**、**§8.3**）。业务说明、通俗理解见主文档 **§7**；**可复制 URL 与 curl** 见 **§8**；筛选参数表亦见 **§8.4**、**§8.6**。

**v3 聚合**（\`/infcontrol-layer-bins/v3/aggregate\`、\`/yield-monitor-triggers/v3/aggregate\`）的 SQL 不在此文件展开，见源码 **\`src/lib/yieldMonitorTriggerV3Aggregate.ts\`**、**\`src/lib/infcontrolLayerBinV3Aggregate.ts\`**（层控 UNPIVOT 与 **\`infcontrolLayerBinAggregate.ts\`** 共用 SQL 片段）。

字符串筛选由解析器生成 **\`UPPER(TRIM(列)) = UPPER(:bind)\`**，与仓库样例表 **\`docs/JBStart.xlsx\`**（层控）、**\`docs/delta-diff.xlsx\`**（产量）中的大小写习惯一致；查询参数**键名**不区分大小写（含 \`limit\`）。

## 源码位置

| 项 | 路径 |
| --- | --- |
| SQL 拼接 | \`src/lib/apiV3ListSql.ts\` |
| 层控 v3 筛选解析 | \`src/lib/infcontrolLayerBinFilters.ts\` → \`parseInfcontrolLayerBinsV3Query\` |
| 产量 v3 筛选解析 | \`src/lib/yieldMonitorTriggerFilters.ts\` → \`parseYieldMonitorTriggerV3Query\` |
| HTTP 路由 | \`src/routes/api.ts\` |

## 绑定变量

- **\`:lim\`**：由查询参数 \`limit\` 解析（默认 200，上限 500；**键名不区分大小写**，见 \`clampLimitFromQuery\`），与其它筛选 bind 一并传入 \`conn.execute\`。

---

## 1. \`GET /api/v3/infcontrol-layer-bins/v3\`

### 1.1 无额外筛选（仅 \`PASSTYPE = 'TEST'\`）

\`\`\`sql
${ic}
\`\`\`

### 1.2 带筛选时 \`WHERE\` 形态

在 \`WHERE t2.PASSTYPE = 'TEST'\` 之后追加 \` AND \` + \`parseInfcontrolLayerBinsV3Query\` 生成的 **\`whereAndSql\`**（片段内已为 \`AND\` 连接的条件，**不含** \`WHERE\`）。

**示例**（\`whereAndSql\` 含 \`TRIM(t1.DEVICE)\` 与 \`t2.TESTEND\` 下界）：

\`\`\`sql
${icEx}
\`\`\`

---

## 2. \`GET /api/v3/yield-monitor-triggers/v3\`

### 2.1 无 \`WHERE\`

\`\`\`sql
${y}
\`\`\`

### 2.2 有筛选时

\`parseYieldMonitorTriggerV3Query\` 生成完整 \`WHERE ...\` 行（含 \`WHERE\` 关键字），插入在 \`FROM\` 与 \`ORDER BY\` 之间。

**示例**：

\`\`\`sql
${yEx}
\`\`\`

---

## 3. 与仓库保持同步

修改 SQL 后执行 **\`npm run docs:api-v3\`**（内部先 \`tsc\` 再运行本脚本）可重新生成本文件。
`;

const out = join(root, "../docs/API_V3.md");
writeFileSync(out, md, "utf8");
console.log("Wrote", out);

const tmp = join(root, "../docs/_v3_sql_snippets.txt");
if (existsSync(tmp)) unlinkSync(tmp);
