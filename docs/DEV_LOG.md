# WaferMind 开发日志

---

## 2026-07-11 — AI Agent 适配 MiniMax-M2.5（多模型白名单 + 大上下文档位）

**完成内容：**
- `pcr-ai-api/src/lib/agent/agentConfig.ts`：`resolveAgentConfig()` 的 `model`/`subAgentModel` 此前被硬编码强制为 `deepseek-ai/DeepSeek-V4-Flash`，忽略前端 Settings 与 env 传入的值。改为按模型族模糊匹配的白名单：新增 `isDeepSeekV4Flash` / `isMiniMaxM25` / `isAllowedAgentModel`（归一化后子串匹配，不要求与某个供应商的完整 ID 一致），解析顺序 `override.model → env AGENT_MODEL → 默认值`；`subAgentModel` 独立解析。目的是同时支持硅基流动与未来可能更换的供应商（如七牛云）上的同名模型，不需要为每个供应商硬编码 ID。
- `detectLargeContext()`：MiniMax-M2.5（192K 上下文）纳入大上下文档位（与 GLM 系列同档：summarize 阈值 80、max_tokens 16384、toolResultMaxHistoryChars 20000），目的是减少历史截断、提升长对话回答质量。
- `pcr-ai-api/.env.example`、`pcr-ai-report/src/App.tsx`：同步更新模型相关注释与 Settings 页「模型」输入框的提示文案，改为准确描述实际允许的两个模型族（此前的示例值 `deepseek-ai/DeepSeek-V3`、`MiniMax/MiniMax-M1` 均不在实际白名单内）。
- 未改动 `agentLoop.ts` 中已有的 MiniMax `<minimax:tool_call>` 嵌入式工具调用解析逻辑（2026-05-27/29 实现）——此前因模型被锁死从未真正运行，本次是让它第一次生效，代码本身无需改动。
- Spec：`docs/superpowers/specs/2026-07-11-agent-minimax-m2.5-adaptation-design.md`。

**测试：** `pcr-ai-api` `npm test` 全量通过（新增 agentConfig.test.ts 用例覆盖 MiniMax 直接生效、跨供应商前缀变体、env 覆盖、大上下文检测；`agentLoop.test.ts` 既有 MiniMax 解析用例保持绿）；`npm run typecheck` 通过；`pcr-ai-report` `npm run build` 通过。

---

## 2026-07-05 — 灰色小字对比度 + 字号微调（全局可读性）

**完成内容：**
- **对比度**：`index.css` 的 `--muted`/`--dimmed` 设计 token（dark/light 两套）与 `chartTheme.ts` 的 `axisColor`（图表坐标轴文字，需与 `--muted` 保持同步）一并调整——dark 主题调亮、light 主题调深，提高与背景的对比度。覆盖所有引用这两个 token 的说明文字、字段提示、图表轴标签、下钻提示等。
- **字号**：所有使用 `color: var(--muted)` / `var(--dimmed)` 的灰色小字统一 +1px（如 11px→12px、12px→13px、13px→14px），覆盖 `index.css`、`AiAgentReport.css`、`QueryInspector.css`、`DataTable.css` 及 `KpiCard`/`TreeTable`/`DrillDownPanel`/`InfDutDistPanel`/`LotUnderperformingDutsPanel`/`YieldMonitorReport`/`InfcontrolReport` 内联样式；未触碰非灰色文字（按钮、输入框等）字号。
- 用批量脚本执行 +1px 替换时曾误跑两次导致部分字号翻倍（+2px），已通过 `git checkout` 恢复原文件后重新单次执行修正。

**测试：** `pcr-ai-report` `npx tsc -b --noEmit` 通过（0 错误）；前端无测试框架，未跑用例；改动为纯样式，未做浏览器实测（已提示用户 `npm run dev` 自行核对）。

---

## 2026-07-04 — light/dark 主题：终审收尾（TreeTable 主题化 + tooltip 对比度 + 防闪屏）

**完成内容：**
- **Finding 1（重要）**：`pcr-ai-report/src/components/TreeTable.tsx` 此前未随 light/dark 主题切换分支改造，仍是硬编码 hex/rgba。全部替换为 CSS 变量：`DEPTH_COLORS` 改用 `--dim-card/--dim-device/--dim-lot/--dim-slot`（复用 `index.css` 已有的按维度配色 token）；边框 `rgba(240,246,252,x)` → `rgba(var(--fg-rgb),x)`；文字色 `#6e7681/#e6edf3/#8b949e` → `var(--dimmed)/var(--text)/var(--muted)`。
- **Finding 2（次要）**：`InfDutDistPanel.tsx` tooltip 高亮行背景已是 `rgba(var(--accent-rgb),0.32)`（light 下为浅蓝），但文字仍写死 `color:#fff`，light 模式下白字不可读；改为 `color:var(--text)`。
- **Finding 3（次要）**：`useTheme.ts` 的 `data-theme` 只在 React mount 后才写入，首帧沿用 `:root` 深色默认值，导致每次刷新闪一下深色再切换。在 `index.html` `<head>` 内 `<meta charset>` 之后、任何样式/脚本之前加同步 IIFE，直接读 `localStorage["pcr-ai-report.theme.v1"]` 并写 `document.documentElement.dataset.theme`（key 与 `useTheme.ts` `STORAGE_KEY` 完全一致，默认值逻辑与 `readStoredTheme` 对齐：非 `"dark"` 一律 `"light"`）。

**测试：** `pcr-ai-report` `npm run build` 通过（0 错误）；`grep -nE "#[0-9a-fA-F]{3,6}|rgba\(2[0-9]{2}," TreeTable.tsx` 无匹配，确认无残留硬编码颜色。前端无单测框架，未跑用例。

---

## 2026-07-02 — first-test 数据脚注 + 会话保存按钮

**完成内容：**
- **需求1（first-test 脚注，后端）**：服务端确定性数据表末尾统一追加 `> *所有数据只包含 first test，不包含 Auto retest*`。新增 `FIRST_TEST_ONLY_NOTE` + **幂等** `stampFirstTestNote`（`agentJbDeterministicReply.ts`），在各数据块构造点（`emitDeterministicJbTablesReply` 主表 / 坏 bin 排行 / BIN×lot / DUT×BIN / 低良率 DUT / per-slot / summary 聚合 / server-tables fallback）stamp；lot 概况/列表/mask 路由经 `emitDeterministicJbTablesReply` 自动覆盖。随数据进消息内容 → 导出会话时一并保留。commit ea70373。
- **需求2（会话保存，前端）**：`AiAgentReport` 工具栏（New Chat 旁）加「⤓ 保存」按钮，下载整个会话为 `.md`。新增纯函数 `utils/exportSession.ts`（`buildSessionMarkdown` / `sessionHasExportableContent`）——仅含用户提问 + Agent 回答文本（`## 问：` / `**答：**`），排除工具 JSON / 图表 / 错误 / 澄清 / 流式未完成 / 欢迎语；无问答时按钮禁用。复用已有 `downloadMarkdown`。commit b0fc23a。
- 执行方式：用户选「直接内联实现」，未走 spec/plan/SDD 流水线。

**测试：** 后端 478 个测试，0 失败（474 pass / 4 skip；含 stampFirstTestNote 幂等单测 3 项）；typecheck 通过。前端 `npm run build` 通过、未新增 lint 问题（前端无测试框架，`buildSessionMarkdown` 经 tsx 手工验证问答提取/内部信息排除/空会话禁用）。

---

## 2026-07-02 — 低良率 DUT 高亮 + 散点图（问 lot 时醒目标出偏低 DUT）

**完成内容：**
- **视图纯函数模块** `src/lib/agent/agentUnderperformingDutView.ts`：`formatAllDutsHighlightMarkdown(passResults, lot, device)` 列出各 pass 全部 DUT 良率，低于 `lot 整体良率 × thresholdRatio`（默认 0.75，**严格小于**）的 DUT 行 🔴+加粗；`buildUnderperformingDutScatterOptions` 每 pass 一个 ECharts 散点 option，三色带（🟢≥平均 / 🟡平均~阈值 / 🔴<阈值）+ lot 平均线 / 阈值线两条 markLine。（Task 1 88c7f4a、Task 2 48ee8bb）
- **路由谓词模块** `src/lib/agent/agentUnderperformingDutRoute.ts`：`isLotUnderperformingDutQuestion`（两门 AND：DUT/探针/触点/site 级 + 低良率意图，排除卡级「哪张卡良率最低」）+ `canRunUnderperformingDutDirectRoute` + `underperformingDutArgsFromText`。（Task 3 675564d）
- **A 路（`agentLoop.ts`）**：新增 PRE_LLM 确定性直连路由 `tryRunUnderperformingDutDirectRoute`（注册首位），命中「lot 内哪些 DUT 偏低」即 `runLotUnderperformingDuts` 直出全 DUT 高亮表 + 每 pass 散点，跳过 LLM；INF 失败 `return false` 落回 LLM。LLM 工具路径经 `RunToolOptions.onUnderperformingDuts` 回调也出散点；`agentToolHandlers.ts` 内部工具结果串换高亮表。（Task 4 9fbfb7f）
- **B 路（`agentLoop.ts`）**：`emitDeterministicJbTablesReply` 在 `generic`/`lot_overview` 概况末尾 best-effort 调 `tryAppendUnderperformingDutSection`，追加独立 `### 🔬 各 DUT 良率` 子节 + 散点；失败 / 缺 lot·device 静默跳过（`return ""`，不 emit error），返回 markdown 并入两处持久化 `const full`（UI 与 history 一致）。（Task 5 ac03371）
- **非破坏**：复用昨天 89c77b3 的 `computeUnderperformingDutsForPass` 已算数据，不碰 SQL/Dummy；`lotUnderperformingDuts.ts` 的 `formatUnderperformingDutsMarkdown`、REST 字段 `underperformingDutsMarkdown`、报表面板 `LotUnderperformingDutsPanel.tsx` 均未动。真库/真 INF 端到端复验交 Cursor（[`HANDOFF_UNDERPERFORMING_DUT_HIGHLIGHT_2026-07-02.md`](HANDOFF_UNDERPERFORMING_DUT_HIGHLIGHT_2026-07-02.md)）。spec/plan 见 `docs/superpowers/`。

**测试：** 475 个测试，0 失败（471 pass / 4 skip）；typecheck + build（含 verify-dist-no-undici）通过。逐 Task TDD + 独立审查（Spec ✅ / Approved）。

---

## 2026-07-02 — A1-2 卡级归因误路由 + A2-4 空 scope 空转（补齐 Cursor 8a6f841 待办）

