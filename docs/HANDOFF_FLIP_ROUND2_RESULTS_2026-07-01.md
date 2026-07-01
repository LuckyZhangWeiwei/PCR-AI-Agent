# 回复:Cursor 真库三步验证结果 — 处理与分诊(Claude，2026-07-01)

> **输入**：Cursor 2026-06-30 真库三步验证（`scratchpad/HANDOFF_STEP{1,2,3}_*.md` + `step{1,2,3}-*.txt`）。
> **本文档**：Claude 对每个 finding 的处理结论。已修的直接提交；改不动/需真库的给分诊 + 索要信息。
> **红线**：不影响现有回复质量。**Claude 不翻开关**；FLIP 由用户据此决定。

---

## 0. 一眼结论

| Finding | 来源 | 结论 | 动作 |
|---|---|---|---|
| **A1-4** `WC13N55Z 各 lot 良率 top5` 落单 lot 概况 | Step2 §3.4 | ✅ **已修 + 验证**（commit `9f90e94`） | `lot_yield_ranking` 正则补「各lot良率/良率topN」 |
| A1-1 / A1-2 派发根治 turn1 | Step2 | ✅ 已证有效（核心 bug 根治） | 无需动 |
| A2-1 / A2-4 不误伤 | Step2 | ✅ | 无需动 |
| REG-A1-1 双开关同开回归 | Step3 §2 | ✅ | 无需动 |
| **B2-1** `各张探针卡 bin8 分布怎么样` **空回复(0字)** | Step3 §3 | ⚠️ 真 bug，**分类器 ON 专属**，沙箱不可复现 | 需 SSE trace，见 §3 |
| **B2-2** `近期哪几批良率掉得厉害` 截断半句 | Step3 §3 | ⚠️ 流式/总结截断，**分类器 ON 专属** | 需 SSE trace，见 §3 |
| **B2-3** `哪片卡 bin35 出得最多` 澄清 | Step3 §3 | ✅ **产品行为可接受**（无 scope 时澄清合理） | 不改，纳入黄金集为「澄清」类，见 §4 |
| Pass C 明确 + invalid apiKey 无表 | Step3 §4 | ✅ **测试假象**（坏 key 本应失败） | 不改，见 §5 |

**FLIP 建议**：`JB_DETERMINISTIC_DISPATCH` **可保持 ON**（A1-1/A1-2/A1-4 现已全部正确）；`JB_LLM_INTENT_CLASSIFIER` **保持 OFF**（B2-1 空回复、B2-2 截断未解决，与 Cursor 建议一致）。

---

## 1. A1-4 已修（commit `9f90e94`）

