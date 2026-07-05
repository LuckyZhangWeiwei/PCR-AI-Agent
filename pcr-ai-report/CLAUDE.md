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
| 2b | [`../docs/SITE_BIN_BY_LOT_INTEGRATION.md`](../docs/SITE_BIN_BY_LOT_INTEGRATION.md) | INF **bin×DUT** 详情：下钻到 device+lot+slot 后调 API、堆叠条图、勿占顶层聚合图 |
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
| `infcontrol` | `InfcontrolReport` | JB STAR / 层控 BIN |
| `ai` | `AiAgentReport` | `POST /api/v4/agent/chat`（SSE；AI Agent 配置在设置页） |
| `table` | `TableRowsReport` | 表浏览（**无**可拖拽布局，查询区也未对齐 Yield/JB 样式） |
| `settings` | 内联面板 | API 地址、健康检查、**`OverviewReport embedded`**（API 目录） |

- **`usePersistedApiBase`**：API 基址 `localStorage`。
- **切换 tab**：`useLayoutEffect` 派发 `window.resize`，供 ECharts 重算尺寸。
- **顶栏样式**：`.app-title-main`（`index.css`）— 整行渐变标题，约 **28px**。
- **明细行数**：**⚙ 设置 → 明细行数**；`usePersistedReportLimits`（`localStorage` 键 `pcr-ai-report.listLimits.v1`）。默认 **300** 条、上限 **500**（与 API `limit` 一致）。Yield / JB 查询传 `limit=defaultLimit`；表浏览的 `limit` 输入受 `maxLimit` 约束。

---

## 5. API 客户端

- **`api/paths.ts`**：列表 **`API_PREFIX = "/api/v4"`**（受设置里 `limit` 约束）；图表聚合 **`INFCONTROL_AGGREGATE_PATH`** / **`YIELD_AGGREGATE_PATH`** 走 **v3 库内聚合**（**不受 `limit` 影响**）。
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

Yield / JB 使用 **`CollapsibleQueryPanel`**（`components/CollapsibleQueryPanel.tsx`）：

- 点击 **「查询条件」** 展开/折叠筛选表单；折叠后顶栏仍保留 **生效筛选 chips**、**查询**、**还原布局**。
- 展开状态持久化：`pcr-ai-report:yield-monitor-query-open`、`pcr-ai-report:jb-start-query-open`（`localStorage` `1`/`0`）。
- **`.filter-grid`**：筛选字段；**`.query-panel-actions`**：底栏 chips + 按钮。

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

## 11. 近期变更纪要（2026-05-16，交接备忘）

1. **AI 助手链路**：`AiAgentReport` 发送 **`POST ${apiBase}/api/v4/agent/chat`**，请求体含 **`message`**、**`sessionId`**、**`agentConfig`**；响应为 SSE，每行 **`data: {type,...}`**。不要再按旧 **`GET /siliconflow/chat`** 排查聊天页。
2. **AI 助手配置**：设置页 **AI Agent 配置** 保存到 `localStorage` 键 **`pcr-ai-report.agent.v1`**；字段含 **`apiKey` / `apiBase` / `model` / `maxRounds` / `streamTimeoutSec` / `clientTimeoutSec` / `toolResultMaxChars`**（工具结果 JSON 上限默认 **12000**，6000–30000；流式 idle 默认 **150s**，客户端总超时默认 **180s**），随 **`agentConfig`** 发给后端（客户端超时仅前端使用）。改 Settings **无需重启 API**。聊天气泡 Markdown 经 **`sanitizeAgentMarkdownForDisplay`** 去掉误用 **`~~…~~`**（见 §19）。布局：**`tab-panel--agent`** + 消息区单滚动（见 §19）。若 key 为空，后端需配置 **`AGENT_API_KEY`** / **`SILICONFLOW_API_KEY`**，否则返回 **400 CONFIG_ERROR**。
3. **后端修复备忘**：2026-05-16 已修复 “输入后无反应” 的 SSE 断开判断问题（`req.close` → `res.close`）并加 **`AGENT_STREAM_TIMEOUT_MS`**；详见 **`../pcr-ai-api/CLAUDE.md` §6 / §11 / §12.1**。
4. **品牌/布局旧纪要**：标题、`@dnd-kit` 三层拖拽、API 目录移入设置页、图表标签格式化、明细默认/最多条数等 2026-05-15 规则仍有效。
5. **未做**：`TableRowsReport` 查询区与拖拽布局未与 Yield/JB 完全统一（表浏览仍保留页内 `limit` 输入）。