**完成内容：**
- **A1-2 修复**（`agentLoop.ts` `isDutBinConcentrationQuestion`，导出供单测）：「BIN35 集中在哪张卡」同时命中 `isBinCardAttributionQuestion` 与 `isDutBinConcentrationQuestion`（含"卡"），而 P-F `tryRunDutBinAggDirectRoute` 在 `PRE_LLM_DIRECT_ROUTES` 排在语义派发之前、又从 mask 概况历史捞到 primary lot → 抢先成单 lot DUT 集中度。改门为**区分 DUT 级（dut/触点/探针）→ P-F** vs **纯卡级归因 → 让给 `bin_card_attribution` 派发（`aggregate_jb_bins(bin,cardId)`）**；P-F 原问句（含 dut）、A1-1（无 history lot 本就 bail）不受影响。
- **A2-4 修复**（新 `agentJbUnscopedBinRoute.ts` + `agentLoop.ts` 薄包 `tryRunUnscopedBinClarifyDirectRoute`，置 PRE_LLM 链末端）：`ZZZZZ 哪个卡测出bin99 多` 解析不到任何 scope → LLM 空转 250s 超时。仅当「有 BIN + bin 归因/排行问句 + 无 lot + device/mask/tester/platform/时间窗全空 + 句中有无法识别的全大写疑似 token」时确定性澄清。**纯中文无 token（B2-3）与可解析 scope 问句均不拦截**，只把会空转的死路变快速澄清。
- 未翻任何开关、未 merge main；改动仅路由层（未碰 SQL/Dummy/响应形状）。真库派发/超时复验交 Cursor：[`HANDOFF_CLAUDE_A1-2_A2-4_FIXES_2026-07-02.md`](HANDOFF_CLAUDE_A1-2_A2-4_FIXES_2026-07-02.md)。

**测试：** 465 个测试，0 失败（461 pass / 4 skip，连跑 3 次稳定）；typecheck + build（含 verify-dist-no-undici）✅

---

## 2026-06-29 — 阶段三完收：决策驱动确定性预 LLM 派发（Tasks 1–5，dark-launch）

**背景：** 真库会话日志 mqygf9mq 复盘显示，turn1 LLM 在高置信意图（`bin_card_attribution` / `lot_yield_ranking` / `card_yield_compare`）下仍会选错工具（如用 `query_jb_bins` 替代 `aggregate_jb_bins`），导致无效往返与无效输出。根治方案：在 LLM 发言前，服务端根据意图决策直接发起正确工具。

**设计：**
- `agentSemanticDispatchTable.ts`（新增）：纯函数 `resolveDispatch(intent, q)` — 三行显式映射表（`bin_card_attribution`→`aggregate_jb_bins`+renderKind `"aggregate"`；`lot_yield_ranking`→`aggregate_jb_bins`+renderKind `"aggregate"`；`card_yield_compare`→`query_jb_bins`+renderKind `"emitTables"`），`confidence==="high"` 才出，其余返回 `null`。
- `agentLoop.ts`：新增 `tryRunSemanticDispatchDirectRoute`，追加到 `PRE_LLM_DIRECT_ROUTES` 尾部；aggregate 模式 → 调 `aggregate_jb_bins` + `renderAggregateJbBinsResult`；query 模式 → 调 `query_jb_bins(device|mask)` + `emitDeterministicJbTablesReply`；mask fallback 与现有路由对齐。
- 空结果 / 工具错误 → 返回 `false`，LLM 自然兜底；仅 `confidence==="high"` 才派发，低置信意图无影响。
- `.env.example`：`JB_DETERMINISTIC_DISPATCH=false`（dark-launch，默认 **OFF**）。

**黄金集与闸门：**
- `test/eval/scenarios/routing-golden.ts`：问句从 57 条扩充到 85 条（≥ spec 要求的 80 条）。
- `test/agentEval.test.ts`：新增两个 CI 闸门 — `scoreDispatchOnGolden`（flag ON 时：派发条目 ≥ 2，且核心 bug 场景 mqygf9mq 必须命中）；`AGENT_EVAL_LIVE=1` live 闸门：实测误分类率 ≤ 2%（真库/真 LLM 环境运行，本 CI 跳过）。
- `test/routingGoldenScore.ts`：新增 `scoreDispatchOnGolden` 打分器，与已有 `scoreRegexOnGolden` / `scoreHybridOnGolden` 并列。

**安全边界（flag 默认 OFF 下零变更）：**
- `JB_DETERMINISTIC_DISPATCH` 未设或非 `"true"` → `tryRunSemanticDispatchDirectRoute` 直接返回 `false`，全量行为与阶段一+二逐字节等价。
- CI 回归（flag 不设）：**429 pass / 0 fail / 4 skip**（含 live 闸门 skip），typecheck 干净。

**FLIP 是用户的决策（Claude 不翻）：** 用户在 Cursor 真库环境设 `AGENT_EVAL_LIVE=1` + 真 LLM 跑实测，确认误分类率 ≤ 2% 后，单独 commit 将 `.env` 的 `JB_DETERMINISTIC_DISPATCH` 改为 `true`。

**文件清单（纯路由/eval 层，未碰 SQL/Dummy/响应形状）：**
`src/lib/agent/agentSemanticDispatchTable.ts`（新增）, `src/lib/agent/agentLoop.ts`（追加 `tryRunSemanticDispatchDirectRoute`）, `.env.example`（新增 flag 注释+默认），`test/eval/scenarios/routing-golden.ts`（57→85 条）, `test/eval/routingGoldenScore.ts`（新增 `scoreDispatchOnGolden`）, `test/agentEval.test.ts`（新增两个闸门）

---

## 2026-06-29 — 阶段一+二完收：单一语义决策 + 黄金集闸门（Tasks 1–7）

**阶段一：单一语义决策（Tasks 1–4）**
- `jbRouteResolver.ts`：`resolveJbRoute`（纯正则单一真相源）+ `classifyJbIntent`（可选 LLM 兜底，`JB_LLM_INTENT_CLASSIFIER` 默认 **off**）+ `isAmbiguous` 快路（有 lot 锚点跳过 LLM）
- `agentJbDeterministicReply.ts`：`extractJbIntentFlags` 集中三谓词（多卡对比/多lot/DUT bail）→ `JbRouteDecision` 三必填字段 `isMultiCardCompare/isMultiLotCompare/isDutLevel`
- `jbIntentClassifier.ts`：DI 可测分类器，失败安全降级 generic
- 三处 bail 收口到 `emitDeterministicJbTablesReply` 入口（多卡 + 多lot + DUT，各路由自动受护）

**阶段二：黄金集闸门（Tasks 5–7）**
- `test/eval/scenarios/routing-golden.ts`：57 条问句黄金集（覆盖 14 个 mode）
- `test/eval/routingGoldenScore.ts`：`scoreRegexOnGolden` 打分器 + `REGEX_BASELINE_PASS_QUESTIONS`（47 条，当前纯正则实际通过） + `scoreHybridOnGolden`（live LLM 对比器，开 flag 后跑全集）
- `test/agentEval.test.ts`：新增两个闸门测试 — 「纯正则 baseline 零回退」（CI 必跑）+ 「混合路由零 mode 回退」（`AGENT_EVAL_LIVE=1` 才跑）

**文件清单（纯路由/eval 层，未碰 SQL/Dummy/响应形状）：**
`src/lib/agent/jbRouteResolver.ts`, `jbIntentClassifier.ts`, `agentJbDeterministicReply.ts`（extractJbIntentFlags），`src/lib/agent/agentLoop.ts`（收口守卫）, `test/eval/routingGoldenScore.ts`, `test/eval/scenarios/routing-golden.ts`, `test/agentEval.test.ts`, `test/jbRouteResolver.test.ts`

**测试计数：** 全套 425 个测试，422 通过，0 失败，3 skip（含 live 闸门）；typecheck 干净；`JB_LLM_INTENT_CLASSIFIER` 默认仍 off；正则 baseline 47/57（10 条黄金集待 LLM 覆盖）

---

## 2026-06-29 — Task 2: JbRouteDecision 携带集中后的多卡/多lot/DUT flag

**完成内容：**
- `agentJbDeterministicReply.ts`：新增 `extractJbIntentFlags(q)` — 将三个 bail 谓词（`isMultiCardComparisonQuestion` / `isMultiLotComparisonQuestion` / `equipmentRouteDutLevelBail`）集中成单一**纯聚合**函数（三字段各自独立调谓词，不做仲裁）。已知点：多卡对比串会同时令 `isMultiLotCompare=true`（「对比」双命中），阶段二无害（消费侧多卡 bail 先短路），**留待阶段三 flag 驱动派发时引入明确优先级 + 测试**
- `jbRouteResolver.ts`：`JbRouteDecision` 接口新增三个必填字段 `isMultiCardCompare / isMultiLotCompare / isDutLevel`；import 加 `extractJbIntentFlags`；`resolveJbRoute` 返回体用 spread `...extractJbIntentFlags(q)` 填充
- `jbRouteResolver.ts`：`resolveJbRouteAsync` LLM 成功分支补 `isMultiCardCompare / isMultiLotCompare / isDutLevel` 透传（Task 3 正式重构前的最小 typecheck 修复）
- `test/jbRouteResolver.test.ts`：新增 TDD 测试「resolveJbRoute 决策携带集中后的三 flag」，先 RED（`undefined !== true`），再 GREEN（8/8 通过）

**测试：** 8 个测试，0 失败；typecheck 干净

---

## 2026-06-28（缺陷修复）— 五会话日志复盘:JB 聚合/列表确定性渲染 5 个真库缺陷

**背景：** 基于最新代码的 5 份 Agent 会话日志复盘,发现 5 个缺陷。systematic-debugging 逐个定位根因后修复;B1/B3/B4/B5 为确定性代码层(行为可测),B2 为 prompt 窄规则(LLM 指代消解,依赖遵守)。改动只在路由/渲染层,不碰 SQL/WHERE/响应形状,未触发 dummy-parity。

**完成内容：**
- **B1（S3-T2）`groupBy device,bin` 丢 device 列。** `buildAggregateBinRankingMarkdown` 只在含 `lot` 时 bail、含 `device` 时不 bail → 跨 device 求和丢列。新增 `buildBinDeviceAggregateMarkdown`（镜像 bin×card 渲染器,focusBin/全表两态）+ 纯 BIN 排行加 device bail + agentLoop 两处 dispatch 在 binRank 前插入。
- **B4（S4-T4/T5）多 lot 卡/dut 问题只出单 lot + 0.0s 缓存重放残缺。** ① summary 路径 `turnLots>1 且本句未点名具体 lot`（指代/复数）→ bail 回 LLM 用全部 lot 历史作答（原仅 `isMultiLotComparisonQuestion` 触发,漏「把对应的卡和dut都列出来」）；② equipment 直连新增 `equipmentRouteDutLevelBail`——问到 DUT 时缓存表只有卡+机台、无 DUT,bail 回 LLM 调 `query_lot_dut_bin_agg`。
- **B5（S5-T1）cardId lot 列表丢 JB lot。** cardId 仅命中 1 个 JB lot 时 `multiLotListingFields` 仅在 `distinctLotCount>1` 保留 `recentLotsByTestEnd` → 该字段不进会话缓存,列表只剩 YM 告警 lot。`buildRecentLotsListingMarkdown` 用 payload 主 `lot` 兜底补一行 JB STAR（slotCount 取 yieldByPassId 最大）。
- **B3（S4-T3）点名多个 lot 未被过滤。** 用户点名 4 个 lot 问「有测出 binXX 吗」,`buildBinFocusedLotRankingMarkdown` 仍出全局排行。新增 `extractLotsFromUserText`(复数,复用同一 lot 正则);该渲染器加 `restrictLots`——≥2 个点名 lot 时仅保留这些 lot,对缺失者显式补 0 行（直接回答「有没有测出」）。两处 dispatch 传入。
- **B2（S3-T4）「这个lot」单数指代未锁定 lot。** 模型把「这个lot 主要 failed bin」按整个 device 聚合。`agentPrompt.ts` 加窄规则:「这个 lot/该批次/此 lot」指代上一轮最近 lot,对该具体 lot `aggregate_jb_bins(lot, groupBy:"bin")` 或读 `topBadBins`,禁用 device 维度。

