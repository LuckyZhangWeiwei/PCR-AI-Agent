# Cursor JB mask 快路 + 多 lot 良率排行交接（2026-07-01 · 给 Claude Code）

> **执行者：** Cursor Agent  
> **分支：** `feat/jb-route-resolver`  
> **前置 commit：** `7348ba2`（lot listing / bin×lot / dut agg / 分类器 guard）  
> **本 commit：** mask PRE_LLM 快路、A1-4 多 lot fan-out、WC device 解析、默认模型 Flash  
> **生产 `.env`（用户已部署）：** `JB_DETERMINISTIC_DISPATCH=true`、`JB_LLM_INTENT_CLASSIFIER=true`、`AGENT_MODEL` / `AGENT_SUB_MODEL` = **`deepseek-ai/DeepSeek-V4-Flash`**  
> **API：** `http://10.192.130.89:30008`  
> **前序：** [`HANDOFF_CURSOR_JB_ROUTE_FIXES_2026-07-01.md`](HANDOFF_CURSOR_JB_ROUTE_FIXES_2026-07-01.md)、[`HANDOFF_CURSOR_VERIFICATION_RESULTS_2026-07-01.md`](HANDOFF_CURSOR_VERIFICATION_RESULTS_2026-07-01.md)

---

## 0. 一眼结论（部署后真库 · 2026-07-01）

| 脚本 | 结果 | 说明 |
|------|------|------|
| **Pass B/C** | **5/5** | Pass C 明确 `P11C 最近的测试情况` + invalid apiKey → **出表**（mask PRE_LLM） |
| **Handoff P-A～F** | **5/5** | P-D bin×lot 排行亦 PASS（上轮 250s timeout 已解） |
| **Step2 派发** | **3/5** | A1-4 **`lots=5`** ✅；A1-2 / A2-4 仍 FAIL（见 §4） |
| **本地 `npm test`** | **453 pass / 0 fail**（+4 skip） | 含新增 mask scope / WC device 单测 |

**给 Claude：** 本轮闭环 **Pass C + A1-4 + handoff 全绿**；默认模型建议 **Flash 主模型**（真库 B1/step3 优于 Pro，且避免 250s 长尾）。待办：**A1-2 二轮追问**、**A2-4 空 mask 超时**、**agentEval live**。

---

## 1. 真库测试结果明细

日志路径（本机 scratchpad，未入 git）：

| 日志 | 路径 |
|------|------|
| Pass B/C | `scratchpad/realdb-jb-route-pass-bc.txt` |
| Handoff | `scratchpad/post-deploy-handoff.txt` |
| Step2 | `scratchpad/post-deploy-step2.txt` |

### 1.1 Pass B/C — 5/5

```
B1 这几张卡最近咋样          PASS（澄清）
B1 最近测得怎么样            PASS
B1 看看这几个批次的情况      PASS
Pass C 模糊 + invalid key    PASS（401 降级，无崩溃）
Pass C 明确 P11C 测试情况    PASS（正则快路/出表正常）
```

### 1.2 Handoff P-A～F — 5/5

| ID | 结果 | 要点 |
|----|------|------|
| P-A | ✅ | `get_filter_values` P11C `totalDistinct=3` |
| P-B | ✅ | uflex 三天 → lot 列表 ~50 |
| P-C | ✅ | 9416 四卡对比 |
| P-D | ✅ | uflex 三天 → BIN40×lot 排行表 |
| P-F | ✅ | BIN79 `query_lot_dut_bin_agg` 集中度 |

### 1.3 Step2 派发 — 3/5

| ID | 结果 | Detail |
|----|------|--------|
| A1-1 | ✅ | `aggregate_jb_bins` groupBy cardId |
| A1-2 | ❌ | setup `n55z 最近测试情况` → `BIN35 集中在哪张卡` 走了 **`query_lot_dut_bin_agg`**，未派发 `aggregate_jb_bins` |
| **A1-4** | ✅ | **`dispatch=true`，`lots=5`**（多 lot fan-out） |
| A2-1 | ✅ | 单 lot 概况 |
| A2-4 | ❌ | `ZZZZZ bin99` → **250s stream timeout** |

---

## 2. 本 commit 代码修改

### 2.1 新文件 `agentJbMaskScopeRoute.ts`

- **`canRunMaskScopeDirectRoute`**：`isLotOverviewQuestion` + 有 mask/device、**无 lot ID**。
- **`maskScopeFilterValuesArgs`**：`get_filter_values(domain:both, mask)`。
- **`maskScopeJbQueryArgs`**：`query_jb_bins(mask|device)` + `resolveRecentTimeWindow`。

### 2.2 `agentLoop.ts`

- **`tryRunMaskScopeDirectRoute`（PRE_LLM）：**  
  `get_filter_values` → `query_jb_bins` → `emitDeterministicJbTablesReply`（**`withCommentaryLlm: false`**，不依赖 SiliconFlow）。  
  插入顺序：在 `tryRunLotOverviewDirectRoute` **之前**（lot overview 要求 lot 锚点）。
