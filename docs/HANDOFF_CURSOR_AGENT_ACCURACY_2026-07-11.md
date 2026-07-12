# 交接（给 Cursor）：Agent 回答准确性修复清单（2026-07-11 会话日志复盘）

> **来源**：逐条复盘 `pcr-ai-api/session-logs/` 中 2026-07-04～07-11 的真实模型会话
> （6 个 `minimax-test-*.md`，模型 `Pro/MiniMaxAI/MiniMax-M2.5`；十余个 DeepSeek-V4-Flash 会话），
> 对照当前 `main`（HEAD `66220a8`）代码确认仍会复现。
> **目标**：让 Agent 回答更准确——消除答非所问、自相矛盾的数字、误导性呈现。
> **优先级**：P0 = 直接答错/自相矛盾；P1 = 误导/不一致；P2 = 体验/待回归。
>
> **已修复、勿重复修**（2026-07-11 已合入，见 [`HANDOFF_AGENT_PROBE_CARD_TESTER_PERFORMANCE.md`](HANDOFF_AGENT_PROBE_CARD_TESTER_PERFORMANCE.md) §7）：
> ① `758c282` 「探针卡+最好/最差」被 `isCardYieldCompareQuestion` 抢答成 `query_jb_bins`；
> ② `31956f1` 总结轮改服务端直出四张表（`tryRunDeterministicProbeCardPerfSummary`）。
> 证据日志 `minimax-test-8914374b` / `minimax-test-2377a648`（劫持）、`minimax-test-e1408ef0`（转述）对应的就是这两处，已闭环。

---

## 通用约束（全部任务适用）

- **dummy-parity 硬规则**：凡涉及取数口径（P0-2）——Oracle 路径与 `*Dummy.ts` 必须同步改，`npm test` 两路都过。纯呈现层（表标题、退化抑制、追加节 bail）不碰 SQL/Dummy。
- 改 `pcr-ai-api` 后：`npm run typecheck` + `npm test`（当前基线 ~478 项 0 fail）。
- 本清单全部在 **agent 层**（`pcr-ai-api/src/lib/agent/` + `src/lib/lotUnderperformingDuts.ts` + `src/lib/probeCardTesterPerformance.ts`），不动 REST 响应形状、不动前端。
- 会话日志均为**本地 Dummy 数据**产生；修复后除单测外，建议用同样问句在本地 dummy 模式人工冒烟一遍（问句在各条目「复现」里）。

---

## P0-1 探针卡组合排名四张表无标题、无 pass 分组，"(无数据)" 裸行直出

**状态：✅ Cursor 已修（2026-07-12，工作区待 commit）** — `probeCardTesterPerformance.ts` 四 markdown 字段内嵌 `#### pass{n}（sort… 温度）` + 表标题；空表/`(无数据)` 不输出；月度趋势不足 2 月改一行说明。

**证据**：`session-logs/minimax-test-bef05547-*.md`（两处修复合入**之后**的最新会话）。
问「WA03P02G 这个 device 下最好的探针卡+机台组合是什么，哪张探针卡表现最差」，`## 实测数据` 下直出 8 张表 + 2 行裸 `(无数据)`，**没有任何表标题、没有 pass1/pass3 分组标题**。用户无法分辨哪张是组合排名、哪张是卡排名、哪组属于哪个 pass。

更糟的是**卡排名表是升序（最差在前）**、组合排名表是降序（最好在前）——同屏无说明时看起来像两张互相矛盾的表（组合表排名 1 = 97.41%，紧邻的卡表排名 1 = 95.46%）。这个排序语义只写在了系统提示词里（`agentPrompt.ts:975`），确定性直出路径根本不经过 LLM，用户侧完全丢失。