**B-core 结构收敛（拔「打地鼠」根,非仅按住）：** 用户点破 B1/B3/B4 是"同一毛病多处各补一次"的打地鼠结构后,做结构收敛:
- **抽单一渲染真相源 `renderAggregateJbBinsResult`**:此前「binLot→multiLot→binCard→binDevice→binRank」选择链被复制在 `tryRunDeterministicJbSummary`(emit SSE)与 `jbBinsYieldFallbackMessage`(返字符串)两处,B1/B3 都要改两遍。收敛为一处,两站点各按返回值(`table/commentaryNote/statusMessage/withDataTitle`)做自己的输出。新增渲染分支只改一个函数。
- **多 lot 拦截收口到 chokepoint**:把「本轮查多 lot 但单 lot 表答非所问」的 bail 从 summary 路径移入 `emitDeterministicJbTablesReply` 入口(与已有多卡 bail 同处);走该收口点的工具后路由自动受护。(DUT bail 仍留 equipment 路由——其语义是"该路由缓存无 DUT",非通用,不能上提。)
- 加 `renderAggregateJbBinsResult` 单测钉死各 groupBy 形状的渲染器选择。

**测试：** 418 个测试,0 失败（新增 8 条回归:B1×4 / B5×1 / B3×1 / B4×1 / B-core×1）；typecheck 干净；eval 37/37。

---

## 2026-06-28（架构）— JB 路由收敛 resolveJbRoute + 混合(正则快路/LLM 兜底)

**目标：** 彻底治理 JB 确定性表路由的「打地鼠」结构（三套重叠正则 + 顺序敏感调度 + 一轮重算意图 3+ 次）。spec `docs/superpowers/specs/2026-06-28-jb-route-resolver-design.md`、plan `docs/superpowers/plans/2026-06-28-jb-route-resolver.md`，subagent-driven 执行。

**完成内容（绞杀者分阶段）：**
- **阶段 0/1：单一真相源。** 新增 `jbRouteResolver.ts`：`JbRouteDecision` + 集中 params 抽取 + `resolveJbRoute`（纯正则,委托 `detectJbReplyMode`,parity 锁等价）。收口点 `emitDeterministicJbTablesReply` 改为一次 `resolveJbRoute` 并透传 `decision.mode`,消除两处重算。`buildDeterministicJbTables` 加 `modeOverride`。
- **阶段 1b / 范围 B：声明式调度。** agentLoop 5 条 pre-LLM 直连 → `PRE_LLM_DIRECT_ROUTES` 有序数组循环（各 runner self-gate,逐字节等价）。注:probe 证实 `detectJbReplyMode` mode 与 `canRunXxx` 门槛非 1:1,故未按 mode 建表,改有序 runner 列表（用户裁定方案 A）。
- **阶段 2：LLM 兜底（默认关）。** 新增 `jbIntentClassifier.ts`（DI 可测,失败返 null）；`resolveJbRouteAsync` 在 `JB_LLM_INTENT_CLASSIFIER=true` 且问句模糊(generic+无 lot 锚点)时调便宜模型分类,失败安全降级回 generic；收口点接 async。开关关 = 与今天逐字节等价。
- **阶段 3：灰度。** routing eval 加历史痛点回归锁(多卡/equipment/lot列表/per-slot) + `live:true` 兜底场景(默认 skip)；`NEXT_STEPS_FOR_CURSOR` 加灰度复验清单。

**关键修正（评审发现）：** 阶段 1 收口点守卫一度误用 `decision.mode === "generic"`（会 bail 非多卡 generic,回归),改回仅 `isMultiCardComparisonQuestion`。

**测试：** 408 通过 / 2 跳过 / 0 失败；typecheck 干净；eval 37/37（routing 11/11）。纯路由层,不触发 dummy-parity。每任务独立提交 + 两段式评审。

---

## 2026-06-28（重构）— 多卡对比 bail 收口到单一守卫点

**背景：** P-C 之前修了三次（`detectJbReplyMode`→generic、`tryRunEquipmentDirectRoute` bail、`tryRunDeterministicJbSummary` summary bail），每次都因「同一意图、另一条路绕过」而补一处 bail。这是脆弱的「打地鼠」结构——下一条直连路由仍可能漏护。

**改动：** 把多卡对比 bail **收口到 `emitDeterministicJbTablesReply` 入口**（`agentLoop.ts`）。该函数是所有「单 lot/卡确定性表」的**唯一出口**（6 处调用全是 `return emitDeterministicJbTablesReply(...)`：equipment 直连、summary 轮、lot 概况/列表/逐片排名 直连）。在入口处 `if (isMultiCardComparisonQuestion) return false`，各调用方按既有逻辑放行给 LLM 做跨卡综述。

- 删除 `tryRunEquipmentDirectRoute` 内联多卡 bail（原 `[equipmentRoute/skip:multiCardCompare]`）。
- 删除 `tryRunDeterministicJbSummary` 内联多卡 bail。
- 统一日志 tag `[jbDeterministic/multiCardCompareBail]`。
- **新增任何走 `emitDeterministicJbTablesReply` 的直连路由自动受保护**，不必再各自补 bail。

**保留不动：** `detectJbReplyMode`→generic（纯分类，单测依赖，非调度顺序脆弱项）；summary 轮 `aggregate_jb_bins` 跨卡聚合分支（产出本就是跨卡表，非单 lot 误答，原 bail 也未护，无回归）。

**测试：** 398 个，396 通过、2 跳过、0 失败；typecheck 通过。行为等价重构，不影响现有回复质量。

---

## 2026-06-28（Cursor 终验 + P-C summary bail）— 5/5 严格复验闭环

**背景：** API 余额恢复 + 远程 dist reload 后，Cursor 跑 `verify-handoff-steps.mjs all`：P-A/B/D/F ✅；P-C 首轮仍 FAIL（单 lot equipment 表），重跑 `pc` ✅。

**P-C 真因 2（Cursor）：** `1b6c9cb` 只拦了 `tryRunEquipmentDirectRoute`；**summary 轮** `tryRunDeterministicJbSummary` 仍用单 lot `query_jb_bins` 缓存吐 equipment 表 → 加 `[jbDeterministic/multiCardCompareBail]`（与 `multiLotBail` 同级）。

**验证：** 远程 10.192.130.89 严格复验 5/5；脚本收紧（P-A `totalDistinct>0`、P-C ≥2 卡、P-F 场景）。完整交接：[`HANDOFF_CURSOR_VERIFICATION_RESULTS_2026-06-27.md`](HANDOFF_CURSOR_VERIFICATION_RESULTS_2026-06-27.md)、[`scratchpad/reverify-2026-06-27.txt`](../scratchpad/reverify-2026-06-27.txt)。

---

## 2026-06-27（第三轮·P-C 真因）— equipment 直连路由缺多卡对比 bail

**背景：** Cursor 真库 curl 验证（见 [`HANDOFF_CURSOR_VERIFICATION_RESULTS_2026-06-27.md`](HANDOFF_CURSOR_VERIFICATION_RESULTS_2026-06-27.md) §3.2）发现 P-C「把这4张probecard的测试情况做对比」**远程 SSE 严格 FAIL**——仍 0.0s 秒回单 lot DR44436.1W 卡表（仅 9416-03）。

**真因（Claude Code 复审定位）：** 我上一轮的 P-C 修复只动了 `detectJbReplyMode`（在 `buildDeterministicJbTables` / 总结轮 `tryRunDeterministicJbSummary` 路径）。但 **`agentLoop.ts` 的 `tryRunEquipmentDirectRoute`（LLM 调用前的直连路由，0.0s 秒回的来源）在它之前就截胡了**——该路由只判 `isProbeCardQuestion` / `isTesterMachineQuestion`，有 binOnCard / crossLot / staleCache 三个 bail，**独缺多卡对比 bail**。「4张probecard」命中 `isProbeCardQuestion` → 直连吐单 lot 缓存 equipment 表，**绕过了 detectJbReplyMode**。即使部署 `ce96b91` 也仍会 FAIL。

**修复：** `tryRunEquipmentDirectRoute` 加 `isMultiCardComparisonQuestion` bail（`[equipmentRoute/skip:multiCardCompare]` 日志 + return false），与 detectJbReplyMode 的 generic bail 共用同一检测函数。多卡对比不再走单批缓存直连，交回 LLM 做跨卡综述。

**测试：** 398 个，396 通过、2 跳过、0 失败；typecheck 通过。`isMultiCardComparisonQuestion` 单测已覆盖检测；该函数现被 detectJbReplyMode + equipment 直连两处共用。**待部署后真库 curl 复验 P-C。**

---

## 2026-06-27（Cursor 闭环）— P-A 探针定位 Oracle 空串陷阱 + P-B/C/D 真库 curl + P-F 实现

**完整验证记录（给 Claude Code）：** [`HANDOFF_CURSOR_VERIFICATION_RESULTS_2026-06-27.md`](HANDOFF_CURSOR_VERIFICATION_RESULTS_2026-06-27.md)

**P-A（已修 + 本地真库探针通过）：** `TRIM(col)!=''` 在 Oracle 恒 unknown → 新增 `oracleStringSql.ts` / 替换 `agentFilterValuesTool.ts` 6 处（含 Claude 补修的 probeCardType 2 处）。探针 `yield/full` P11C=3、N55Z=6；`jb/full` P11C=1、N55Z=2。**远程 10.192.130.89 SSE 仍见 `get_filter_values` 空 JSON** → 需 `npm run build && pm2 reload` 部署 `0177538`+`53bfb97` 后复验。

**P-B/C/D 真库 curl（`scripts/verify-handoff-steps.mjs`）：** P-B lot 列表 ✅；P-D bin+lot 排行 ✅；P-C 仍秒回单 lot 卡表（脚本误判 PASS，严格 ❌）→ 待部署 `ce96b91` 或再查 deterministic 劫持。

**P-F（已实现 · 本 commit）：** `lotDutConcentrationOpts` 传 `focusBins` + `goodBins`；单测 ✅；远程 curl 待 deploy 后复验。398 测试 396 通过。

---