## 12. 近期变更纪要（2026-05-17，交接备忘）

1. **Dashboard 标题重设计**：  
   - `App.tsx` 顶栏：`[NXP badge] ATTJ WaferTest Dashboard` + 四个功能 chips（`Probe Card Yield Monitor` / `Layer BIN Analysis` / `Trigger Trends` / `✦ AI Query`）在同一行，CSS `.app-brand-row` + `.app-feature-chips`。  
   - Tab 标签全改英文：`⚡ Yield Monitor`、`🔬 JB Star`、`🤖 AI Agent`、`📋 Table Browser`、`⚙ Settings`。  
   - `index.css` 新增 `.app-brand-badge`、`.app-chip`、`.app-chip--ai` 及 header 底部渐变分割线 `::after`。

2. **Report 区段标题样式**：  
   - `h2 + .report-desc` 改为同一 flex 行（`flex-wrap: wrap`）；宽屏一行，窄屏自动换行。  
   - `h2::before` 添加蓝→紫竖条装饰；`.report-desc code` 高亮技术关键词（`TYPE = delta_diff` 等）。  
   - 四个报表描述文字全改英文（`YieldMonitorReport`、`InfcontrolReport`、`TableRowsReport`、`AiAgentReport`）。

3. **AI Agent 界面改进**：  
   - `RobotAvatar` 组件（内联 SVG，34 × 34 圆形）替代纯文字 “AI” 头像。  
   - `ReactMarkdown` 覆盖 `img` 渲染器，将 AI 生成的 `![alt](url)` 转为灰色斜体 `[alt]`，防止破图。  
   - Toolbar 标题改为 `🤖 AI Agent — Wafer Test Data Analytics`，”新对话” → “New Chat”。

4. **AI 系统提示词（`agentPrompt.ts`）变更**：  
   - 模板字符串内的 ` ``` ` 代码块已转义为 `\`\`\``（原 bug 导致 esbuild 崩溃）。  
   - 新增 **领域知识**：探针卡层级 `device → probeCardType → probeCard/cardId → dut/site`、每个 lot 绑定具体的卡。  
   - 探针卡维度区分规则：区分”哪张卡”（`probeCard`/`cardId`）vs”哪种卡”（`probeCardType`）。  
   - 图表生成规则：AI **不主动**调用 `generate_chart`，只在结论末尾提示用户是否需要图表，等确认后再生成。  
   - 格式限制：禁止 Markdown 图片语法 `![...](url)`。

## 13. 近期变更纪要（2026-05-21，交接备忘）

1. **AI Agent 流式体验改进**：
   - 空 AI 气泡（`streaming: true && text === ""`）不再显示 `"…"`，改为渲染 **`statusHint`**（灰色斜体 `.ai-status-hint`），默认文字 `"正在思考…"`。后端在以下时机发 `status` 事件：`"正在压缩历史对话…"` / `"正在准备系统信息…"` / `"正在执行工具 xxx…"` / `"正在分析工具结果…"`。用户可在气泡内看到当前阶段，不再面对空白 pending。
   - 修改文件：**`AiAgentReport.tsx`**（`msg.text ? <ReactMarkdown> : msg.streaming ? <span className="ai-status-hint">` 替换原先的 `"…"`）；**`AiAgentReport.css`**（新增 `.ai-status-hint { color: #6a8aaa; font-style: italic; font-size: 0.9em }`）。
2. **历史上下文延长**：后端 `agentHistory.ts` 的阈值均已上调（见 `../pcr-ai-api/CLAUDE.md` §11 条目 9），前端无需改动。

## 14. 近期变更纪要（2026-05-22，交接备忘）