**根因**：
- [`probeCardTesterPerformance.ts:142-148`](../pcr-ai-api/src/lib/probeCardTesterPerformance.ts) `mdTable()` 只产表体，无标题；空表返回裸 `"(无数据)"`。
- [`agentLoop.ts:2859-2872`](../pcr-ai-api/src/lib/agent/agentLoop.ts) `tryRunDeterministicProbeCardPerfSummary` 把每组四个 markdown 字段 `\n\n` 裸拼接；`"(无数据)"` 因 `md.trim()` 为真也被推给用户。

**修改点（推荐做法）**：在 `computeProbeCardTesterPerformance`（`probeCardTesterPerformance.ts`）里给四个 markdown 字段**内嵌标题行**，这样确定性直出路径和 LLM 转述路径同时受益：

- 每组组首加 `#### pass{passId}（sort 对应温度）`——passId→温度映射复用既有约定：1→sort1 常温、3→sort2 高温、5→sort3 低温（`agentPrompt.ts` 已有该映射文案，勿新造）。
- `comboRankingMarkdown` 标题：`**探针卡+机台组合排名（平均良率降序，最好在前）**`
- `cardRankingMarkdown` 标题：`**探针卡排名（平均良率升序，最差在前）**`
- `cardTrendMarkdown` 空时**不出表**，改一行：`*月度趋势：每卡不足 2 个月数据，暂无趋势表*`（非空时标题 `**按卡月度良率走势**`）
- `cardBadBinMarkdown` 标题：`**按卡坏 bin Top3 频率（仅编号频率统计，非空间分布）**`

若担心改字段影响既有单测/工具 JSON 体积，备选：字段不动，只在 `agentLoop.ts:2860-2870` 拼接循环里按 key 补标题、跳过 `"(无数据)"`。二选一即可，推荐前者。

**验收**：本地 dummy 问上面原句，回复中每张表有标题、pass 分组清晰、无裸 `(无数据)`；`test/probeCardTesterPerformance.test.ts`（如断言 markdown 内容需同步更新）+ 全量 `npm test` 通过。

---

## P0-2 同屏两个矛盾的「整体良率」：JB 口径 47.83% vs DUT 表 89.41%

**状态：✅ Cursor 已修（2026-07-12，工作区待 commit）** — B 路 `tryAppendUnderperformingDutSection` 从 query_jb_bins payload 提取 `goodBinsByPassId`（含 `goodBins[]` / `bins[].isGoodBin`）传入 `runLotUnderperformingDuts`；`jbYieldCalc.goodBinIndicesForJbRow` 可读 agent 格式化行的 `goodBins` 数组。

**证据**：`session-logs/8e98720b-*.md`。问「NF12595.1A 的测试情况」：
- 「分测试层（sort）批次良率」表：pass1 良率 **47.83%**（JB：1154 总 die / 602 坏 die）；
- 尾部追加的「🔬 各 DUT 良率」表：`pass1 — lot 整体 89.41% · 阈值 67.06%`。

同一 lot、同一 pass、同一屏，两个「整体良率」相差 41 个百分点，无任何解释。JB 口径来自 PASSBIN 良品判定；DUT 表口径来自 INF good-bin 集合（`computeUnderperformingDutsForPass`）。**两边良品 bin 集合没对齐**。这正是 [`HANDOFF_CURSOR_VERIFICATION_RESULTS_2026-07-04_DUT_YIELD_MULTISELECT.md`](HANDOFF_CURSOR_VERIFICATION_RESULTS_2026-07-04_DUT_YIELD_MULTISELECT.md) 里「A2 建议改取数（JB PASSBIN 优先）」的延续。