**背景：** 上一轮修复 **部署后**（用户已 `npm run build`）的 6 个真库会话日志（`Desktop/New folder (3)`）。P2 链路 / BIN×卡归因 / 卡型综述已确认生效。本轮修剩余问题。

**完成内容：**
- **P-B** `agentJbDeterministicReply.ts` `isLotListingQuestion`：补「(都)测试了什么lot / 测了哪些lot / 都有什么批次 / 跑了多少个lot」口语（`什么|哪些|多少` + `lot|批次`，排除 wafer/片/slot）。修掉「都测试了什么lot」第一次被判 `lot_overview` 答成单 lot 详情（要追问第二次才出 lot 列表）。
- **P-C** 新增 `isMultiCardComparisonQuestion`（多张卡「测试情况对比」泛问：`≥2 完整卡号` 或 `这4张/几张/这些卡` + 对比/概况词；≥2 卡号时免「卡」字且优先于 lot 排除，因卡号 `9416-01` 会被 `extractLotFromUserText` 误当 lot）；`detectJbReplyMode` 在 `isProbeCardQuestion`→equipment **之前** bail 回 `generic`。修掉「把这4张probecard的测试情况做对比」被单 lot equipment 卡表劫持（0.0s 秒回答非所问）。「哪张卡良率更差」仍走 `card_yield_compare`。
- **P-D** 平台级纯 BIN 排行无定位价值（「uflex 最近三天」跨 54 lot 只出 bin 总排行）：`buildAggregateBinRankingMarkdown` 加引导脚注「如需定位批次请问『哪个 lot 的 BIN<n> 最多』」；`agentPrompt.ts` 平台专节补「某 BIN 集中在哪个 lot → `aggregate_jb_bins(groupBy:"bin,lot")`，纯 `groupBy:"bin"` 是全平台合计无法定位批次」。
- **P-E** `agentPrompt.ts`：加「device 必须按本轮问题重新解析，禁止沿用上一轮其它产品的 device」（修 N94W 会话误用上一轮 N48A device 的 stray 调用；输出仍正确，低优先）。
- **P-A 翻案（重要）：** `get_filter_values` device-by-mask **真库恒空**，但**同会话同 mask** 的 `query_yield_triggers`/`query_jb_bins` **有数据**（WB01P11C / WC13N55Z / WA88888811N48A / WK71N94W）。**已 build 仍空 → 否定上一轮「旧 dist/部署」结论**。两路径用同一 `deviceMaskOracleWhere`（含 `LIKE '%mask%'` 必命中），且 filter 范围更宽（无时间窗、JB 无 PASSTYPE），逻辑上**不该空**；`FETCH FIRST` 语法也被 query 同样使用且能跑 → 排除。**纯读代码无法解释，需服务器 pm2 日志 `[agentSql/filterValues:yieldDeviceByMask]` + `:result`（binds.mask / rowCount / 有无 ORA 错误）定位**；最可能：真库 `TYPE` 裸值 ≠ `'DELTA_DIFF'`（yield 侧）或异常被 catch 吞成空。详见交接文档。
- **P-F（留交接）：** `query_lot_dut_bin_agg` 把 good bin（BIN1/BIN55）混进「坏die DUT集中度」表、「总坏die」列实为 good die 数；且 `focusBin:79` 仍混出 BIN55（focusBin 未严格生效）。涉 `buildDutConcentrationInsights` good-bin 集合来源 + handler focusBin 传递，无 dummy 易验证，留 Cursor。
- 新增交接文档 `docs/HANDOFF_AGENT_ISSUES_2026-06-27_ROUND2.md`（P-A~P-F 可执行排查/修复清单 + pm2 抓日志步骤 + 真库二分法）。
- 测试：`agentJbDeterministicReply.test.ts` 新增 P-B（4 lot 列表口语 + 单 lot 概况/wafer 枚举反例）、P-C（3 多卡对比 → generic + 单卡/单 lot 反例仍 equipment）。

**测试：** 396 个测试，394 通过、2 跳过（既有）、0 失败；`tsc --noEmit` 通过。

> 修正上一轮日志结论：P1/P6（get_filter_values 空）**不是部署问题**——已 build 仍空，是代码/数据层面问题，待 pm2 SQL 日志定位（见本轮 P-A）。

---

## 2026-06-27 — FW_ 五会话精修：bin 特定 lot 排行 + 卡型/单片 bail + DUT 路由 + dummy-parity 展平

**完成内容：**
- `agentJbDeterministicReply.ts`：新增 `buildBinFocusedLotRankingMarkdown`——「哪个 lot BINnn 最多」按**指定 bin** 在各 lot 的坏 die 颗数排序（含探针卡列），修掉 `buildMultiLotBinTable` 按**坏 die 总量**排序把该 bin 少但总量大的 lot 误排第一（真实会话 N55Z：bin35=968 的 DR41662 错排在 bin35=1402 的 DR42190 之前）；`agentLoop.ts` 总结轮主聚合分支 + fallback 分支均在 `buildMultiLotBinTable` 之前接入（gate=`extractBinFromUserText` 有值）
- `agentJbDeterministicReply.ts`：新增 `isCardTypeLevelOverviewQuestion`（4 位卡型 + 「卡/型号」+ 概况词，排除具体卡号 `dddd-dd`/具体 lot）；`buildDeterministicJbTables` lot_overview 分支命中即 `[jbDeterministic/cardTypeOverviewBail]` 日志 + 返回 null，交回 LLM 跨 lot 结合 YM 聚合作答，修掉「9416 卡的测试情况」被渲染成最新单 lot 概况；`agentLoop.ts` fallback 分支同步 bail
- `agentJbDeterministicReply.ts`：新增 `isSingleWaferDieClusterQuestion`（「这片/该片 wafer」+「聚集/集中分布」，排除给了具体片号者）；`agentLoop.ts` `tryRunDeterministicJbSummary` + fallback 在 query_jb_bins 单片空间聚集问题时 `[jbDeterministic/singleWaferClusterBail]` 日志 + bail，修掉整 lot BIN 趋势警示表"套话"劫持；`agentPrompt.ts` 改为「device+lot+slot 已知时直接 `inf_cluster_detect`，勿先 `query_jb_bins`」
- `agentPrompt.ts`：DUT×BIN 路由行强化「是否聚集到某个 DUT / BINxx 是否集中在某 DUT」追问 → `query_lot_dut_bin_agg(device, focusBin)`，明确禁止用 `aggregate_jb_bins(groupBy:"bin,lot")` 代答（lot 维度答不了哪个 DUT）
- `agentToolHandlers.ts`（**dummy-parity 真 bug**）：`aggregate_jb_bins` / `aggregate_yield_triggers` 的 **dummy 分支**原返回嵌套组 `{key, parts:{bin,lot}, count}`，而 **Oracle 分支**返回展平 `{bin, lot, count}`——所有确定性渲染器读 `g["bin"]`/`g["lot"]` 在 dummy 下恒空、与生产分叉（即 P2 链路 dummy 下不渲染的根因）。已将 dummy 组展平 `{...g.parts, count: g.count}` 与 Oracle 对齐
- P1/P6（get_filter_values 返回空）：用 docs 两个 xlsx（=Oracle 结构）实跑 device-by-mask（N57U/P55A）与 probeCardType→卡号（8003/8041）枚举**全部正常**，逻辑无误 → 真库返空属部署（旧 dist 未 reload）/数据格式问题，看 `filterValues:*DeviceByMask:result` 的 rowCount/sampleDevices 与 SQL 日志定位
- 新增验证文档 `docs/AGENT_FIX_VERIFICATION_2026-06-27.md`（P1–P7 验证问答 + dummy 等价对象 + 实测结果）
- 测试：`agentJbDeterministicReply.test.ts`（+`buildBinFocusedLotRankingMarkdown` 3 例、`isSingleWaferDieClusterQuestion`、`isCardTypeLevelOverviewQuestion`）、`agentFilterValues.test.ts`（P1/P6 会话形状 3 例）、`agentAggregateGuard.test.ts`（dummy-parity 展平 2 例）；live DeepSeek-V4-Pro + dummy 实测 P2 链路、P5 跨卡型综述通过

**测试：** 394 个测试，392 通过、2 跳过（既有）、0 失败；`tsc --noEmit` 通过

---

## 2026-06-27 — 续评审修复：mask 级概况/卡归属误答 + bin×card 聚合渲染 + 多 lot 对比 bail

**完成内容：**
- `agentJbDeterministicReply.ts`：新增 `isMaskLevelQuestionOnMultiLotPayload`——句中无具体 lot 但有 mask/device 且 payload 多 lot 时为真。`buildDeterministicJbTables` 的 **lot_overview 分支**命中即改出 `buildRecentLotsListingMarkdown`（多 lot 列表），修掉「P11C 最近一个月测试情况」被渲染成最新单 lot（TR23373.1T）概况；**bin_card_attribution 分支**命中即 `[jbDeterministic/binCardMaskScope]` 日志 + 返回 null，不再用单 lot `slotBadBinsCompact` 代答 mask 级「BINxx 集中在哪张卡」
- `agentJbDeterministicReply.ts`：新增 `buildBinCardAggregateMarkdown`——`aggregate_jb_bins(groupBy:"bin,cardId")` 渲染卡归属（focusBin 有值出「BINxx 各卡排行」，无值出「坏 BIN×探针卡」全表），修掉 `buildAggregateBinRankingMarkdown` 只取 bin+count、丢掉 cardId 渲染成重复 BIN 行的问题；`agentLoop.ts` 总结轮主聚合分支 + fallback 分支均在 bin-only 排行前接入
- `agentJbDeterministicReply.ts`：新增 `isMultiLotComparisonQuestion`（「前5个lot都用什么卡」「这几个lot各自…」）；`agentLoop.ts` `tryRunDeterministicJbSummary` 本轮查 >1 lot 且命中该问法时 `[jbDeterministic/multiLotBail]` 日志 + bail，交回 LLM 用全部 lot 历史作答，修掉「问 5 个 lot 的卡、只答最后 1 个 lot 概况」答非所问
- `agentFilterValuesTool.ts`：device-by-mask 的 `:result` SQL 日志增加 `sampleDevices`（返回前 5 个 device），便于真库判断 get_filter_values(device,mask) 空结果是 SQL 返 0（数据/mask 格式）还是下游丢弃；确认顶层 `mask` 入参已被 `resolveDeviceMaskArg` 正确解析
- 测试：`agentJbDeterministicReply.test.ts` 新增 7 例（mask 级概况→列表、bin_card mask bail、各回归保护、`buildBinCardAggregateMarkdown` focusBin/全表/无 cardId、`isMultiLotComparisonQuestion`）

**测试：** 384 个测试，382 通过、2 跳过（既有）、0 失败；`tsc --noEmit` 通过

---

## 2026-06-27 — JB 漏斗多选：lot 及以后级别支持多选 + MASK label 修正