1. **Settings → 最大推理轮数**：**`usePersistedAgentConfig.ts`** 新增 **`maxRounds`**（默认 **5**，**1–20**）；**`App.tsx`** 数字输入；随 **`POST /api/v4/agent/chat`** 的 **`agentConfig`** 下发。复杂跨表/INF 分析可在 Settings 调高。
2. **超时重试**：**`AiAgentReport.tsx`** 对 timeout 类错误（SSE **`Request timeout after …ms`** 或客户端 **AbortSignal.timeout**）显示 **↻ 重试**；点击发 **`{ retry: true, sessionId, agentConfig }`**，保留已展示的工具结果与部分 AI 文字，从后端 session 续跑。样式 **`.ai-error-retry`**（**`AiAgentReport.css`**）。

## 15. 近期变更纪要（2026-05-22，工具后总结 — 后端修复，前端无 diff）

1. **现象（用户侧）**：工具块已展开且含 JSON（如 **`totalRowsMatching`**），但 AI 气泡长时间停在 **「正在分析工具结果…」**，最终 270s 或 5min 超时；**↻ 重试** 在修复前也常无字。
2. **修复位置**：**`../pcr-ai-api/src/lib/agent/agentLoop.ts`**、**`agentStream.ts`**（详见 **`../pcr-ai-api/CLAUDE.md` §11 条目 11、§12.1**）。
3. **本包无需改代码**：SSE 事件形状不变（仍 **`text` / `status` / `tool_*` / `done` / `error`**）。部署 API **`npm run build` + pm2 reload** 后，现有 **`AiAgentReport`** 即可受益。
4. **与 §13（2026-05-21）关系**：§13 的 statusHint / LOOKAHEAD 改善 pending 显示与流式粒度，**不解决**工具后第二轮不写结论；两者叠加后体验最佳。
5. **验证**：问「8037 probecard 测试情况」或「最近 7 天 WA03P02G 触发次数」— 工具返回后应持续流出中文总结；若仍失败，看 SSE **`error`** 文案是否为新加的「模型未返回分析结论」类提示。

## 16. 近期变更纪要（2026-05-22，New Chat + 超时 150s）

1. **New Chat 不再卡住「处理中」**：**`AiAgentReport.tsx`** 增加 **`chatGenerationRef`**；进行中点 **New Chat** 时先 **`setLoading(false)`** / 清 **`statusHint`**，再 **`abort()`** 并 **`abortRef = null`**。旧请求的 SSE / **`finally`** 通过 generation 或 **`abortRef === null`** 兜底，不再把发送按钮留在「处理中」。
2. **超时 150s**：后端 **`AGENT_STREAM_TIMEOUT_MS`** 默认 **150s**（idle）；前端整请求 **180s**；**`vite.config.ts`** 代理 **180s**。超时提示改为「约 N 秒」。
3. **验证**：发一条长问题 → 处理中点 **New Chat** → 按钮应恢复「发送」、底部无处理提示；输入后可正常发新消息。

## 17. 近期变更纪要（2026-05-22，Settings 可配超时）

1. **Settings → 超时**：**`usePersistedAgentConfig.ts`** 新增 **`streamTimeoutSec`**（默认 **150**，30–600）与 **`clientTimeoutSec`**（默认 **180**，至少流式 + 30s）；**`App.tsx`** 数字输入；**`streamTimeoutSec`** 随 **`agentConfig`** 下发，**`agentStream.ts`** 按请求使用；**`AiAgentReport`** 用 **`clientTimeoutSec`** 作浏览器 Abort 上限。
2. **服务端回退**：未传 **`streamTimeoutSec`** 时仍读 **`AGENT_STREAM_TIMEOUT_MS`** env（毫秒）。

## 18. 近期变更纪要（2026-05-22，流式泄漏过滤）

1. **现象**：气泡偶发 **think**、**`redacted_thinking`**、整段 **DSML** 工具 XML（INF 下钻前常见）。
2. **修复在后端**：**`../pcr-ai-api/src/lib/agent/agentLoop.ts`** **`createDeepSeekFilter`**；前端 SSE 形状不变，**API 部署后即生效**。
3. **勿改 DSML 结束正则**：闭合标签为 **`</｜DSML｜tool_calls>`**（`>` 前无第三个 **`｜`**）。

## 19. 近期变更纪要（2026-05-22，Markdown 横线 + 单滚动条）

