# WaferMind 开发日志

---

## 2026-06-06 — Agent 探针卡测试概况模式（card_test_overview）

**完成内容：**
- `agentJbDeterministicReply.ts`：新增 `JbReplyMode` 值 `"card_test_overview"`，处理「8036-06 的测试情况」类探针卡概况问题（原先被 `lot_overview` 误截，输出错误 lot 的 cluster alerts）。
- `agentJbDeterministicReply.ts`：新增 `isCardTestOverviewQuestion()`（已导出），检测用户文本含 `\b\d{4}-\d{2,3}\b` 卡号格式 + 「测试情况/的情况/整体情况/使用情况」等关键词；在 `detectJbReplyMode` 中优先于 `isLotOverviewQuestion`，防止「8036-06 的测试情况」被 `测试情况` 匹配为 lot_overview。
- `agentJbDeterministicReply.ts`：新增私有 `extractCardIdFromUserText()`，从文本提取 `dddd-dd/ddd` 格式卡号。
- `agentJbDeterministicReply.ts`：新增私有 `buildCardTestOverviewMarkdown()`，输出：① `yieldByPassIdMarkdown` 良率总览；② `cardByPassIdMarkdown` 各 pass 卡分配；③ 从 `slotBadBinsCompact` 过滤该卡 ID，输出该卡坏 die BIN 排行（最多 10 条）；④ 从 `lotYieldRankByTestEnd` 按 testEnd 降序输出近期 lot 记录（最多 10 条）。不跳过 LLM 解读（需要趋势分析）。
- `agentJbDeterministicReply.ts`：`buildDeterministicJbTables` 新增 `"card_test_overview"` case，提取卡号后调用上述 helper。

**测试：** 258 个测试，255 通过，1 失败（Oracle 本地未安装，预存问题）；typecheck 通过

---

## 2026-06-05 — 晶圆图 BIN 高亮丢失 + JB 逐片坏 bin 排名 + lot 良率排名 + 探针卡追问答案重复修复

**完成内容：**
- `agentJbBinFormat.ts`：`buildJbSessionCacheJson` 新增 `slotBadBinsCompact` 字段入 session cache，确保后续追问时仍能获取逐卡 BIN 细分数据（原先 session cache 缺此字段，导致逐卡归因失败）。
- `agentJbDeterministicReply.ts`：新增 `isBinCardAttributionQuestion()`，识别「BINxx 是哪张探针卡」类型的追问，映射到新模式 `"bin_card_attribution"`；输出逐卡 BIN 颗数表（显示所有卡，包括 0 颗），跳过 LLM 解读（表即答案）。
- `agentJbDeterministicReply.ts`：新增 `isCardYieldCompareQuestion()`，识别「7747-01 和 7747-03 哪张更差」「哪张探针卡 yield 最差」类型追问，映射到新模式 `"card_yield_compare"`；输出逐卡坏 die 汇总表 + 中断段良率表 + cardByPassId，让 LLM 推断哪张卡更差。
- `agentJbDeterministicReply.ts`：`detectJbReplyMode()` 在 `isProbeCardQuestion` 之前先检测两个新模式，防止被泛化的 `"equipment"` 模式截断。
- `agentJbDeterministicReply.ts`：新增私有 helper `buildBinCardAttributionMarkdown()` / `buildCardBadDieSummaryMarkdown()`。

- `agentJbBinFormat.ts`：`buildJbSessionCacheJson` 同时写入 `lotYieldRankByTestEnd`，支持 lot 良率排名追问。
- `agentJbDeterministicReply.ts`：新增 `isLotYieldRankingQuestion()`，识别「良品率最差的 N 个 lot」类问题，映射到新模式 `"lot_yield_ranking"`；输出按良率% 升序排列的 lot 排名表，跳过 LLM 解读。
- `agentJbDeterministicReply.ts`：新增 `isPerSlotBadBinRankingQuestion()`，识别「每一片坏bin的前五名」类问题，映射到新模式 `"per_slot_bin_ranking"`；从 `slotBadBinsCompact` 按 (slot, passId) 聚合后，输出逐片 top-N 坏 bin 表，支持中文数字（前五名=5），跳过 LLM 解读。
- `agentJbDeterministicReply.ts`：新增 `extractTopN()` 工具函数，解析「前五名/前3名/top5」中的 N，支持阿拉伯数字和中文数字。

- `agentInfWaferMapTool.ts`：新增 `findDeviceForLot(history, lot)` 函数，在 history 中为指定 lot 查找 device；修复 `buildInfDrawArgsAfterJbLookup`：用户文本里的 lot 优先于 payload lot（防止 session cache 是上一个 lot/product 的 JB 数据时，拿到错误的 device+lot 画图）。
- `agentInfWaferMapTool.ts`：修复 `normalizeInfDrawWaferMapArgs` 里 `passes=composite` 的误触发：composite 快捷路径（仅重画合成层）只在同 lot+slot 的 BIN 换亮时生效；若 lot 或 slot 与上一次 wafer map 不同（新画图请求），不继承 composite，使用默认 final（全层图）；彻底解决"跨 lot 换 BIN 仍用 composite 导致高亮消失"问题。

**根因（lot 排名答非所问）：** `query_jb_bins(cardId)` 返回多 lot 时，`primaryLot` 取第一行（最近测试的 TR21625.1N），`shouldDetectClusteredBins=true` → cluster alerts 都是 TR21625.1N 的；`"generic"` 模式输出该 lot 的总览表，完全答非所问。新的 `"lot_yield_ranking"` 模式优先于 `"generic"` 截获这类问题。
**根因（探针卡追问）：** 问题2（bin55 是哪张卡）和问题3（哪张卡 yield 最差）都被识别为 `"equipment"` 模式 → 永远输出同一张 `cardByPassId` 表，无法区分回答。

**测试：** 258 个测试，255 通过，1 失败（Oracle 连线，非代码 bug）；typecheck 通过

---

## 2026-06-05 — Agent INF 工具瘦身 + New Chat 滚动重置

**完成内容：**
- `infTools/index.ts`：新增 `INF_DRAW_AGENT_SCHEMAS`，仅保留 `inf_draw_wafer_map` 和 `inf_draw_dut_bin_map` 两个工具 schema；原有 21 个分析工具的库函数和 `runInfTool` 调度保持完整。
- `agentToolSchemas.ts`：改为 `export { INF_DRAW_AGENT_SCHEMAS as INF_TOOL_SCHEMAS }`，agent function call 列表从 23 个 INF 工具精简至 2 个，减少 LLM 工具过多导致的答案不准问题。
- `agentLoop.ts`：`INF_KEYWORDS` 从 28 项缩减至 10 项，去掉只属于已移除分析工具的触发词（die 坐标、cluster/聚集/划伤、DUT 良率统计等）。
- `AiAgentReport.tsx`：`newSession()` 补加 `window.scrollTo(0, 0)`，修复点击 New Chat 后页面停留在原滚动位置的问题（根因：app-shell 仅 `min-height: 100vh`，agent 输出大量内容时 window 会滚动，原来只重置了消息容器内部滚动）。
- `runtime-config.json`：`listDefaultLimit` 1000 → 2000。

**测试：** `npm run typecheck` 通过，无新后端测试

---

## 2026-06-05 — InfDutDistPanel 交互优化 + DataTable 列筛选