**完成内容：**
- `InfcontrolReport.tsx`：`FunnelChainStep.value` 改为 `string | string[]`；新增 `stepValues` / `stepDisplayValue` 辅助函数；`funnelFilter` 改用 `vals.some(...)` 支持多值 OR 过滤
- `InfcontrolReport.tsx`：新增 `FUNNEL_MULTI_SELECT_FROM = 2`（lot 及以后）；`FunnelDrillSection` 加 `pendingValues` 状态与 `useEffect` 重置（chain.length 变化即清空）；`handleBarClick` 在多选级别改为切换选中/取消；`handleConfirmMultiSelect` 确认后写入 chain 并推进；图表 bar 用 `opacity` 高亮已选（未选变暗 0.18）
- `InfcontrolReport.tsx`：父组件 `funnelLotVal` 返回 `string | string[]`；新增 `funnelLotKey`（join 字符串用于 effect 依赖）；多 lot 并行拉取数据（`Promise.all` 每 lot 单独请求后 `flat` 合并）；DUT 面板 `dutLot` 支持多 lot join 显示
- `index.css`：新增 `.funnel-confirm-btn`（绿色边框/文字，hover 加背景）
- `InfcontrolReport.tsx`：JB STAR 查询条件 MASK 字段 label 由 "Mask" 改为 "MASK(后4位)"，与字段含义对齐

**测试：** tsc --noEmit 通过，无类型错误

---

## 2026-06-27 — 三段会话评审修复：get_filter_values 空结果 hint + 缓存 scope 校验 + SQL 调试日志

**完成内容：**
- `agentFilterValuesTool.ts`：新增 `enrichEmptyCardEnumResult`——`cardId`/`probeCard` 按 `probeCardType` 过滤返回空时，结果内附 hint（索引未命中≠型号无记录，改用已知卡号直查或 `aggregate_jb_bins(groupBy:"bin,cardId")` 枚举），挂到 yield/jb 两出口；防止模型据空断言「型号无记录/无法对比」并臆造卡号
- `agentJbBinFormat.ts`：`formatJbRowsForAgent` 前 `warnSuspectGoodBins`——对被标 `isGoodBin` 却累计大量 die（≥300，排除 BIN1）的 bin 打 `[jbGoodBin/suspect]`（暴露 BIN152 类 PASSBIN/分类与良率口径不一致）；多 lot 范围（`multiLotYieldScope`）结果新增 `_multiLotYieldScopeGuide`，明示 topBadBins/cardByPassId 仅代表单 lot，「BIN 集中在哪张卡」须用 `aggregate_jb_bins(groupBy:"bin,cardId")`
- `agentLoop.ts`：`tryRunEquipmentDirectRoute` 加三道守卫——`isBinCardAttributionQuestion`（BIN-on-card 走聚合）、`equipmentRouteCrossLotBail`（跨多 lot 分析不用单批缓存）、`cachedJbScopeMismatchReason`（问题 mask/lot 与缓存 device/lot 不一致则拒绝吐缓存），修掉「N55Z 问题被上一题 P11C 缓存张冠李戴」的 0.0s 空转；`buildMultiLotBinTable` 加坏 die 总量日志 + 排序口径脚注（坏 die 绝对量≠良率最低）；`emitDeterministicJbTablesReply` 加 `[jbDeterministic/staleMaskCache]` 残缺缓存诊断；`collectQueryJbBinsLotsThisTurn` 多 lot 单卡回复诊断
- `agentSqlDebugLog.ts`（新文件）：`logAgentSql(tag, sql, binds, extra)` 把实际 SQL+binds+行数打到 stderr（`AGENT_SQL_DEBUG=false` 可关）；接入 `query_jb_bins` / `aggregate_jb_bins`（`agentToolHandlers.ts`）与 `get_filter_values` 的 device-by-mask、字段枚举两条路径（`agentFilterValuesTool.ts`），便于把语句贴去真库定位「实查有数据但聚合/枚举为空」
- 测试：`agentFilterValues.test.ts`（空结果 hint）、`agentJbBinFormat.test.ts`（多 lot scope guide）、`agentLoop.test.ts`（缓存 scope 不一致 / 跨 lot bail，4 例）

**测试：** 376 个测试，0 失败

---

## 2026-06-26 — Task 5 审查修复：focusBins 无命中不回退全量 + 测试走聚焦路径

**完成内容：**
- `agentToolHandlers.ts` `attachDutConcentrationToJbPayload`：删除「focusBins 非空但 INF 无命中 → 回退全量集中度表」分支（语义错误，会用无关 bin 误导卡 vs 工艺判断）；改为 `insights.length === 0` 直接 return 不出表；删重复 JSDoc
- `test/agentDutBinAggInsight.test.ts`：`clustered alerts cause DUT concentration to be attached` 的 clusteredBadBinAlerts bin 由 11（fixture 无）改为 98（真实存在/集中型），新增非空断言，测真正的聚焦路径

**测试：** 366 个测试，0 失败

---

## 2026-06-26 — Task 5: 可疑坏 bin 自动附 DUT 集中度判别 + prompt 专节

**完成内容：**
- `agentToolHandlers.ts`：新增并导出 `attachDutConcentrationToJbPayload(payload, userText)`——调 `shouldRunDutAnalysis` 判断是否触发，取 `clusteredBadBinAlerts[].bin` 为 focusBins，复用 Task 4 byDirectory 取数路径拉 `SiteBinPass[]`，`formatDutConcentrationMarkdown` 结果写入 `payload["dutConcentrationMarkdown"]`，INF 失败静默跳过；在 `toolQueryJbBins` dummy/Oracle 两条路 `onJbBinsWrapped` 后各加 `await attachDutConcentrationToJbPayload(wrapped, options?.userText ?? "")`；`RunToolOptions` 新增 `userText?: string` 字段；import `shouldRunDutAnalysis`
- `agentJbDeterministicReply.ts`：`formatAlertsAndPatternsSection` 在 `clusteredBadBinAlertsMarkdown` 之后、`detectAndFormatDataPatterns` 之前，追加 `dutConcentrationMarkdown` 块（若非空字符串）——自动出现在「警示 / 规律识别」节内
- `agentPrompt.ts`：在「### 联合诊断 3 步流程」之后新增「### DUT 集中度：卡 vs 工艺判别」专节——规定工具结果含集中度表时须据此点明各可疑 BIN 判别方向，禁止自估数字
- `test/agentDutBinAggInsight.test.ts`：追加 3 条 Task 5 测试——`clustered alerts cause DUT concentration to be attached`、无警示时不注入、缺 device 时不注入

**测试：** 366 个测试，0 失败

---

## 2026-06-26 — Task 4: query_lot_dut_bin_agg 结果附 DUT 集中度判别表

**完成内容：**
- `agentToolHandlers.ts`：import `buildDutConcentrationInsights` / `formatDutConcentrationMarkdown`；`toolQueryLotDutBinAgg` 4 个返回点（probeCardType/无 × dummy/真库）均在 `compactSiteBinPasses` 前用原始 `SiteBinPass[]` 计算集中度，将 markdown 表前置到 JSON 结果之前（`dutMd ? dutMd + "\n\n" : ""`），不影响 maxChars 截断逻辑
- `test/agentDutBinAggInsight.test.ts`（新增）：3 条断言——结果类型、不含内部字段名（cardByPassId/topShare/DutConcentrationInsight）、dummy lot DR43782.1A 判别表前置于 JSON（含「疑」字且位置在 JSON 之前）
- Dummy lot 实测：同时产出「疑工艺/批次」（BIN55/2/3 等分散型）和「疑探针卡」（BIN98/5/10 等集中型）

**测试：** 365 个测试，363 通过，0 失败，2 跳过

---

## 2026-06-12 — Agent 质量改进：6 项修复（截断标记 / 空结果回退 / lot 参数名 / 机台重试 / generate_chart / aggregate_jb_bins）

**完成内容：**
- `agentToolHandlers.ts` `truncateResult`：截断后缀改为明确标注省略字符数和完整字符数，并提示"以上为不完整数据，勿假设省略部分内容"
- `agentPrompt.ts` `SEC_DATA_RULES`：新增「通用查询返回空时的回退策略」子节（检查格式→扩大时间→换域→ask_clarification，四步禁直接报错）
- `agentPrompt.ts` `SEC_LOT_ID`：新增 `query_yield_triggers` 用 `lotId`、`query_jb_bins`/`aggregate_jb_bins` 用 `lot` 的参数名区分提示
- `agentPrompt.ts` 机台名称规则：步骤5 由"尝试更短子串"改为**必须立即重试**，新增步骤6（两次均空才 ask_clarification）
- `agentToolSchemas.ts` `generate_chart`：新增"调用前必须已有真实数值，禁止传空数组或占位符"
- `agentToolSchemas.ts` `aggregate_jb_bins`：新增"若用户未给出任何范围条件，必须先 ask_clarification 询问再调用"

**测试：** typecheck 通过，无运行时变更

---

## 2026-06-12 — 机台名标准化规则扩充：补充 J750/MST/UFLEX 系列及台号推导示例

**完成内容：**
- `agentPrompt.ts` `SEC_DATA_RULES` 机台名标准化：列出所有系列（PS16、UFLEX、FLEX、J750、MST、93K）及对应搜索关键词推导规则；新增 J750/MST 台号格式示例（不确定零填充时先用系列名搜索，查看实际格式后再精确匹配）

**测试：** typecheck 通过

---

## 2026-06-12 — get_filter_values 加 search 模糊查询 + 修 TESTERID 列错误 + 机台名标准化规则

**完成内容：**
- `agentFilterValuesTool.ts` `countDistinct`：新增 `search` 可选参数，做大小写不敏感的包含过滤（Dummy 路径）
- `agentFilterValuesTool.ts` Oracle yield/jb：新增 `filterBy.search` → `UPPER(...) LIKE '%'||UPPER(:search)||'%'` 条件，支持 hostname/testerId/probeCard/lot/cardId 等字段的模糊匹配
- `agentFilterValuesTool.ts` `oracleJb`：修复 `t1.TESTERID` → `t2.TESTERID`（TESTERID 在 INFLAYERBINLIST，不在 INFCONTROL），消除之前触发的 `ORA-00904` 错误
- `agentToolSchemas.ts`：`filterBy` 新增 `search` 字段文档
- `agentPrompt.ts` `SEC_DATA_RULES`：新增「机台名称标准化」硬规则——禁止直接用用户原始机台描述作参数，先调 `get_filter_values(field:"hostname"/"testerId", filterBy:{search:关键词})` 获取实际 ID，再查询

**测试：** 267 个测试，264 通过，1 失败（OCI 库环境限制），2 跳过

---

## 2026-06-12 — mask 提取规则修正：首个 - 或 _ 之前的基础段后 4 位

**完成内容：**
- `agentFilterValuesTool.ts` `deviceMask()`：新增辅助函数，先截取 device 中首个 `-`/`_` 之前的基础段，再取末 4 位；Dummy 路径改用此函数替代 `.slice(-4)`
- `agentFilterValuesTool.ts` Oracle SQL（yield/jb）：`SUBSTR(TRIM(DEVICE),-4)` 改为 `SUBSTR(REGEXP_SUBSTR(TRIM(DEVICE),'^[^-_]+'),-4)`，与 Dummy 逻辑一致
- `agentPrompt.ts` SEC_MASK：更新 mask 定义，新增带 `-`/`_` 的示例（WC21P51A-V2 → P51A、WA13N06Z_R1 → N06Z）

