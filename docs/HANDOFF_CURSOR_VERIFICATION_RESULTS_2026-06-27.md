# Cursor 真库验证结果交接（2026-06-27 · 给 Claude Code）

> **执行者：** Cursor Agent（按 [`NEXT_STEPS_FOR_CURSOR_2026-06-27.md`](NEXT_STEPS_FOR_CURSOR_2026-06-27.md) 步骤 1→2→3）。  
> **问题背景 / 修复说明：** [`HANDOFF_AGENT_ISSUES_2026-06-27_ROUND2.md`](HANDOFF_AGENT_ISSUES_2026-06-27_ROUND2.md)。  
> **复跑脚本：** `pcr-ai-api/scripts/verify-handoff-steps.mjs`（Agent SSE）；`pcr-ai-api/scripts/probe-device-by-mask.ts`（SQL 探针，不经 LLM）。

---

## 1. 环境与代码基线

| 项 | 值 |
|---|---|
| 验证日期 | 2026-06-27 |
| 分支 | `feat/dynamic-prompt-injection` |
| 已 push 的修复 commit | `0177538`（P-A Oracle 空串）、`53bfb97`（probeCardType 枚举补 2 处）、`1cc2702`（NEXT_STEPS 文档） |
| 更早相关 commit | `ce96b91`（P-B/C/D/E 代码 + 单测） |
| **远程 API** | `http://10.192.130.89:30008`（`/health` OK，`agentEnabled:true`） |
| **本地 Oracle 探针** | 本机 `pcr-ai-api` + `.env` 连真库（Thin 模式，有 NJS-116 提示但不影响本次探针） |
| **Cursor 本地未提交** | P-F 实现 + `verify-handoff-steps.mjs` + `DEV_LOG` / `TODO` / `NEXT_STEPS` 更新 |

**关键结论：** 本地 SQL 探针已证明 P-A 修复有效；**远程 10.192.130.89 的 dist 在验证时尚未 reload**，故 SSE 里 `get_filter_values` 仍为空 JSON，但 Agent 靠 `query_*` fallback 仍能答对。

---

## 2. P-A：`get_filter_values` device-by-mask（SQL 探针）

### 2.1 命令

```bash
cd pcr-ai-api
PCR_AI_LOCAL_DUMMY=false npx tsx scripts/probe-device-by-mask.ts P11C
PCR_AI_LOCAL_DUMMY=false npx tsx scripts/probe-device-by-mask.ts N55Z
```

### 2.2 修复前（Cursor 首轮定位，P11C）

| 探针段 | rowCount | 说明 |
|---|---:|---|
| `yield/full` | **0** | 复现生产 bug |
| `yield/noType` | 3 | 去掉 TYPE 后有 device |
| `yield/onlyMask` | 3 | mask 逻辑正常 |
| `yield/distinctType` | 3 组 | `delta_diff` CNT=550 |
| `jb/full` | **0** | 同因 |
| `jb/onlyMaskNoJoin` | 3 | INFCONTROL 有 device |

**二分定位（额外探针，未写入 probe 脚本主流程）：**

| 探针 | rowCount | 结论 |
|---|---:|---|
| `yield/typeOnly` | 3 | TYPE 条件无误 |
| `yield/type+devNotNull`（含 `TRIM != ''`） | **0** | **元凶** |
| `yield/count/isNotNull` | 550 | `IS NOT NULL` 正常 |
| `yield/count/lenGt0` | 550 | `LENGTH(TRIM)>0` 正常 |
| `jb/join+regexp` | 1 | JOIN 正常 |

**根因：** Oracle 中 `''` ≡ `NULL`，`TRIM(col) != ''` → `!= NULL` → WHERE 恒 unknown。  
**修复：** `oracleStringSql.oracleNonEmptyTrimmedColumn`（commit `0177538` + `53bfb97`）。

### 2.3 修复后（本地真库，2026-06-27 Cursor 复跑）

**P11C**

| 探针段 | rowCount | sample |
|---|---:|---|
| `yield/full` | **3** | WB00P11C, WA00P11C, WB01P11C |
| `yield/noType` | 3 | 同上 |
| `yield/onlyMask` | 3 | 同上 |
| `yield/distinctType` | 3 TYPE | delta_diff 550 / low_yield 38 / ConseFail 12 |
| `jb/full` | **1** | WB01P11C |
| `jb/onlyMaskNoJoin` | 3 | WA00P11C, P11C-CORR, WB01P11C |