**完成内容：**
- `InfDutDistPanel.tsx`：tooltip 内 DUT 列表按 die count 降序排列。
- `InfDutDistPanel.tsx`：hover legend DUT 时，只有该 DUT count>0 的柱（bin）高亮，其余变暗；hovered DUT 对应色块加 shadowBlur + borderColor 发光效果。
- `InfDutDistPanel.tsx`：点击柱子时，legend 中该 bin 内所有 count>0 的 DUT 同时高亮。
- `InfDutDistPanel.tsx`：hover 柱子某段时，tooltip 中对应 DUT 行高亮（蓝色背景 + 白色加粗 + 描边），通过 `hoveredSeriesIndexRef`（stable ref）在 formatter 调用时读取，无需重建 chart option。
- `InfDutDistPanel.tsx`：x 轴标签字号 9px → 11px；tooltip padding/行间距/列间距放宽；滚动条右侧加 `padding-right:14px` 留白。
- `DataTable.tsx` + `DataTable.css`：新增 `filterRow` prop，表头第二行展示每列文本过滤输入框，实时筛选行，无匹配时显示"无匹配行"；重构为 hooks 组件（`useState`/`useMemo`）。
- `InfcontrolReport.tsx`：明细行 DataTable 加 `filterRow`，支持对所有列逐列筛选。

**测试：** 未运行后端测试，仅前端改动；`tsc --noEmit` 通过

---

## 2026-06-05 — 标题改名 + 漏斗顺序调整 + Hostname 下钻免 Oracle 查询

**完成内容：**
- `pcr-ai-report/index.html` + `App.tsx`：页面标题从 "ATTJ Prober PCR Dashboard" 改为 "ATTJ WT PCR Dashboard"。
- `InfcontrolReport.tsx`：`FUNNEL_LEVEL_DEFS` 中 Pass 与 Wafer ID 位置互换（Lot → Pass → Wafer ID → ProbeCard），与业务钻取习惯对齐。
- `InfcontrolReport.tsx`：`jbRowDimValue` 新增 `testerId` case（读 `row.TESTERID`），使 Device 下钻面板点击 Hostname tab 时从已有明细行内存派生分组，不再发起 Oracle aggregate 查询，消除生产环境慢查询。

**测试：** 未运行，本次仅前端 UI 修改

---

## 2026-06-04 — Agent JB/Wafermap 四项 Bug 修复

**完成内容：**
- `agentJbDeterministicReply.ts`：`lot_overview` 模式改为优先用 `digest.lotOverview`（预计算的完整总览 markdown，含探针卡段），修复 session cache 里 `cardByPassId` 原始数组未持久化导致 lot 概况不输出探针卡信息的 bug。
- `agentJbHistoryCompact.ts`：`formatLotYieldOverviewMarkdown` 的探针卡段加防御性回退——优先用 `cardByPassIdMarkdown`（序列化后仍保留的字符串），避免从 session cache 重建时因缺 `cardByPassId` 数组而静默跳过卡段。
- `agentLoop.ts`：新增 `tryRunEquipmentDirectRoute`——当用户追问"probecard是什么"等装备类问题时，直接从 session cache 读取探针卡/机台信息输出，不走 LLM，避免 LLM 将上一轮 lot 总览表（每片良率 + 聚集 die）重复输出。
- `agentInfWaferMapTool.ts`：`extractBinNumberFromText` 新增 m4（`(\d+)\s*号?\s*bin\b`）和 m2 扩展（`[号#:=]?`），支持"7号bin"、"BIN号7"等数字在前的中文表达。修复此类 phrasing 导致 `binHint=undefined`、晶圆图 BIN highlight 不生效的 bug。
- `infWaferMap.ts`：新增 `buildPassIdWaferMapSpecs(root, passId)`——当用户说"只画 pass1"时，展开为该 passId 的全部物理块（正测·中断前/续测后/段N + 复测）+ pass 级合成 tab，而不是以前的单个合并视图。有中断时每段独立 tab 自动出现。
- `buildWaferMapPassSpecs` 对 plain digit passId token 调用新函数展开，graceful fallback（找不到 passId 时退回旧行为）。

**测试：** 255 个测试通过，1 失败（agentAggregateGuard Oracle 连线，本机无库，非代码 Bug）；typecheck 通过

---

## 2026-06-03 — Agent 工具并发执行（减少多工具轮次 timeout 概率）

**完成内容：**
- `agentLoop.ts`：新增 `getToolResourceGroup` 函数，按 Oracle 连接池（probeweb / main / perl / pure）对工具分组。
- `agentLoop.ts`：将工具执行段从串行 `for` 循环改为 `Promise.all` 分组并发——同组（同连接池）内仍串行，不同组并发。工具消息仍按原始 `tool_calls` 顺序 append 到 history，LLM 上下文顺序不变，回答质量不受影响。
- 典型收益：`query_yield_triggers`（probeweb 池）与 `query_jb_bins`（main 池）同轮调用时，由串行 ~25s 降至并发 ~15s，减少 SiliconFlow 等待时长，降低 idle timeout 概率。
- Oracle 连接池代码（`oracle.ts`）和 SiliconFlow 流式调用（`agentStream.ts`、`streamSiliconFlow`）均未改动。

**测试：** 249 个测试通过，2 失败（agentAggregateGuard Oracle 连线，本机无库，预存失败项）；typecheck 通过

---

## 2026-06-03 — Code Review 修复（INF 晶圆图 + Agent 三路由）

**完成内容：**
- `agentWaferMapRoute.ts`：`after_jb_bins` 阶段工具非 `query_jb_bins` 时返回 `notApplicable`（`skipJbDeterministicSummary=false`），修复晶圆图意图 + 错误工具时 JB 确定性表也被静默跳过的 bug。
- `repairGfmMarkdownTables.ts`：将 `out.push(line)` 移入 repair 分支，消除有效 GFM 表格表头行被重复 push 两次导致渲染错乱的 bug。
- `infWaferMapHtml.ts`：`generateDutBinMapHtml` 中 `Math.min(...xs)` 改为 `reduce`，避免超大晶圆（>65k die）抛 RangeError 崩溃。
- `infWaferMapHtml.ts`：移除图例中 `if (bc !== COLORS_BAD[0])` 过滤，BIN 0/5/10/15 均显示具名图例条目（原逻辑使同色 BIN 在图例中不可见）。
- `splitAgentReplyMarkdown.ts`：`m.index === 0` 时（LLM 回复直接以 `## 分析结论` 开头，无前置数据表）正确放入 `commentaryMarkdown` 而非 `dataMarkdown`。
- `agentLoop.ts`：`## 分析结论` 标题已 SSE 流出，LLM 空输出时也写入 history，消除客户端所见与模型上下文不一致的问题。
- `agentDutBinMapRoute.ts`：移除冗余的 `findLastInfDrawWaferMapContext` + `findJbLotContext` 独立调用（`normalizeInfDrawWaferMapArgs` 内部已调用），同时清理无用 import。
- `agentLoop.ts` + `agentJbOverviewRoute.ts`：合并同模块重复 import，消除 ESLint `no-duplicate-imports` 报错。

**测试：** 249 个测试通过，2 失败（agentAggregateGuard Oracle 连线，本机无库，非代码 Bug）；前端 tsc 构建通过。

---

## 2026-06-02 — Agent INF Wafer Map 工具路由精确化

