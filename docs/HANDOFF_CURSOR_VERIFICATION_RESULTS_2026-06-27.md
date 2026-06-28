# Cursor 真库验证结果交接（2026-06-27～28 · 给 Claude Code）

> **执行者：** Cursor Agent  
> **问题背景 / 修复说明：** [`HANDOFF_AGENT_ISSUES_2026-06-27_ROUND2.md`](HANDOFF_AGENT_ISSUES_2026-06-27_ROUND2.md)  
> **复跑脚本：** `pcr-ai-api/scripts/verify-handoff-steps.mjs`（Agent SSE）；`pcr-ai-api/scripts/probe-device-by-mask.ts`（SQL 探针）  
> **短摘要副本：** [`scratchpad/reverify-2026-06-27.txt`](../scratchpad/reverify-2026-06-27.txt)

---

## 0. 给 Claude Code 的一眼结论（2026-06-28 最终）

| ID | 代码状态 | 远程 SSE 严格复验 | 备注 |
|---|---|---|---|
| **P-A** | ✅ `0177538` + `53bfb97` | ✅ `totalDistinct=3` | 部署后闭环 |
| **P-B** | ✅ `ce96b91` | ✅ lot 列表 | — |
| **P-C** | ✅ `1b6c9cb` + **本 commit summary bail** | ✅ 重跑通过（首轮偶发 FAIL） | 见 §3.2 |
| **P-D** | ✅ `ce96b91` | ✅ bin+lot 排行 | — |
| **P-E** | prompt only | — | 低优先 |
| **P-F** | ✅ `31ea104` | ✅ 仅 BIN79 集中度表 | — |

**5/5 闭环**（API 余额恢复 + 服务器 dist 已 reload 后）。

**本 commit 新增：** P-C summary 轮 `multiCardCompareBail` + 收紧 `verify-handoff-steps.mjs`（严格 P-A/P-C + P-F 场景）。

---

## 1. 环境与 commit 基线

| 项 | 值 |
|---|---|
| 分支 | `feat/dynamic-prompt-injection` |
| 远程 API | `http://10.192.130.89:30008` |
| 关键 commit（时间序） | `0177538` P-A Oracle 空串 · `53bfb97` probeCardType 补 2 处 · `ce96b91` P-B/C/D/E · `1b6c9cb` P-C equipment 直连 bail · `31ea104` P-F · `c492bed` 部署复验清单 · **本 commit** P-C summary bail + verify 脚本 |
| 本地单测 | 398 total / 396 pass / 2 skip / 0 fail |
| 中间阻塞 | ① 远程旧 dist（P-A `totalDistinct=0`）② SiliconFlow **403 余额不足**（P-C/D/F 多轮中断）— 均已恢复 |

---

## 2. P-A：`get_filter_values` device-by-mask

### 根因（已修）

Oracle `''` ≡ `NULL` → `TRIM(col) != ''` 恒 unknown → 全行滤掉。  
修复：`oracleStringSql.oracleNonEmptyTrimmedColumn` → `LENGTH(TRIM(col)) > 0`（6 处 + probe 脚本 + 单测）。

### 本地 SQL 探针（修复后）

```bash
PCR_AI_LOCAL_DUMMY=false npx tsx scripts/probe-device-by-mask.ts P11C
```

| 探针 | rowCount | sample |
|---|---:|---|
| `yield/full` | **3** | WB00P11C, WA00P11C, WB01P11C |
| `jb/full` | **1** | WB01P11C |

### 远程 SSE（部署 + 严格脚本）

Session `v-d0b8f0bc-…`，问句 `P11C 最近的测试情况`：

```json
{"domain":"both","field":"device","values":["WB01P11C (Yield: 2026-06-18, JB: 2026-06-27)","WA00P11C (Yield: 2024-11-05)","WB00P11C (Yield: 2024-10-19)"],"totalDistinct":3}
```

**严格判定：✅ PASS**

---

## 3. P-B / P-C / P-D

### 3.1 P-B — lot 列表口语 ✅