**N55Z**

| 探针段 | rowCount | sample |
|---|---:|---|
| `yield/full` | **6** | WC13N55Z, WB02N55Z, WC12N55Z, WA02N55Z, WA01N55Z, WC02N55Z |
| `jb/full` | **2** | WC13N55Z, WC12N55Z |
| `jb/onlyMaskNoJoin` | 6 | 含 *-ENG 变体 |

**首轮还曾跑 P48A / N94W（修复前模式一致）：** 四个 mask 均为 `yield/full=0`、`jb/onlyMaskNoJoin>0` —— 与 P11C 同因。

### 2.4 P-A Agent SSE（远程，修复代码未部署到 10.192.130.89）

```bash
node scripts/verify-handoff-steps.mjs pa
# 等价：POST /api/v4/agent/chat  message="P11C 最近的测试情况"
```

| 项 | 结果 |
|---|---|
| Session | `v-64d2bc9e-2155-407d-bfc3-cf9a3d2334b6` |
| `get_filter_values` 工具 JSON | **`{"domain":"both","field":"device","values":[],"totalDistinct":0,"devices":[]}`** ❌ 仍空 |
| 最终中文回答 | ✅ 含 **WB01P11C**、lot 列表（前 50/共 99），例 TR23373.1T @ b3flex32 |
| **严格判定** | SQL 层已修；**SSE 闭环待 `npm run build && pm2 reload`** |
| 脚本判定 | PASS（脚本过宽：fallback 有 WB01P11C 即过） |

---

## 3. P-B / P-C / P-D：Agent SSE（远程 10.192.130.89）

脚本：`node scripts/verify-handoff-steps.mjs pb|pc|pd`

### 3.1 P-B — lot 列表口语

| 项 | 值 |
|---|---|
| Session | `pb-adc7b79e-a5e4-4218-9fa2-3f0189ab1a98` |
| 多轮 | ① `uflex 最近三天` → ② `都测试了什么lot` |
| 脚本判定 | **PASS**（检测到 ~4 个 lot id） |
| 严格预期 | lot **列表**，非单 lot 逐片概况 |
| 备注 | 上下文较窄时 lot 数少于 54；行为符合 lot_listing，非 lot_overview |

**单测（本地 dummy，commit `ce96b91`）：**

```
agentJbDeterministicReply.test.ts
  ✔ P-B: '都测试了什么lot' routes to lot_listing not lot_overview
  ✔ detects lot listing vs single-lot overview
```

### 3.2 P-C — 多卡对比 bail

| 项 | 值 |
|---|---|
| Session | `pc-9554504e-a521-4ad9-8f75-124e4cd19e24` |
| 多轮 | ① `9416 卡的测试情况` → ② `把这4张probecard的测试情况做对比` |
| 实际回答摘要 | **单 lot** DR44436.1W；**各测试层探针卡** 仅 **9416-03** 一行；机台 b3ps1612 |
| 脚本判定 | PASS（误判：正则 `9416-0[1-4]` 命中 `9416-03`） |
| **严格判定** | **FAIL** ❌ — 仍是 0.0s 单 lot equipment 卡表，**非**跨 9416-01/02/03/04 对比综述 |
| 单测 | ✅ `isMultiCardComparisonQuestion` / bail 逻辑通过（本地） |
| 待 Claude 跟进 | 部署 `ce96b91` 后复验；若仍 FAIL，查线上 `detectJbReplyMode` 顺序 / 缓存 / 确定性层是否仍劫持 |

**单测输出：**

```
  ✔ P-C: multi-card comparison bails to generic, single-card stays equipment
```

### 3.3 P-D — 平台宽范围 bin+lot 定位

| 项 | 值 |
|---|---|
| Session | `pd-89b16441-5ca1-4e93-aca5-abf05e6a6ebc` |
| 多轮 | ① `uflex 最近三天的测试情况` → ② `哪个lot bin40最多` |
| 实际回答摘要 | **各 lot BIN40 坏 die 排行**（平台 UFLEX 2026-06-24～27，合计 8292） |
| Top lots | NF13300.1C 2352 / NF13302.1L 1764 / NF13269.1R 1584 / … |
| 脚本判定 | **PASS** ✅ |
| 严格判定 | **PASS** ✅ — bin+lot 关联表，非纯 bin 总排行 |

---

## 4. P-F：`query_lot_dut_bin_agg`（Cursor 实现 · 本地 · 未 push）

### 4.1 改动摘要

