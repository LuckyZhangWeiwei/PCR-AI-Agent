# 真库测试任务（给 Cursor）— Vero 循环真实字符预算 + 全程零硅基流动复验

> **执行者：** Cursor Agent（需真实 Oracle 访问 + 真实网络访问 `verostudio.sw.nxp.com` + 真实 `WCHAT_ACCESS_TOKEN`；Claude Code 沙箱两者都没有）
> **被测代码：** `mcp-branch`，commit `5e4e50c`（含本文档要求复验的最新一处修复，见 §0.1）
> **前置阅读：**
> - `docs/superpowers/specs/2026-07-21-vero-generic-agent-loop-design.md`（Vero 通用循环设计，§4.2 字符预算）
> - `docs/HANDOFF_CURSOR_VERO_GENERIC_LOOP_TEST_RESULTS.md`（2026-07-22 上一轮真连测试结果，§4 已指出字符预算这条从未在真实大结果集上测过，本文档就是补这个缺）
> - `pcr-ai-api/src/lib/agent/core/veroAgentLoopConfig.ts`（当前生效的预算常量，见下）

---

## 0. 背景

### 0.1 这次任务因何而起

用户问「完全替换硅基流动为 wchat 这条路上还差什么」，Claude Code 盘了一遍代码后发现两类缺口：

1. **真库大结果集是否会撞 Vero 的单轮字符预算**——`VERO_PROMPT_CHAR_BUDGET` 目前是 **280,000**（2026-07-22 用真实测得的 200K 上下文窗口重新校准过，见 `veroAgentLoopConfig.ts` 注释），但 Cursor 上一轮真连测试全程 Dummy 数据，单轮 prompt 实测只有 **7.2 万～8.4 万字符**，从未接近过这个上限——`isVeroPromptOverBudget()` 触发的"压缩历史对话"分支（`compactHistoryForBudget` → `summarizeHistoryViaVero`）**代码存在但从未被真实数据执行过一次**。
2. **JB 意图分类器（`jbIntentClassifier.ts`）曾经是纯硅基流动、完全没有 Vero 分支**——`tryRunSemanticDispatchDirectRoute`（现在是 `PRE_LLM_DIRECT_ROUTES` 共享表的一员，Vero 循环和旧 SiliconFlow 循环都会跑到它）在 JB 问题落到"generic 模式+语义模糊"时会调用这个分类器。生产环境的 `pcr-ai-api/runtime-config.json` 里 `jbLlmIntentClassifier` 字段是 **`true`**（已生效，不是理论开关），也就是说**在今天之前，只要用户问一句模糊的 JB 问题，即使 `AGENT_VERO_GENERIC_LOOP` 全开，这一条路径也会静默调硅基流动**。Claude Code 已经在 `5e4e50c` 把这处改成了"Vero 就绪则走 Vero，否则退回硅基流动"（同 JB 表解读/DUT 解读/探针卡默认解读用的同一个 `isVeroGenericLoopReady()` 判断模式），**但这个改动只在本地 mock 掉 Vero 调用的单测里验证过，从未在真实网络上跑过**。

本文档要 Cursor 验证这两件事，并且贯穿全程执行**用户明确提出的纪律要求：全程绝对不能出现任何一次硅基流动调用**——§3 提供了一个具体的"金丝雀"手段来把这条要求变成可验证的硬事实，而不是"看日志觉得应该没有"。

### 0.2 当前生效的预算/阈值常量（`pcr-ai-api/src/lib/agent/core/veroAgentLoopConfig.ts`）

| 常量 | 值 | 作用 |
|---|---|---|
| `VERO_SUMMARIZE_THRESHOLD` | 80（消息条数） | 跨轮次历史摘要触发阈值（`agentHistory.ts` 的 `needsSummarization`） |
| `VERO_TOOL_RESULT_MAX_HISTORY_CHARS` | 20,000 | 单次工具结果写入 history 时的截断上限 |
| `VERO_PROMPT_CHAR_BUDGET` | **280,000** | 单轮发给 Vero 的完整 prompt 字符数上限，超过则先压缩历史再重建 prompt |

---

## 1. 部署被测代码

