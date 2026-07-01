# Cursor 真库验证结果交接（2026-07-01 · 给 Claude Code）

> **执行者：** Cursor Agent  
> **前置：** 用户已部署含 `89c77b3`（Lot 低良率 DUT API）的 dist；`.env` 双开关 **`JB_DETERMINISTIC_DISPATCH=true`**、**`JB_LLM_INTENT_CLASSIFIER=true`**  
> **API：** `http://10.192.130.89:30008`  
> **测试 lot（新 API）：** `NF12316.1X`  
> **日志：** [`scratchpad/step2-dispatch-2026-07-01.txt`](../scratchpad/step2-dispatch-2026-07-01.txt)（handoff 复验）、[`scratchpad/step3-classifier-2026-07-01.txt`](../scratchpad/step3-classifier-2026-07-01.txt)、[`scratchpad/step3-pass-bc-2026-07-01.txt`](../scratchpad/step3-pass-bc-2026-07-01.txt)

---

## 0. 给 Claude Code 的一眼结论

| 层 | 结果 | FLIP 建议 |
|---|---|---|
| **新 REST** `lot-underperforming-duts` | ✅ HTTP 200；`lotOverall` 96.38% × 0.75；0 个 underperforming DUT | 可视为已上线 |
| **阶段三派发**（A1-1/A1-2 + A2） | ✅ 5/5 脚本 PASS；turn1 BIN×卡表稳定 | **`JB_DETERMINISTIC_DISPATCH` 可保持 true** |
| **阶段三 A1-4** | ⚠️ 仍 **`dispatch=false`**，单 lot 概况（非 top5 排名） | 待修 `lot_yield_ranking` 派发/渲染 |
| **阶段二分类器**（双开关同开） | ⚠️ step3 **3/4**；Pass B/C **3/5**；较 6/30 **B2-1/B2-1 空回复已改善** | **`JB_LLM_INTENT_CLASSIFIER` 暂缓 FLIP 默认** |
| **历史回归 handoff** | ⚠️ **4/5**（P-D 250s 超时） | P-A/B/C/P-F ✅ |
| **Live eval 误分类率** | ⏭ 未跑 `AGENT_EVAL_LIVE=1` | 服务器补跑后再定阶段二 FLIP |

---

## 1. 环境

| 项 | 值 |
|---|---|
| UTC | 2026-07-01T10:42～11:01 |
| 开关 | `JB_DETERMINISTIC_DISPATCH=true`，`JB_LLM_INTENT_CLASSIFIER=true` |
| Health | `agentEnabled=true`，`agentJbCacheVersion=6` |
| 脚本 | `verify-step2-dispatch.mjs all`、`verify-step3-classifier.mjs`、`verify-handoff-steps.mjs all`、`verify-jb-route-pass-bc.mjs` |

---

## 2. 新 API — `GET /api/v4/inf-analysis/lot-underperforming-duts`

```bash
curl -s "http://10.192.130.89:30008/api/v4/inf-analysis/lot-underperforming-duts?lot=NF12316.1X&passId=1"
```

| 字段 | 值 |
|---|---|
| HTTP | 200 |
| device | `WA03P02G`（`deviceResolvedFromJb: true`） |
| probeCardType | `8041`（`probeCardTypeResolvedFromJb: true`） |
| waferCount | 25 |
| `filters.baselineMethod` | **`lotOverall`** |
| pass1 baseline | 96.38% |
| threshold (×0.75) | 72.29% |
| `underperformingDuts` | **[]**（24 DUT 均 ≥ 72.29%，符合预期） |

**结论：** 产品口径（lotOverall × thresholdRatio、仅 lot、JB 反查 device/卡型）在真库闭环 ✅。

---

## 3. 阶段三派发 — `verify-step2-dispatch.mjs` → **5/5 PASS**

| ID | 问句 | 首轮工具 | 结论 |
|---|---|---|---|
| A1-1 | `n55z 哪个卡测出bin35 多` | `aggregate_jb_bins(groupBy:bin,cardId)` | ✅ BIN×9416 四卡表 |
| A1-2 | `BIN35 集中在哪张卡` | `aggregate_jb_bins` | ✅ 同上 |
| A1-4 | `WC13N55Z 各 lot 良率 top5` | `query_jb_bins`，**`dispatch=false`** | ⚠️ **仅 1 lot 概况**，非跨 lot 排名（与 6/30 同 gap） |
| A2-1 | `NF13338.1K 概况` | `query_jb_bins` | ✅ 未误伤 |
| A2-4 | `ZZZZZ 哪个卡测出bin99 多` | — | ✅ 中文无数据提示 |

Session 示例：A1-1 `a1-1-9adaf7d2-…`；A1-4 `a1-4-53ec46c0-…`。