**修改点**：
1. 排查 agent B 路（`agentLoop.ts:2181` `tryAppendUnderperformingDutSection` → `runLotUnderperformingDuts`）调用时是否传入了 `goodBinsByPassId`（JB PASSBIN 解析结果）。[`lotUnderperformingDuts.ts:70-78`](../pcr-ai-api/src/lib/lotUnderperformingDuts.ts) 的 `resolveGoodBinsForPass` 已实现「JB PASSBIN 优先」，但从日志看该路径**没有生效**（详见 P0-3，同一根因的另一个症状）。
2. 对齐后，DUT 表头的「lot 整体 %」应与 JB 分测试层良率**同口径**（差异 ≤ 舍入）；若 INF 与 JB die 数本身有差异（复测/半片），表头注明数据源即可，不能出现无解释的 40pp 级差异。

**验收**：本地 dummy 问「NF12595.1A 的测试情况」，JB 良率表与 DUT 表头的整体良率一致（或有明确口径脚注）；`test/lotUnderperformingDuts.test.ts` 补一条「goodBinsByPassId 生效时 DUT 整体良率 = JB 口径」用例。

---

## P0-3 good bin 非 BIN1 的 lot：78 行全 0 DUT 大表仍然直出

**状态：✅ Cursor 已修（2026-07-12，工作区待 commit）** — 口径随 P0-2；呈现层 `formatAllDutsHighlightMarkdown` 退化时只出警告行、不出表体/散点图。

**证据**：`session-logs/f704996d-*.md`、`d7346963-*.md`、`f16ea547-*.md`、`4649d88f-*.md` 共 4 个会话。
device WA01N39W 各 lot（良品 bin 实际是 **BIN250**，JB 明确给出 goodDie 6213/BIN250），DUT 表输出：

```
### pass1 — ⚠️ 整体良率 0%（无良品 die 落入良品 bin）…请核对 pass/bin 口径
| DUT0 | 0 | 0/26 | DUT1 | 0 | 0/24 | …（78 个 DUT 全 0，26 行大表）
```

**根因**（两层）：
1. **口径层**：`resolveGoodBinsForPass`（`lotUnderperformingDuts.ts:70-78`）在 `goodBinsByPassId` 为空/未覆盖该 passId 时兜底 `{BIN1}`。该 lot 良品是 BIN250 → 良率恒 0%。注释里写明这是「已确认接受的残余风险」，但前提是「JB 数据完全没覆盖该 passId」——而这里 **JB 明明知道 BIN250**（`query_jb_bins` 返回里 goodBins 有 BIN250，用户追问时 LLM 都能答对）。需要排查：是 agent B 路没把 JB goodBins 传进来，还是 PASSBIN 解析没产出 250。
2. **呈现层**：[`agentUnderperformingDutView.ts:56-68`](../pcr-ai-api/src/lib/agent/agentUnderperformingDutView.ts) 的 `degenerate` 分支只是换了个警告标题，**表体照出**。全 0 大表对用户是纯噪音，还会连带散点图。

**修改点**：
1. 修口径（随 P0-2 一起）：让 agent 路径拿到正确的 `goodBinsByPassId`。
2. 修呈现（独立兜底，必做）：`formatAllDutsHighlightMarkdown` 中 `degenerate === true` 时**只输出警告行，不输出表体**，同时跳过对应 pass 的散点图（`buildUnderperformingDutScatterOptions` 同文件）。口径修好后这条兜底仍保留——真库上仍可能遇到 JB 无 PASSBIN 的 lot。

**验收**：构造 goodBins 解析不到的 pass → 回复只有一行警告无大表；WA01N39W 场景在口径修复后应出正常高亮表。`test/agentUnderperformingDutView.test.ts`（或就近测试文件）补退化用例。

---

## P0-4 「good bin 是多少」被 lot 概况表劫持，答非所问

**状态：✅ Cursor 已修（2026-07-12，工作区待 commit）** — `isGoodBinValueQuestion` + `good_bin_value` mode + `tryRunGoodBinValueDirectRoute` + `buildGoodBinValueMarkdown`；黄金集零回退已复验。

