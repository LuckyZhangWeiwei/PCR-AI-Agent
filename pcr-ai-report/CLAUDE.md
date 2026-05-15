# Claude Code 交接说明（pcr-ai-report）

本文档供 **Claude Code**、Cursor Agent 或其它自动化在**接手本包**时快速对齐上下文。后端契约、Dummy、v3/v4 聚合语义见 **[`../pcr-ai-api/CLAUDE.md`](../pcr-ai-api/CLAUDE.md)** 与 **[`../pcr-ai-api/docs/AI_AGENT_API.md`](../pcr-ai-api/docs/AI_AGENT_API.md)**。

---

## 1. 本包是什么

- **技术栈**：React 19 + TypeScript + Vite 8 + ECharts 6。
- **角色**：只读看板，通过 **`GET`** 调用 **`pcr-ai-api`**（默认 **`/api/v4`**），在浏览器内做筛选、图表、下钻、KPI 与布局持久化。
- **产品标题**：**NXP ATTJ WaferTest Dashboard**（`App.tsx` 顶栏 + `index.html` `<title>`）。
- **不写库**：所有业务写入仅在 Oracle；前端仅 `localStorage` 存 API 地址与报表布局。

---

## 2. 必读文档（优先级）

| 顺序 | 文件 | 用途 |
| --- | --- | --- |
| 1 | 根目录 [`../CLAUDE.md`](../CLAUDE.md) | 双包命令、代理、整体数据流 |
| 2 | [`../pcr-ai-api/CLAUDE.md`](../pcr-ai-api/CLAUDE.md) | v3/v4、Dummy、聚合上限、硅基流动代理 |
| 3 | [`.env.development`](.env.development) / [`.env.production`](.env.production) | 开发代理 vs 生产 `VITE_API_BASE_URL` |
| 4 | [`.env.example`](.env.example) | 勿在 dev 直连 `10.x` 的说明 |

---

## 3. 常用命令

```bash
cd pcr-ai-report
npm ci
npm run dev       # Vite，读 .env.development
npm run build     # tsc -b && vite build → dist/
npm run lint
npm run preview   # 本地预览 dist/
```

**开发代理（PNA）**：`VITE_DEV_API_VIA_PROXY=true` 时，`api/client.ts` 在 dev 下用 **`window.location.origin`**，`vite.config.ts` 将 **`/api`**、**`/health`** 代理到 **`VITE_DEV_PROXY_TARGET`**（默认 `http://10.192.130.89:30008`）。设置页「服务器地址」应**留空或同源**；不要在 localhost 页面里填 `http://10.x:30008` 却仍指望代理生效。

---

## 4. 应用壳与导航（`src/App.tsx`）

| Tab | 组件 | 说明 |
| --- | --- | --- |
| `yield` | `YieldMonitorReport` | 产量触发 · delta_diff |
| `infcontrol` | `InfcontrolReport` | JB START / 层控 BIN |
| `ai` | `AiAgentReport` | `GET …/siliconflow/chat` |
| `table` | `TableRowsReport` | 表浏览（**无**可拖拽布局，查询区也未对齐 Yield/JB 样式） |
| `settings` | 内联面板 | API 地址、健康检查、**`OverviewReport embedded`**（API 目录） |

- **`usePersistedApiBase`**：API 基址 `localStorage`。
- **切换 tab**：`useLayoutEffect` 派发 `window.resize`，供 ECharts 重算尺寸。
- **顶栏样式**：`.app-title-main`（`index.css`）— 整行渐变标题，约 **28px**。

---

## 5. API 客户端

- **`api/paths.ts`**：`API_PREFIX = "/api/v4"`（全报表共用）。
- **`api/client.ts`**：`apiGetJson<T>(base, path, params?, init?)` — 规范化 base、序列化 query、非 2xx 抛结构化错误。
- **并发**：`utils/asyncConcurrency.ts` 中 **`REPORT_ORACLE_FANOUT_CONCURRENCY = 1`**，避免打爆 Oracle 连接池（NJS-040）。
- **v4 聚合 422**：筛选过宽、匹配行超过服务端 **`MEMORY_AGG_ORACLE_MAX_ROWS`** 时收窄时间窗或维度；见 API 文档，勿在前端硬编码密钥。