```bash
git fetch origin && git checkout mcp-branch && git pull
git log --oneline -3   # 顶部应为 5e4e50c(JB 分类器迁 Vero) / 92a5aae(探针卡解读规划文档) / 7c532c0(冒烟脚本修复)
cd pcr-ai-api && npm ci && npm run build && npm test
```

`npm test` 期望：**736 个测试，730 pass / 2 fail（已知预置问题，见下）/ 4 skip**。2 个失败固定是 `test/jbRouteResolver.test.ts` 里「开关关 → 不调分类器」相关的用例，根因是 git 追踪的 `runtime-config.json` 里 `jbLlmIntentClassifier` 已设 `true`，与本次改动无关（这两个用例本身是在测"开关关掉时"的行为，跟生产配置"开关开着"不是一回事）。**如果失败数/失败用例不是这两个，先停下来报告，不要继续验证。**

```bash
npm run pm2:reload   # 或你机器上实际的部署方式
```

确认部署环境：
- `.env` 里 `AGENT_VERO_GENERIC_LOOP` **不是 `false`**（不设置=默认开）且 `WCHAT_ACCESS_TOKEN` 有值、`VERO_BASE_URL` 能连通 `verostudio.sw.nxp.com`。
- `PCR_AI_LOCAL_DUMMY` / `INFCONTROL_LAYER_BINS_DUMMY` / `YIELD_MONITOR_TRIGGERS_DUMMY` 均为 **false**（走真实 Oracle；生产/dist 下 `listDummyRuntime.ts` 本来就会强制关闭，正常部署无需手动设置）。

---

## 2. Q1 — 真实大结果集是否会真正触发 280,000 字符预算压缩

### 2.1 先摸出一个"大"的真实查询

需要一个会产生**很大**工具结果的真实查询——目标是让**多轮**工具调用累积的 history 文本超过 28 万字符（单次工具结果已经被 `VERO_TOOL_RESULT_MAX_HISTORY_CHARS=20000` 截断，所以单次调用几乎不可能触发，需要多轮累积）。建议：

- 挑一个你确认历史数据量很大的真实 `device` 或 `mask`（lot 数多、跨月份多）。
- 用一个**开放式、会连续问多次**的对话，例如：先问"这个 device 最近一年整体良率概况"，工具返回后追问"每个月分别怎么样"，再追问"坏 bin 趋势呢"，再追问"哪几个探针卡表现最差"，再追问"这几片 lot 各自详细情况"——目的是让同一个 session 里连续跑 5-8 轮真实工具调用，每轮都往 history 里堆一份接近 2 万字符的真实结果。

如果自然对话凑不出 28 万字符，用脚本更可控（`scratchpad/vero-generic-loop-live-test.mjs` 是 2026-07-22 已有的 Dummy 版参考写法，**不要直接复用它**——那份脚本开着 `INFCONTROL_LAYER_BINS_DUMMY=true`。照着它的结构写一份新脚本，去掉 Dummy 开关、换成真实 `device`/`lot`，在同一个 `sessionId` 上连续调用 `runVeroAgentLoop` 多次（模拟同一对话的连续追问），每次追问都设计成会真正触发一次新的、内容不同的大工具调用（避免工具层缓存导致重复调用被短路）。

### 2.2 观察是否触发压缩

在你的测试脚本或聊天页里，观察 SSE 事件流：

- **期望在某一轮看到**：`{ type: "status", message: "正在压缩历史对话…" }`
- 触发压缩后，**期望对话能继续正常进行**（不报错、不卡死、后续轮次仍能正常调工具/收尾），而不是压缩之后模型的回答开始丢失早期轮次提到的关键信息（如 device/lot 号）—— 可以在压缩发生后追问一句"我们最开始问的是哪个 device"，看回答是否还对得上。
- 如果始终没有触发（`promptText.length` 一直不到 28 万），把你实际测到的最大单轮 prompt 字符数记下来（可以临时在 `veroAgentLoop.ts` 第 165-166 行附近加一行 `console.log('promptText.length=', promptText.length)`，测完记得删掉），交回 Claude Code——可能需要专门写一个绕过真实对话、直接往 `agentHistory.ts` 的 session 里灌入 N 条大 `tool` 角色消息的脚本来强制触发（不依赖模型自然产生这么长的多轮对话）。

