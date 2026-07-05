# Claude Code 交接：INF 晶圆图 + Agent 专用路由 + 表格 UX

**日期：** 2026-06-03（本批未提交前为 `feat/inf-wafer-map` 工作区）  
**分支：** `feat/inf-wafer-map`  
**读者：** Claude Code / Cursor Agent 接手 **INF 晶圆图**、**AI Agent 意图路由**、**聊天气泡 Markdown** 时**必读**。  
**前置阅读：** [`HANDOFF_AGENT_JB_DETERMINISTIC_SUMMARY.md`](HANDOFF_AGENT_JB_DETERMINISTIC_SUMMARY.md)、[`HANDOFF_AGENT_JB_CLUSTER_INTERRUPT_TESTER_UX.md`](HANDOFF_AGENT_JB_CLUSTER_INTERRUPT_TESTER_UX.md)、[`pcr-ai-api/CLAUDE.md`](../pcr-ai-api/CLAUDE.md) §6 / §11

---

## 0. 架构总览（Agent 每轮 `user_turn` 决策顺序）

`agentLoop.ts` 在调用 LLM **之前**按序尝试服务端直连（避免误走 `query_jb_bins` 大表 / 错误工具 / 超时）：

```
用户消息
  ├─ 1. tryRunLotOverviewDirectRoute     ← agentJbOverviewRoute（lot 整体/测试情况）
  ├─ 2. tryRunDutBinMapDirectRoute       ← agentDutBinMapRoute（BIN×DUT 关系图）
  ├─ 3. applyWaferMapRoutePlan (user_turn) ← agentWaferMapRoute（只画晶圆图）
  └─ 4. LLM + 工具 …
awaitingSummary（上轮工具结束）
  ├─ lotOverviewNeedsJbRecovery → tryRunLotOverviewDirectRoute（只查了 YM 时补救）
  ├─ planWaferMapRoute (after_jb_bins) → inf_draw_wafer_map
  └─ tryRunDeterministicJbSummary（JB 表 + 可选解读 LLM）
```

**原则：** 三种用户意图用**三条路由**，不要混在一个 `if (wafermap)` 里补丁。

| 用户说法示例 | 应用路由 | 工具 |
| --- | --- | --- |
| 「DR44117.1Y 整体的测试情况」 | `agentJbOverviewRoute` | `query_jb_bins` + 服务端全表 |
| 「画出第14片 pass1 wafermap」 | `agentWaferMapRoute` | `inf_draw_wafer_map`（`passes=1`） |
| 「同理标出 BIN14」 | `agentWaferMapRoute` | `inf_draw_wafer_map`（`passes=composite`） |
| 「BIN15 和相关 DUT 的关系 wafermap」 | `agentDutBinMapRoute` | **`inf_draw_dut_bin_map`**（非 `highlight:bin`） |

---

## 1. 本批解决的用户问题

| 问题 | 根因 | 修复要点 |
| --- | --- | --- |
| 同理画 BIN14 wafermap 无链接 | 第二轮漏传 `lot` | `normalizeInfDrawWaferMapArgs` |
| 中断层未出现在晶圆图 | 默认只画 `final` 一层 | `buildStandardWaferMapPassSpecs` 全物理层 + 合成 |
| 聚集警示表 `\|...\|` 原文 | GFM 分隔行列数错误 | 5 列分隔 + `repairGfmMarkdownTables` |
| 良率表下方「总结」像在表里 | 表与解读同块 | `## 分析结论` + `splitAgentReplyMarkdown` |
| 画 pass1 / 换 BIN 超时 120–240s | 未测灰格 × 多 pass + 重复 `query_jb_bins` | `infWaferMapHtml` 性能 + `agentWaferMapRoute` |
| 整体测试情况只有 YM 文字、无 JB 表 | 模型只调 `query_yield_triggers` | `agentJbOverviewRoute` + `buildLotOverviewTablesMarkdown` |
| 「BIN15 和 DUT 关系」图不对 | 误走 `inf_draw_wafer_map` 高亮 | `agentDutBinMapRoute` → `inf_draw_dut_bin_map` |
| 竖线（其他 DUT 的 BIN）不明显 | 图案对比度低 | `infWaferMapHtml` 青色双竖线 + 粗描边 |
| 晶圆图右侧 notch 三角（2026-06-03 曾移除，2026-07-05 恢复） | `appendNotch` | 按 INF `dNotchAngle` 真实角度绘制（0=右/90=下/180=左/270=上，顺时针，与 die 网格同坐标系），非固定位置 |