**证据**：`session-logs/f704996d-*.md` 第 3 轮。问「**DR41803.1Y 中的 good bin 是多少**」，直出整套 lot 概况（机台表 + 探针卡表 + 良率表 + 全 0 DUT 大表），从头到尾没答 good bin。用户**原句重问第二遍**，才走 LLM 路径答出「BIN250，6213 颗」（第 4 轮回答本身是对的）。

**根因**：「good bin / 良品 bin 是多少」这类**具体字段问句**命中了 lot 概况确定性路由（问句含 lot 号 → `lot_overview`/`generic` 直出），没有更窄的谓词先行拦截。

**修改点**：在 JB 直出收口点（`emitDeterministicJbTablesReply` 的 mode 判定或 `resolveJbRoute` 谓词层，参考既有 `isMultiCardComparisonQuestion` 等 bail 的做法）新增窄谓词 `isGoodBinValueQuestion`：问句同时含「good bin / 良品 bin / goodbin」+「是多少 / 哪个 / 什么 / 几号」时——
- **优先**：从 session 缓存的 lot payload `goodBins` 字段确定性直答（bin 编号 + 颗数，一两句话 + 小表）；
- **保底**：至少 bail 出确定性直出、放行给 LLM（第 4 轮证明 LLM 拿着工具结果能答对）。

注意勿误伤：「BIN55 是 good bin 吗」「good bin 数量趋势」等问法先跑一遍既有黄金集（`test/eval/scenarios/routing-golden.ts`）确认零回退。

**验收**：本地 dummy 依次问「DR41803.1Y 的测试情况」→「DR41803.1Y 中的 good bin 是多少」，第二问**第一次**就直接回答 bin 编号，不再输出概况表；黄金集回归零回退。

---

## P1-5 device 级「测试情况」的 lot 列表尾部误挂单 lot 的 DUT 大表

**状态：✅ Cursor 已修（2026-07-12，工作区待 commit）** — `shouldAppendUnderperformingDutYield` 对 `lot_listing` / `isLotListingQuestion` / `payloadCoversMultipleLots` bail。

**证据**：`session-logs/f704996d-*.md`、`4649d88f-*.md` 第 1 轮。问「WA01N39W 的测试情况」（device 级），主体是正确的多 lot 列表，但尾部凭空追加了**最新单个 lot（DR41803.1Y）的 78 行 DUT 表**（还是 P0-3 的全 0 退化表）。多 lot 问题挂单 lot 明细，答非所问。

**根因**：[`agentJbDeterministicReply.ts:919-928`](../pcr-ai-api/src/lib/agent/agentJbDeterministicReply.ts) `shouldAppendUnderperformingDutYield` 对 `mode === "generic"` 一律放行，device 级列表回复走 generic 时也被追加。

**修改点**：`shouldAppendUnderperformingDutYield`（或调用点 `agentLoop.ts:1047`）增加 bail：payload 覆盖多个 lot（可复用既有 `payloadCoversMultipleLots`）或本次回复主体是 lot 列表（`isLotListingQuestion(userQuestion)` 为真）时不追加。单 lot 概况行为不变。

**验收**：「WA01N39W 的测试情况」→ 只出 lot 列表；「DR41803.1Y 的测试情况」→ 仍带 DUT 良率节。

---

## P1-6 同一问题 3 分钟内两次结果不一致（5 lot vs 4 lot），列表标题误带机台

**状态：✅ Cursor 已修（2026-07-12，工作区待 commit）** — `resolveJbListingScope` 不再从 history 推断 tester（仅用户句中 explicit）；`buildRecentLotsListingMarkdown` fallback 标签不再读 payload.testerId。

**证据**：`4649d88f-*.md`（11:00，5 个 lot，含最新 DR41542.1H）vs `f704996d-*.md`（11:03，**只剩 4 个 lot，丢了 DR41542.1H**）。同一问句「WA01N39W 的测试情况」。且两次标题都是：

```
测试 lot 列表（device=WA01N39W，机台=b3j75053）
```