### 2.3 如果临时想验证压缩逻辑本身没写错（不依赖真的攒出 28 万字符）

`VERO_PROMPT_CHAR_BUDGET` 是硬编码常量（`pcr-ai-api/src/lib/agent/core/veroAgentLoopConfig.ts`），**没有**环境变量覆盖入口。如果想用"临时调低阈值"的方式做一次快速验证（不依赖真凑出 28 万字符的对话）：

1. 临时手改该文件里的 `280_000` 为一个很小的数（比如 `5000`）。
2. 跑一次真实的多轮真库对话，确认小阈值下**很容易**在第 2-3 轮就看到"正在压缩历史对话…"且之后对话正常继续。
3. **把这个文件用 `git checkout -- pcr-ai-api/src/lib/agent/core/veroAgentLoopConfig.ts` 恢复**（不要提交这处临时改动）。

这只是验证"压缩机制本身工作正常"的快速旁路，不能替代 2.1/2.2 里"真实阈值 280,000 下用真实大数据会不会被撞到"这个问题本身的答案——两者都要做。

---

## 3. Q2 — 全程零硅基流动复验（含新修的 JB 意图分类器路径）

### 3.1 金丝雀手段：把"不能用硅基流动"从人工检查变成会主动报错的硬约束

在这次测试的整个过程中，**临时**把硅基流动的 API base 指向一个不可达地址：

```bash
# 仅在这次验证会话的 shell 里临时设置，不要写进 .env，测完关掉终端/新开会话即可失效
export AGENT_API_BASE=https://127.0.0.1:1
```

（`agentConfig.ts` 里 `resolveAgentConfig` 读 `AGENT_API_BASE` / `SILICONFLOW_API_BASE`，任何代码路径如果真的调用了 `streamSiliconFlow`，会因为连不上这个地址而**立刻报错或超时**，而不是悄悄成功、不留痕迹。Vero 相关调用走的是 `WCHAT_ACCESS_TOKEN` + `VERO_BASE_URL`，跟这个变量无关，不受影响。）

**先确认这个金丝雀本身没有误伤**——用一句肯定会走纯 Vero 路径的简单问题（比如一句明确的 JB lot 概况问题）跑一遍，确认整个对话能正常走完、不报错。如果这一步都失败了，说明测试环境本身有问题（比如 Vero 也没配好），不是发现了硅基流动调用，先排查清楚再往下走。

### 3.2 覆盖场景清单

在开着上面的金丝雀设置的前提下，依次跑以下几类真实问题，每一类都确认全程无报错、无异常（如果某句问题触发了 SiliconFlow 调用，因为 §3.1 的金丝雀，这里会看到明确的连接失败错误或超时，而不是需要你去猜）：

1. **JB 表解读**（走 `emitBriefCommentaryOrFallback`）：正常问一个具体 lot 的良率概况。
2. **DUT×BIN 聚焦解读**：正常问一个具体 device 下哪些 DUT 良率偏低。
3. **探针卡组合解读**：正常问一个 device 下探针卡+机台组合表现（走 `agentProbeCardVeroPilot.ts` 的 Path B，如果 `.env` 里 `AGENT_PROBE_CARD_VERO_PILOT` 也开着）。
4. **（新修复，重点验证）JB 意图分类器路径**：问一句**故意模糊、不含明确 lot/device/具体维度关键词**的 JB 问题，让正则判不出具体 mode、落到"generic 模式"（例如"这批数据怎么样"这种没有指代清楚的问法，前提是上下文里也没有可复用的 lot/device 缓存）。这句话如果命中了 generic + ambiguous 判定，会调用刚修好的 `callJbIntentClassifier`——**这是本次任务最想验证的一句**，因为它是今天新改的代码，此前只在本地 mock 测试里跑过，从未在真实网络上验证过 Vero 分支是否真的生效。
5. **子项目 A 兜底通用问答**：问一句完全不匹配任何 direct route 的开放式问题，走 `veroAgentLoop.ts` 的多轮 ReAct 主循环。

### 3.3 如何确认第 4 句真的走了 Vero 而不是"根本没触发分类器"