**完成内容：**
- `agentLoop.ts` `INF_KEYWORDS`：移除误触发词（`"晶圆"`、`"温度"`、`"趋势"`、`"边缘"`、`"画图"`）；新增 DUT-BIN 分析专用触发词（`"dut坏"`、`"dut良率"`、`"dut分布"`、`"各dut"`、`"每个dut"`、`"dut占比"`、`"dut和bin"` 等），区分 die 级 DUT 分析（需 INF 工具）与数据库 YM/JB 查询（无需 INF）。
- `agentLoop.ts` `selectToolSchemas`：改为只扫描 **user 消息**（`role: "user"`）的最近 3 条，不再扫 tool result 和 assistant 消息——防止 `inf_draw_wafer_map` 工具结果里含"晶圆图"字样导致 INF 工具永久粘连注入。
- `agentPrompt.ts`：新增「晶圆图与数据库查询路由」章节（位于决策优先级最前），含 wafermap vs Oracle 路由对照表、lot 级聚集（`clusteredBadBinAlerts`）vs die 级 cluster（`inf_cluster_detect`）区分规则、DUT 汇总（base tool）vs die 级 DUT 分析（INF 工具）两层分工说明、画晶圆图四步硬规则（多轮对话时强制重调 `query_jb_bins` 避免从摘要猜参数）。

**测试：** 225 个测试，1 失败（agentAggregateGuard Oracle 连线，本机无库，非代码 Bug）

---

## 2026-06-02 — Agent JB 坏 bin 排行检测修复（bad_bin_ranking 模式）

**完成内容：**
- `agentJbDeterministicReply.ts`：新增 `JbReplyMode "bad_bin_ranking"` 及 `isBadBinRankingQuestion` 检测函数（匹配「主要坏bin / 坏bin排行 / 坏bin排名 / top bad bin…」，无具体 bin 编号时触发）；`detectJbReplyMode` 在 `bin_trend` 后插入该检测，结束「主要坏bin」类问题落入 generic 模式只返回 lot overview 而不含排行表的问题。
- `buildDeterministicJbTables`：新增 `bad_bin_ranking` 分支，优先输出 lot overview，追加 `topBadBins` 排行表；无数据则降级 fallback。
- `formatTopBadBinsMarkdown`：修复 lot 标题字段读 `primaryLot`（不存在）而非 `lot` 的 bug，改为优先读 `lot` 再 fallback `primaryLot`。

**测试：** 7 个测试（agentJbDeterministicReply），0 失败；typecheck 通过

---

## 2026-06-02 — Agent 新工具 query_lot_dut_bin_agg（lot 级 DUT×Bin 聚合）

**完成内容：**
- 发现 `query_inf_site_bin_by_dut` 已完整接入（schema + handler + prompt），TODO 条目为过时记录。
- `agentToolSchemas.ts`：新增 `query_lot_dut_bin_agg` 工具 schema（device + lot + passId/passIds + probeCardType 可选）。
- `agentToolHandlers.ts`：新增 `toolQueryLotDutBinAgg` 函数，复用已有的 `runOutputSiteBinByLotForLot`（含卡型过滤）和 `runOutputSiteBinByLotForLotByDirectory`（目录扫描）；dummy 路径同样复用已有 `tryResolveSiteBinByLotDummyForLot/ForLotByDirectory`；调用现有 `compactSiteBinPasses` 压缩返回体积；新增 `runTool` case。
- `agentPrompt.ts`：工具列表加入 `query_lot_dut_bin_agg`；新增「Lot 级 DUT 聚合」说明节，含适用场景、调用前置、结论写法、禁止项。

**测试：** 225 个测试，1 失败（agentAggregateGuard Oracle 连线，本机无库，非代码 Bug）

---

## 2026-06-01 — 明细行数上限调整（默认 1000 / 最多 2000）

**完成内容：**
- `pcr-ai-api/src/lib/infcontrolLayerBinV2Filters.ts`：`INFCONTROL_LAYER_BIN_V2_MAX_TOP` 1000 → 2000，同时提升 `API_V3_LIST_LIMIT_MAX`（v3/v4 列表端点共用此常量）。
- `pcr-ai-report/src/hooks/usePersistedReportLimits.ts`：`API_LIST_LIMIT_CEILING` 1000 → 2000，`REPORT_LIST_LIMITS_DEFAULT.defaultLimit` 300 → 1000，`REPORT_LIST_LIMITS_DEFAULT.maxLimit` 1000 → 2000。UI 说明文字与「↺ 恢复默认」按钮自动更新（动态读常量）。

**测试：** 225 个测试，1 失败（Oracle 连线，非代码 Bug）

---

## 2026-06-01 — Cursor 改动 Review + 测试修复

**完成内容：**
- `pcr-ai-api/src/lib/infcontrolLayerBinDummy.ts`：`buildInfcontrolDummyExampleQuery` 改用滚动日期（now-30d 到 now+60s），修复 v3 dummy time-shift 逻辑导致 example query 返回 0 行的时间窗口 Bug（shifted_to = maxTs - delta，最大 TESTEND 的行被排除）。
- `pcr-ai-api/test/agentConfig.test.ts`：默认值断言对齐新设置（maxRounds 5→8、streamTimeoutSec 150→120、toolResultMaxChars 12000→20000，与 runtime-config.json 一致）。
- `pcr-ai-api/test/agentJbBinFormat.test.ts`：`_slotYieldGuide` 断言改查 `_slotYieldInterruptGuide`（"0%" 提示已移入中断专项 guide）；`indexOf("整片正片（合并）")` 改 `lastIndexOf`（新 header 文字含该串导致查到表头而非表行）。
- `pcr-ai-api/test/agentJbHistoryCompact.test.ts`：同上，`indexOf` → `lastIndexOf` 修复 wholeIdx 顺序断言。

**测试：** 225 个测试，1 失败（agentAggregateGuard Oracle 连线问题，本机无库，非代码 Bug）

---

## 2026-05-29 — Code Review 修复（JB 换卡检测三项 Bug）

**完成内容：**
- `pcr-ai-api/src/lib/agent/agentJbBinFormat.ts`：修复 `buildRecentLotsByTestEnd` 中 `hasCardChangeInLot` 多 lot 污染——原代码 `lotHasMidRunCardChange(rows)` 扫描全量 rows，任何一个 lot 换卡就让所有 lot 都被标记 `true`；改为在积累阶段每个 lot entry 收集 `_lotRows`，map 时仅传当前 lot 的行。
- `pcr-ai-api/src/lib/agent/agentJbBinFormat.ts`：修复 `buildCardChangesBySlotPass` 中 `hasTestInterrupt` 误报——`hasCardChange=false` 时原用 `splitPassGroupIntoHalves(group).segmented`，该函数对任意 2+ TEST 行（同 PASSNUM）均返回 `segmented:true`，导致正常多行测试被标为中断；两个分支统一改为 `groupHasExplicitTestInterrupt(group)`（仅检测 INTERRUPT 行和 PASSNUM 递增），并移除不再需要的 `splitPassGroupIntoHalves` import。
- `pcr-ai-api/src/lib/agent/agentJbBinFormat.ts`：修复 null TESTEND 时最后行覆盖问题——`!entry._testEndMs` 在 ms=0 时永远为 true，使每行都覆盖 cardId/device（last-row-wins）；改用 `_initialized` 标志，首行无条件设置，后续行需 `ms > 0 && ms > entry._testEndMs` 才覆盖，恢复旧代码 first-row-wins 语义。
- `pcr-ai-api/test/agentJbBinFormat.test.ts`：新增三条回归测试覆盖上述三个 bug。

**测试：** 183 个测试，0 失败

---

## 2026-05-28 — Code Review 修复（GLM 正则、DUT 面板、selectionSummary）