| 文件 | 改动 |
|---|---|
| `agentDutConcentration.ts` | `goodBins?: Set<number>`；`goodBinNumbersFromSiteBinPasses()`（avg die/DUT > 100，与 `compactSiteBinPasses` 一致） |
| `agentToolHandlers.ts` | `lotDutConcentrationOpts(rawPasses, focusBinNum)` → 四处 `buildDutConcentrationInsights` 均传 `focusBins` + `goodBins` |
| `agentDutConcentration.test.ts` | 新增 `goodBins excludes passing bins`；原有 `focusBins limits` 仍绿 |

### 4.2 单测

```
agentDutConcentration.test.ts
  ✔ goodBins excludes passing bins from concentration table
  ✔ focusBins limits which bins are analyzed
```

### 4.3 真库 curl（P-F 验收问句 — **未跑**）

待部署 P-F 后：

```
1) NF13322.1J 哪一片 wafer bin79 最多
2) 哪个卡 哪个dut 测试出的 bin79 最多
```

**判定：** DUT 集中度表仅 BIN79，无 BIN1/BIN55。

---

## 5. 全量 `npm test` / typecheck（P-F 改动后，本地）

```bash
cd pcr-ai-api && npm test && npm run typecheck
```

| 项 | 结果 |
|---|---|
| 测试总数 | **398** |
| 通过 | **396** |
| 跳过 | 2（既有 Oracle 可选 `db/ping`、`table-rows`） |
| 失败 | **0** |
| `tsc --noEmit` | **通过** |

**新增/相关用例：**

- `test/oracleStringSql.test.ts` — Oracle 空串陷阱（commit `0177538`）
- `test/agentFilterValues.test.ts` — P1 session shape、device-by-mask dummy
- `test/agentJbDeterministicReply.test.ts` — P-B、P-C 路由
- `test/agentDutConcentration.test.ts` — goodBins + focusBins（Cursor P-F，未 commit）

---

## 6. 验证汇总表（给 Claude Code 一眼看）

| ID | 本地 SQL 探针 | 本地单测 | 远程 SSE（10.192.130.89） | 阻塞项 |
|---|---|---|---|---|
| **P-A** | ✅ yield/full、jb/full > 0 | ✅ oracleStringSql + agentFilterValues | ⚠️ `get_filter_values` **仍空**；回答靠 fallback ✅ | **pm2 reload** 部署 `0177538`+`53bfb97` |
| **P-B** | — | ✅ | ✅ lot 列表（~4 lot，上下文窄） | 无 |
| **P-C** | — | ✅ | ❌ **仍单 lot 卡表**（脚本误判 PASS） | 部署 `ce96b91` 后复验；可能需再查 deterministic 劫持 |
| **P-D** | — | — | ✅ bin+lot 排行表 | 无 |
| **P-E** | — | — | （未单独 curl；prompt 已合入 `ce96b91`） | — |
| **P-F** | — | ✅ goodBins/focusBins | ⬜ **未验** | commit + deploy 后跑 P-F curl |

---

## 7. 建议 Claude Code 下一步

1. **合并并部署** Cursor 本地未提交改动（P-F + `verify-handoff-steps.mjs` + 本文档）。
2. 服务器：`cd pcr-ai-api && npm run build && pm2 reload`。
3. 复跑：
   ```bash
   PCR_AI_LOCAL_DUMMY=false npx tsx scripts/probe-device-by-mask.ts P11C
   node scripts/verify-handoff-steps.mjs all
   ```
4. **收紧 P-A 脚本判定：** `get_filter_values` 的 `totalDistinct` 必须 > 0，不能仅靠 fallback 有 WB01P11C。
5. **收紧 P-C 脚本判定：** 必须出现 ≥2 张 9416-0x 卡或明确「对比/分别」跨卡综述，单卡 equipment 表判 FAIL。
6. P-C 若部署后仍 FAIL：读 SSE 中 `detectJbReplyMode` / 是否仍走 `equipment`；对照 `isMultiCardComparisonQuestion` 与 session 缓存。
7. P-F 部署后跑 §4.3 curl，确认集中度表无 good bin、focusBin 生效。

---

## 8. 附录：远程 health 探针

```
GET http://10.192.130.89:30008/health
→ {"status":"ok","service":"pcr-ai-api","agentEnabled":true,"agentJbDeterministicSummary":true,"agentJbCacheVersion":6}
```

本地 `localhost:30008` 验证时 **无法连接**（API 未在本机监听）。
