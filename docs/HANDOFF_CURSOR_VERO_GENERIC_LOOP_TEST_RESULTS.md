# Cursor 真连测试结果（2026-07-22 · 给 Claude Code）— Vero 通用 Agent 循环

> **执行者：** Cursor Agent  
> **读者：** Claude Code  
> **任务书：** [`HANDOFF_CURSOR_VERO_GENERIC_LOOP_TEST.md`](HANDOFF_CURSOR_VERO_GENERIC_LOOP_TEST.md)  
> **分支 / commit：** `worktree-vero-generic-agent-loop` @ `2d84dfc`  
> **环境：** 本机 Dummy（`INFCONTROL_LAYER_BINS_DUMMY=true` + `YIELD_MONITOR_TRIGGERS_DUMMY=true`）+ 真实 `WCHAT_ACCESS_TOKEN` + `VERO_BASE_URL=https://verostudio.sw.nxp.com`  
> **原始日志：** [`scratchpad/vero-generic-loop-live-log.txt`](../scratchpad/vero-generic-loop-live-log.txt)、[`scratchpad/vero-generic-loop-live-results.json`](../scratchpad/vero-generic-loop-live-results.json)、[`scratchpad/vero-generic-loop-followup-3.6b.json`](../scratchpad/vero-generic-loop-followup-3.6b.json)、[`scratchpad/vero-generic-loop-followup-3.5b.json`](../scratchpad/vero-generic-loop-followup-3.5b.json)  
> **未提交：** token / `.env`；scratchpad 脚本与日志仅本地

---

## 0. 一眼结论

| 项 | 结果 | 说明 |
|---|---|---|
| **总判** | ✅ **可继续合并评估** | 真连多轮协议稳定；直连劫持 gate 生效；超时生效；TLS OK |
| **JSON 协议** | ✅ 极稳 | 观测到的 **全部** Vero 轮次均为裸 JSON（`bare_json`），**未触发** fenced / `{…}` slice 兜底 |
| **多轮 ReAct** | ✅ | 开放问题可稳定走出 `tool → tool → … → final`（最多见 4 次工具 + 5 次 Vero 调用） |
| **§1 直连劫持修复** | ✅ | 工具写入 history 后仍继续调 Vero，**未见** mid-turn 被 PRE_LLM 抢答 |
| **最后一轮强约束** | ⚠️ **模型不遵守** | `maxRounds=2` 时最后一轮 system 已带「必须 final」hint，Vero 仍回 `action:tool` → 落服务端兜底文案（符合已知设计，不算 bug） |
| **字符预算压缩** | ⏭ Dummy 未触发 | 实测单轮 prompt **~72k–84k** chars；预算 **180_000**；压缩 status 从未出现。真库大结果集仍待验 |
| **冒烟脚本 3.1** | ⚠️ 符合任务书警告 | 命中 Path B「Vero 试点」探针卡直连，**未**走通用多轮；功能本身 OK |

**未发现需立刻改代码的真连 bug。** 建议 Claude Code 关注的产品/协议项见 §5。

---

## 1. 结果表（回填任务书 §4）

| 测试项 | 结果 | 备注/异常日志 |
|---|---|---|
| 3.1 冒烟脚本 | ⚠️ 通过但未测多轮 | `smoke-vero-generic-loop.mjs` → status「Vero 试点…」、`aggregate_probe_card_tester_performance(device=WA03P02G)`、四表+解读；**1 次工具即 done**（Path B / `tryRunProbeCardPerfDirectRoute`，且 `.env` 仍 `AGENT_PROBE_CARD_VERO_PILOT=true`） |
| 3.2 多轮 JSON 协议 | ✅ | 见 §2；全程 `bare_json`；3.2a/3.2b 真实多轮 |
| 3.3 direct-route 劫持修复 | ✅ | 工具后继续 `vero#2…#5`；无「Vero 试点」/直连抢答；未做「注释掉 gate」反证（避免脏改分支） |
| 3.4 超时 | ✅ | 本地 TCP accept-and-hold + `timeoutMs=5000` → `Vero request timed out after 5000ms`；默认 60s 路径同机制 |
| 3.5 字符预算 | ⏭ 未触发压缩 | max ~**83601**（3.2c 大 tool result）/ **75054**（3.5b）；预算 180k；**建议暂不调常量**，真库再校准 |
| 3.6 最后一轮强约束 | ⚠️ 模型不守 / 兜底 OK | 见 §3；遵守率本测 **0/1** |
| 3.7 TLS | ✅ | ping→PONG，~2.3s；无证书报错（`VERO_TLS_INSECURE` 默认跳过） |

---

## 2. 3.2 多轮明细

测试入口：临时脚本 `scratchpad/vero-generic-loop-live-test.mjs`（**直接** `runVeroAgentLoop` + wrap `invoke` 计数；不依赖 `AGENT_VERO_GENERIC_LOOP` HTTP 开关）。