**完成内容：**
- `pcr-ai-api/src/lib/agent/agentLoop.ts`：GLM `<tool_call>` 正则改为 `/<tool_call>[a-zA-Z_]/`，要求函数名首字母紧跟标签，避免模型正文中的字面量 `<tool_call>` 触发流式截断（Fix 1）。`parseGlmToolCallBody` 改用单个配对正则代替两个独立循环做位置 zip，消除嵌套 XML 标签导致的 key/value 错位（Fix 4）。
- `pcr-ai-report/src/reports/InfcontrolReport.tsx`：`toggleDrillBarKey` 中 `setInfCtx(next.size > 0 ? ctx : null)` 改为 if/else if，当 `ctx` 为 null 但用户有选中项时保留现有面板（Fix 2）；移除本地 `normalizeBinToken` 函数，改从 `infDutSelection` 导入（Fix 6）。
- `pcr-ai-report/src/components/InfDutDistPanel.tsx`：useEffect 依赖数组移除冗余的 `wafers` 引用，只保留 `waferKey`，避免父组件重建数组时触发多余 HTTP 请求（Fix 3）。
- `pcr-ai-report/src/utils/infDutSelection.ts`：两处 `selectionSummary` 均改用 `wafers.length` 替代 `indexList.length`/`keys.length`，显示实际解析成功的片数（Fix 5）；`normalizeBinToken` 改为导出函数（Fix 6）。
- `docs/HANDOFF_CODE_REVIEW_2026_05_28.md`：新增，记录全部 6 项修复的根因、diff 和未修复项说明。

**测试：** 176 个测试，0 失败（2 skipped）；前端 tsc + vite build 通过

---

## 2026-05-27 — 下钻 tab 中移除 Mask 选项

**完成内容：**
- `pcr-ai-report/src/reports/InfcontrolReport.tsx`：`DRILL_FROM_LOT` 移除 `{ label: "Mask", value: "mask" }` 条目，完成所有下钻 tab（Device/CardType/Card/Bin/Lot）的 Mask 清理。`DRILL_FROM_MASK`（Mask 图表自身的下钻面板）保留不动。

**测试：** 构建通过（tsc + vite），0 失败

---

## 2026-05-27 — JB Star 分组汇总树加入 Mask 层

**完成内容：**
- `pcr-ai-report/src/reports/InfcontrolReport.tsx`：`buildTree` 第一维改为 `"mask"`，树层次变为 **Mask → Device → LOT → ProbeCard Type → CardId**；树标头同步更新。`infcontrolTreeYieldExtra` 去掉 `depth > 1` 早退，改为 `if (!device && !lot) return null`（mask 节点静默，device/lot 节点仍正常显示良率）。`TREE_DRILL_DIMS` 加 `"mask"`。`rowMatchesJbDrillParent` 加 mask 分支（`DEVICE.slice(-4).toUpperCase() === val`）。`jbRowDimValue` 加 mask 分支（优先 `row.MASK`，回退 `DEVICE.slice(-4)`）。

**测试：** 构建通过（tsc + vite），后端 150 个测试，0 失败

---

## 2026-05-27 — fix: mask 在聚合 parts 中未填充

**完成内容：**
- `pcr-ai-api/src/lib/infcontrolLayerBinDummy.ts`：`aggregateInfcontrolLayerBinDummyRows` 与 `aggregateInfcontrolLayerBinV3FromRows` 在 parts 构建后加 `if (groupBy.includes("device")) parts["mask"] = deviceMask(DEVICE) ?? ""`，对齐 `buildInfcontrolLayerBinAggregateGroupParts` 的逻辑。根因：combined 端点（Oracle + Dummy 路径均走 `aggregateInfcontrolLayerBinV3FromRows`）不走 `buildInfcontrolLayerBinAggregateGroupParts`，导致 mask 图表显示 "—"。

**测试：** 150 个测试，148 通过，0 失败（2 skipped）

---

## 2026-05-27 — JB Star mask 分组汇总维度

**完成内容：**
- `pcr-ai-api/src/lib/infcontrolLayerBinAggregate.ts`：`InfcontrolLayerBinGroupBy` 新增 `"mask"`；`parseGroupByToken` 加 `mask: "mask"`；`infcontrolLayerBinNonBinSelectSql` 返回 `UPPER(SUBSTR(TRIM(ic.DEVICE), -4)) AS MASK`；`oracleGroupColumnName` 返回 `"MASK"`；`sqlExprForGrpKeyFragment` / `groupBySqlExprs` 通过 default 路径自动处理。
- `pcr-ai-api/src/lib/infcontrolLayerBinDummy.ts`：`valueForInfcontrolDimension` 新增 `case "mask"` → `deviceMask(DEVICE) ?? ""`（Dummy 路径对齐 Oracle）。
- `pcr-ai-report/src/reports/InfcontrolReport.tsx`：新增 `DRILL_FROM_MASK` 下钻选项组；`DRILL_FROM_DEVICE_JB / CARDTYPE / CARD / BIN / LOT` 各加 `Mask` 选项；`JB_CHART_BLOCK_ORDER` 加 `"jbMask"`；新增 `selectedMask` state；`maskOption` useMemo（从 `aggDevice.groups[].parts.mask` 汇总，紫色，无需额外 API 调用）；chartsGrid 加 `jbMask` section（ChartDrillSplit + DrillDownPanel）。

**测试：** 150 个测试，148 通过，0 失败（2 skipped）

---

## 2026-05-27 — toolResultMaxHistoryChars 可配置化

**完成内容：**
- `pcr-ai-api/src/lib/agent/agentConfig.ts`：`AgentConfig` 接口新增 `toolResultMaxHistoryChars`；常量 `DEFAULT=6000 / MIN=1000 / MAX=12000`；`clampToolResultMaxHistoryChars`；`resolveAgentConfig` 读 `AGENT_TOOL_RESULT_MAX_HISTORY_CHARS` env 并写入返回对象。
- `pcr-ai-api/src/lib/agent/agentLoop.ts`：移除硬编码 `TOOL_RESULT_MAX_HISTORY = 6000`，改为 `agentConfig.toolResultMaxHistoryChars`。
- `pcr-ai-report/src/hooks/usePersistedAgentConfig.ts`：`AgentConfig` 接口加 `toolResultMaxHistoryChars`；常量 `DEFAULT=6000 / MIN=1000 / MAX=12000`；`clampToolResultMaxHistoryChars`；`DEFAULTS` / `normalizeAgentConfig` 对齐。
- `pcr-ai-report/src/App.tsx`：Settings 「工具结果最大字符数」区域下方增加「历史存储上限」数字输入（1000–12000，默认 6000）；字段说明改为动态说明（不再写死 6000）。

**测试：** 150 个测试，0 失败

---

## 2026-05-27 — mask filter + 报表展示