---

## 2. INF 晶圆图：`inf_draw_wafer_map`

### 2.1 默认标签页（`passes=final` / `all`）

每个 **`SmWaferPass`** 一页 + 最后一页 **合成**（`dieKey=final`）。中断多段 → `正测·中断前` / `续测后` 等（见 `describePassLayer`）。

- `pcr-ai-api/src/lib/infWaferMap.ts` — `buildStandardWaferMapPassSpecs`、`buildWaferMapPassSpecs`（`passes=composite` 仅合成一层）
- `pcr-ai-api/src/lib/infTools/infToolsSingleWafer.ts` — `runDrawWaferMap`
- 工具返回：`Device: … Lot: ${lot} … Slot: …`（**必须用请求 lot**，勿只用 `r.lot` 空值）

### 2.2 性能（大 INF 必知）

| 改动 | 文件 |
| --- | --- |
| 多 pass **不画**未测 tyControl 灰格；单 pass 未测上限 12000 | `infWaferMapHtml.ts` |
| 用户仅 pass1 → `passes=1` | `agentInfWaferMapTool.inferSinglePassIdFromText` |
| 换 BIN 高亮（非 DUT 关系）→ `passes=composite` | `normalizeInfDrawWaferMapArgs` |

### 2.3 多轮补参

`agentInfWaferMapTool.ts` → `agentToolHandlers.ts` 在 `inf_draw_wafer_map` 前 `normalizeInfDrawWaferMapArgs`。

---

## 3. 晶圆图路由 `agentWaferMapRoute.ts`

| API | 作用 |
| --- | --- |
| `userWantsWaferMapOnly(text)` | 只画晶圆图；**排除** DUT×BIN 关系、lot 概况 |
| `planWaferMapRoute(sessionId, history, userText, phase, …)` | `draw` / `need_jb_lookup` / `not_applicable` |
| `WAFER_MAP_JB_LOOKUP_NUDGE` | 缺 device 时 system 提示仅 `query_jb_bins` |

`phase=after_jb_bins`：上轮 `query_jb_bins` 后**优先本轮 tool 内容**解析 payload（避免旧 session 缓存盖掉）。

---

## 4. Lot 概况路由 `agentJbOverviewRoute.ts`

| API | 作用 |
| --- | --- |
| `canRunLotOverviewDirectRoute` | `isLotOverviewQuestion` + 话中 lot ID |
| `tryRunLotOverviewDirectRoute` | 服务端 `query_jb_bins(lot, limit:200)` + `emitDeterministicJbTablesReply` |
| `buildLotOverviewTablesMarkdown` | **完整**聚集/机台/卡/良率 pivot（不单返回短 `lotOverview`） |
| `lotOverviewNeedsJbRecovery` | 上轮仅 `query_yield_triggers` → 补 JB |
| `LOT_OVERVIEW_JB_NUDGE` | 禁止只查 YM |

`jbReplySkipsCommentaryLlm`：**不含** `lot_overview`（概况仍要表 + 解读 LLM）。

---

## 5. DUT×BIN 关系图 `agentDutBinMapRoute.ts` + `inf_draw_dut_bin_map`

**与 `inf_draw_wafer_map` 完全不同：**

| 工具 | 视觉 | 用途 |
| --- | --- | --- |
| `inf_draw_wafer_map` + `highlight:bin:N` | 彩色 die / 黄框 | 标出 BIN 位置 |
| **`inf_draw_dut_bin_map`** | 白块 / 横线 / **青色竖线** | DUT 与 BIN 归属关系 |

图例（`generateDutBinMapHtml`）：

- **白色** = 目标 DUT 且目标 BIN  
- **横线** = 该 DUT 的其他 bin  
- **青色竖线**（加粗描边）= **其他 DUT** 上的目标 BIN（「相关 DUT」）  
- 极暗 = 其他 die  

未指定 `dut` 时：`inferPrimaryDutForBin` 选该 BIN 颗数最多的 site；竖线即其余 DUT。

