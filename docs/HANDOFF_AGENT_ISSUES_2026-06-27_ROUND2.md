# Agent 问题交接（2026-06-27 第二轮 · 真库验证后）

> 给 **Cursor / 下一位** 的可执行排查 + 修复清单。本轮日志来自 `Desktop/New folder (3)`（**最新代码已 `npm run build` 部署后**的真库会话）。
> **硬规则**：改 WHERE / 筛选 / 排序 / 响应形状必须 **Oracle 与 Dummy 双路径同步**（dummy-parity）；改后跑 `npm test` + `npm run typecheck`（在 `pcr-ai-api/`）。

---

## ✅ 本轮已确认「生效、勿动」

- **P2 · 按指定 BIN 给 lot 排行**：`n55z 哪个lot bin35最多` → 正确按 BIN35 颗数降序（`DR42190.1X 1402 > DR42192.1H 1397 > … > DR41662.1J 968`），非坏 die 总量。`buildBinFocusedLotRankingMarkdown` 工作正常。
- **BIN×卡归因**：`bin35 集中在哪张卡` → `9416-04 65.8% / 9416-03 21.8% / 9416-01 12.4%`，正确。
- **卡型跨 lot 综述**：`9416 四张卡分别怎样` → YM 报警对比 + JB 跨 lot 良率，正确。

> 这些是上一轮（commit `5547c6a`）的成果，**不要回改**。

---

## ✅ P-A（已修复 · 2026-06-27）：`get_filter_values` device-by-mask 真库恒空

### 现象（修复前，4 会话一致）
| mask | `get_filter_values(domain:both,field:device,mask)` | 同会话 `query_yield_triggers(mask)` / `query_jb_bins(mask)` |
|---|---|---|
| P11C | `{"values":[],"totalDistinct":0,"devices":[]}` | `WB01P11C`（14 行）/ 有数据 |
| N55Z | 空 | `WC13N55Z` / 有数据 |
| N48A | 空 | `WA88888811N48A` / 有数据 |
| N94W | 空 | `WK71N94W` / 有数据 |

### 根因（Cursor 真库探针已定位，勿再查 TYPE / mask / JOIN）

**Oracle 空字符串 = NULL 语义陷阱**：`agentFilterValuesTool.ts` 里 device-by-mask 与其它 enum SQL 使用了

```sql
AND t.DEVICE IS NOT NULL AND TRIM(t.DEVICE) != ''
```

在 Oracle 中 `''` 被当作 `NULL`，故 `TRIM(t.DEVICE) != ''` 实际变为 `!= NULL`，在 WHERE 里恒为 **unknown**，**把所有行（含 `WB01P11C` 等正常 device）全部滤掉**。

探针二分（`npx tsx scripts/probe-device-by-mask.ts P11C` + 额外变体）：

| 探针 | rowCount | 说明 |
|---|---|---|
| `yield/typeOnly`（TYPE + mask） | 3 | TYPE / mask 均正常 |
| `yield/type+devNotNull`（再加 `TRIM != ''`） | **0** | 元凶 |
| `yield/count/isNotNull` | 550 | `IS NOT NULL`  alone 正常 |
| `yield/count/lenGt0` | 550 | `LENGTH(TRIM(...))>0` 正常 |
| `jb/join+regexp` | 1 | JOIN 正常 |
| `jb/full`（含 `TRIM != ''`） | **0** | 同因 |

**已排除（不要再查）**：旧 dist、mask 逻辑、`FETCH FIRST`、TYPE 裸值不匹配（`distinctType` 显示 `delta_diff`）、probeweb 连错库、异常吞没（无 ORA 报错）。

### 修复（已合入）

- 新增 [`oracleStringSql.ts`](../pcr-ai-api/src/lib/oracleStringSql.ts) → **`oracleNonEmptyTrimmedColumn(col)`**：
  `col IS NOT NULL AND LENGTH(TRIM(col)) > 0`
