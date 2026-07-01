# 交接:给 Cursor 的下一步(2026-07-01 · Claude → Cursor)

> **背景**：Cursor 2026-07-01 真库验证（`docs/HANDOFF_CURSOR_VERIFICATION_RESULTS_2026-07-01.md`）是用**旧 dist `89c77b3`** 跑的，**未包含** Claude 的 A1-4 修复 `9f90e94`。本文档列出需 Cursor 做的四件事。
> **开关**：`JB_DETERMINISTIC_DISPATCH` 可保持 **true**；`JB_LLM_INTENT_CLASSIFIER` 请设 **false** 后再测（两个 250s 超时 + Pass C 均在分类器开时出现，先隔离变量）。

---

## 0. 一眼清单

| # | 任务 | 优先级 | Claude 需要的回传 |
|---|---|---|---|
| 1 | 重部署含 `9f90e94` 的 dist → 复测 **A1-4** | ⭐ 高 | A1-4 首轮工具 + 是否出跨 lot 排名表 |
| 2 | 排查 **P-D `哪个lot bin40最多` 250s 超时**（疑 `35225b1` PASSTYPE 扩量） | ⭐ 高 | 该查询真库行数 + 耗时 + 是否 DB 侧慢 |
| 3 | 抓 **P-A `undefined.length`** 的报错栈行号 | 中 | stack trace 具体文件:行 |
| 4 | 补跑 **live 误分类率**（可选，定阶段二 FLIP） | 低 | 误分类率数字 + 回退问句清单 |

---

## 1. 复测 A1-4（Claude 已修 `9f90e94`，待部署验证）

**必须先重新构建 + 部署 dist**（Cursor 上次测的旧 dist 无此修复）：
```bash
cd pcr-ai-api
git pull                       # 确认含 9f90e94
npm ci && npm run build        # 重建 dist（含 verify-dist-no-undici）
pm2 reload <app>               # 或你的部署方式
curl -s http://10.192.130.89:30008/health   # 确认起来
```

**复跑**（`JB_DETERMINISTIC_DISPATCH=true`，`JB_LLM_INTENT_CLASSIFIER=false`）：
```bash
cd pcr-ai-api
VERIFY_OUT=../scratchpad/step2-dispatch-<date>.txt node scripts/verify-step2-dispatch.mjs all
```

**A1-4 期望**（修复后）：`WC13N55Z 各 lot 良率 top5`
- 首轮 `query_jb_bins`，**`dispatch=true`**（此前 false）；
- 输出**跨 lot 良率排名表**（表头形如「良率最差 N 个 lot（共 M 个 lot…）」，含多行 lot / 良率% / 测试结束时间），**不再**是单 lot `DR44919.1F` 概况。

**收紧脚本断言**（`verify-step2-dispatch.mjs` A1-4）：把「`lots>=1` 即 PASS」改为要求 `lots>=3` **或** 表头含「良率排名 / 各 lot 良率 / 良率最差」——否则单 lot 概况会被误判 PASS（这是 6/30、7/1 两次漏判的原因）。

**Claude 已做的验证**（沙箱，可信但非真库）：
- `mode("N55Z device 各 lot 良率 top5") = lot_yield_ranking`（此前 lot_overview）；
- 端到端渲染路径：dispatch → `query_jb_bins(mask:N55Z)` → payload 的 `lotYieldRankByTestEnd`（多 lot rows 生成）→ `emitDeterministicJbTablesReply` 命中 lot_yield_ranking → `buildLotYieldRankingMarkdown` 出排名表；
- 黄金集 baseline 零回退；dispatch 正确性 failures=`[]`，dispatched 2→4；相关测试 101 pass / 0 fail。
- **若真库复测仍不出排名表**：抓该 session 的 `query_jb_bins` 返回 JSON，确认 `lotYieldRankByTestEnd` 字段是否存在且非空（若空 → 说明 mask 查询未回该字段，回传给 Claude 定位序列化/体积裁剪）。

---

## 2. 排查 P-D 超时（疑 PASSTYPE 扩量性能回归）

**现象**：`哪个lot bin40最多`（P-D）**6/30 PASS**（出 lot+BIN40 排行表），**7/1 250s idle 超时**。