| API | 作用 |
| --- | --- |
| `userWantsDutBinRelationMap` | `bin` + `dut` + 「关系/相关」等 |
| `tryRunDutBinMapDirectRoute` | 直连 `inf_draw_dut_bin_map` |
| `userWantsWaferMapOnly` | 对 DUT×BIN 关系返回 **false** |

实现：`infToolsSingleWafer.runDrawDutBinMap`、`infWaferMapHtml.generateDutBinMapHtml`。

---

## 6. Agent 聊天气泡：表 vs 解读

- `splitAgentReplyMarkdown.ts` — 表在上、解读在下  
- `emitDeterministicJbTablesReply` — 统一 JB 表 SSE（`agentLoop.ts`）  
- 聚集表 5 列 GFM — `agentJbBadBinCluster.ts`

---

## 7. 关键文件索引

| 领域 | 文件 |
| --- | --- |
| Agent 主循环 | `agent/agentLoop.ts` |
| 晶圆图路由 | `agent/agentWaferMapRoute.ts` |
| Lot 概况路由 | `agent/agentJbOverviewRoute.ts` |
| DUT×BIN 路由 | `agent/agentDutBinMapRoute.ts` |
| 参数补全 | `agent/agentInfWaferMapTool.ts` |
| JB 表选择 | `agent/agentJbDeterministicReply.ts` |
| INF pass / 合成 | `infWaferMap.ts` |
| HTML | `infWaferMapHtml.ts` |
| 工具 | `infTools/infToolsSingleWafer.ts` |
| Prompt | `agent/agentPrompt.ts` |
| 超时默认 | `pcr-ai-report/src/hooks/useServerConfig.ts`（client 300s / stream 180s） |
| 气泡 UI | `reports/AiAgentReport.tsx`、`utils/splitAgentReplyMarkdown.ts` |

---

## 8. 测试

```bash
cd pcr-ai-api
npm test -- test/infWaferMapPassSpecs.test.ts
npm test -- test/agentInfWaferMapTool.test.ts
npm test -- test/agentWaferMapRoute.test.ts
npm test -- test/agentJbOverviewRoute.test.ts
npm test -- test/agentDutBinMapRoute.test.ts
npm test -- test/agentJbBadBinCluster.test.ts   # 若改聚集表
cd ../pcr-ai-report && npm run build
```

Fixture INF：`pcr-ai-api/docs/inf-dummy-r_1-1`。

---

## 9. 部署与手动验证

```bash
cd pcr-ai-api && npm ci && npm run build && npm test
cd ../pcr-ai-report && npm ci && npm run build
# 生产：pm2 reload（见 pcr-ai-api/docs/DEPLOY_PM2.md）
```

| 话术 | 预期 |
| --- | --- |
| `DR44117.1Y 整体的测试情况` | `query_jb_bins` + **完整 JB 表** + 解读；无仅 YM |
| `画出 DR44117.1Y 第14片 wafer` | 多标签或全层；Lot 行有值 |
| `画出第14片 pass1 wafermap` | 单 pass、数秒、`Pass 数: 1` |
| `画出 bin15 所在位置的 wafermap` | 仅 `inf_draw`、合成层、黄框 BIN15 |
| `画出 bin15 和相关 dut 的关系 wafermap` | **`inf_draw_dut_bin_map`**、白/横/青竖线 |
| 设置超时 | 建议 client ≥300s（概况 + Oracle） |

---

## 10. 勿破坏的约定

1. **dummy-parity** — 本批 INF 路由未改 Oracle WHERE。  
2. **新增路由** — 改 Agent 意图时同步改 `planWaferMapRoute` / overview / dutBin 三模块与测试，勿只在 `agentPrompt` 打补丁。  
3. **DUT×BIN** — 禁止用 `inf_draw_wafer_map` 代替 `inf_draw_dut_bin_map`。  
4. **GFM 表** — 分隔符列数 = 表头列数；表后空行。  
5. **`no-undici`** / **`oracledb@5.5`** — 不变。

---

## 11. 后续可做

- 合成层标签置顶（当前顺序与 INF 文件一致，合成在最后）  
- 一张图展示多个 DUT×BIN（当前单 DUT + 竖线表示其他 DUT）  
- `splitAgentReplyMarkdown.test.ts` 纳入 CI  

---

*文档版本：2026-06-03。冲突时以源码为准并更新本文。*