- 替换 [`agentFilterValuesTool.ts`](../pcr-ai-api/src/lib/agent/agentFilterValuesTool.ts) 内 **6 处**：`oracleYieldDeviceByMaskMap`、`oracleJbDeviceByMaskMap`、yield/jb 通用 enum SQL（device 列）4 处，**外加 yield/jb `probeCardType` 维度枚举的 `sub.pct != ''` 2 处**（Cursor 首轮漏修，复审补上——否则「列出有哪些卡型」也恒空）。已全库 grep `(!=|<>|=) ''` 确认无残留。
- 探针脚本 [`probe-device-by-mask.ts`](../pcr-ai-api/scripts/probe-device-by-mask.ts) 同步，便于回归。
- 单测：[`test/oracleStringSql.test.ts`](../pcr-ai-api/test/oracleStringSql.test.ts)；Dummy 形状仍走 [`test/agentFilterValues.test.ts`](../pcr-ai-api/test/agentFilterValues.test.ts)。

### 部署后回归（真库）

```bash
cd pcr-ai-api && npm run build && npm test && npm run typecheck
# 真库探针：yield/full、jb/full 应从 0 变为非 0
PCR_AI_LOCAL_DUMMY=false npx tsx scripts/probe-device-by-mask.ts P11C
PCR_AI_LOCAL_DUMMY=false npx tsx scripts/probe-device-by-mask.ts N55Z
```

Agent 侧：`get_filter_values(domain:both, field:device, mask:P11C)` 应枚举出 `WB01P11C` 等。

**Cursor 验证（2026-06-27）：** 本地探针 P11C `yield/full=3`、`jb/full=1` ✅；远程 SSE 仍 `totalDistinct:0`（dist 未 reload）——详见 [`HANDOFF_CURSOR_VERIFICATION_RESULTS_2026-06-27.md`](HANDOFF_CURSOR_VERIFICATION_RESULTS_2026-06-27.md) §2。

> **给后续改 SQL 的提醒**：凡 Oracle WHERE 里判「非空字符串」，**禁止** `!= ''` / `<> ''`；用 **`LENGTH(TRIM(col)) > 0`** 或仅 **`IS NOT NULL`**（Oracle 空串即 NULL）。其它文件若仍有 `TRIM(x) != ''` 应同样替换。

---

## 🟠 P-B：「都测试了什么lot」第一次答成**单个 lot 详情**

### 现象
`uflex 最近三天` 之后问 `都测试了什么lot` → 第一次只回单 lot `NF13252.1X` 的逐片良率（答非所问）；用户重复问一次，第二次才列出全部 54 个 lot。