**完成内容：**
- `pcr-ai-api/src/lib/yieldMonitorTriggerFilters.ts`：`parseYieldMonitorTriggerV3Query` 新增 `mask` 参数 → `UPPER(SUBSTR(TRIM(t.DEVICE), -4)) = UPPER(:v3_mask)`（Oracle SQL）。
- `pcr-ai-api/src/lib/infcontrolLayerBinFilters.ts`：`parseInfcontrolLayerBinsV3Query` 同上 → `UPPER(SUBSTR(TRIM(t1.DEVICE), -4)) = UPPER(:ic3_mask)`。
- `pcr-ai-api/src/lib/yieldMonitorTriggerDummy.ts`：`filterYieldMonitorDummyRowsMatchingV3` 增加 mask 过滤（slice(-4) 等价 Oracle）。
- `pcr-ai-api/src/lib/infcontrolLayerBinDummy.ts`：`filterInfcontrolLayerBinV3DummyRowsMatching` 同上。
- `pcr-ai-report/src/api/types.ts`：`YieldMonitorV3Row` / `InfcontrolLayerBinV3Row` 添加 `MASK?: string | null`。
- `pcr-ai-report/src/reports/YieldMonitorReport.tsx`：`FormState` + `buildCoreParams` 加 `mask`；filter-grid 新增「Mask (后4位)」输入；detail 表增加 `MASK` 列。
- `pcr-ai-report/src/reports/InfcontrolReport.tsx`：同上。

**测试：** 150 个测试，0 失败

---

## 2026-05-27 — Agent prompt 支持 mask 提问

**完成内容：**
- `pcr-ai-api/src/lib/agent/agentPrompt.ts`：新增「device 后缀标识（mask）」章节，说明 mask = device 后 4 位、API 中的 MASK 字段位置、按 mask 提问时先用 get_filter_values / 快照匹配完整 device 再查询的流程，以及 4 位字母数字串默认判断为 mask 的规则。

**测试：** N/A（prompt-only 改动，无测试文件）

---

## 2026-05-27 — mask 字段：所有涉及 device 的 API 返回后四位产品标识

**完成内容：**
- `pcr-ai-api/src/lib/deviceMask.ts`（新建）：`deviceMask(raw)` 取 device 字符串末 4 位，空则 null；例：`"WA03P02G"` → `"P02G"`。
- `pcr-ai-api/src/routes/yieldMonitorRoutes.ts`：`enrichYieldMonitorTriggerV3ListRow` 增加 `MASK` 字段。
- `pcr-ai-api/src/routes/infcontrolRoutes.ts`：`enrichInfcontrolLayerBinV3ListRow` 增加 `MASK` 字段。
- `pcr-ai-api/src/lib/agent/agentToolHandlers.ts`：`enrichYieldRow` / `enrichJbRow` 增加 `MASK` 字段。
- `pcr-ai-api/src/lib/yieldMonitorTriggerDummy.ts`：`filterYieldMonitorDummyRowsMatchingV3` map 增加 `MASK`（dummy-parity）。
- `pcr-ai-api/src/lib/infcontrolLayerBinDummy.ts`：`filterInfcontrolLayerBinV3DummyRowsMatching` map 增加 `MASK`（dummy-parity）。
- `pcr-ai-api/src/lib/yieldMonitorTriggerV3Aggregate.ts`：`buildYieldMonitorV3AggregateGroupParts` 当 dimensions 含 `device` 时在 parts 追加 `mask`。
- `pcr-ai-api/src/lib/infcontrolLayerBinAggregate.ts`：`buildInfcontrolLayerBinAggregateGroupParts` 同上逻辑。

**测试：** 150 个测试，0 失败（2 skipped）

---

## 2026-05-27 — history bug 修复 + AI Agent 开关 + Settings 描述清晰化

**完成内容：**
- `pcr-ai-api/src/lib/agent/agentLoop.ts`：修复 `TOOL_RESULT_MAX_HISTORY` 对 string 类型不生效的 bug（`runTool` 始终返回 string，旧分支是死代码）；调整上限 3000 → **6000**。修复前每条工具结果最多塞 12000 chars 进历史，多轮对话后 LLM context 快速膨胀导致无输出；修复后历史每条固定 ≤ 6000 chars，与 `toolResultMaxChars`（单次分析）解耦。
- `pcr-ai-report/src/App.tsx`：Settings 新增「**启用 AI Agent 标签页**」toggle switch（`localStorage` 键 `pcr-ai-report.agent.enabled`）；关闭时导航栏隐藏 AI tab，若当前在 AI tab 则自动跳回 Yield；下方配置及会话历史保留。
- `pcr-ai-report/src/App.tsx`：AI Agent 配置区重构为三分组（接入配置 / 推理行为 / 超时）+ 分隔线 + 小标题，每项均有完整说明；工具结果字符数描述新增「历史固定 6000 上限不受此值影响」说明，消除用户误以为调大此值只影响单次分析的误解。
- `pcr-ai-report/src/index.css`：新增 `.toggle-switch` / `.toggle-track` toggle switch 样式；`.settings-divider` / `.settings-group-title` 分组辅助样式。

**测试：** `pcr-ai-api` typecheck 通过；`pcr-ai-report` build 通过（901 modules）。

---

## 2026-05-27 — Agent by lot BIN10 vs BIN66 + recentLots 延续

**现象：** 问「7747-01 by lot BIN10 是否多于 BIN66」时 Agent 用 `aggregate_jb_bins` top 表，误判 BIN10 整体更多。

**完成内容：**
- `agentJbBinFormat.ts`：`buildBinTotalsByLot`、`buildBin10Vs66ByLot` → 工具回传 **`bin10Vs66ByLot`**。
- `agentPrompt.ts`：专节「按 lot 对比两个 BIN」；禁止 aggregate 代替横向对比。
- `agentToolSchemas.ts`：`query_jb_bins` / `aggregate_jb_bins` 描述同步。
- 交接 `docs/HANDOFF_AGENT_JB_BIN_AND_TOOL_RESULT.md` **§9**（含 7747-01 Oracle 全量验证：149 lot 中 139 个 BIN66 多）；`pcr-ai-api/CLAUDE.md` §11 条目 17。

**测试：** `test/agentJbBinFormat.test.ts`（`buildBin10Vs66ByLot`）。

---

## 2026-05-27 — Agent JB 逐片 BIN + 工具结果体积可配

**现象：** 问 lot 每片 BIN7 颗数时 Agent 报「API 截断」，只列部分 slot。

**完成内容：**
- `pcr-ai-api/src/lib/agent/agentJbBinFormat.ts`：`slotBadBinsCompact`、`binBySlot`、`serializeJbQueryResultForAgent(wrapped, maxChars)`（超限省略 `rows`，不输出无效 JSON）。
- `pcr-ai-api/src/lib/agent/agentConfig.ts`：`toolResultMaxChars` 默认 **12000**（6000–30000）；env `AGENT_TOOL_RESULT_MAX_CHARS`。
- `pcr-ai-api/src/lib/agent/agentToolHandlers.ts` / `agentLoop.ts`：`runTool(..., { toolResultMaxChars })`。
- `pcr-ai-api/src/lib/agent/agentPrompt.ts` + `agentToolSchemas.ts`：逐片 BIN 专节与工具描述。
- `pcr-ai-report` Settings：`toolResultMaxChars` 输入（`usePersistedAgentConfig.ts`、`App.tsx`）。
- 交接文档：`docs/HANDOFF_AGENT_JB_BIN_AND_TOOL_RESULT.md`；`pcr-ai-api/CLAUDE.md` §11 条目 15。

**测试：** `test/agentJbBinFormat.test.ts`、`test/agentConfig.test.ts`；前后端 build/typecheck 通过。

**部署：** `pcr-ai-api` build + pm2 reload；`pcr-ai-report` build。Settings 改值无需重启 API。

---

## 2026-05-26 — AI Chat 重新生成按钮 + 会话日志