**测试：** 267 个测试，264 通过，1 失败（OCI 库环境限制，无关本次改动），2 跳过

---

## 2026-06-12 — get_filter_values 支持 field=device 按 mask 从 Oracle 查最新 device 代码

**完成内容：**
- `agentFilterValuesTool.ts`：新增 `field:"device"` + `filterBy:{mask:"N06Z"}` 支持，两域（yield/jb）均实现 Oracle 路径和 Dummy 路径
  - Oracle yield 路径：`YMWEB_YIELDMONITORTRIGGER` 按 `SUBSTR(DEVICE,-4)=mask` 过滤，`GROUP BY DEVICE ORDER BY MAX(TESTEND) DESC`
  - Oracle JB 路径：`INFCONTROL⋈INFLAYERBINLIST` 同逻辑，TESTEND 在 INFLAYERBINLIST 表
  - Dummy 路径：yield 用 `TIME_STAMP`，JB 用 `TESTEND`，同样按最新日期排序
  - 返回格式：`"WC21N06Z (最近: 2026-06-01)"` 方便 agent 直接取用 device 代码
- `agentToolSchemas.ts`：更新 `get_filter_values` schema，补充 `field:"device"` 和 `filterBy.mask` 文档
- `agentPrompt.ts` `SEC_MASK` 情况B：改为先调 `get_filter_values(field:"device", filterBy:{mask})` 查真实 device 代码，取代之前的前缀猜测策略

**测试：** 267 个测试，264 通过，1 失败（OCI 库环境限制，无关本次改动），2 跳过

---

## 2026-06-12 — generate_chart 崩溃修复 + mask 查询策略改进

**完成内容：**
- `agentChartTool.ts` `normalizeGenerateChartArgs`：新增解包 `{"arguments":"...JSON..."}` 单键包装。DeepSeek-V4-Flash 有时以 GLM 风格把完整 args 作为字符串放在 `arguments` 键下，导致 `data`/`labels` 为 undefined，错误走入 history 推断路径
- `agentChartTool.ts` `chartDataFromRecord`：改为返回全部 series（原仅取第一条），支持多组对比柱状图
- `agentChartTool.ts` `buildDutShareChartData`：新增对 compact 格式 `_duts` 字段及无 duts good bin 的防护，消除 `binEntry.duts is not iterable` crash（来源：当 generate_chart args 未被正确解析时，history 推断路径取 compact INF 结果并访问 `.duts`）
- `agentPrompt.ts` `SEC_MASK` 情况 B：明确 `get_filter_values` 不支持 device 字段；改为依次尝试 WC/WA/WB/WD 常见前缀查询，全部返回空才用 `ask_clarification` 反问

**测试：** 267 个测试，264 通过，1 失败（OCI 库环境限制，与本次改动无关），2 跳过

---

## 2026-06-11 — Agent 页面 query_jb_bins 按钮点击导致页面变空（闭包 Bug）修复

**完成内容：**
- `AiAgentReport.tsx` 渲染循环 orphan tool 分支：`onClick={() => toggleTool(i)}` 中 `i` 为 `while` 循环外层变量，被闭包按引用捕获，循环结束后 `i === messages.length`，点击时 `copy[messages.length]` 为 `undefined`，`m.kind` 抛 `TypeError`，React 无 error boundary → 页面变空白。修复：在分支入口加 `const toolIdx = i`，用值快照替代引用捕获，`onClick` 改为 `toggleTool(toolIdx)`，`key` 同步替换

**测试：** tsc --noEmit 通过，无运行时测试（纯前端逻辑修复）

---

## 2026-06-11 — Agent 页面链接点击导致页面变空修复

**完成内容：**
- `AiAgentReport.tsx` `makeAgentMarkdownComponents`：所有 `<a>` 加 `onClick` — `e.preventDefault()` + `window.open(..., "_blank", "noopener,noreferrer")`，彻底阻断浏览器弹窗拦截退化成当前页跳转（原仅靠 `target="_blank"`）；`href` 为空时渲染 `<span>` 防止空链接点击
- `AiAgentReport.tsx` `downloadMarkdown`：`a` 元素改为 `appendChild` → `click` → `removeChild` + `setTimeout(() => revokeObjectURL, 100ms)`，修复部分浏览器 detached 元素 click 不触发下载的问题

**测试：** tsc --noEmit 通过，无运行时测试（纯前端交互改动）

---

## 2026-06-09 — JB 明细表 TESTEND 转 CST + 删除 PROBECARDTYPE + DataTable 列排序

**完成内容：**
- `datetimeLocal.ts`：新增 `formatDatetimeChinaTime`，将 UTC ISO 字符串加 8 小时格式化为 `"YYYY-MM-DD HH:mm:ss"`（CST）
- `DataTable.tsx`：新增 `columnFormatters` prop，仅影响单元格显示和列筛选文本，不修改底层 row 数据（行内匹配逻辑不受影响）
- `DataTable.tsx`：新增列排序功能，点击表头循环切换升序 ▲ / 降序 ▼ / 无排序；数字列按数值比较，其余按字符串本地化排序
- `DataTable.css`：排序图标样式（`data-table-sortable` / `data-table-sort-icon`）
- `InfcontrolReport.tsx`：明细表 TESTEND 列传入 `columnFormatters` 转 CST 显示；从行数据和 `columnOrder` 同时删除 PROBECARDTYPE 列

**测试：** tsc --noEmit 通过，无运行时测试（纯前端显示改动）

---

## 2026-06-09 — 「常见 fail bin」确定性路径修复（英文模式匹配 + topBadBins + 恢复 LLM 解读）

**完成内容：**
- `agentJbDeterministicReply.ts` `isBadBinRankingQuestion`：新增英文 `fail bin` 变体正则 — 原函数仅匹配中文「坏 bin」，导致「常见的 fail bin」走 `generic` 路径（无 topBadBins）；现覆盖 `常见.*fail\s*bin` / `主要.*fail\s*bin` / `实测.*fail\s*bin` 等模式
- `agentJbDeterministicReply.ts` `bad_bin_ranking` 输出：`withPatterns` → `withAlertsAndPatterns`，确保 cluster 警示（`clusteredBadBinAlertsMarkdown`）进入确定性输出，与 LLM 路径一致
- `agentJbDeterministicReply.ts` `jbReplySkipsCommentaryLlm`：将 `bad_bin_ranking` 移出跳过名单，恢复 LLM 工程解读（`### 数据解读 / ### 专业建议`），满足「不能比现在的回答差」约束
- `test/agentJbDeterministicReply.test.ts`：新增 4 个断言覆盖英文 fail bin 路由（正向×3 + 有具体 BIN 号不触发×1）

**背景**：根本原因分析——`tryRunDeterministicJbSummary` 在总结轮调用 `detectJbReplyMode` 时，因正则未覆盖英文返回 `generic`；`generic` 路径不含 `topBadBins` 表，LLM 也未从 JSON 中提取，导致「常见 fail bin」回答缺失排行表

**测试：** 264 通过，1 预先存在失败（aggregate_jb_bins scope guard，与本次改动无关）

---

## 2026-06-09 — Agent prompt 两项修复（重复图表请求 + 常见 fail bin 排行表缺失）

**完成内容：**
- `agentPrompt.ts` `SEC_CHART_RULES`：新增「用户直接要求图表时必须重新生成」规则 — 用户明确说「画图」「yield 对比图」「by slot 图」等时，即使本次会话已生成过相同图表，也必须重新调用 `generate_chart`；禁止回复「图表已在上方生成，请查看」；重复请求表明图表可能未渲染
- `agentPrompt.ts` 聚集性坏 bin 规则（line 867 区域）：新增「必须」规则 — 用户问「常见 fail bin」「实测失效」「坏 bin 排行」时必须先给出 `topBadBins` 全 lot 坏 bin 总量排名表（按 dieCount 降序），再附 cluster 警示；cluster 警示不能代替排行表；仅从 cluster 警示提取少数 bin 号不能作为「常见 fail bin」的完整答案

**背景**：Session 日志（mq6cv0pg）回顾：①用户连问 3 次「DR43102.1H yield 对比图 by slot」，第 2、3 次 agent 只说「图表已在上方生成」未重新生成；②用户问「常见的 fail bin」agent 只展示了 cluster 警示（BIN15/BIN43）而未输出 `topBadBins` 完整排行表

**测试：** typecheck 通过，未运行 unit tests（prompt-only 改动）

---

## 2026-06-09 — Agent prompt 三项修复（BIN×DUT 二维表格 + 历史上下文丢失 + 反引号语法错误）

**完成内容：**
- `agentPrompt.ts` `SEC_OUTPUT_FORMAT`：新增「BIN×DUT 二维表格」硬规则 — 用户要求「二维表格」「BIN×DUT 交叉表」时必须输出 markdown 表格（行=BIN，列=DUT，格值=die颗数），禁止用 `generate_chart` 代替；历史对话已有 `query_inf_site_bin_by_dut` 结果时直接构造表格无需再调工具；DUT 列过多（52列）时可拆分两段但禁止丢弃其余列
- `agentPrompt.ts` `SEC_DECISION`：澄清优先规则新增子条款 — 禁止声称「这是我们之间的第一条消息」/「我没有找到之前的对话内容」；上下文不足时应说「我当前无法访问之前的对话记录，请告知是哪个批次/waferId」；用户说「为什么不生成XXX」/「刚才的XXX呢」说明之前有交互，应承认上下文丢失而非否认历史
- `agentPrompt.ts` line 118：修复 pre-existing 语法错误 — `\`focusBinDuts\`` 未转义反引号导致 TypeScript 模板字符串解析报错（TS1005），顺手修复

**背景**：Session 日志（mq4x4n2x）回顾：①「完了吗」时 agent 用 `generate_chart` 柱状图代替「二维表格」；②会话隔夜后（19小时后）agent 声称「无历史记录」；③typecheck 预先存在语法错误

**测试：** typecheck 通过，未运行 unit tests（prompt-only 改动）

---

## 2026-06-09 — Agent prompt 两项路由/质量修复（DUT-BIN 查询 + wafermap 回复）

**完成内容：**
- `agentPrompt.ts` `SEC_ROUTING`：路由表「DUT×BIN 数量汇总」行新增「某BIN集中在哪些DUT」场景说明，禁止列补充 `inf_draw_dut_bin_map`（之前只禁止 `inf_site_stats`）；新增「某 BIN 集中在哪些 DUT 硬规则」子节 — lot 已知时必须先 `query_lot_dut_bin_agg(focusBin:N)` 取整批各 DUT 颗数，禁止直接用 `inf_draw_dut_bin_map`（只看单片且自动选 DUT，无法回答整批哪些 DUT）
- `agentPrompt.ts` `SEC_ROUTING`：新增「highlight BIN 后的回复质量」规则 — 禁止画完 wafermap 仅粘工具原文；若当前片高亮 BIN 颗数明显偏少（< 批次峰值 20%），必须说明高峰 waferId 范围并邀请换片；用户对同片同 BIN 重复请求 ≥2 次时，主动询问链接是否可访问

