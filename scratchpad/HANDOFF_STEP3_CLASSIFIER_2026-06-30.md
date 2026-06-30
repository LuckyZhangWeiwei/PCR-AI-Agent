# 步骤 3 · 双开关验证交接（给 Claude Code · 2026-06-30）

> **执行者：** Cursor Agent  
> **用户配置：** `JB_DETERMINISTIC_DISPATCH=true` + `JB_LLM_INTENT_CLASSIFIER=true`  
> **前置：** 步骤 1 基线 5/5、步骤 2 派发 A1-1/A1-2 ✅（A1-4 ⚠️ 待修）  
> **日志：** [`step3-classifier-2026-06-30.txt`](step3-classifier-2026-06-30.txt)、[`step3-pass-bc-2026-06-30.txt`](step3-pass-bc-2026-06-30.txt)

---

## 0. 一眼结论

| 层 | 结果 |
|---|---|
| 本地 `npm test`（含 agentEval 确定性 + 黄金集 + 派发 CI） | ✅ 429 pass / 0 fail |
| Live eval（`AGENT_EVAL_LIVE=1`） | ⏭ 未跑（本机无 key；需在服务器或带 `AGENT_API_KEY` 跑） |
| **回归 A1-1（双开关同开）** | ✅ 仍首轮 `aggregate_jb_bins` + BIN×卡表 |
| **B2 口语长尾（4 场景）** | ⚠️ **1/4 PASS**（见 §3） |
| **Pass B/C 口语 + 降级（5 场景）** | ⚠️ **3/5 PASS**（见 §4） |

**判断：阶段三派发与分类器可共存（A1-1 回归 OK）。阶段二 FLIP 证据不足——口语/空回复/Pass C 明确问句在 invalid key 下未出表，需 Claude 跟进。**

---

## 1. 环境

| 项 | 值 |
|---|---|
| API | `http://10.192.130.89:30008` |
| UTC | 2026-06-30T12:24～12:30 |
| 脚本 | `verify-step3-classifier.mjs`（新增）、`verify-jb-route-pass-bc.mjs` |

---

## 2. 回归：派发 + 分类器同开 ✅

**REG-A1-1** `n55z 哪个卡测出bin35 多`  
- Session: `reg-a1-1-ae46175e-…`  
- `dispatch=true`，首轮 `aggregate_jb_bins`，9416 四卡 BIN35 表  
- **结论：** 开分类器**未破坏**阶段三派发快路

---

## 3. FLIP Test B2（口语长尾）— 1/4

| ID | 问句 | 结果 | 现象 |
|---|---|---|---|
| b2-1 | 各张探针卡 bin8 分布怎么样 | ❌ | **空回复**（0 字） |
| b2-2 | 近期哪几批良率掉得厉害 | ❌ | 流式截断，仅「要分析近期良率掉得厉害的」半句 |
| b2-3 | 哪片卡 bin35 出得最多 | ❌* | 实为 **ask_clarification 式** 追问（卡 vs wafer / 是否指定 lot）— 脚本判 FAIL，**产品行为可能可接受** |
| reg-a1-1 | （见 §2） | ✅ | — |

\*建议 Claude：b2-3 纳入黄金集时区分「澄清」vs「答非所问」。

---

## 4. Pass B/C（verify-jb-route-pass-bc）— 3/5

| 场景 | 结果 | 现象 |
|---|---|---|
| B1 这几张卡最近咋样 | ❌ | **空回复**（与 b2-1 同类） |
| B1 最近测得怎么样 | ✅ | 澄清 device/lot/card |
| B1 看看这几个批次的情况 | ✅ | 澄清 lot/device/mask |
| Pass C 模糊 + invalid apiKey | ✅ | SSE error 401 Invalid token，**无崩溃** |
| Pass C 明确 P11C + invalid apiKey | ❌ | 未出表（invalid key 可能阻断全链路，非仅分类器） |

**Pass C 明确失败说明：** 请求体 `apiKey: invalid-key` 时，即使用户问句可走纯正则，`P11C 最近的测试情况` 仍无 `get_filter_values` 表——需确认 invalid key 是否应在分类器失败时仍走 regex+工具快路。

---

## 5. 未跑项（建议 Claude / 用户在服务器补）

```bash
cd pcr-ai-api
AGENT_EVAL_LIVE=1 AGENT_API_KEY=<key> AGENT_SUBAGENT_MODEL=<model> \
  npx tsx --test test/agentEval.test.ts
```

记录：混合路由零回退、误分类率 ≤2%、失败问句清单。

---

## 6. FLIP 建议（Cursor）

| 开关 | 建议 |
|---|---|
| `JB_DETERMINISTIC_DISPATCH` | **可保持 true**（A1-1 双开关回归 OK） |
| `JB_LLM_INTENT_CLASSIFIER` | **暂缓 FLIP 或观察** — 空回复（b2-1/B1-首条）、B2 长尾不稳定；补 live eval 后再定 |

---

## 7. 给 Claude 的修复输入

1. **空回复：** `这几张卡最近咋样`、`各张探针卡 bin8 分布怎么样`（session 见日志）— 分类器/总结轮/流式？  
2. **b2-2 截断：** 是否 idle timeout 或总结轮 bail 过早？  
3. **Pass C 明确 + bad key：** 分类器失败时应降级纯正则 + `get_filter_values`，不应整段空白。  
4. **b2-3：** 无 scope 时澄清是否合理，或应默认全库 BIN×卡 aggregate？

---

## 8. 复现

```bash
cd pcr-ai-api
VERIFY_OUT=../scratchpad/step3-classifier-2026-06-30.txt node scripts/verify-step3-classifier.mjs
VERIFY_BC_OUT=../scratchpad/step3-pass-bc-2026-06-30.txt node scripts/verify-jb-route-pass-bc.mjs
```