---

## 6. 可拖拽布局（核心，`components/DraggableReportSections.tsx`）

### 6.1 依赖与层级

使用 **`@dnd-kit/core`** + **`@dnd-kit/sortable`**（**无** framer-motion）。

每个报表最多三层 **`DraggableReportBlocks`**（或顶层 **`DraggableReportSections`** = `axis="y"` + 固定中文 `labels`）：

| 层级 | 典型 `axis` | 用于 |
| --- | --- | --- |
| 顶层模块 | `y` | KPI 条、趋势图、图表矩阵、树表、明细 |
| KPI 条内 | `x` | 各 KPI 卡片 |
| 图表矩阵内 | `grid` | 2 列网格中的单图 |

### 6.2 localStorage 键

| 常量 | 用途 |
| --- | --- |
| `YIELD_MONITOR_LAYOUT_STORAGE_KEYS` | Yield 三键：modules / kpi-blocks / chart-blocks |
| `JB_START_LAYOUT_STORAGE_KEYS` | JB 三键：同上 |

每个 `storageKey` 存 **JSON 字符串数组**（顺序）；**`{storageKey}:hidden`** 存已关闭模块 id 列表。

- **`resetReportLayoutStorage(keys)`**：清除顺序 + hidden。
- 报表内 **`layoutEpoch`** state：reset 后 `setLayoutEpoch(n => n+1)`，触发 hook 从 storage 重载。

### 6.3 UI 行为

- 每块：**拖动条**（`.report-reorder-drag-head`，含 ⋮⋮ + 标题）+ **✕ 关闭** + **`.report-reorder-body`** 内容。
- 拖动时拖动**整块**（header + body），**不用 `DragOverlay`**（用户曾反馈 overlay 只剩标题条）。
- **`ReportLayoutResetButton`**（↺ 还原布局）：放在查询区 **「查询」右侧**（`.query-panel-actions-buttons`），与查询按钮同尺寸样式。
- **标题去重**：KPI 条内 `KpiCard` 设 **`showLabel={false}`**；图表/树/明细内层标题已删，主标题仅在拖动条 `labels` 上。

### 6.4 碰撞检测（改拖动手感必读）

**`createPointerMidpointCollision(axis)`** — 解决「高模块要拖很久才换位」：

- **`y` / `x`**：按 top/left 排序其它项，指针越过该项**中线**即视为 `over`（排除 `active`）。
- **`grid`**：指针到各块**中心**欧氏距离最近者优先；否则 `pointerWithin` / `rectIntersection`（均排除 active）。

**`onDragOver`** + **`onDragEnd`** 均调用 **`moveActiveIdOver`** → `arrayMove` 可见顺序 → **`applyVisibleReorder`** 写回含 hidden 的完整顺序。

**动画**：`REPORT_REORDER_TRANSITION` **480ms**；拖动项 `z-index: 10000`（`.report-reorder-item--dragging`）。

> **勿**改回仅 `pointerWithin` / `closestCenter` 而不排除 active 整块矩形，否则高图表区会回归「长距离才换位」。

### 6.5 接入报表的模板

`YieldMonitorReport` / `InfcontrolReport` 均已接入，模式一致：

```tsx
const [layoutEpoch, setLayoutEpoch] = useState(0);
const resetReportLayout = () => {
  resetReportLayoutStorage(YIELD_MONITOR_LAYOUT_STORAGE_KEYS); // 或 JB_START_*
  setLayoutEpoch((e) => e + 1);
};
// 查询成功后 sections 填入 DraggableReportSections / DraggableReportBlocks
```

新增模块 id 时：同步 **`defaultOrder`**、**`TOP_SECTION_LABELS`**（或 KPI/图表 `labels`）、以及 sections 对象键。

---

