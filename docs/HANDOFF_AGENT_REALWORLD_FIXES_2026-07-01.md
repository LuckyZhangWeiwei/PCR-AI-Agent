# 交接:真实会话 log 暴露的 Agent 回复问题 — 诊断 + 修复方案(给 Cursor，2026-07-01)

> **背景**：这批 markdown log 是**已上新路由(阶段一~三 dark-launch)**后的真实 agent 会话。用户复核发现 7 类「回答不好 / 第一遍答错重问才对」的案例，要求修复。
> **本文档由 Claude 在无库沙箱完成根因定位（精确到代码行）+ 修复方案**，但 **Claude 不改代码、不翻开关**。请 Cursor 在**真实 Oracle 环境**按下列方案实现 + 验证 + 回报。
> **红线（用户）**：不得降低现有回复质量。确定性、低风险的按「直接改 + 单测兜底」；动热路径查询参数的建议**藏 default-OFF 开关**（与阶段二/三一致），真库验证后由用户 FLIP。

---

## 0. TL;DR — 问题 × 根因 × 修法一览

| # | 案例（log 文件） | 现象 | 根因（代码行） | 修法 | 风险 |
|---|---|---|---|---|---|
| ① | `mr1nxdn4`「列出6月份，P32P出现bin fail，集中在哪张卡上」| 首答只出探针卡表+机台表，**没答"哪张卡"**；「数据不准确」重问才对 | `isBinCardAttributionQuestion` 强制要 BIN 数字（[agentJbDeterministicReply.ts:95](../pcr-ai-api/src/lib/agent/agentJbDeterministicReply.ts#L95)）；「bin fail」无号→false→漏派发 | 放宽正则：允许「(bin\|坏bin\|bin fail) 集中在哪张卡」无具体号 → aggregate_jb_bins(bin,cardId) 全 BIN | 低 |
| ② | `mr1ntrqq`「P29E **最近两周**的测试情况」| 无时间过滤，返回133 lot（回溯到5月），**"最近两周"被忽略** | (a)`inferRecentMonthsWindow` 不认「两周」中文数字周（[agentQueryScope.ts:195-202](../pcr-ai-api/src/lib/agent/agentQueryScope.ts#L195)）；(b)模型自建 mask 查询时服务端不补注入 | (a)纯函数补中文数字周（低险直接改）；(b)工具层补注入时间窗（藏开关） | (a)低 (b)中 |
| ③ | `mr1db4v6`「**今天** wb01n63r 的测试情况」| 同②，返回118 lot（回溯到2023），**"今天"被忽略** | `inferRecentMonthsWindow` 完全没处理「今天/今日/当天」 | 补「今天/今日/当天/近N天」→ 日窗（低险直接改）；配合②(b)注入 | (a)低 (b)中 |
| ④ | `mr1nn6wr`「9416-04 最近两个月测试的lot列出来」| 首答只列2个YM lot，**漏JB的26 lot**；「数据不全！」重问才补全 | lot 列表路由只认 device/tester，**不认 cardId**（[agentJbLotListingRoute.ts:17-20](../pcr-ai-api/src/lib/agent/agentJbLotListingRoute.ts#L17)）→ 裸卡号bail→落LLM→LLM只渲染YM漏 recentLotsByTestEnd | 扩 lot 列表路由 + `buildLotListingQueryArgs` 支持 cardId 域 → query_jb_bins(cardId,窗) 直出 recentLotsByTestEnd | 中 |
| ⑤ | `mr1b0hvc` 首轮「P32P，**近一周**，有什么bin fail」| **报错**"模型未返回分析结论"；重问才对 | get_filter_values 作首个工具→耗掉唯一非总结轮→总结轮阻塞数据工具→空文本报错。恢复路径 isJbScoped 闸门漏「有什么bin fail」（[agentPendingQuery.ts:112-119](../pcr-ai-api/src/lib/agent/agentPendingQuery.ts#L112)） | 放宽 isJbScoped 正则 → 恢复路径 fire → 按 mask 直查 JB | 低-中 |
| ⑥ | `mr1b0hvc`「一个dut，不同bin fail，放到一个柱图上」**连问4次** | agent 反复误解，4次都没对上用户意图 | generate_chart 意图理解 + 缺 ask_clarification | 偏 LLM/prompt，见 §7（只收集，暂不强改） | — |
| ⑦ | `mr1ao8i4`/`mr1cnwa1`「TR16426.1H 测试情况」| lot 在 JB 存在（见④N63R列表第36行）却直查 count:0；且 `mr1ao8i4` **重复3次同样空JB查询**（浪费92s） | (a)直查lot空但lot存在=数据/查询bug（需真库）；(b)无进展重复同参查询 | (a)真库诊断；(b)加「同参查询去重/不重试」护栏 | 需真库 |

**正常无需动的**：`mr1nl7hv`（TR23797.1H 概况，确定性表齐全）、`mr1nrqrj`（NF12316.1X bin7 趋势 + DUT 下钻，优秀）、`mr1nvxzl`（**核心bug "n55z 哪个卡测出bin35 多" 已修好** → aggregate bin,cardId 直出）、`mr1nqnt1`（7747 卡两域摘要，合理）。

**优先级建议**：①④⑤ 是「用户明确重问纠正」的硬伤且确定性可修 → **第一梯队**；②③ 高频且确定性（(a)部分零风险）→ **第二梯队**；⑥⑦ 需 LLM/真库 → **收集为主**。

---

## 1. 前置（同上次 FLIP 交接）

1. **真 Thick / 真库**：`db/ping` 正常，非 Thin NJS-116。
2. **API key**：`AGENT_API_KEY`（或 `SILICONFLOW_API_KEY`）+ `AGENT_SUBAGENT_MODEL` 已配。
3. **flag 透传**：若新增 default-OFF 开关（②b），确认 `ecosystem.config.cjs` 透传白名单包含它，否则改 `.env` 不生效（参考上次交接 §1.3）。
4. **改任何查询/WHERE/响应形状**：遵守 **dummy-parity**（Oracle + `*Dummy.ts` 同步）。JB 取数走 `query_jb_bins`/`aggregate_jb_bins`，本批改动集中在 **agent 层**（路由/正则/scope），一般不触 v3/v4 SQL；若确需改 SQL 请同步 Dummy。

---

## 2. 修 ① — bin_card 无具体 BIN 号也应归卡

**位置**：[`pcr-ai-api/src/lib/agent/agentJbDeterministicReply.ts:92`](../pcr-ai-api/src/lib/agent/agentJbDeterministicReply.ts#L92) `isBinCardAttributionQuestion`

**现状**：第 95 行 `if (!/\bBIN\s*\d{1,3}\b|.../.test(t)) return false;` —— **必须**有具体 BIN 号。「P32P出现bin fail，集中在哪张卡上」无号 → false → 不派发/不路由 → 首答走了别的路由只出探针卡表。

**建议修法**：新增一条「泛 bin fail + 归卡」判定（不要求具体号）：
- 命中 `(bin\s*fail|坏\s*bin|失效\s*bin|bin\s*失效|哪些?\s*bin\s*fail)` **且** `(哪张|哪个|哪块|集中在?哪).*(卡|探针)` → 视为 bin_card_attribution（无 focusBin）。
- 保留原「具体 BIN 号 + 卡」分支不变（回归保护）。

**派发/渲染**：无具体 BIN 时 → `aggregate_jb_bins(groupBy:"bin,cardId")`（不带 focusBin），渲染**全 BIN × 卡** Top 表 —— 正是用户重问后 `mr1nxdn4` 第二轮的正确输出。dispatch 表 `bin_card_attribution` 分支（[agentSemanticDispatchTable.ts:21](../pcr-ai-api/src/lib/agent/agentSemanticDispatchTable.ts#L21)）已复用 `scopedBadBinAggregateArgsFromUser` 换 `groupBy:bin,cardId`，无 focusBin 天然成立，无需额外改。

**测什么**（真库，新开聊天）：
- `列出6月份，P32P出现bin fail，集中在哪张卡上` → **首轮**应直出 BIN×卡表（对齐 `mr1nxdn4` 第二轮）。
- 回归：`n55z 哪个卡测出bin35 多`（有号）仍正常（对齐 `mr1nvxzl`）；`P32P概况`/`P32P各卡良率` 不被误抢。

**加黄金集**：`test/eval/scenarios/routing-golden.ts` 增一条 `{ q:"列出6月份，P32P出现bin fail，集中在哪张卡上", mode:"bin_card_attribution", ... }`（无 focusBin）。

---

## 3. 修 ④ — lot 列表路由支持 cardId 域

**位置**：
- [`agentJbLotListingRoute.ts:17`](../pcr-ai-api/src/lib/agent/agentJbLotListingRoute.ts#L17) `canRunLotListingDirectRoute` —— 只 `Boolean(inferDeviceFromText || inferTesterIdFromText)`。
- [`agentQueryScope.ts:303`](../pcr-ai-api/src/lib/agent/agentQueryScope.ts#L303) `buildLotListingQueryArgs` —— 只推 device/tester。

**现状**：「9416-04 …lot列出来」`isLotListingQuestion=true`，但 9416-04 既非 device 也非 tester → `canRunLotListingDirectRoute=false` → 路由 bail → 落 LLM。LLM 先 query_yield_triggers（2 lot）再 query_jb_bins(cardId)（拿到 recentLotsByTestEnd 26 lot），**却只渲染了 YM 的 2 lot**（漏 JB）。用户「数据不全！」后第二轮才对（26 lot）。

**建议修法**（确定性直出，绕开 LLM 漏渲染）：
1. 加卡号识别：`inferCardIdFromText(text)` 匹配 `\b\d{4}-\d{2,3}\b`（如 9416-04）。注意与 tester（b3flex05 等）、device（WA10P29E）不冲突。
2. `canRunLotListingDirectRoute`：`device || tester || cardId` 任一即可 run。
3. `buildLotListingQueryArgs`：无 device/tester 但有 cardId 时 → `{ cardId, testEndFrom/To(窗), limit:200 }`。query_jb_bins(cardId) 返回 `recentLotsByTestEnd` → 走既有 `buildRecentLotsListingMarkdown` 直出，YM 报警作附列。
4. 「最近两个月」时间窗：`inferRecentMonthsWindow` 已支持「两个月」（[agentQueryScope.ts:218](../pcr-ai-api/src/lib/agent/agentQueryScope.ts#L218) 中文数字月）→ 复用即可。

**测什么**：
- `9416-04 最近两个月测试的lot 列出来` → **首轮**直出 26 lot（对齐 `mr1nn6wr` 第二轮），含 device、测试结束、片数、YM 告警标记。
- 回归：`WA10P29E 最近两周测试的lot`（device 域）、`b3flex05 最近的lot`（tester 域）仍正常。
- 边界：不存在的卡 `0000-99 的lot` → 空表优雅落回，不卡死。

---

## 4. 修 ②③ — 相对时间「今天 / 最近两周」

**位置**：[`agentQueryScope.ts:192`](../pcr-ai-api/src/lib/agent/agentQueryScope.ts#L192) `inferRecentMonthsWindow`

### 4a（低风险，直接改 + 单测）——补解析缺口
现状缺口：
- **「今天/今日/当天」完全没处理** → `{}`（③）。
- **中文数字周「两周/三周」没处理**：第 195 行 `(\d+)…周` 只认阿拉伯数字，第 200 行只认 `[一1]` 单周；「两周」落空 → `{}`（②）。ZH_NUM 已含 `两:2` 但只用于「月」（218 行），未用于「周」。

修法：
- 加 `/今天|今日|当天/` → `windowFromDays(0)`（当日 00:00~现在；或按需 `windowFromDays(1)`，与业务「今天」语义确认）。
- 加中文数字周：仿 218 行 `moZh`，写 `wkZh = text.match(/(?:最近|近|过去|这|本)\s*([一两二三四五六七八九十]+)\s*个?\s*(?:周|星期|礼拜)/)` → `windowFromDays(7*ZH_NUM[..])`。放在阿拉伯周（195-202）之后、年（205）之前。
- 加「近N天」中文/阿拉伯：`/(?:最近|近|过去)\s*(\d+|[一两二三四五六七八九十]+)\s*天/` → `windowFromDays(n)`（覆盖 log 里 `mr1b0hvc` 的「近一周/近2天/近3天」——「近2天」目前已被谁解析？请核，"近\d天"当前**未**在函数内，模型 log 里是 LLM 自己填的 timeFrom；补上后可确定性）。

**单测**：`test/agentQueryScope.test.ts` 加断言：`今天`→当日窗、`最近两周`→14天、`近3天`→3天、`本周`→7天（回归）。

### 4b（中风险，藏 default-OFF 开关）——模型自建查询时补注入时间窗
**这是②③真正没被兜住的层**：`mr1ntrqq`/`mr1db4v6` 是**模型自己**调 `query_jb_bins(mask:…)` 且没填时间参数；服务端目前**不覆盖模型选的查询参数**，所以 4a 修好解析也不会自动生效（因为没人拿模型的 mask 查询去调用 `inferRecentMonthsWindow`）。

注意：恢复路径 [agentPendingQuery.ts:122-124](../pcr-ai-api/src/lib/agent/agentPendingQuery.ts#L122) **已经**会注入窗，但仅在「get_filter_values 未命中 device」的窄路径。一般模型查询不经过它。

建议（藏开关 `JB_INJECT_RELATIVE_TIME_WINDOW`，默认 OFF）：在 `agentToolHandlers` 执行 `query_jb_bins`/`aggregate_jb_bins` 前，若 **args 无 testEndFrom/To** 且 **用户当前问句 `inferRecentMonthsWindow` 命中** → 注入该窗。
- 安全性：只**补**用户明确要的过滤，且仅模型漏填时；命中「今天/最近两周」等显式时间词才注入，无时间词不动。
- 风险点（务必真库验证）：与 `multiLotYieldScope` 渲染、lot 列表窗、缓存 key 的交互；模型是否有**故意**不加时间窗的合理场景（本 case 里没有——用户明说了时间）。
- 若判风险偏高：退而求其次，只在 prompt 里强化「问句含相对时间必须转 testEndFrom/To」（但这是脆弱的 LLM 指令路径，非首选）。

**测什么**（开关 ON）：
- `今天 wb01n63r 的测试情况` → 只返回今天的 lot（对齐真实「今天」应有的少数 lot，而非118个回溯2023）。
- `P29E 最近两周的测试情况` → 只返回近14天 lot（而非133个回溯到5月）。
- 回归（开关 ON）：无时间词的 `wb01n63r 的测试情况` 行为不变（不注入）。

---

## 5. 修 ⑤ — get_filter_values 首轮后总结轮 bail

**位置**：[`agentPendingQuery.ts:104-130`](../pcr-ai-api/src/lib/agent/agentPendingQuery.ts#L104) 恢复路径 `query_jb_bins:after_filter_values_mask`

**机制**：`mr1b0hvc` 首轮「P32P，近一周，有什么bin fail」→ 模型先调 get_filter_values(mask P32P) 解析 device。这**耗掉唯一非总结轮**；下一轮为总结轮（数据工具被阻塞），模型想继续查 → 阻塞 → 空文本 → 报错"模型未返回分析结论"（见 `pcr-ai-api/CLAUDE.md §11 条目 11`）。

恢复路径本应把 get_filter_values 转成按 mask 直查 JB，但其 `isJbScoped` 闸门（112-119 行）
```
isBinCardAttributionQuestion || isProbeCardQuestion || isLotOverviewQuestion ||
isCardTestOverviewQuestion || isBadBinRankingQuestion || extractBinFromUserText!=null ||
/测试情况|哪.*die|坏\s*die|哪.*bin/i
```
**漏了「有什么bin fail」**（无具体号、无「测试情况」、不匹配 `哪.*bin`）→ 返回 null → 恢复不触发 → bail。

**建议修法**：放宽 119 行正则，纳入泛 bin-fail 口语：
`/测试情况|哪.*die|坏\s*die|哪.*bin|有\s*(什么|哪些)\s*bin|bin\s*fail|坏\s*bin|失效\s*bin/i`
（与 §2 的 ① 放宽保持一致，可抽公共判定 `mentionsBadBinGeneric(text)` 复用，避免两处正则漂移。）

**测什么**：
- `P32P，近一周，有什么bin fail` → **首轮**恢复路径 fire，按 mask 直查 JB，出坏 bin 结论（不再报错）。对齐 `mr1b0hvc` 第二轮的正确行为。
- 回归：现有能正常回答的 mask 概况/归卡问句不变。
- 注意：此路径也应吃到 §4a 的时间窗（122-124 行已调 `inferRecentMonthsWindow`）→「近一周」自动生效。

---

## 6. ⑦ — 直查 lot 空但 lot 存在 + 重复空查询（需真库）

**两个子问题**：

**(a) 数据/查询 bug**：`TR16426.1H` 在 JB STAR 存在（`mr1db4v6` 的 N63R 多 lot 列表第 36 行明确标 "JB STAR"，device WB01N63R，2026-03-11，24 片），但 `query_jb_bins(lot:"TR16426.1H", testEndFrom:"2020-01-01")` 返回 `count:0`。**矛盾 → 疑 bug**。
- 请真库直接查：`GET /api/v4/infcontrol-layer-bins/v4?lot=TR16426.1H`（或 agent 的 query_jb_bins 等价 SQL），确认 lot 在 JB 表里到底有没有行、lot 字段是否有前后空格/大小写/device 绑定差异。
- 对比：为何 mask=N63R 的 recentLotsByTestEnd 能列出它，而按 lot 精确查空？（可能 recentLotsByTestEnd 来自不同 JOIN/来源，或 lot 精确匹配有 TRIM/大小写陷阱——参考 `docs/HANDOFF_AGENT_ISSUES_2026-06-27_ROUND2.md` 里 Oracle `TRIM(col)!=''` 类陷阱、`oracleStringSql.ts`）。
- **收集**：真库两条 SQL 的实际返回 + lot 字段原始字节（有无空格）。

**(b) 无进展重复查询**：`mr1ao8i4` 用**完全相同**参数连调 3 次 query_jb_bins（都空），浪费 92s。
- 建议护栏：agent loop 检测「同名工具 + 同参 + 上次空结果」→ 不再重复调用，直接进结论（或换策略）。可在 `agentToolHandlers`/`agentLoop` 加一个「本 session 已执行过的 (toolName, argsHash) → 空结果集」记忆，命中则跳过。
- **收集**：确认这是模型行为（自发重试）还是某路由重复触发；给出 loop 轮次 trace。

---

## 7. ⑥ — generate_chart 意图反复误解（收集为主）

`mr1b0hvc` 中「一个dut，不同bin fail，放到一个柱图上」用户**连问 4 次**，agent 先说"已是堆叠图"、再逐个 DUT 出图、再给表，始终没稳定对上「单个 DUT 内部各 BIN 一根柱」的意图。

- 这偏 LLM 理解 + 缺主动澄清。**暂不强改**（改 prompt 风险动全局质量，属用户红线敏感区）。
- **收集**：真库重放这串对话，记录每轮 generate_chart 入参与渲染；判断是否该在**连续 2 次同问**时触发 `ask_clarification`（"您是要：A 每个DUT一根柱堆叠各BIN / B 单个DUT一张图列各BIN / C 全部DUT各出一图？"）。
- 若确认，后续可在 loop 加「同一句重复 N 次 → 强制 ask_clarification」的通用护栏（独立小改，另议）。

---

## 8. 建议实施顺序 & 交付形态

1. **第一梯队（确定性、对齐"用户重问"硬伤）**：① §2、④ §3、⑤ §5 —— 直接改 + 单测 + 加黄金集。低-中风险，无需开关。
2. **第二梯队**：②③ §4a（纯函数补解析，零风险直接改）；§4b（注入窗，**藏 `JB_INJECT_RELATIVE_TIME_WINDOW` 默认 OFF**，真库验证后 FLIP）。
3. **第三梯队（真库诊断/收集）**：⑦(a) 数据 bug 复核、⑦(b) 重复查询护栏、⑥ 收集。

**每改一处**：`cd pcr-ai-api && npm run typecheck && npm test`（全绿）。改查询/WHERE 须过 dummy-parity。提交**勿**带 `.claude/settings.local.json`（用显式 `git add <path>`）。commit trailer：`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。

---

## 9. 请回报给 Claude 的信息

1. **①④⑤**：每条修法**改前/改后**首轮工具 + 回复前若干行 + 是否对齐"第二轮正确输出"；回归句是否无误伤。
2. **②③**：§4a 单测结果；§4b 开关 ON 的 `今天`/`最近两周` 实际返回 lot 数（对比改前的 118/133）；开关 ON 时无时间词句是否行为不变。
3. **⑦(a)**：真库两条 SQL 返回 + lot 字段原始值（关键：到底是数据缺失还是精确匹配 bug）。⑦(b)：重复查询是模型行为还是路由 bug + loop trace。
4. **⑥**：4 次重放的入参/渲染 + 你判断是否值得加"重复即澄清"护栏。
5. **任何新的答非所问案例**：原样贴问句 + 回复 → Claude 标注进黄金集（`test/eval/scenarios/routing-golden.ts`），走"加 case → eval → 修 → 闸门防回退"闭环。
6. **你的判断**：哪些改动可直接并入分支 `feat/jb-route-resolver`，哪些需继续观察 / 藏开关。

---

## 10. 安全提醒

- ①③④⑤ 4a 属 agent 层正则/路由/纯函数，不动 v3/v4 SQL，风险局限在**路由命中面**；靠单测 + 黄金集 + 回归句防误伤。
- 4b（注入窗）是唯一动"模型查询参数"的改动 → **必须**藏开关 + 真库验证 + 用户 FLIP。
- ⑦(a) 若是数据 bug 则非本层能修，需上报数据/DBA；⑦(b) 护栏改 loop 须跑 `test/agentLoop.test.ts`。
- 分支 `feat/jb-route-resolver` 仍未 merge main（用户指示）；本批修复继续落此分支。