- **`enrichLotYieldRankingPayload` + `mergeLotYieldRankingPayloads`（A1-4）：**  
  `lot_yield_ranking` 派发后，若 `lotYieldRankByTestEnd` 不足 topN，按 `recentLotsByTestEnd` **逐 lot `query_jb_bins(lot)`** 合并 rank。
- **`emitDeterministicJbTablesReply`：** `lot_yield_ranking` 模式下 **跳过多 lot bail**（fan-out 故意查多 lot）。

### 2.3 `agentQueryScope.ts`

- **`inferDeviceFromText`：** 支持 **`WC/WB` 全码**（`DEVICE_FULL_RE`，如 `WC13N55Z`），不再只匹配 `WA…`。

### 2.4 防御性修复（P-A SSE `undefined.length`）

- `agentFilterValuesTool.ts`：`merged.values?.length ?? 0`
- `agentJbDeterministicReply.ts`：`hit.testerIds?.length` 可选链

### 2.5 默认模型（`agentConfig.ts` + `.env.example`）

| 项 | 改前 | 改后 |
|----|------|------|
| `DEFAULT_MODEL` | `DeepSeek-V4-Pro` | **`DeepSeek-V4-Flash`** |
| `DEFAULT_SUB_MODEL` | Flash | Flash（表解读/压缩仍用 Flash） |
| `.env.example` 注释 | V3 示例 | **Flash 为生产推荐，禁止 Pro 作默认** |

**依据：** 用户生产 `.env` 双 Flash；真库 Pass B/C 5/5、handoff 5/5；Pro 在 B2/A2-4 等场景易 250s 超时。

### 2.6 测试

- `test/agentJbMaskScopeRoute.test.ts` — P11C 门控与 args
- `test/agentQueryScope.test.ts` — `WC13N55Z` device / `buildJbScopeArgs`

---

## 3. 与 `7348ba2` 的关系

`7348ba2` 已含：分类器 guard、P-B/P-D/P-F 直连、`jbRouteResolver` mask 降级 regex。  
**本 commit 补齐：**

1. **Pass C 仍失败** → 需 **PRE_LLM 整条链路**（不只 classifier 降级），invalid apiKey 时不能进首轮 LLM。
2. **A1-4 仍 1 lot** → 需 **WC device 解析** + **多 lot fan-out**。
3. **代码默认模型** → Flash（与生产对齐）。

---

## 4. 仍待 Claude 跟进

| P | 现象 | 建议 |
|---|------|------|
| **A1-2** | 二轮「BIN35 集中在哪张卡」误走 `query_lot_dut_bin_agg` | summary 轮或 PRE_LLM：`bin_card_attribution` + session 有 `query_jb_bins(mask)` → `aggregate_jb_bins(groupBy:bin,cardId)` |
| **A2-4** | `ZZZZZ bin99` 250s timeout | 空 mask 快速回落（不调 LLM）或 verify 降 `streamTimeoutSec`；或 scoped aggregate 空结果直出 |
| **agentEval live** | 黄金集误分类率门禁 | `AGENT_EVAL_LIVE=1` 在服务器补跑；与 handoff 正交 |

---

## 5. FLIP 建议

| 开关 / 配置 | 建议 |
|-------------|------|
| `JB_DETERMINISTIC_DISPATCH=true` | **保持**（A1-4 / bin×card 已验证） |
| `JB_LLM_INTENT_CLASSIFIER=true` | **保持**（B1 口语澄清正常） |
| `AGENT_MODEL` / `AGENT_SUB_MODEL` | **`deepseek-ai/DeepSeek-V4-Flash`**（勿改回 Pro） |
| 代码默认（无 env） | 本 commit 后 **Flash** |

---

## 6. 复现命令

```bash
cd pcr-ai-api
npm ci && npm run build && npm test

node scripts/verify-jb-route-pass-bc.mjs
VERIFY_OUT=../scratchpad/post-deploy-handoff.txt node scripts/verify-handoff-steps.mjs all
VERIFY_OUT=../scratchpad/post-deploy-step2.txt node scripts/verify-step2-dispatch.mjs all
node scripts/verify-step3-classifier.mjs

AGENT_EVAL_LIVE=1 npx tsx --test test/agentEval.test.ts   # 需 AGENT_API_KEY
```

---

## 7. Claude Code 建议下一步

1. 读 **A1-2** session `a1-2-*`（step2 日志）— 为何 `tryRunDutBinAggDirectRoute` 或 pending 抢在 `bin_card_attribution` 前。
2. **A2-4：** `scopedBadBin` / semantic dispatch 对不存在 mask 的 **fast-fail**（0 行 aggregate → 文本「无数据」，不调 LLM）。
3. 可选：收紧 `verify-step2-dispatch.mjs` A1-4 断言 **`lots>=3`**（现已自然满足 `lots=5`）。
4. 回传 step2 / live eval 日志 + 是否将 Flash 默认合入 `main`。
