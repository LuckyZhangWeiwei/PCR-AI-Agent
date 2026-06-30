# 步骤 2 · 阶段三派发验证交接（给 Claude Code · 2026-06-30）

> **执行者：** Cursor Agent  
> **前置：** 步骤 1 基线 5/5 PASS（见 `HANDOFF_STEP1_BASELINE_2026-06-30.md`）  
> **用户配置：** `JB_DETERMINISTIC_DISPATCH=true`，`JB_LLM_INTENT_CLASSIFIER=false`  
> **脚本：** `pcr-ai-api/scripts/verify-step2-dispatch.mjs`（本 commit 新增）  
> **详细日志：** [`step2-dispatch-2026-06-30.txt`](step2-dispatch-2026-06-30.txt)

---

## 0. 一眼结论

| 项 | 结果 |
|---|---|
| FLIP Test A 核心（A1-1 / A1-2） | ✅ **派发生效**：首轮 `aggregate_jb_bins(groupBy:bin,cardId)` + 直出 BIN×卡表 |
| FLIP Test A2 不误伤（A2-1 / A2-4） | ✅ 单 lot 概况 / 无数据 mask 未 dead-end |
| A1-4 `WC13N55Z 各 lot 良率 top5` | ⚠️ **脚本 PASS 但行为不符 spec**（见 §3.4） |
| 脚本汇总 | 5/5 PASS（A1-4 判定过宽，建议 Claude 收紧） |

**阶段三 FLIP 判据（HANDOFF_FLIP §4）：A1 核心句稳定 + A2 无误伤 → 可考虑长期保持 `JB_DETERMINISTIC_DISPATCH=true`。A1-4 派发路径待跟进。**

---

## 1. 环境

| 项 | 值 |
|---|---|
| API | `http://10.192.130.89:30008` |
| 验证 UTC | 2026-06-30T12:13～12:20 |
| 耗时 | ~6.9 min（5 场景） |
| 开关（用户确认） | `JB_DETERMINISTIC_DISPATCH=true`，分类器关 |

---

## 2. Test A — 派发命中（核心）

### A1-1 ✅（根治 turn1 选错工具）

- **Session:** `a1-1-81a879ad-…`
- **问句:** `n55z 哪个卡测出bin35 多`
- **SSE:** `status: 正在按意图直发查询…` → **首轮** `tool_start: aggregate_jb_bins`
- **Args:** `{"groupBy":"bin,cardId","groupTop":20,"mask":"N55Z"}`
- **输出:** BIN35 × 9416-01/02/03/04 排行表（0.x s 级，无 LLM 选工具轮）

### A1-2 ✅

- **Session:** `a1-2-6aa82751-…`
- **多轮:** `n55z 最近测试情况` → `BIN35 集中在哪张卡`
- **首轮工具:** `aggregate_jb_bins`（dispatch=true）
- **输出:** 同上 BIN×卡表

---

## 3. 其余场景

### A2-1 ✅ 单 lot 概况不误伤

- **问句:** `NF13338.1K 概况`
- **首轮:** `query_jb_bins`（非 bin×card aggregate）
- **输出:** 标准 lot 概况 + 各片良率表

### A2-4 ✅ 无数据 graceful

- **问句:** `ZZZZZ 哪个卡测出bin99 多`
- **输出:** 中文说明未找到 + 排查建议（无 SSE error、无空白）

### A1-4 ⚠️ 行为与 FLIP spec 不一致（脚本误判 PASS）

- **问句:** `WC13N55Z 各 lot 良率 top5`
- **期望（FLIP A1-4）:** 派发 `query_jb_bins` → **跨 lot 良率排名**（top5）
- **实际:** `dispatch=false`，首轮 `query_jb_bins` 但直出 **单 lot `DR44919.1F` 概况 + 逐片表**（仅 1 个 lot）
- **根因假设:** `lot_yield_ranking` 未命中派发 / `resolveDispatch` 为 null → 落 LLM 或 equipment 路由；或 device 解析后走了 lot_overview
- **建议 Claude:** 查 `isLotYieldRankingQuestion` / `lot_yield_ranking` plan + `emitDeterministicJbTablesReply` 对 device 级 ranking 的渲染；收紧 `verify-step2-dispatch.mjs` A1-4 断言（要求 `lots>=3` 或表头含「良率排名」）

---

## 4. 与步骤 1 对比

| 场景 | 步骤 1（派发关） | 步骤 2（派发开） |
|---|---|---|
| A1-1 类问句 | 可能 LLM 选工具 / 偶发单 lot 表 | **确定性 aggregate bin×card** |
| P-C 多卡对比 | ✅（已有 bail） | 未复跑；建议步骤 2 稳定后再抽测 `verify-handoff-steps.mjs pc` |

---

## 5. 下一步建议

1. **可维持** `JB_DETERMINISTIC_DISPATCH=true`（A1-1/A1-2 已证明价值）。
2. **修复/验证 A1-4** 后再宣称阶段三完整 FLIP。
3. **步骤 3（可选）：** `JB_LLM_INTENT_CLASSIFIER=true` + `AGENT_EVAL_LIVE=1`。
4. 回归：`node scripts/verify-handoff-steps.mjs all`（步骤 2 下 P-B/P-C 是否仍 PASS）。

---

## 6. 复现命令

```bash
cd pcr-ai-api
VERIFY_OUT=../scratchpad/step2-dispatch-2026-06-30.txt \
  node scripts/verify-step2-dispatch.mjs all
```

---

## 7. 异常

无 SiliconFlow 403 / CONFIG_ERROR / Oracle ORA。A1-4 为逻辑/路由 gap，非基础设施故障。