**完成内容：**
- `pcr-ai-report/src/reports/AiAgentReport.tsx`：每条完整 AI 回答的反馈栏新增 🔄 重新生成按钮（位于 👍👎 左侧，竖线分隔）；`handleRegenerate(idx)` 截断消息列表到该回答前的用户问题，重新提交同一问题并清除旧反馈状态；`submitAgentRequest` 增加 `baseMessages` 选项支持重新生成场景。
- `pcr-ai-report/src/reports/AiAgentReport.css`：新增 `.ai-feedback-btn--regen` 样式（右侧竖线分隔符，与 👍👎 区分）。
- `pcr-ai-api/src/lib/agent/sessionLogger.ts`（新建）：`SessionLogger` 类，监听 SSE emit 事件（text/tool_start/tool_result/done/error），将每次对话请求记录为 markdown 文件；文件名 = 请求开始时间戳（Windows 安全格式，`:` → `-`）；存放目录由 `SESSION_LOG_DIR` env 控制，默认 `pcr-ai-api/session-logs/`。
- `pcr-ai-api/src/routes/agent.ts`：每次请求创建 `SessionLogger` 并将所有 `writeEvent` 调用同步 feed 给 logger。
- `pcr-ai-api/.env.example`：新增 `SESSION_LOG_DIR` 说明注释。

**测试：** typecheck 与 build 均通过（前端 `npm run build`，后端 `npm run typecheck` + `npm run build`）。

---

## 2026-05-25 — Code Review 修复 + Agent 工程经验提示词

**完成内容：**
- `pcr-ai-report/src/utils/yieldCalc.ts`：`computeYieldPct` 中将 `goodUp === 0` 检查移至 `secondPct === null` guard 之前，消除与 API `jbYieldCalc.ts` 的边缘情况分歧（上半段 goodDie=0 且下半段 grossDie=0 时前端误返回 0% 而非 null）。
- `pcr-ai-api/src/routes/infAnalysisRoutes.ts`：将 ~400 行单路由处理器拆分为三个独立 async 函数（`handleLotWithCardType` / `handleLotByDirectory` / `handleDeviceAgg`），嵌套层级从 5 层降至 2 层，功能不变。
- `pcr-ai-api/src/lib/siteBinByLotWaferResolve.ts`：`resolveSiteBinWafersWithSkips` 文件可读性检查从串行 for-await 改为 `Promise.allSettled` 并行，device 聚合场景（~250 文件）性能提升。
- `pcr-ai-api/scripts/`：删除 8 个 slot 良率排查诊断脚本（bug 已修复，脚本不再需要）。
- `pcr-ai-api/src/lib/agent/agentPrompt.ts`：新增 `## 工程经验参考（诊断辅助）` 章节——DUT 报警模式/坏 bin 分布/温度层失效/INTERRUPT 含义 四张精炼参考表 + 联合诊断 3 步流程。
- `docs/HANDOFF_CODE_REVIEW_2026_05_25.md`：本次修复交接文档。

**测试：** 138 个测试，136 pass，2 skip，0 失败。

---

## 2026-05-25 — JB 中断 slot 良率半片 + Agent 汇报顺序

**完成内容：**
- `jbYieldCalc.ts`：`slotYieldSummary` 增加 `interruptHalf` / `completionHalf`；`computeJbYieldBreakdown`；整片正片仍走 `computeJbYieldMetrics`（前半 good=0 → 仅后半）。
- `agentPrompt.ts`：有中断时输出顺序 **整片正片 → 前半段 → 后半段**；良率 0% 也必须写出。
- 诊断脚本 `scripts/print-slot-breakdown.ts`；单测 `jbYieldCalc.test.ts` 半片用例。
- 交接文档 [`HANDOFF_JB_INTERRUPT_YIELD.md`](HANDOFF_JB_INTERRUPT_YIELD.md)，`pcr-ai-api/CLAUDE.md` §2 已索引。

**部署：** `npm run build` + `pm2:reload` 后 Agent `query_jb_bins` 才带半片字段。

**测试：** `npm test`（含 `jbYieldCalc.test.ts`）。

**后续（同分支）：** `f448422` 用 passId+passNum/TESTEND 识别续测；`agentJbBinFormat` 单测确认 `yieldPct:0` 写入 JSON。交接见 `HANDOFF_JB_INTERRUPT_YIELD.md` §5 0% 清单。

---

## 2026-05-24 — 规划：INF 文件聚合路径 + 报表重构 UX 原则

**完成内容：**
- 确定 lot 级 DUT×Bin 聚合数据源路径规则：`/data/INF/{DEVICE大写}/{LOT大写}/`，最多 25 个 INF 文本文件；device 级路径 `/data/INF/{DEVICE大写}/` 文件量大，不轻易触发
- 明确报表重构三项 UX 原则：① YM↔JB 跨报表跳转链接；② 相同维度分析逻辑抽共用组件（精简重复）；③ Drilldown 可用性视觉标志——不可下钻的 chart hover 时显示红色禁止圈（`cursor: not-allowed`）
- 以上规则已记录至项目记忆（`memory/project_report_ux_dut_bin_plan.md`）

**测试：** 无代码变更，无测试运行。

---

## 2026-05-22 — AI Agent 允许总结轮继续调工具（多步推理）

**现象：** MiniMax 2.5 对复杂查询（如"top15 lot device yield"）在工具结果返回后仍需追加调用第二个工具（`aggregate_jb_bins` → `query_jb_bins`），触发"模型在总结阶段仍尝试调用工具"错误，无法得到最终结论。

**根因：** `agentLoop.ts` 的 `awaitingSummary && toolCalls.length > 0` 错误块阻断了合法的多步推理。MiniMax 通过 `<minimax:tool_call>` 嵌入格式调用工具，新增的 MiniMax filter 将其转换为 `toolCalls`，触发该错误。

**完成内容：**
- `pcr-ai-api/src/lib/agent/agentLoop.ts`：删除 `if (awaitingSummary)` 工具调用错误块。`maxRounds`（默认 5）是防止无限循环的正确安全网；`SUMMARIZE_NUDGE` 持续引导模型最终输出中文结论。多步推理可正常进行（如 aggregate → query → 结论）。

**测试：** 108 个测试，106 pass，2 skip，0 失败。

---

## 2026-05-22 — AI Agent MiniMax 2.5 tool_call 流式泄漏过滤

**现象：** 使用 MiniMax 2.5 模型时，工具调用以 `<minimax:tool_call>…</minimax:tool_call>` XML 格式泄漏到聊天气泡，工具未被执行，后续也无分析输出。

**完成内容：**
- `pcr-ai-api/src/lib/agent/agentLoop.ts`：`createDeepSeekFilter` 扩展支持 MiniMax 格式：新增 `MINIMAX_START_RE`、`MINIMAX_END_RE`、`MINIMAX_INVOKE_RE`、`MINIMAX_PARAM_RE`、`MINIMAX_PARTIAL_OPEN_TAIL_RE` 常量；新增 `tryExtractFromMinimaxBuf()`（解析 `<invoke name>` + `<parameter name>`，生成 `CollectedToolCall`）；`scanForTokens` 加入 MiniMax 检测分支；`push` / `finalize` 接入 `"minimax"` tokenKind。
- `pcr-ai-api/test/agentLoop.test.ts`：新增 2 个测试（完整块 / 跨 chunk 分割），108 tests，106 pass。

**测试：** 108 个测试，106 pass，2 skip，0 失败。

---

## 2026-05-22 — Code Review 修复：双超时 / 测试健壮性 / 总结轮非标消息