| 项 | 值 |
|---|---|
| Session | `pb-01405058-…` |
| 多轮 | ① `uflex 最近三天` → ② `都测试了什么lot` |
| 结果 | ~50 lot 列表，非单 lot 逐片概况 |

### 3.2 P-C — 多卡对比（三层 bail）

**现象：** ① `9416 卡的测试情况` → ② `把这4张probecard的测试情况做对比` 偶发秒回单 lot equipment 表（仅 9416-02）。

**已修路径（按拦截顺序）：**

| 层 | 位置 | commit | 日志 tag |
|---|---|---|---|
| 1 | `detectJbReplyMode` → `generic` | `ce96b91` | — |
| 2 | `tryRunEquipmentDirectRoute` bail | `1b6c9cb` | `[equipmentRoute/skip:multiCardCompare]` |
| 3 | `tryRunDeterministicJbSummary` bail | **本 commit** | `[jbDeterministic/multiCardCompareBail]` |

**远程复验时间线：**

| 轮次 | Session | 结果 | 说明 |
|---|---|---|---|
| 首轮 `all` | `pc-feb35b36-…` | ❌ FAIL | 单 lot DR44042.1A + 9416-02 equipment 表（summary 劫持） |
| 重跑 `pc` | `pc-ce2bb474-…` | ✅ PASS | 跨 9416-01/02/03/04 综述（YM 报警 + JB lot 覆盖） |

**建议：** 部署本 commit 后 P-C 更稳定；pm2 日志应见 equipment skip 或 summary bail，不应再 0.0s 单 lot 表。

### 3.3 P-D — bin+lot 定位 ✅

Session `pd-e8421ad9-…`：BIN40 各 lot 排行 NF13329.1F 1400 / NF13338.1K 1323 / …

---

## 4. P-F：`query_lot_dut_bin_agg` ✅

Session `pf-e939fa32-…`：

- 多轮：① `NF13322.1J 哪一片 wafer bin79 最多` → ② `哪个卡 哪个dut 测试出的 bin79 最多`
- 集中度表：**仅 BIN79**，无 BIN1/BIN55
- 代码：`31ea104` — `goodBins` + `focusBins` 经 `lotDutConcentrationOpts()` 传四处 handler

---

## 5. 验证脚本（本 commit）

`pcr-ai-api/scripts/verify-handoff-steps.mjs`：

- **P-A**：`get_filter_values` JSON `totalDistinct > 0` 才 PASS
- **P-C**：≥2 张 `9416-0x` 或跨卡综述；单 lot equipment 表判 FAIL
- **P-F**：新增 pf 场景
- 输出 → `scratchpad/reverify-2026-06-27.txt`

```bash
cd pcr-ai-api
PCR_AI_LOCAL_DUMMY=false npx tsx scripts/probe-device-by-mask.ts P11C
node scripts/verify-handoff-steps.mjs all   # 或 pa|pb|pc|pd|pf
```

---

## 6. 曾出现的非代码阻塞（已解决）

| 症状 | 原因 | 处理 |
|---|---|---|
| P-A `totalDistinct=0` 但本地探针 OK | 远程跑旧 dist | `npm run build && pm2 reload` |
| P-C/D/F HTTP 403 | SiliconFlow 余额不足 | 充值 / 换 `AGENT_API_KEY` |
| P-C 首轮 FAIL、重跑 PASS | summary 轮未 bail（本 commit 修） | 部署后应稳定 |

---

## 7. Claude Code 建议后续（可选）

1. **合并本 commit 并 deploy** — 含 P-C summary bail + 严格 verify 脚本。
2. 部署后复跑 `verify-handoff-steps.mjs all`，期望 **5/5** 且 P-C 首轮即 PASS。
3. **P-E**（stray device 工具调用）：低优先，prompt/历史压缩提醒即可。
4. 若 P-C 仍偶发 FAIL：查 pm2 是否同时出现 `equipmentRoute/skip` 与 `multiCardCompareBail`；确认 LLM 是否被 maxRounds 截断。

---

## 8. 附录

```
GET http://10.192.130.89:30008/health
→ {"status":"ok","agentEnabled":true,"agentJbDeterministicSummary":true,"agentJbCacheVersion":6}
```