**Claude 假设**：中间部署了 `35225b1 fix(api): expand JB v3 PASSTYPE scope`，把 JB PASSTYPE 从 `IN ('TEST','INTERRUPT')` 扩到含 **`TEST ISR` / `TEST INTERRUPT` / `RETESTBIN`** → **命中行数变多** → 跨 lot 聚合变慢 → 超时。**这是 `35225b1` 的性能副作用，非 Claude 的路由工作。**

**请 Cursor 验证**（真库，Claude 无法做）：
1. 直接量该问句触发的 JB 查询**行数**与**耗时**：
   - 扩 PASSTYPE 前后行数差多少？（可临时对比 `IN ('TEST','INTERRUPT')` vs 现状的 COUNT）
   - 单次 Oracle 查询耗时是否已接近/超过 idle 超时（当前 `AGENT_STREAM_TIMEOUT_MS` 你们环境 = 250000ms）？
2. 若确认是行量导致：
   - 选项 A：给这类跨 lot 重聚合加**时间窗默认**（如无时间词默认近 N 月）或 **COUNT 上限护栏**（超限提示收窄范围，而非硬跑到超时）；
   - 选项 B：评估 `RETESTBIN` 等是否真该进 bin 排行聚合（重测 bin 可能重复计数，既影响正确性也放大行量）——这点请产品/你们确认口径。
3. **回传**：该查询的行数、耗时、Oracle 执行计划（若能取），以及是否只在 bin 排行类问句上超时（`P-D`）还是所有 mask/device 级聚合都变慢。

> Claude 侧：护栏（默认时间窗 / COUNT 上限）可在 agent scope 层加，但**必须有真库行数/耗时数据**才能定阈值，否则拍脑袋。等你回数据再改。

---

## 3. 抓 P-A `undefined.length` 报错栈

**现象**：P-A（`get_filter_values` P11C）流中**偶发** error event `Cannot read properties of undefined (reading 'length')`，虽 PASS 但不该出现。

**请 Cursor**：
- 复跑 `node scripts/verify-handoff-steps.mjs pa`（或 all），在 API 端**打开 stack trace 日志**（该 error 抛出处的 `文件:行号`）。多半在 `agentLoop.ts` 或分类器/流式过滤某分支读了 `undefined.length`。
- 回传：完整 stack trace（至少最内层 3 帧）+ 触发的 session id。

拿到行号 Claude 直接加空值防御（这是确定性 bug，改完加单测）。

---

## 4.（可选）补跑 live 误分类率

定阶段二（分类器）能否 FLIP 的硬指标：
```bash
cd pcr-ai-api
AGENT_EVAL_LIVE=1 AGENT_API_KEY=<key> AGENT_SUBAGENT_MODEL=<model> \
  npx tsx --test test/agentEval.test.ts
```
回传：误分类率数字（应 ≤2%）+ 回退/误分类问句清单。

---

## 5. FLIP 现状（供用户决策）

| 开关 | 建议 | 理由 |
|---|---|---|
| `JB_DETERMINISTIC_DISPATCH` | **可保持 true** | A1-1/A1-2 稳定；A1-4 修复后应闭环（任务 1 确认）|
| `JB_LLM_INTENT_CLASSIFIER` | **保持 false** | 两个 250s 超时 + Pass C 均分类器开时出现；且 B2-1/B2-2 空回复虽已改善但需 misclass 数字才敢翻 |

---

## 6. 已判定为「非 bug / 可接受」（无需再测）

- **B2-3** `哪片卡 bin35 出得最多` → 无 scope 时**澄清合理**（强行全库 BIN×卡 aggregate 慢且噪声大）。脚本对此应判 PASS。
- **Pass C 明确 + invalid apiKey 无表** → 坏 key 本就阻断 LLM（分类器与最终中文总结都要 key），**预期行为**，非降级缺陷。
- **B2-1 / B2-2** → 6/30 空回复/截断，7/1 已改善为正常澄清，**无需再修**。

---

## 7. 分支

所有改动在 `feat/jb-route-resolver`，**未 merge main**（遵用户指示）。A1-4 修复 `9f90e94` 已在该分支。