**完成内容：**
- `pcr-ai-api/src/lib/agent/agentStream.ts`：删除 `req.setTimeout(timeoutMs, handleTimeout)`。`req.setTimeout` 是 Node socket 级超时，从请求开始固定计时、不因 SSE 字节流入而重置，会在 `timeoutMs` 精确杀死仍在传输的长流；`data` 事件里的 idle-reset `setTimeout` 已足够。
- `pcr-ai-api/src/lib/agent/agentConfig.ts`：`resolveStreamTimeout` 新增对 `override?.streamTimeoutMs` 的直接支持（原先只认 `streamTimeoutSec`），使测试可传 `streamTimeoutMs: 20` 而无需依赖 env 副作用。
- `pcr-ai-api/test/agentStream.test.ts`：两个超时测试去掉 `process.env.AGENT_STREAM_TIMEOUT_MS` 设置/还原，改为 `resolveAgentConfig({ streamTimeoutMs: 20 })` 直接注入，消除模块缓存脆弱性。
- `pcr-ai-api/src/lib/agent/agentLoop.ts`：把 `SUMMARIZE_NUDGE` 从追加在 `messages` 末尾的 `{ role: "system" }` 改为并入第一条 system prompt（仅对总结轮）；去掉总结轮的 `tool_choice: "none"`（无 `tools` 时该字段冗余，部分 SiliconFlow/DeepSeek 版本对无 `tools` + `tool_choice: "none"` 组合返回空响应）；总结轮 LLM 调用前新增 `{ type: "status", message: "正在生成分析结论…" }` 事件，减少用户等待感知。

**测试：** 106 个测试，104 pass，2 skip（设计跳过），0 失败。

---

## 2026-05-22 — AI Agent 聊天气泡横线（~~）与页面双滚动条

**现象：** 模型用 **`~~…~~`** 标「未展示/截断」时，GFM 渲染成删除线横线；消息变多后**页面最外层**出现纵向滚动条（应只在消息区滚动）。

**完成内容（仅 `pcr-ai-report`）：**
- **`utils/sanitizeAgentMarkdown.ts`**：展示前去掉 **`~~…~~`** 包裹。
- **`AiAgentReport.tsx`**：**`remarkGfm({ singleTilde: false })`**；**`del`/`s`** 组件不画删除线。
- **`AiAgentReport.css`**：去掉 **`calc(100vh - 180px)`**，**`flex: 1; min-height: 0; overflow: hidden`**；**`.ai-agent-messages`** 加 **`min-height: 0`**。
- **`index.css` + `App.tsx`**：AI Tab 使用 **`tab-panel--agent`** 占满 grid 第三行。
- 交接：**`pcr-ai-report/CLAUDE.md` §19**、根 **`CLAUDE.md`**。

**部署：** 前端 rebuild / 重启 dev（无 API 变更）。

---

## 2026-05-22 — AI Agent Settings 可配超时 + 流式泄漏过滤（think / DSML）

**现象：** 聊天气泡偶发 **think**、**`redacted_thinking`**、**`<｜DSML｜tool_calls>`** 等内部标记；复杂 INF 下钻需更长 idle 超时。

**完成内容：**
- **Settings**：**`streamTimeoutSec`**（默认 150s，30–600）、**`clientTimeoutSec`**（默认 180s）；随 **`agentConfig`** 下发；**`agentStream.ts`** 用 **`streamTimeoutMs`**；未传回退 **`AGENT_STREAM_TIMEOUT_MS`**。
- **`agentLoop.ts` `createDeepSeekFilter`**：剥离 `` / `` / **`<think>`**；剥离 **DSML** 工具块（结束标签 **`</｜DSML｜tool_calls>`**，无尾部 `｜`）；可解析为嵌入式 **`query_*`** 调用；**`agentStream.ts`** 不转发 **`reasoning_content`**。
- 测试：**`agentLoop.test.ts`**（think / thinking / DSML）；**`agentConfig.test.ts`**（**`streamTimeoutSec`**）。
- 交接：**`pcr-ai-api/CLAUDE.md` §11 条目 14/§12.1**、**`pcr-ai-report/CLAUDE.md` §17–§18**、根 **`CLAUDE.md`**。

**部署：** API **`npm run build` + pm2 reload**；前端 rebuild / 重启 dev。

---

## 2026-05-22 — AI Agent New Chat 重置、超时 150s

**现象：** 请求进行中点 **New Chat** 后，底部「仍在处理中」与 **发送** 按钮仍显示「处理中」；上游 idle 超时默认 270s 偏长。

**完成内容：**
- `pcr-ai-report/src/reports/AiAgentReport.tsx`：**`chatGenerationRef`** 隔离旧 SSE；**`newSession`** 先 **`setLoading(false)`** 再 **`abort()`**；stale **`finally`** 在 **`abortRef === null`** 时兜底重置 UI。
- `pcr-ai-api/src/lib/agent/agentStream.ts`：**`AGENT_STREAM_TIMEOUT_MS`** 默认 **270s → 150s**（idle：有 SSE 字节则重置计时）。
- `pcr-ai-report`：客户端整请求超时 **180s**（略大于后端）；Vite dev 代理 **`timeout` / `proxyTimeout`** 同步 **180s**；超时提示改按秒显示。
- 交接：**`pcr-ai-api/CLAUDE.md` §6/§11 条目 13/§12.1**、**`pcr-ai-report/CLAUDE.md` §16**、根 **`CLAUDE.md`**。

**部署：** API **`npm run build` + pm2 reload**；若 `.env` 曾设 **`AGENT_STREAM_TIMEOUT_MS=270000`** 请改为 **150000** 或删除以用新默认。前端 rebuild / 重启 dev。

---

## 2026-05-22 — AI Agent 工具后强制总结（有数据无输出 / 超时）

**现象：** 工具（如 `aggregate_yield_triggers`）JSON 已在 UI 展示，但第二轮 LLM 无中文结论，270s 或前端 5min 超时；与 2026-05-21 流式 UX 改动无关。

**完成内容：**
- `pcr-ai-api/src/lib/agent/agentLoop.ts`：`historyAwaitingToolSummary`；工具后总结轮 `tool_choice: "none"` + `SUMMARIZE_NUDGE`；DeepSeek filter `finalize()` flush；tool 消息补 `name`；空总结/总结轮再调工具 → 明确 error。
- `pcr-ai-api/src/lib/agent/agentStream.ts`：idle 超时（有 SSE 字节则重置 `AGENT_STREAM_TIMEOUT_MS`）。
- `pcr-ai-api/test/agentLoop.test.ts`：回归 `historyAwaitingToolSummary`。
- 交接：**`pcr-ai-api/CLAUDE.md` §6/§9/§11 条目 11/§12.1**、**`pcr-ai-report/CLAUDE.md` §15**、根 **`CLAUDE.md`**。

**测试：** `npm test`（含 `agentLoop.test.ts`）。

## 2026-05-22 — AI Agent 可配置轮数、超时重试、INF PASS_TYPE 过滤