**背景**：Session 日志回顾发现「bin98 主要集中在哪些dut」被错误路由到 `inf_draw_dut_bin_map(slot=1)` 只得到9颗、以及「画第一张wafermap highlight bin98」连问3次均只收到工具原文回显。

**测试：** typecheck 通过，未运行 unit tests（prompt-only 改动）

---

## 2026-06-08 — Agent prompt 三项诊断质量修复

**完成内容：**
- `agentPrompt.ts` `SEC_ENG_TIPS`：新增「多张卡对比 → 根因定位」子节 — 两张不同探针卡在同一 DUT、同一 BIN 失效时，优先排查机台（tester），而非探针卡；用对比表覆盖四种场景（两卡同 DUT/BIN → 机台；单卡失效消失 → 该卡问题；两卡全卡下降 → load board；两卡失效 DUT 不同 → 各自排查）
- `agentPrompt.ts` `SEC_LOT_ID`：新增「用户问某一片 wafer 的问题/情况」规则 — 触发条件为问句含明确片号；要求分析段只聚焦该片中断/BIN突增/良率偏差，禁止把 25 片宽表、机台表粘贴到分析里当背景
- `agentPrompt.ts` `SEC_OUTPUT_FORMAT`：新增禁止在用户可见文字中暴露内部工具名规则 — `### 专业建议` / `### 数据解读` 等段落严禁出现 `inf_draw_dut_bin_map(...)`、`inf_bin_spatial(...)` 等函数调用语法，改用「可继续追问『…』」的自然语言引导

**测试：** typecheck 通过，未运行 unit tests（prompt-only 改动）

---

## 2026-06-07 — 探针卡跨域退化信号（JB 良率 + YM 触发趋势关联）

**完成内容：**
- `agentCrossdomainInsights.ts`（新建）：`buildCardDegradationSignal(jbRows, ymRows, cardId)` — 算法关联同一卡多 lot 的 YM 触发频次趋势与 JB 最差片良率趋势；早/晚段均值比较，输出 `signalStrength`（strong/moderate/none）+ `evidence`（10 lot 时间倒序）+ 预渲染 `summaryMarkdown`；`CARD_DEGRADATION_SIGNAL_GUIDE` 约束 LLM 引用具体数字、禁止因果推断
- `agentToolHandlers.ts`：`fetchYmRowsForCard` helper（Dummy + Oracle 双路径）；`toolQueryJbBins` 在有 `cardId` 无 `lot` 时并发拉 YM 并计算信号，结果传入 `wrapJbQueryResultForAgent`
- `agentJbBinFormat.ts`：`wrapJbQueryResultForAgent` 接受 `meta.cardDegradationSignal`，输出 `_cardDegradationSignalGuide` + `cardDegradationSignal`；slim 序列化路径同步删除该字段
- `agentPrompt.ts`：新增 `SEC_CROSS_DOMAIN_INSIGHTS` 节（位于 SEC_BIN_COMPARE 与 SEC_BIN_BY_SLOT 之间），按 signalStrength 分级给出回复规则与反幻觉约束
- `test/agentCrossdomainInsights.test.ts`（新建）：10 个测试覆盖 null 返回条件、strong/none 信号检测、jbOnlyLots 计数、evidence 倒序、markdown 结构

**测试：** 264 通过，1 失败（Oracle DPI-1047 预存故障，与本次无关）

---

## 2026-06-07 — binTotalsByLot 泛化替换 bin10Vs66ByLot

**完成内容：**
- `agentJbBinFormat.ts`：删除硬编码的 `buildBin10Vs66ByLot` 函数与 `LotBinPairCompareEntry` 类型；输出字段改为 `binTotalsByLot`（复用已有 `buildBinTotalsByLot`，每 lot 给出全部坏 bin 的 `{ bin, dieCount }` 数组），Guide 描述同步更新
- `agentPrompt.ts` `SEC_BIN_COMPARE`：引导改为从 `binTotalsByLot[].badBins` 按 bin 编号查 dieCount；覆盖任意 bin 对，删除原「其它 bin 对须手算」的 workaround
- `agentToolSchemas.ts`：`aggregate_jb_bins` description 禁用说明从「BIN10 vs BIN66」改为「任意两个 bin 的 by-lot 对比（用 binTotalsByLot）」
- `test/agentJbBinFormat.test.ts`：删除 `buildBin10Vs66ByLot` 直接调用测试；包装器测试改为验证 `binTotalsByLot` 结构（BIN10=50 / BIN66=10 可正确读取）

**测试：** 254 通过，1 失败（Oracle DPI-1047 预存故障，与本次无关）

---

## 2026-06-07 — 警示/规律识别节 markdown 渲染修复

**完成内容：**
- `agentLoop.ts`：`jbReplySkipsCommentaryLlm` 路径改为在 `tablesBlock` 后发送 `## 分析结论` 分隔符 + 纯文字页脚，取代原 `JB_TABLES_ONLY_FOOTER`（含 `---` 的格式）
- `agentJbDeterministicReply.ts`：移除不再使用的 `JB_TABLES_ONLY_FOOTER` 常量导出
- 根本原因：无 `## 分析结论` 时，`splitAgentReplyMarkdown` 的 `detachProseAfterMarkdownTables` 会把 `### 🔍 警示 / 规律识别` 节（含 cluster 告警表和 patterns bullet）移入 `commentaryMarkdown`，而 CSS `.ai-md-commentary table { display: none }` 会隐藏表格；现在始终有 `## 分析结论` 分隔符，`### 🔍` 节始终落在 `dataMarkdown`
- `splitAgentReplyMarkdown.test.ts`：新增 2 个测试覆盖 patterns-only 和 cluster+patterns 两种路径

**测试：** 6 个前端 splitAgentReplyMarkdown 单元测试通过，0 失败；API typecheck 0 错误

---

## 2026-06-07 — 回答质量修复：unused import 清除 + 专业建议长度指引

**完成内容：**
- `agentLoop.ts`：移除 `DETERMINISTIC_TABLES_HEADER` 的 unused import（泄漏 fix 早已在代码侧完成，此行 import 为遗留死代码，清除避免混淆）
- `agentPrompt.ts` `SEC_OUTPUT_FORMAT`：新增长度指引——`### 专业建议` ≤ 3 条、每条 ≤ 2 句、直接写操作步骤不复述数据；坏 BIN 列表 top 8 即可，超出部分一行概括

**测试：** 255 通过，1 失败（Oracle DPI-1047 预存故障，与本次无关）

---

## 2026-06-06 — agentPrompt 可维护性重构（22 section consts）

**完成内容：**
- `agentPrompt.ts`：将 793 行、59 KB 的单体模板字符串重构为 22 个命名 TypeScript const（`SEC_TERMS_AND_TOOLS` … `SEC_FORMAT_LIMITS`）；`buildSystemPrompt` 用 `.join("\n\n")` 组装，LLM 收到的文本**完全不变**
- 顶部新增 TOC 注释表，列出每个 const 名 → 对应的 `##` 章节标题，方便 Ctrl+F 精准定位
- `buildHeader` / `buildManifestSection` 提取为独立函数（仅含 `${today}` / `${manifest}` 动态部分）
- `npm run typecheck` 通过，无编译错误

**测试：** typecheck 0 错误

---

## 2026-06-06 — 警示表格渲染修复 + focusBin DUT 明细置顶

**完成内容：**
- `splitAgentReplyMarkdown.ts`：`detachSummaryLikeTableRows` 只剥 `SUMMARY_FIRST_CELL` 匹配的行（总结/汇总/结论等），遇到 `BIN66`/`BIN55` 等非 summary 首格行立即停止，不再误删 `### 警示/规律识别` 的 markdown 表格
- `splitAgentReplyMarkdown.test.ts`：新增 BIN 命名行保留在 body 的测试用例
- `agentToolHandlers.ts`：`toolQueryLotDutBinAgg` 实现 `focusBin` 参数——解析 `focusBin: 55` 为 `bin55`，调用 `extractFocusBinDuts` 从 compact passes 中提取该 bin 的 DUT 明细，注入到结果对象最顶部（`focusBin` + `focusBinDuts`），避免被 `truncateResult` 截断后 LLM 看不到

**测试：** 4 个前端单元测试全通过；后端 255 通过，1 失败（Oracle DPI-1047 预存故障）

---

## 2026-06-06 — Session 日志合并：一个 session 一个文件

**完成内容：**
- `agentLoop.ts / sessionLogger.ts`：重构 `SessionLogger`，文件名由「每条消息时间戳」改为 `{sessionId}.md`；第一轮用 `writeFile` 写 session header + 第一轮内容，后续轮用 `appendFile` 追加分隔符 + 本轮内容，同一会话所有轮集中在一个文件中。

**测试：** 255 通过，1 失败（Oracle DPI-1047 预存故障）

---

## 2026-06-06 — Agent 确定性输出 5 项 UI 修复 + feedback 500 修复

**完成内容：**
- `agentJbHistoryCompact.ts`：移除 `formatLotYieldOverviewMarkdown` 顶部 cluster 警示块（防止与末尾重复输出）；简化测试机台标题（去掉 "API testerId 列名说明"）；移除中断次数与 slotYieldInterrupt 两处说明文字；`formatSlotYieldPivotMarkdown` 新增单 pass 两列布局（slot 1–25 每行两片，减少垂直空间）。
- `agentJbDeterministicReply.ts`：`buildLotOverviewTablesMarkdown` 改为调用 `withAlertsAndPatterns`（cluster 警示只在末尾追加一次）；`lot_overview` 预计算路径区分 precomputed/重建，避免双重追加。
- `test/agentJbBadBinCluster.test.ts`：移除 `lotYieldOverviewMarkdown` 包含"警示"的断言（该字段不再直接内嵌 cluster）。
- `agentFeedback.ts`：`readAll` 捕获 `SyntaxError`/`ENODATA` 返回 `[]`（防止空/损坏 JSON 导致 500）；`saveFeedback` 改为原子写（`.tmp` + `rename`）。
- `routes/agent.ts`：feedback 路由错误响应附带 `code` + `message` 便于诊断。

**测试：** 255 通过，1 失败（Oracle DPI-1047 预存故障）

---

## 2026-06-06 — default 兜底方案输出优化：指令泄漏清除 + 警示/规律合并至末尾