1. **`~~…~~` 横线**：模型误用 GFM 删除线 → **`sanitizeAgentMarkdownForDisplay`** + **`remarkGfm` `singleTilde: false`** + CSS **`del/s`** 无删除线。
2. **最外层滚动条**：**`.ai-agent-report`** 原 **`calc(100vh - 180px)`** 撑破布局 → 改为填满 **`tab-panel--agent`**（**`index.css`**），仅 **`.ai-agent-messages`** 内 **`overflow-y: auto`**。
3. **验证**：长对话后页面本身不纵向滚动；消息区可滚；含「未全部展示」类句子无横线。

## 20. 近期变更纪要（2026-05-27，Agent JB 逐片 BIN + 工具结果体积）

1. **Settings → 工具结果最大字符数**：**`usePersistedAgentConfig.ts`** 新增 **`toolResultMaxChars`**（默认 **12000**，6000–30000）；**`App.tsx`** 数字输入；随 **`agentConfig`** 下发，**无需重启 API**。
2. **后端**：**`agentJbBinFormat.ts`** **`slotBadBinsCompact`** / **`binBySlot`**；详见 **`../docs/HANDOFF_AGENT_JB_BIN_AND_TOOL_RESULT.md`**、**`../pcr-ai-api/CLAUDE.md` §11 条目 15**。

## 21. 近期变更纪要（2026-07-05，AI Agent API Key + JB 灰度开关服务器端共享）

1. **API Key 不再是 per-browser 设置**：`usePersistedApiKey`（`localStorage` 键 `pcr-ai-report.agent.apikey.v1`）已删除。`serverConfig.agentApiKey` 现在和 `agentApiBase` / `agentModel` 等字段一样，走 `useServerConfig` 的 `GET/PATCH /api/v4/admin/config`——任一客户端在 Settings 页改动 API Key，其他所有客户端立即生效，无需重启 API。
2. **一次性迁移**：`App.tsx` 里 `migratedApiKeyRef` 守卫的 `useEffect`，在 `useServerConfig` 首次确认拉取完成（新增的 `loaded` 返回值）且服务器尚无 key 时，读取旧 `localStorage` 键并 `updateServerConfig({ agentApiKey })` 一次，随后清掉该 `localStorage` 项。之后即使用户主动清空 key，也不会被旧值复活。
3. **`useServerConfig` 签名变化**：返回值从 3 元组变为 4 元组 `[config, updateConfig, fetchConfig, loaded]`，新增的 `loaded: boolean` 在首次 `fetchConfig()`（成功或失败）完成后置 `true`。改动此 hook 的调用方需同步更新解构。
4. **JB 灰度开关也纳入共享配置**：`serverConfig.jbDeterministicDispatch` / `jbLlmIntentClassifier` 对应后端 `JB_DETERMINISTIC_DISPATCH` / `JB_LLM_INTENT_CLASSIFIER`（见 `../pcr-ai-api/CLAUDE.md` 同日条目）。Settings 页「JB 路由（内部灰度开关）」分组新增两个 toggle，样式与既有 `agentEnabled` toggle 一致；这两个是内部路由行为开关，未纳入「↺ 恢复默认」按钮。
5. **未变**：`GET /api/v4/admin/config` 仍无鉴权、字段仍明文直返——与其它字段安全等级一致，未额外加固。`YIELD_MONITOR_TRIGGERS_DUMMY` / `INFCONTROL_LAYER_BINS_DUMMY` 未纳入共享配置（生产环境下这两个 flag 被 `listDummyRuntime.ts` 强制忽略，纳入也不起作用）。

---

## 12. 与 API 联调速查

```
浏览器 → apiGetJson(apiBase, API_PREFIX + "/yield-monitor-triggers/v4/aggregate", …)
       → pcr-ai-api（见 ../pcr-ai-api）
```

- 健康检查：`GET /health`（设置页「检查连接」）。
- AI：`POST {apiBase}/api/v4/agent/chat`（SSE；`AiAgentReport` 使用 `fetch` 直接读 stream，不走 `apiGetJson`）。

---

*文档版本：2026-05-16。若实现与本文冲突，以源码为准并应更新本文。*