**给 Claude：** A1-4 脚本判 PASS 过宽（`lots=1` 即过）；建议收紧断言或修 `lot_yield_ranking` 派发 + device 级 ranking 渲染（见 [`scratchpad/HANDOFF_STEP2_DISPATCH_2026-06-30.md`](../scratchpad/HANDOFF_STEP2_DISPATCH_2026-06-30.md) §3.4）。

---

## 4. 双开关 — `verify-step3-classifier.mjs` → **3/4 PASS**

| ID | 问句 | 结果 | vs 6/30 |
|---|---|---|---|
| REG-A1-1 | `n55z 哪个卡测出bin35 多` | ✅ dispatch + BIN×卡表 | 同 ✅ |
| B2-1 | `各张探针卡 bin8 分布怎么样` | ✅ **澄清 scope**（非空回复） | 6/30 ❌ 空回复 → **改善** |
| B2-2 | `近期哪几批良率掉得厉害` | ✅ **澄清 device/lot** | 6/30 ❌ 截断 → **改善** |
| B2-3 | `哪片卡 bin35 出得最多` | ❌ 追问 scope，**无 BIN×卡表** | 脚本 FAIL；产品或需默认 mask 派发 |

---

## 5. Pass B/C — `verify-jb-route-pass-bc.mjs` → **3/5 PASS**

| 场景 | 结果 |
|---|---|
| B1 `这几张卡最近咋样` | ✅ 澄清（无历史卡号） |
| B1 `最近测得怎么样` | ❌ **250s SSE timeout** |
| B1 `看看这几个批次的情况` | ✅ 澄清 lot/device |
| Pass C 模糊 + invalid key | ✅ 401 Invalid token，无崩溃 |
| Pass C 明确 `P11C 最近的测试情况` + invalid key | ❌ **未出表**（分类器失败时应降级纯正则 + 表） |

---

## 6. 历史 handoff — `verify-handoff-steps.mjs` → **4/5 PASS**

| ID | 结果 | 备注 |
|---|---|---|
| P-A | ✅ `get_filter_values` P11C `totalDistinct=3` | 流中偶发 `Cannot read properties of undefined (reading 'length')` error event，但 PASS |
| P-B | ✅ lot 列表 ~50+ |
| P-C | ✅ 9416 四卡跨卡综述 |
| P-D | ❌ `哪个lot bin40最多` **250s timeout** |
| P-F | ✅ BIN79 集中度，无 BIN1/BIN55 |

---

## 7. 本地 CI（Cursor 本机，非 live）

- 全量 `npm test`：**442 pass / 0 fail**
- `agentEval.test.ts`：**4 pass / 2 skip**（live 闸门 skip）

---

## 8. FLIP 判据（Cursor 建议，Claude 不翻开关）

| 开关 | 建议 | 理由 |
|---|---|---|
| `JB_DETERMINISTIC_DISPATCH=true` | **可保持** | A1-1/A1-2 稳定；双开关下 REG-A1-1 仍 OK |
| `JB_LLM_INTENT_CLASSIFIER=true` | **暂缓改为 repo 默认** | 超时（P-D、B1）、Pass C 明确未降级出表；live 误分类率未测 |

**用户侧：** 当前 `.env` 双 true 可继续观察；不必回滚派发开关。

---

## 9. 给 Claude Code 的修复输入（优先级）

1. **A1-4** `WC13N55Z 各 lot 良率 top5` — `lot_yield_ranking` 未派发 / 落单 lot overview；收紧 `verify-step2-dispatch.mjs` A1-4 断言。
2. **P-D / B1 超时** — `uflex…` → `哪个lot bin40最多`；`最近测得怎么样` — 250s idle timeout；查工具链是否卡死或需 summary bail。
3. **Pass C 明确 + bad key** — 分类器 401 后应 **`resolveJbRoute` 纯正则** + `get_filter_values` 表，非空白。
4. **B2-3** — 无 scope 时澄清 vs 默认 N55Z/mask 派发：产品定夺 + 黄金集。
5. **P-A 流 error event** — `undefined.length` 非致命但应查 agentLoop 某分支。
6. **补跑** — 服务器 `AGENT_EVAL_LIVE=1 npx tsx --test test/agentEval.test.ts`，回传误分类率数字。

---

## 10. 复现

```bash
cd pcr-ai-api
VERIFY_OUT=../scratchpad/step2-dispatch-2026-07-01.txt node scripts/verify-step2-dispatch.mjs all
VERIFY_OUT=../scratchpad/step3-classifier-2026-07-01.txt node scripts/verify-step3-classifier.mjs
node scripts/verify-handoff-steps.mjs all
VERIFY_BC_OUT=../scratchpad/step3-pass-bc-2026-07-01.txt node scripts/verify-jb-route-pass-bc.mjs
```