### 根因
`isLotListingQuestion`（[agentJbDeterministicReply.ts:120](../pcr-ai-api/src/lib/agent/agentJbDeterministicReply.ts#L120)）的正则**未覆盖「(测试了)什么lot / 测了哪些lot」这类口语**。它认 `所有lot/全部lot/列出…lot/有哪些lot`，但 `都测试了什么lot`、`测了什么lot`、`都有什么lot` 全部落空 → `detectJbReplyMode` 继续往下走到 `isLotOverviewQuestion` → 单 lot 概况。

### 待办
- 在 `isLotListingQuestion` 增加分支，覆盖：
  `/(都|有|测试了|测了|跑了|做了)?\s*(什么|哪些|多少)\s*(lot|批次)/i`、`/(lot|批次)\s*(都|有)?\s*(有哪些|是什么|测了什么)/i`。
- 小心**不要**误吞「这片有哪些 wafer / 逐片」（已有 SEC_WAFER_ENUM 排除，保持）。
- 纯文本检测，**不涉及 SQL/dummy-parity**。加单测到 `test/agentJbDeterministicReply.test.ts`。

**Cursor 验证（2026-06-27）：** 代码+单测 ✅（`ce96b91`）；远程 SSE「uflex 最近三天 → 都测试了什么lot」✅ lot 列表。见 [`HANDOFF_CURSOR_VERIFICATION_RESULTS_2026-06-27.md`](HANDOFF_CURSOR_VERIFICATION_RESULTS_2026-06-27.md) §3.1。

---

## 🟠 P-C：「把这4张probecard的测试情况做对比」答成**单 lot 卡表**（0.0s 秒回，连答 2 次）

### 现象
`把这4张probecard 的测试情况 做一个对比` → 0.0s 直出**单 lot `DR44436.1W` 的「探针卡/机台」小表**，完全没做对比。改说法 `9416-01/02/03/04 分别怎样` 才正确对比。

### 根因
`detectJbReplyMode`（[agentJbDeterministicReply.ts:706-730](../pcr-ai-api/src/lib/agent/agentJbDeterministicReply.ts#L706-L730)）里 `isProbeCardQuestion`→`equipment`（第 715 行）**优先级太高**。`isProbeCardQuestion`（83 行）匹配 `probe\s*card`，所以「4张probecard对比」先命中 equipment（单 lot 卡/机台表），轮不到「多卡对比」判断。

### 待办
- 新增 `isMultiCardComparisonQuestion(text)`：要求**对比意图 + 多卡信号**，如
  `/对比|比较|分别|各自|哪.*张.*更|哪.*张.*差/` **且** `/(这|那)?\s*\d+\s*张|多张|几张|各\s*卡|每\s*张|\d{4}[-‑].*\d{4}[-‑]/`。
- 在 `detectJbReplyMode` **`isProbeCardQuestion` 之前** bail：命中则 `return "generic"`（交回 LLM 做跨卡综述，参照上一轮 `isCardTypeLevelOverviewQuestion` 的 bail 思路）。
- 防回归：单卡问句（`这片用什么卡` / `9416-03 用的卡`）**仍走 equipment**——单测两类都要覆盖（`test/agentJbDeterministicReply.test.ts`）。

**Cursor 验证（2026-06-27）：** 单测 ✅；**远程 SSE 严格 ❌** — 仍秒回 DR44436.1W 单 lot 卡表（仅 9416-03）。`verify-handoff-steps.mjs` 曾误判 PASS。

**Claude Code 复审（2026-06-27）— 真因找到并修复：** 上一轮只改了 `detectJbReplyMode`，但 0.0s 秒回来自 **`agentLoop.ts` `tryRunEquipmentDirectRoute`**（LLM 前的直连路由），它只判 `isProbeCardQuestion`/`isTesterMachineQuestion`，**缺多卡对比 bail** → 在 detectJbReplyMode 之前就吐了单 lot 缓存 equipment 表。已加 `isMultiCardComparisonQuestion` bail（`[equipmentRoute/skip:multiCardCompare]`）。**部署后复验 P-C 应通过**；若仍 FAIL 再查 session 缓存。

---

## 🟡 P-D：范围宽时**只输出 BIN、没有 lot**，跨多 lot 无定位价值

### 现象
`uflex 最近三天的测试情况` → 只给「主要坏 BIN 排行」（BIN40 4552 / BIN4 2217 …），但这三天跨 **54 个 lot**，混在一起算总和，工程上无法定位是哪批的问题。

### 根因（两层）
1. **LLM 选了 `aggregate_jb_bins(groupBy:"bin")`**（图省事看总览），底层数据本就没 lot 维度。
2. **确定性层** `buildAggregateBinRankingMarkdown` 老实渲染纯 bin 排行（无 lot 维度时它就只能出 bin）。

### 区分（别一刀切）
- **已锁定单 lot**（上下文已有具体 lot）→ 纯 bin 排行**合理**，保留。
- **范围宽**（平台/产品/时间窗、payload 跨多 lot 无单一 lot）→ 纯 bin **无意义**，需带 lot。

### 待办
- **prompt 引导**（[agentPrompt.ts](../pcr-ai-api/src/lib/agent/agentPrompt.ts)）：问「平台/产品/最近N天 测试情况」且无单一 lot 时，聚合带 lot 维度（`groupBy:"bin,lot"`）或先走 `lot_listing` 列出各 lot。
- **确定性兜底**：渲染前若检测到 `groupBy` 仅 `bin` 且 payload 跨多 lot（`multiLotDistinctCount>1` / `recentLots.length>1`），**不出纯 bin 表**，改为 bin+lot 关联表（复用 `buildMultiLotBinTable` / `buildBinFocusedLotRankingMarkdown` 思路）或提示「按 lot 下钻」。
- 改聚合渲染/维度记得 **dummy-parity** + `npm test`。

**Cursor 验证（2026-06-27）：** 远程 SSE「uflex 最近三天 → 哪个lot bin40最多」✅ 出 bin+lot 排行（NF13300.1C 2352 …）。见验证文档 §3.3。

---

## 🟢 P-E（低优先）：N94W 会话混入上一产品 device 的 stray 工具调用
`mqw5rjgk` 中查 N94W 时，LLM 误发了一次 `query_jb_bins(device:"WA88888811N48A")`（上一轮 N48A 残留）。**最终答案用的是正确的 WK71N94W**，实害小。可在 prompt / 历史压缩侧提醒「device 须取本轮 mask 解析值，勿沿用上一产品」。

## 🟢 P-F：`query_lot_dut_bin_agg` good bin 混入 + focusBin 未生效

### 现象（修复前）
多个会话工具输出首行是 `BIN1 / BIN55`（good bin），`总坏die` 列填的是 good die 总数。`focusBin:79` 仍混出 **BIN55**。

### 根因
`toolQueryLotDutBinAgg` 调用 `buildDutConcentrationInsights(rawPasses, [])` **未传** `focusBins` / `goodBins`。

### 修复（Cursor 2026-06-27 · commit 含本实现）
- `goodBinNumbersFromSiteBinPasses()` + `lotDutConcentrationOpts()` → 四处 handler 同步。
- 单测 `goodBins excludes passing bins` + 既有 `focusBins` 用例 ✅。
- **远程 curl 未验** — 见 [`HANDOFF_CURSOR_VERIFICATION_RESULTS_2026-06-27.md`](HANDOFF_CURSOR_VERIFICATION_RESULTS_2026-06-27.md) §4。

---

## 端到端验证 + 结果回传（给 Cursor / Claude Code）

**Cursor 已跑完并记录：** [`HANDOFF_CURSOR_VERIFICATION_RESULTS_2026-06-27.md`](HANDOFF_CURSOR_VERIFICATION_RESULTS_2026-06-27.md)（摘要副本：`scratchpad/cursor-verification-2026-06-27.txt`）。

两类问题用两种验证方式，别混：

### A. P-A（SQL 层）→ 直接跑脚本，**不用 LLM**
见上方「第 0 步」。`npx tsx scripts/probe-device-by-mask.ts <mask>` → 把输出贴回 / 写进 `scratchpad/probe-result.txt` 回传给 Claude 分析。这是定位 P-A 最快路径。

### B. P-B / P-C / P-D（路由 + LLM 行为）→ 走 LLM 端到端，看回答对不对
用 curl 直接打 Agent SSE 接口提问（不用开浏览器）：
```bash
curl -N -X POST http://localhost:30008/api/v4/agent/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"都测试了什么lot"}],"agentConfig":{"maxRounds":5}}'
```
- `apiKey` 不传则回退服务器 env `AGENT_API_KEY` / `SILICONFLOW_API_KEY`；没配就在 `agentConfig.apiKey` 里填。
- SSE 流里能看到工具调用与最终中文回答；**确定性表是否正确、有没有答非所问**直接可判。
- 多轮场景（如 P-C「先列 4 张卡，再问对比」）按顺序发多次，带上 `sessionId` 续跑。
- 验证清单：
  - P-B：问 `都测试了什么lot` / `测了哪些lot` → 应直接出 **lot 列表**，不是单 lot 概况。
  - P-C：问 `把这4张probecard的测试情况做对比` → 应进 LLM 做**跨卡综述**，不是单 lot 卡表秒回。
  - P-D：问 `uflex 最近三天的测试情况` 后追问 `哪个lot bin40最多` → 应出 **bin+lot 关联表**。
- 把 SSE 输出（或关键片段）贴回 Claude 即可。SQL 相关疑点再配合 pm2 `[agentSql/...]` 日志。

> 反馈环要点：**一次只验证/打透一个问题到闭环**，把脚本或 curl 的真实输出回传，Claude 据此判断真好了没——而不是攒一批日志再盲改。

---

## 执行顺序建议
1. ~~**P-A**~~：**已修复**（见上文 ✅ P-A）；部署后跑探针 + `get_filter_values` 真库回归即可。
2. **P-B、P-C**：纯文本检测正则，改动小、风险低、收益直接，配单测。
3. **P-D**：prompt + 确定性兜底，注意 dummy-parity。
4. **P-E、P-F**：有余力再做。

每步完成跑 `npm test` + `npm run typecheck`（`pcr-ai-api/`），保持 Oracle/Dummy 双路径同步。