**完成内容：**
- `pcr-ai-api/src/lib/agent/agentConfig.ts`：`AgentConfig.maxRounds`（默认 5，clamp 1–20）；环境变量 **`AGENT_MAX_ROUNDS`**；测试 **`test/agentConfig.test.ts`**。
- `pcr-ai-api/src/lib/agent/agentLoop.ts`：ReAct 上限读 **`agentConfig.maxRounds`**；支持 **`{ resume: true }`** 跳过重复追加 user 消息。
- `pcr-ai-api/src/routes/agent.ts`：请求体 **`retry: true`** 续跑 session。
- `pcr-ai-report`：Settings 新增「最大推理轮数」；**`AiAgentReport`** timeout 错误显示 **↻ 重试**（**`retry: true`** + 同 **`sessionId`**）。
- `pcr-ai-api/src/perlscripts/output_site_bin_bylot.pl`：仅统计 **`SmWaferPass`** 且 **`PASS_TYPE='TEST'`**（对齐 JB **`PASSTYPE=TEST`**）。
- 交接文档：**`pcr-ai-api/CLAUDE.md`** §6/§11/§12.1、**`pcr-ai-report/CLAUDE.md`** §14、根 **`CLAUDE.md`**、**`pcr-ai-api/docs/SITE_BIN_BY_LOT_API.md`**。

## 2026-05-21 — AI Agent 流式体验优化（历史上下文延长 + pending 状态显示 + LOOKAHEAD 收紧）

**完成内容：**
- `pcr-ai-api/src/lib/agent/agentHistory.ts`：`SUMMARIZE_THRESHOLD` 20→40、`KEEP_RECENT` 10→20、`MAX_MESSAGES` 60→80；正常会话极少触发压缩，lot ID / bin 编号不再被摘要洗掉。
- `pcr-ai-api/src/lib/agent/agentLoop.ts`：`LOOKAHEAD` 30→12，文字推送更连续（中文减少每批 15 字的卡顿）；补 3 条 `status` SSE 事件填补静默期（summarization 前 / manifest fetch 前 / 工具结果处理后）。
- `pcr-ai-report/src/reports/AiAgentReport.tsx`：空 AI 气泡改显示 `statusHint`（如"正在准备系统信息…"），不再只显示无意义的 `"…"`。
- `pcr-ai-report/src/reports/AiAgentReport.css`：新增 `.ai-status-hint`（灰色斜体，0.9em）。
- `pcr-ai-api/test/agentHistory.test.ts`：trim 断言同步更新为 `≤80 messages`。
- `pcr-ai-api/CLAUDE.md`、`pcr-ai-report/CLAUDE.md`：补充上述变更的交接说明。

**测试：** 94 个测试，92 pass，2 skip，0 失败。

## 2026-05-21 — INF DUT 分布面板、drill 缓存、图表布局重构、Node 23+ 兼容修复

**完成内容：**
- `pcr-ai-api/src/polyfillUtilIsDate.ts` + `loadEnv.ts`：Node 23+ 删除了 `util.isDate`，oracledb 5.5 Date 绑定会崩溃；在加载 oracledb 前打补丁；`npm run dev` 下自动开启 Dummy（`PCR_AI_LOCAL_DUMMY=false` 可关闭）。
- `pcr-ai-report/src/components/InfDutDistPanel.tsx`：新组件，展示 JB STAR lot/slot 下各 DUT 的 bin 分布（stacked bar，per pass）；调用 `GET /inf-analysis/site-bin-bylot`；默认只显示 good bins。
- `pcr-ai-report/src/components/ChartDrillSplit.tsx`：新组件，CSS grid `1fr 1fr`，左图 + 右侧下钻面板跨全行，`overflow:hidden` 防首次点击页面变宽。
- `pcr-ai-report/src/utils/infGoodBins.ts`：从三来源合并 good bin — `HARD_GOOD_BIN=1`、`bins[].isGoodBin`、PASSBIN 连字符格式（`1-55-250`）；与 API `parsePassBinHyphenGoodBins` 逻辑一致。
- `pcr-ai-report/src/utils/drillAggregate.ts`：`drillFromTree()` 从内存 aggTree 按父维切片，切换 drill tab 不再重复请求 Oracle；优先级：aggTree → list rows → tab cache → Oracle。
- `pcr-ai-report/src/reports/YieldMonitorReport.tsx` + `InfcontrolReport.tsx`：改为全行块 + 右侧下钻布局（`ChartDrillSplit`）；DUT# 分布移入 ProbeCard 下钻面板底部；JB detail 行按 Yield% 升序；Y 轴 `containLabel: true` 防截断。
- `pcr-ai-report/scripts/pack-report-dist.mjs`：`npm run pack:dist` 打 `dist.tar` 供 nginx 一步部署（extract at web root）。
- `CLAUDE.md`（根目录）：补 `loadEnv.ts` 启动链、`ChartDrillSplit`/`InfDutDistPanel`、新 utils、`pack:dist`/PM2 命令、修正 INF 状态为"已实现"。
- `feature/site-bin-bylot-integration` 已 fast-forward merge 到 `main`，分支已删除。

**测试：** 94 个测试，92 pass，2 skip（Oracle 集成测试），0 失败。

## 2026-05-16 — Agent ask_clarification 防空校验 + 前端空气泡修复

**完成内容：**
- `pcr-ai-api/src/lib/agent/agentTools.ts`：`ask_clarification` 工具对 `question` 做非空/trim 校验，空白时返回错误字符串让模型重试，防止空 clarification 事件导致对话死锁。
- `pcr-ai-report/src/reports/AiAgentReport.tsx`：`case "clarification"` SSE 处理改为检查最后一条消息是否为空 AI 气泡，若是则原地替换为 clarification 气泡，而不是追加，消除 ask_clarification 仅触发时界面出现空白 AI 框的问题。

**测试：** `tsc --noEmit`（pcr-ai-api）及 `tsc -b`（pcr-ai-report）均无类型错误；无功能回归。

## 2026-05-16 — AI Agent SSE 无响应修复

**完成内容：**
- `pcr-ai-api/src/routes/agent.ts`：将 SSE 客户端断开判断从 `req.close` 改为 `res.close`，修复 POST 请求体读完后误判连接关闭导致前端“输入后无反应”的问题。
- `pcr-ai-api/src/lib/agent/agentStream.ts`、`pcr-ai-api/.env.example`：新增 `AGENT_STREAM_TIMEOUT_MS` 流式上游总超时，默认 30000ms，避免 SiliconFlow 连接/响应停滞时前端一直空等。
- `pcr-ai-api/test/agentRoute.test.ts`、`pcr-ai-api/test/agentStream.test.ts`、`pcr-ai-api/package.json`：新增 SSE 路由与流式超时回归测试，并将 `npm test` 扩展为运行全部 `test/*.test.ts`。
- `CLAUDE.md`、`pcr-ai-api/CLAUDE.md`、`pcr-ai-report/CLAUDE.md`：记录 AI Agent 新链路、根因、修复点、验证命令和交接注意事项，避免继续按旧 `GET /siliconflow/chat` 排查聊天页。

**测试：** 46 个测试，0 失败（44 pass，2 skip）；`npm run typecheck` 通过；`npm run build` 通过。

## 2026-05-15 — 文档修正：JB START → JB STAR 全局重命名

**完成内容：**
- `CLAUDE.md`：修正 "JB START" 拼写为 "JB STAR"
- `docs/superpowers/plans/2026-05-13-report-rebuild.md`：全文替换 "JB START" → "JB STAR"（涉及 UI 标签、注释、commit message 模板等多处）
- `docs/superpowers/specs/2026-05-13-report-rebuild-design.md`：Tab 列表及 Section 5 标题修正
- `.superpowers/brainstorm/` 相关 HTML 文件：approaches、final-nav、grouping-options、wireframe 同步修正
- `.claude/settings.local.json`：权限/配置微调

**测试：** 无代码变更，仅文档；无测试需运行。