| ID | 问法 | Vero 调用 | 工具链 | JSON mode | 耗时 | 备注 |
|---|---|---:|---|---|---:|---|
| 3.2a | 最近整体测试情况怎么样… | 5 | YM×2 → JB agg×2 → final | 全 bare | ~77s | 曾选无过滤 `aggregate_jb_bins` 被工具层拒绝后改带 `device=WC06N84R`；Dummy 部分时间窗 0 行 |
| 3.2b | 帮我看看现在有没有什么异常趋势 | 4 | YM device+card → device → probeCard → final | 全 bare | ~33s | 干净多轮 |
| 3.2c | 随便挑一个最近的批次，分析一下良率 | 2 | `query_jb_bins(limit:50)` → final | 全 bare | ~22s | 单工具即够；prompt 顶到 **83601** |

**协议稳定性：** 0 次 fenced / slice；0 次 `parseVeroRoundDecision` 失败。

**选错工具？** 3.2a 第一次无 scope 的 `aggregate_jb_bins` 被服务端工具校验挡住（预期防护）；随后自纠。Dummy 时间窗常空 → 模型会反复换窗（3.3 更明显），属数据环境而非协议失败。

---

## 3. 3.3 / 3.6 要点

### 3.3 劫持 gate

问法：「请先查一下最近有哪些 device…再挑其中一个分析…」

- `veroCalls=5`，`tools=4`（多次 `query_jb_bins` 换时间窗），**全部在工具结果之后仍进 Vero**
- status **无**「Vero 试点」；`hitDirectOrPilot=false`
- Dummy 下时间窗多次 0 行后仍给出 final（解释数据空）——足以证明 **未**被 listing/概况直连中途打断

### 3.6 最后一轮（`maxRounds: 2`）

问法复用开放题 +「请尽量多查几轮」。

| 轮 | lastRoundHint | Vero 决策 |
|---|---|---|
| 1 | false | `tool:query_jb_bins` |
| 2 | **true** | 仍 `tool:query_jb_bins`（**未** final） |

随后 SSE text：

> 已完成以下查询：query_jb_bins，但未能在 2 轮内给出最终结论。请点击「重试」继续，或缩小查询范围后重新提问。

→ **兜底符合任务书「已知后续优化项」**；最后一轮强约束对当前 Vero 模型**软**，不能当硬保证。

另：模糊「先列表再聚合」类问法（初版 3.5/3.6）易被 Vero 选 `ask_clarification` 提前结束——测轮次耗尽时应用已验证能跑多工具的开放问法（如 3.2a 风格）。

---

## 4. 3.4 / 3.5 / 3.7

- **超时：** `invokeVeroSimpleAgent(..., { timeoutMs: 5000, baseUrl: https://127.0.0.1:<hang-port> })` → 明确 timeout 错误（非无限挂起）。未对真实 Vero 慢响应做 60s 实锤，但实现路径已验。
- **预算：** `VERO_PROMPT_CHAR_BUDGET=180000`，`VERO_TOOL_RESULT_MAX_HISTORY_CHARS=15000`。Dummy 下单轮 prompt 量级 **~7.2万–8.4万**，距阈值约一半；**暂无需下调/上调**。真库全量 JB / 多轮大 JSON 再观察是否打到「正在压缩历史对话…」。
- **TLS：** 企业 MITM 跳过校验下多次 invoke 无新错误。

---

## 5. 给 Claude Code 的建议（非阻塞）

1. **合并前：** 任务书冒烟问法必然打 Path B；可考虑改 `smoke-vero-generic-loop.mjs` 的默认问句为 3.2 类开放问题，或在冒烟里断言 `veroCallCount>=2`（否则打印 WARN）。  
2. **最后一轮：** 若产品要求硬约束，需在 `veroAgentLoop` 对 `isLastRound && decision.action==="tool"` 做拒绝/重试/强制转 final（当前仅靠 prompt + 耗尽兜底）。  
3. **字符预算：** Dummy 验不了压缩路径；合并后可在真库用大 lot / 高 limit 复验一次。  
4. **勿合并进 `mcp-branch` 的决策**仍由你侧会话定；本结果未改业务代码、未推送。  
5. Hard rules 遵守：未引入 undici；未把 token 写入仓库；未升 oracledb。

---

## 6. 复现命令（本机已跑通）

```bash
cd pcr-ai-api
# .env: WCHAT_ACCESS_TOKEN + VERO_BASE_URL；建议 Dummy on
npx tsx scripts/smoke-vero-generic-loop.mjs
npx tsx ../scratchpad/vero-generic-loop-live-test.mjs
npx tsx ../scratchpad/vero-generic-loop-followup.mjs
```