## 7. 查询区（`.query-panel`，`index.css`）

Yield / JB 共用结构：

- **`.filter-grid`**：筛选字段。
- **`.query-panel-actions`**：左侧 chips（生效筛选），右侧 **查询** + **还原布局**。
- 类名：**`.query-panel-submit`**、**`.report-layout-reset-btn`**。

`TableRowsReport` 仍为旧式卡片，若要对齐需单独改。

---

## 8. 图表与标签

- **`components/DarkChart.tsx`**：ECharts 封装 + resize。
- **`theme/chartTheme.ts`**：深色主题常量。
- **`utils/datetimeLocal.ts`**：
  - **`formatChartDayLabel`** — 日趋势 x 轴 `timeDay`。
  - **`formatAggregateDimLabel`** — 自由维度聚合轴（含 `timeDay`）。
- **`utils/yieldCalc.ts`**、**`rollup.ts`**、**`binFilterLines.ts`**：域内计算；Yield% 由前端从 bins **实时**算（顶栏 hint 已说明）。

下钻：**`DrillDownPanel`**；树表：**`TreeTable`**。

---

## 9. 目录结构速查

```
src/
  App.tsx                 # 壳、tab、设置、标题
  api/client.ts, paths.ts
  hooks/usePersistedApiBase.ts
  components/
    DraggableReportSections.tsx   # 布局 DnD + reset
    DarkChart, DataTable, KpiCard, QueryInspector, TreeTable, DrillDownPanel
  reports/
    YieldMonitorReport.tsx
    InfcontrolReport.tsx
    AiAgentReport.tsx
    TableRowsReport.tsx
    OverviewReport.tsx      # embedded 在设置页
  utils/
  theme/
  index.css                 # 全局 + report-reorder-* + query-panel-*
```

---

## 10. 修改时的检查清单

1. **新 API 字段**：先确认 v4 列表/聚合响应在 API 包与 Dummy 已对齐，再改报表解析。
2. **新图表/模块**：Oracle fanout 仍受 **`REPORT_ORACLE_FANOUT_CONCURRENCY`** 约束；避免并行暴增。
3. **布局/DnD**：改顺序逻辑时同时测 **高模块**、**KPI 横条**、**图表 grid**；勿恢复 `DragOverlay` 除非产品明确要求。
4. **localStorage 键名**：改名会破坏用户已存布局，需有迁移或接受重置。
5. **构建**：改完跑 **`npm run build`**；勿提交 **`dist/`**、**`node_modules/`**（除非团队明确要求发布产物）。
6. **样式**：优先扩展现有 CSS 变量（`--text`、`--border` 等），与深色看板一致。

---

## 11. 近期变更纪要（2026-05-15，交接备忘）

1. **品牌**：标题改为 **NXP ATTJ WaferTest Dashboard**；全行渐变 + 更大字号（`.app-title-main`）。
2. **布局**：`@dnd-kit` 三层拖拽；顺序/隐藏 **localStorage**；查询旁 **还原布局**。
3. **拖动**：整项拖动；**指针中线**碰撞（`createPointerMidpointCollision`）；**480ms** 过渡。
4. **导航**：**API 目录**从顶栏 tab 移至 **⚙ 设置**（`OverviewReport` `embedded`）。
5. **标签**：图表日轴 / 聚合维 **`formatChartDayLabel`** / **`formatAggregateDimLabel`**。
6. **未做**：`TableRowsReport` 查询区与拖拽布局未与 Yield/JB 统一。

---

## 12. 与 API 联调速查

```
浏览器 → apiGetJson(apiBase, API_PREFIX + "/yield-monitor-triggers/v4/aggregate", …)
       → pcr-ai-api（见 ../pcr-ai-api）
```

- 健康检查：`GET /health`（设置页「检查连接」）。
- AI：`GET {API_PREFIX}/siliconflow/chat?message=…`（密钥在 API 侧 env）。

---

*文档版本：2026-05-15。若实现与本文冲突，以源码为准并应更新本文。*