第 4 句如果因为某种原因没有落入"generic + 模糊"判定（比如正则已经能判出具体 mode），分类器根本不会被调用，这一步就测不到东西。用服务端日志确认分类器确实被调用了——检查是否出现分类器的 system prompt 文本（"你是测试数据问句的意图分类器"）对应的一次 Vero `simple-agent/invoke` 请求（如果服务端有请求级日志/`logAgentSql` 之类的记录 Vero 调用，参考已有的 Vero 调用日志格式）。如果始终无法通过自然问法触发这条路径，在回传里说明"未能在真实对话中触发 generic+模糊判定"即可，不是必须项，但请尽量多试几种模糊问法。

### 3.4 恢复

测完之后：

```bash
unset AGENT_API_BASE
```

（如果是新开的 shell 会话跑的测试，直接关掉即可，不需要额外操作；只要确认没有把 `AGENT_API_BASE=https://127.0.0.1:1` 写进 `.env` 或 `pm2` 的持久化配置。）

---

## 4. 回传格式

写入 `scratchpad/realdb-vero-char-budget-and-no-siliconflow-2026-07-23.txt` 或贴回对话，包含：

```
环境：mcp-branch commit = <git rev-parse --short HEAD>，pm2 已 reload（时间）
npm test 结果：<X pass / Y fail / Z skip>，失败用例是否仍是那 2 个已知问题=<是/否，若否贴出具体失败>

Q1 真实字符预算
  测试方式：<自然多轮对话 / 脚本驱动，简述>
  实测到的最大单轮 promptText 长度：<...>字符
  是否触发"正在压缩历史对话…"：<是/否>
  若触发：压缩后对话是否正常继续（追问早期信息是否还答得对）=<是/否，具体说明>
  若未触发：临时调低 VERO_PROMPT_CHAR_BUDGET 快速验证压缩机制本身是否工作正常=<是/否，结果>（记得改回 280_000，未提交此改动）

Q2 全程零硅基流动
  金丝雀设置（AGENT_API_BASE 指向不可达地址）本身是否验证有效（先用简单问题跑通）=<是/否>
  场景1 JB表解读：<正常完成，无报错/超时=是/否>
  场景2 DUT×BIN聚焦解读：<是/否>
  场景3 探针卡组合解读：<是/否，若AGENT_PROBE_CARD_VERO_PILOT未开注明跳过>
  场景4（重点）JB意图分类器路径：是否成功触发generic+模糊判定=<是/否>；若触发，是否观察到走了Vero调用而非报错=<是/否，贴日志片段>
  场景5 兜底通用问答：<是/否>
  全程是否出现任何因AGENT_API_BASE不可达导致的报错（=发现了残留的硅基流动调用）=<是/否，若是贴出具体是哪句问题触发的>

总判：是否发现需要改代码的真实问题？（列出，不要在这份文档里自行改代码）
```

---

## 5. 给 Cursor 的纪律提醒

- **这是一个验证任务，不是改代码。** 如果发现真实问题（压缩机制没生效、压缩后丢失关键上下文、分类器仍然在某些场景下调了硅基流动等），把具体复现步骤 + 数据带回来，交给 Claude Code 定位修复，不要自行改动 `veroAgentLoop.ts` / `veroAgentLoopConfig.ts` / `veroAgentLoopPrompt.ts` / `jbIntentClassifier.ts`。
- **`VERO_PROMPT_CHAR_BUDGET` 如果临时改小做快速验证（§2.3），测完必须 `git checkout` 恢复，不要提交。**
- **`AGENT_API_BASE` 的金丝雀设置只能在这次测试的 shell 会话里临时 `export`，绝不能写进 `.env` 或 pm2 的持久化配置**——那样会让生产环境的 SiliconFlow 回退路径（`AGENT_VERO_GENERIC_LOOP` 未就绪时的兜底）永久失效，属于破坏性变更。
- 不提交 `.claude/settings.local.json`、真实 `.env`、任何密钥（含 `WCHAT_ACCESS_TOKEN`）。
- 若临时加调试脚本/`console.log`（如 §2.2 提到的 `promptText.length` 打印）验证，测完请还原或删除。