用户从未提机台。`b3j75053` 是最新 lot 的 tester——scope 推断把上下文/payload 里的 tester 带进了列表标签，且疑似第二次真的按机台过滤了（DR41542.1H 可能在别的机台上测试，被滤掉）。

**根因方向**：`agentQueryScope.ts` 的 scope 推断 / `buildRecentLotsListingMarkdown` 的标签拼接（见 [`HANDOFF_AGENT_JB_LOT_LISTING.md`](HANDOFF_AGENT_JB_LOT_LISTING.md)）。需要日志复现确认是「仅标签错」还是「真被过滤」——两个会话行为不同提示可能与 session 内缓存的上一轮 scope 有关（11:03 会话前一轮是否留下了 tester scope，从日志看该会话首轮即如此，更可疑的是跨会话/进程内缓存）。

**修改点**：
1. tester 未出现在**用户本轮问句**时，不得进入 lot 列表的过滤条件；标签只展示用户显式给出的维度（device/mask/时间窗）。
2. 若排查发现是 `detectPendingQuery` / listing 参数推断从 payload 回填了 tester——去掉该回填或仅作展示注脚（「以上 lot 涉及机台：…」放列表下方，不进 WHERE）。

**验收**：新会话重复问同一 device 两次，lot 行数一致且等于该 device 全部 lot；标题不再出现用户未提的机台。

---

## P1-7 总结解读跨温度层（passId）直接对比「最好/最差」，甚至下因果结论

**状态：✅ Cursor 已修（2026-07-12，工作区待 commit）** — `BRIEF_COMMENTARY_SYSTEM` 增补 pass/温度层三条硬规则。

**证据**：
- `minimax-test-bef05547`（修复后）：解读写「最佳组合为 8041-03 配 b3uflex25（99.79%）；最差为 8041-02 配 b3uflex13（95.46%）」——前者是 **pass3（高温）**、后者是 **pass1（常温）**，跨温度直接排名。
- `minimax-test-e1408ef0` / `74d6bd18`：「pass3 整体良率显著高于 pass1，说明该 device 在**高温测试阶段良率更稳定**」——每卡仅 1 片样本就下工艺因果结论。
- `minimax-test-21b1c3b4`：把 pass3 写成「**pass2**」（不存在的层）。

**根因**：`BRIEF_COMMENTARY_SYSTEM`（[`agentJbDeterministicReply.ts:2452`](../pcr-ai-api/src/lib/agent/agentJbDeterministicReply.ts)）对 pass 语义无约束。该 system 同时服务 JB 表解读与探针卡组合排名解读（`agentLoop.ts` 三处 `buildBriefCommentaryUserMessage` 调用）。

**修改点**：`BRIEF_COMMENTARY_SYSTEM` 增补三条硬规则（措辞可调）：
1. 不同 passId/sort（温度条件）之间**禁止**直接比较良率高低或合并排名；「最好/最差」必须**按 pass 分别**陈述（例：pass1 最差 8041-02；pass3 最差 8041-06）。
2. 只允许出现数据中实际存在的 passId（1/3/5 → pass1/pass3/pass5），禁止写 pass2/pass4。
3. 单 lot/单片样本禁止下「更稳定」「工艺差异导致」等因果或统计结论，只可陈述数字并注明样本量。

P0-1 的表标题带上温度语义后，模型犯错空间也会同步缩小。

**验收**：本地 dummy 重跑「WA03P02G…最好的探针卡+机台组合…哪张最差」×3 次，解读均按 pass 分别给最好/最差、无 pass2、无因果推断。（LLM 输出有随机性，人工抽查即可，不强求单测。）

---

## P2-8 两项遗留

### 8a. `query_jb_bins(cardId)` 返回 count=0 但 `recentLotsByTestEnd` 有 lot，随后 125.9s 空转