**根因**：`isLotYieldRankingQuestion`（[agentJbDeterministicReply.ts:363](../pcr-ai-api/src/lib/agent/agentJbDeterministicReply.ts#L363)）只认「最差/最低/排行/排名」。`各 lot 良率 top5` 无这些词 → mode 落到 `lot_overview` → 单 lot `DR44919.1F` 概况（Step2 日志 `dispatch=false first=query_jb_bins lots=1`）。

**修法**：补三条正则，精确锚定跨 lot 良率排名意图：
```
(各|所有|全部|每个?)\s*(lot|批次)\s*(的)?\s*(良率|良品率|yield)   → "各lot良率"
(良率|良品率|yield)\s*(的)?\s*(top\s*\d+|前\s*\d+\s*(名|个|批)?)     → "良率top5/前5"
(lot|批次).*(良率|良品率|yield).*top\s*\d+                          → "lot良率top5"
```
- **避开误伤**（已单测确认）：`前5个lot各自的良率`（多 lot 枚举，lot 在「各」之前）、`各片良率`（单 lot 逐片，无 lot token）、`各卡良率排名`（card_yield_compare，由 `detectJbReplyMode` 顺序先截）均**不**被纳入。
- **与开关无关**：dispatch 与非 dispatch 路径都受益（mode 修正是根）。

**验证**（沙箱，全绿）：
- `mode("N55Z device 各 lot 良率 top5") = lot_yield_ranking` ✅（此前 = lot_overview）
- 黄金集 baseline **零回退**；`scoreDispatchOnGolden` failures=`[]`，dispatched **2→4**（lot_yield_ranking 现正确派发 query_jb_bins）。
- `agentEval` / `agentJbDeterministicReply` / `jbRouteResolver` / `agentLoop` / `agentQueryScope`：**101 pass / 0 fail**。
- 黄金集 line 273 已有此 case；加入 `REGEX_BASELINE_PASS_QUESTIONS` 形成**防回退棘轮**。

**请 Cursor 真库复测**（开 `JB_DETERMINISTIC_DISPATCH`）：
- `WC13N55Z 各 lot 良率 top5` → 应出**跨 lot 良率排名**（多 lot），而非单 lot `DR44919.1F` 概况。
- 收紧 `verify-step2-dispatch.mjs` A1-4 断言：要求 `lots>=3` 或表头含「良率排名/各 lot 良率」。

---

## 2. 派发核心已证（无需动）

A1-1/A1-2（`n55z 哪个卡测出bin35 多` → 首轮 `aggregate_jb_bins(bin,cardId)`）在开关 ON 下**确定性直出 BIN×卡表**，turn1 选错工具的原始 bug **根治成立**。REG-A1-1 证明开分类器不破坏此快路。

---

## 3. B2-1 空回复 / B2-2 截断 — 需 SSE trace（分类器 ON 专属）

**为什么 Claude 现在改不动**：
1. 两者**只在 `JB_LLM_INTENT_CLASSIFIER=true`** 复现；OFF（当前生产）不受影响。
2. 是**分类器多加一轮 LLM 调用后的下游**现象（空 done / 流式截断），**非路由层可修** —— 正则路径这两句 mode 分别是 `equipment`（B2-1，因 `isProbeCardQuestion=true`）与 `generic`（B2-2），路由本身不产生空串。
3. 沙箱**无真 LLM/真库**，无法复现空 done 的确切触发轮次。

**假设**（待 trace 证实）：
- B2-1：`各张探针卡…` 无 lot/device/mask scope → equipment 确定性表无数据 → bail → 分类器占用的那一轮后进入总结轮，`textBuffer` 空。按 `pcr-ai-api/CLAUDE.md §11 条目 11`，空 textBuffer 本应 SSE `error`「模型未返回分析结论」，但 B2-1 得到的是**纯空 done**（既无文本也无该 error）→ 疑**分类器路径绕过了空文本护栏**。若属实，这是可修点（让空文本护栏覆盖分类器分支）。
- B2-2：出了半句即停 → 疑 idle 超时或 `createDeepSeekFilter` 尾部 token 未 flush，被分类器额外轮次的时序放大。

**请 Cursor 提供**（sessions 已知）：
- **B2-1** `b2-1-091787ef-…`、**B2-2** `b2-2-81cd2951-…` 的**完整 SSE 事件流**（非仅最终文本）：`status` / `tool_start` / `tool_result` / `delta` / `done` / `error` 逐条，含**轮次数**与**每轮是否带 tool_choice**。
- 是否伴随 `Request timeout after …ms`？总耗时？
- 同两句在**分类器 OFF** 下的输出（对照——若 OFF 正常、ON 空，则锁定分类器分支的空文本护栏缺口）。

拿到后 Claude 定位空文本护栏 / flush 时序并修（预计集中在 `agentLoop.ts` 总结轮 + `createDeepSeekFilter.finalize`）。

---

## 4. B2-3 澄清 — 可接受，纳入黄金集

`哪片卡 bin35 出得最多` 的实际回复是**合理澄清**（问：卡级 vs 某 lot 某 wafer？有无 lot/device scope？还是全库）。**无 scope 时澄清优于**：
- 强行 bin_card_attribution：无 mask/device → `scopedBadBinAggregateArgsFromUser` 返 null，无法确定性出表；
- 默认全库 BIN35×卡 aggregate：可能扫全库、慢且噪声大。

**动作**：把 `哪片卡 bin35 出得最多` 作为 **`ask_clarification` 期望**纳入黄金集（区分「澄清」vs「答非所问」），不计为 FAIL。`verify-step3` 脚本对此类应判 PASS。
> 注：`哪片卡` 未被 `isBinCardAttributionQuestion` 命中（卡正则有「哪张/哪个/哪块」无「哪片」）。**有 scope 时**（如 `N55Z 哪片卡 bin35 最多`）才值得补「哪片」→ 走确定性归卡；无 scope 维持澄清。此项低优先，待 §3 修完再评估。

---

## 5. Pass C 明确 + invalid apiKey — 测试假象

请求体 `apiKey: invalid-key` → SiliconFlow 401 → **任何**需要 LLM 出文的路径都会失败（分类器与最终中文总结都要 key）。「明确 P11C 仍无 `get_filter_values` 表」是**预期**：坏 key 阻断的是 LLM，不是分类器专属。**非 bug**。
> 若要「坏 key 也走纯正则 + 工具直出表」，那是另一条产品线（离线确定性直答），不在本轮 FLIP 范围。当前 Pass C 模糊句在坏 key 下 `SSE error 401 无崩溃` 已是正确降级。

---

## 6. 汇总给用户的 FLIP 决策输入

| 开关 | 现状 | 建议 |
|---|---|---|
| `JB_DETERMINISTIC_DISPATCH` | A1-1/A1-2/**A1-4(已修)** 全 OK；A2 不误伤 | **可 FLIP 为 true**（真库复测 A1-4 通过后）|
| `JB_LLM_INTENT_CLASSIFIER` | B2-1 空回复、B2-2 截断未解 | **保持 OFF**，待 §3 trace + 修复后再评 |

**Claude 下一步**：等 Cursor 回 §3 的 SSE trace → 修空文本护栏/flush → 再交回复测。A1-4 可并入 `feat/jb-route-resolver`（未 merge main，遵用户指示）。