**完成内容：**
- `agentJbBadBinCluster.ts`：`formatClusteredBadBinAlertsMarkdown` 移除"解读与专业建议中必须首段写明..."指令文本（属 LLM 系统提示，不应出现在用户可见输出）。
- `agentJbDeterministicReply.ts`：`detectAndFormatDataPatterns` 简化格式——去掉 `---` 分隔线和 `>` 引用块，改为 `-` 无序列表；移除"可生成趋势图"提示（简洁）。
- `agentJbDeterministicReply.ts`：新增 `formatAlertsAndPatternsSection()`，将「聚集性/突增坏 bin 警示」与「AI 自动规律识别」合并为单节（`### 🔍 警示 / 规律识别`）。
- `agentJbDeterministicReply.ts`：新增 `withAlertsAndPatterns()`，generic / slot_pass_yield 模式从 `withPatterns` 改用此函数，cluster 警示随规律识别同节出现在末尾。
- `agentJbDeterministicReply.ts`：`rebuildDeterministicTablesFallback` 将 cluster 段从头部移除，改为末尾追加 `formatAlertsAndPatternsSection`；早返回的 overview 路径也改用 `withAlertsAndPatterns`。

**测试：** 255 通过，1 失败（Oracle DPI-1047 预存故障）

---

## 2026-06-06 — Agent Bug 修复：wafermap composite shortcut + 逐片 bin 循环 + 指令泄漏

**完成内容：**
- `agentInfWaferMapTool.ts`：移除 BIN highlight 跟画时强制 `passes="composite"` 的性能捷径（Bug A）。改为继承上次 inf_draw 的 passes 参数，用户切换 BIN 高亮后保持原有多层视图而非被折叠成合成层。
- `agentLoop.ts`：新增 `tryRunPerSlotBinRankingDirectRoute`（Bug C）。"每片/每一片/各片坏 bin" 问题命中时直接从 session cache 的 `slotBadBinsCompact` 出表，绕过 LLM 工具选择（LLM 误选 `aggregate_jb_bins` 导致死循环）。
- `agentLoop.ts`：修复 `jbBinsYieldFallbackMessage` 中 `DETERMINISTIC_TABLES_HEADER` 被拼入用户可见输出的指令泄漏（Bug 副作用）。
- `test/agentInfWaferMapTool.test.ts`、`test/agentWaferMapRoute.test.ts`：更新两处断言以匹配新行为（`passes === undefined` 替代 `"composite"`），同步重命名测试名称。

**测试：** 255 通过，1 失败（Oracle DPI-1047 预存故障，与本次无关）

---

## 2026-06-06 — agentPrompt 规划规则收紧 + 工具调用硬规则

**完成内容：**
- `agentPrompt.ts`：决策优先级 § 上方加全局硬规则："识别到 device/lot/cardId 后必须立即调用工具，禁止输出计划性文字后停下来等待"。
- `agentPrompt.ts`："规划其次" 规则收紧，明确只触发"跨多个不同 device/lot/cardId 的对比"场景；显式标注 device+bin/良率/维修建议不触发（1 次工具调用，非 3 步操作）。

**测试：** typecheck 通过

---

## 2026-06-06 — BRIEF_COMMENTARY_SYSTEM 修复空解读根本原因

**完成内容：**
- `agentJbDeterministicReply.ts`：`BRIEF_COMMENTARY_SYSTEM` 移除末尾 `generate_chart` 提示（commentary 调用不传工具 schema，推理模型决定调 generate_chart 后输出嵌入式工具调用格式，被 `createDeepSeekFilter` 整体剥离 → `cleanText` 为空）。
- `agentJbDeterministicReply.ts`：在 system prompt 开头加"⚠️ 本次调用无工具可用，禁止输出任何工具调用格式"，截断推理模型通过 think 块决定调工具的路径。
- `agentJbDeterministicReply.ts`：修正 system prompt 中 "DeepSeek-V4-Pro" 过时模型名称引用。

**测试：** typecheck 通过

---

## 2026-06-06 — per_slot_bin_ranking 启用 LLM 解读

**完成内容：**
- `agentJbDeterministicReply.ts`：`per_slot_bin_ranking` 从 `jbReplySkipsCommentaryLlm` 跳过名单移出，改为调 LLM 解读（跨 50 行逐片 Top5 BIN 数据最需要规律总结与异常片识别）。

**测试：** typecheck 通过，未重跑全量测试

---

## 2026-06-06 — 确定性表输出：指令泄漏 + 空分析结论修复

**完成内容：**
- `agentLoop.ts`：`tryRunDeterministicJbSummary` 的 `tablesBlock` 移除 `DETERMINISTIC_TABLES_HEADER`（该文字是给 LLM 的约束指令，不应出现在用户可见的 SSE 输出中）。
- `agentLoop.ts`：解读 LLM 调用后，若 `commentary` 为空（模型返回空或被 filter 吞掉）或 `streamError` 有值，通过 SSE `{ type: "text" }` emit fallback 提示（之前只写入 history，用户看到的是空白"分析结论"段落）。

**测试：** 255 通过，1 失败（Oracle DPI-1047 预存故障，与本次无关）

---

## 2026-06-06 — JB STAR 查询区 more 分隔线美化

**完成内容：**
- `index.css`：`.filter-grid-more-toggle` 改为 `grid-column: 1/-1` 撑满整行，用 `::before`/`::after` 伪元素在左右各画一条水平分隔线，文字居中；hover 时线条同步变亮。
- `InfcontrolReport.tsx`：删除 toggle div 上多余的 `span-2` class（改由 CSS `grid-column` 控制）。

**测试：** 未运行，仅前端样式调整

---

## 2026-06-06 — Agent generic/双源总结轮结构化改善（方向 A+B）

**完成内容：**
- `agentLoop.ts`：新增 `SummaryContext` 类型（`"jb" | "dual_source" | "generic"`）+ `getSummaryContext(history)` 推断函数 + `getRecentSummaryToolNames()` 工具名提取。
- `agentLoop.ts`：新增 `DUAL_SOURCE_SYNTHESIS_NUDGE`（YM+JB 双源时强制分节：YM 侧 / JB 侧 / 综合结论）和 `GENERIC_STRUCTURED_SYNTHESIS_NUDGE`（非 JB 预计算路径时强制三节：数据摘要 / 主要发现 / 建议）。
- `agentLoop.ts`：总结轮系统提示词追加 `summarySuffix`（根据 `summaryCtx` 选对应 nudge），`summaryUserNudge` 改为三路动态内容，双源和 generic 模式各有专用格式要求。

**测试：** 全量非 Oracle 测试通过，agentLoop 相关用例 61–65 全通过；Oracle 连接测试（DPI-1047）因本机无 Oracle Client 跳过，与本次改动无关。

## 2026-06-06 — Agent 子任务模型（subAgentModel）支持

**完成内容：**
- `runtimeConfig.ts`：新增 `agentSubModel` 字段（`RuntimeConfig` + 默认值 `""`，空字符串 = 与主模型相同）；支持 `AGENT_SUB_MODEL` 环境变量。
- `agentConfig.ts`：新增 `subAgentModel: string` 字段；`resolveAgentConfig` 优先读 `override.subAgentModel`，其次 `AGENT_SUB_MODEL` env，最后 fallback 到 `model`（保持无感兼容）。
- `agentLoop.ts`：`summarizeHistory`（历史压缩，best-effort）和 `emitDeterministicJbTablesReply` 解读调用（结构化输入/有界输出）改用 `agentConfig.subAgentModel`；工具选择轮与总结轮最终回答仍用主 `model`。
- `useServerConfig.ts`（前端）：`ServerConfig` 新增 `agentSubModel: string`，默认 `""`。
- `usePersistedAgentConfig.ts`（前端）：`AgentConfig` 接口新增 `subAgentModel: string`，随 POST 请求体下发给后端。
- `App.tsx`：agentConfig 对象新增 `subAgentModel: serverConfig.agentSubModel`；Settings 新增「子任务模型」文本输入框，留空时显示 placeholder「留空 = 与主模型相同」。
- `InfDutDistPanel.tsx`：顺手删除预存未使用函数 `computeBinDuts`（TS6133 预存错误）。

**测试：** 前后端 typecheck 均通过

---

## 2026-06-06 — Agent 多源时间段联查规则

**完成内容：**
- `agentPrompt.ts`：新增「探针卡 / device / lot + 时间段联查（必须双源）」规则：用户询问某张卡/某 device 在某时间段内的情况时，必须同时调 `aggregate_yield_triggers`（YM 侧）和 `aggregate_jb_bins`（JB 侧），合并汇报；明确 INF 文件不支持时间范围查询，无需强求纳入。

**测试：** typecheck 通过

---

## 2026-06-06 — Agent 主动规律/风险识别模块

**完成内容：**
- `agentJbDeterministicReply.ts`：新增 5 个规律检测函数（`detectYieldDeclineTrend` / `detectDominantBin` / `detectPersistentBadSlot` / `detectTemperatureSensitivity` / `detectCardChangeBinShift`），从 `lotYieldRankByTestEnd` 和 `slotBadBinsCompact` 推断人眼不易察觉的规律。
- `agentJbDeterministicReply.ts`：新增导出函数 `detectAndFormatDataPatterns()`，汇总所有规律为 blockquote 段（⚠️ 警告 / 💡 信息）；无规律时返回 null，不强求输出。
- `agentJbDeterministicReply.ts`：新增私有 `withPatterns()` helper，在基础输出后追加规律段；接入 `lot_overview` / `card_test_overview` / `bad_bin_ranking` / `lot_yield_ranking` / `slot_pass_yield/generic` 五个模式的返回路径。
- `agentJbDeterministicReply.ts`：`BRIEF_COMMENTARY_SYSTEM` 末尾新增一行：发现良率趋势或 BIN 集中度规律时，可调用 `generate_chart` 生成折线/柱状图；无规律时勿强求画图。

**测试：** 258 个测试，255 通过，1 失败（Oracle 本地未安装，预存问题）；typecheck 通过

---

## 2026-06-06 — generic 兜底结构性修复 + 探针卡 DUT 定位模式 + 探针卡测试概况模式

**完成内容：**
- `agentJbDeterministicReply.ts`：新增 `JbReplyMode` 值 `"card_test_overview"`，处理「8036-06 的测试情况」类探针卡概况问题（原先被 `lot_overview` 误截，输出错误 lot 的 cluster alerts）。
- `agentJbDeterministicReply.ts`：**结构性修复** — `"generic"` 兜底分支在问题含明确卡号（`\b\d{4}-\d{2,3}\b`）或 DUT/触点关键词时，提前返回 `null` 而非盲目输出缓存的 `lotOverview`（大概率是错误 lot 的数据）；返回 `null` 后，总结轮 LLM 从原始工具 JSON 作答（总结轮无法再调工具）。
- `agentJbDeterministicReply.ts`：新增 `isCardDutQuestion()`，检测卡号 + DUT/触点类关键词（「哪个dut有问题/dut异常/哪个触点」等），映射到新模式 `"card_dut_question"`；`buildCardDutQuestionMarkdown` 输出该卡 BIN 级坏 die 汇总 + 各片坏 die 排行（前 5）+ DUT 级定位引导文字（指向 `inf_draw_dut_bin_map` 而非不存在的 inf_site_stats）；跳过 LLM 解读（防止 LLM 继续调工具或建议不存在的工具）。在 `detectJbReplyMode` 中排在 `card_test_overview` 之前。
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