**状态：⏭ 未在本轮复验** — 2026-07-10 `resolveJbListingScope`（cardId 优先）可能已覆盖；需真库重放「9440-03 卡的测试情况」。

**证据**：`session-logs/8e98720b-*.md` 第 2 轮。问「9440-03 卡的测试情况」：`query_jb_bins(cardId:"9440-03")` 返回 `count:0, passIdsPresent:[]` 但 `recentLotsByTestEnd` 含 NF12595.1A（该卡明明测过 slot9）；模型接着又发起一次 device 查询也是 0 行，全程 **125.9s**。
2026-07-10 的 [`HANDOFF_CURSOR_JB_CARD_LISTING_SCOPE_2026-07-10.md`](HANDOFF_CURSOR_JB_CARD_LISTING_SCOPE_2026-07-10.md)（`resolveJbListingScope`，cardId 优先）**可能已覆盖**此场景——请先在当前 main 上重放该问句：已修则在该 handoff 的回归清单里勾掉；未修则排查 cardId 查询谓词为何 0 行（大小写/TRIM/时间窗）。

### 8b. 同一会话同一 lot 的 DUT 大表重复输出两次

**状态：⏭ 观察（P0-4 + P1-5 修完后应自然消失，未单独加 session 去重兜底）

**证据**：`f704996d-*.md`：第 1 轮（device 测试情况）与第 3 轮（good bin 问句被劫持）各输出一遍 DR41803.1Y 的 78 行 DUT 表。P0-4 + P1-5 修复后此场景自然消失；如仍想兜底，可在 `tryAppendUnderperformingDutSection` 里记录 session 内已输出过的 `(lot, pass)`，重复时改为一行「（各 DUT 良率表见上文，如需重发请说明）」。**优先级最低，前两项修完先观察。**

---

## 建议实施顺序

| 顺序 | 条目 | 理由 |
|---|---|---|
| 1 | P0-3 呈现兜底（退化不出表） | 改动最小，立刻止血 4 个会话的最刺眼输出 |
| 2 | P0-2 + P0-3 口径（goodBinsByPassId 打通） | 同一根因，一起修；是「数字矛盾」的根治 |
| 3 | P1-5（listing 不追加 DUT 表） | 一行 bail，顺手修 |
| 4 | P0-1（四表标题 + pass 分组） | 探针卡新功能的可读性主修 |
| 5 | P0-4（good bin 问句谓词） | 需过黄金集，工作量中等 |
| 6 | P1-7（commentary 规则） | prompt 层，独立 |
| 7 | P1-6（scope 复现排查） | 需要先复现定位，工作量不确定 |
| 8 | P2-8a 回归 / 8b 观察 | 收尾 |

## 完成标准

- [x] `npm run typecheck` 通过
- [x] 相关新增/改动用例全绿（`agentJbDeterministicReply` / `agentUnderperformingDutView` / `lotUnderperformingDuts` / `probeCardTesterPerformance` / `agentEval` 黄金集）
- [ ] `npm test` **全量**全绿 — 仍有 **5 个已知本地预置失败**（`jbRouteResolver`×2 因 `runtime-config.json` flag 开；`agentLoop` semantic dispatch×1；`agentStream`×2），与本次改动无关
- [x] 黄金集路由零回退（`routing-golden`，P0-4）
- [ ] 本地 dummy 冒烟：各条目验收问句逐条人工过（待部署前）
- [x] 更新本文件：每条目标注 ✅/⏭
- [x] commit **`ee48ab2`** 已 push
- [x] 真库 REST 初验 — 见 [`HANDOFF_CURSOR_VERIFICATION_RESULTS_2026-07-12_AGENT_ACCURACY.md`](HANDOFF_CURSOR_VERIFICATION_RESULTS_2026-07-12_AGENT_ACCURACY.md)
- [ ] 真库 Agent SSE — **待远程 pm2 reload `ee48ab2` 后复验**（本轮 1/4 SSE pass，blocked on deploy）
