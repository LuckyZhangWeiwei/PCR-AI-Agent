# Cursor 交接（2026-07-22 · 给 Cursor）— Vero 通用 Agent 循环真连测试

> **执行者：** Cursor Agent（需真实网络 + 真实 `WCHAT_ACCESS_TOKEN`，本机 Claude Code 环境连不上 `verostudio.sw.nxp.com`）
> **读者：** Cursor / 有真实网络访问权限的同事
> **前置阅读：**
> - 设计：[`docs/superpowers/specs/2026-07-21-vero-generic-agent-loop-design.md`](../superpowers/specs/2026-07-21-vero-generic-agent-loop-design.md)
> - 计划：[`docs/superpowers/plans/2026-07-21-vero-generic-agent-loop.md`](../superpowers/plans/2026-07-21-vero-generic-agent-loop.md)
> - 进度台账（9 个子任务 + code review 均已完成）：`.superpowers/sdd/progress.md`
> - 参考实现（Path B，已生产验证过一次真连）：[`HANDOFF_CURSOR_VERO_PROBE_CARD_PILOT.md`](HANDOFF_CURSOR_VERO_PROBE_CARD_PILOT.md)
> **分支：** `worktree-vero-generic-agent-loop`（**尚未合并进 `mcp-branch`**，需要先 fetch/checkout 这个分支）

---

## 0. 一眼结论

| 项 | 状态 | 说明 |
|---|---|---|
| **代码实现** | ✅ 完成 | 9 个子任务 + 独立 code review 均 clean，`npm test`/`typecheck`/`build` 全绿 |
| **Review 后修复** | ✅ 已合入本分支 | 见 §1 两处 Important 修复（commit `cdb91b1`） |
| **本机可验证范围** | ✅ 已做完 | 单元测试（mock Vero）、类型检查、构建产物 no-undici 检查 |
| **本机不可验证范围** | ⏭ **交给你** | 一切需要真实 `POST {VERO_BASE}/api/simple-agent/invoke` 网络调用的行为 —— 本机环境无法访问 `verostudio.sw.nxp.com` |
| **开关** | 默认关 | `AGENT_VERO_GENERIC_LOOP=true` **且** `WCHAT_ACCESS_TOKEN` 有值才生效；关闭时 100% 回退到现有 SiliconFlow 循环，零风险 |
| **数字权威** | 不变 | 工具执行层（`runTool`）和 Oracle/Dummy 双路径完全不受影响，本子项目只换"谁来决定调哪个工具/何时收尾" |

---

## 0.5 官方澄清（2026-07-22）——"Claude 4.6 / 128K"这个前提未经证实

设计文档和 `veroAgentLoopConfig.ts` 里的 128K 校准常量（`VERO_SUMMARIZE_THRESHOLD=60`、`VERO_TOOL_RESULT_MAX_HISTORY_CHARS=15000`、`VERO_PROMPT_CHAR_BUDGET=180_000`），全部基于 2026-07-21 会话里的一句转述"wchat 是 claude4.6 的模型，上下文是 128K"——**这不是官方信息，只是当时的印象**。

官方口径（NXP IT 提供）：

> Vero Studio 的 LLM provider 是 **AWS Bedrock**。上下文窗口是"该模型在 AWS Bedrock 上支持的标准值"——具体是多少要看 NXP AIAC 批准的是 Bedrock 目录里哪一个 Claude 型号（**不是 Bedrock 全部模型 VeroStudio 都能看到**）。

也就是说，背后可能是 Claude 3.x/3.7（Bedrock 上通常 200K）、Claude 4.x（Bedrock 上通常也是 200K，除非另开了更大上下文的 beta），也可能真的接近 128K——**方向未知，不能再当作已确认的事实**。§3.5 的字符预算实测，请先做以下两件事再测：

1. **确认背后到底是哪个模型。** 可以直接问 Vero："你是基于哪个模型/哪个版本？"（模型自报不一定准，但作为交叉验证的第一步）；如果有权限，检查 Vero Studio 后台/管理界面里 AIAC 批准的具体 Bedrock 模型 ID（`anthropic.claude-...`）。
2. **确认真实上下文窗口。** 用递增长度的 prompt 测试实际何时开始报错/截断/质量骤降，不要假设 128K。

如果实测发现真实上下文比 128K **更小**，现有护栏（180K 字符 ≈ 128K token 的保守估算）可能不够，需要收紧；如果**更大**（比如 200K），现有护栏只是偏保守、浪费一点摘要触发的余量，不算 bug，但值得放宽以减少不必要的历史压缩。两种情况都请回填进 §4 结果表。

---

## 1. 这次 code review 发现并已修的两处问题（供你验证修复是否生效）

1. **`PRE_LLM_DIRECT_ROUTES` 之前每轮都会重跑**，而不是像旧 SiliconFlow 循环那样只在本轮第一次工具调用前跑一次。如果第一轮 Vero 选的工具往 history 写入了 device/card 之类信息，第二轮某个直连路由（例如 lot 列表路由 `resolveJbListingScope`）可能因为能从 history 里"倒推"出 device 而突然从"匹配不上"变成"匹配上"，把模型正在做的多轮分析中途打断、抢答一张确定性表格。现已改为只在 `!historyAwaitingToolSummary(history)` 时才跑直连路由表，与旧循环行为对齐。见 `pcr-ai-api/src/lib/agent/core/veroAgentLoop.ts` 的 gate + `pcr-ai-api/test/veroAgentLoop.test.ts` 新增的回归测试（"PRE_LLM_DIRECT_ROUTES does not re-run mid-turn..."）。
2. **Vero 的 HTTPS 调用之前没有超时**，而通用循环一轮最多可能连续发起 2 次（重试 1 次）× 最多 `maxRounds`（默认 5）轮 = 最多 10 次不设超时的请求。一旦 Vero 后端卡住，SSE 连接会靠 15 秒心跳一直挂着，前端一直转圈但既不报错也不结束。现已加 60 秒 socket 超时（`pcr-ai-api/src/lib/vero/veroSimpleAgent.ts` 的 `DEFAULT_VERO_REQUEST_TIMEOUT_MS`，可通过 `invokeVeroSimpleAgent(..., { timeoutMs })` 覆盖）。**这条本机无法验证超时是否真的触发（需要真实网络挂起场景）——见 §3.4。**

---

## 2. 环境变量

写在 **API 服务器** `pcr-ai-api/.env`（**勿提交**；勿进浏览器；与 Path B 共用同一个 token）：

```bash
AGENT_VERO_GENERIC_LOOP=true
WCHAT_ACCESS_TOKEN=<JWT，不要带 Bearer 前缀>
VERO_BASE_URL=https://verostudio.sw.nxp.com
# 企业 MITM：默认 Vero TLS 可跳过校验；强制校验：
# VERO_TLS_STRICT=true
# 建议测试期间保持 Dummy，便于反复重跑不占用真实 Oracle：
INFCONTROL_LAYER_BINS_DUMMY=true
```

- 进程须能访问 `verostudio.sw.nxp.com`（NXP 内网/VPN）。
- **关闭：** `AGENT_VERO_GENERIC_LOOP=false` 或清空 token → `pm2 reload`（若已部署）或直接停用本地进程 → 回到现有 SiliconFlow 循环。

---

## 3. 测试任务清单（请逐条跑，把结果填进 §4 的表）

### 3.1 冒烟脚本（起点，先跑这个）

```bash
cd pcr-ai-api
npm ci
npx tsx scripts/smoke-vero-generic-loop.mjs
```

**已知局限，跑完请留意：** 脚本里的问题 `"WA03P02G 最近的探针卡机台组合表现怎么样"` 措辞很可能直接命中 `tryRunProbeCardPerfDirectRoute`（探针卡×机台组合的既有直连路由），如果命中，这条问题**根本不会走到 Vero 的多轮协议**，只是验证了"开关生效后没有报错"。请在日志里确认：如果只看到一次 `tool_start`/`tool_result` 就直接 `done`，且没有出现任何你能辨认出的"第二次 Vero 调用"的痕迹，说明是被直连路由接管了，不算多轮验证——请追加 §3.2 的问题重跑。

### 3.2 多轮工具调用 + JSON 协议稳定性（spec §8.3 开放问题）

用**不会命中任何现有直连路由**的问法（不含具体 lot/device/card/bin 编号，不含"探针卡"+"机台"+"组合"这种固定搭配），例如：

- "最近整体测试情况怎么样，有什么值得关注的吗"
- "帮我看看现在有没有什么异常趋势"
- "随便挑一个最近的批次，分析一下良率"

对每条问题记录：
- Vero 是否稳定吐出裸 JSON / ```json 围栏 JSON，还是偶尔在 JSON 外面夹杂解释性文字导致 `parseJsonLoose` 的首尾 `{…}` 截取兜底被触发（若被触发但仍解析成功，记录下来，不算失败，但值得跟踪）？
- 是否出现过 `tool` → `tool` → `final` 的真实多轮链路（至少 2 次工具调用）？
- 每轮 `tool_start`/`tool_result` 事件与最终 `final` 文案是否语义匹配（Vero 有没有"选错工具"或"读错上一轮工具结果"的情况）？

### 3.3 §1 第 1 条修复的真实验证：direct-route 劫持场景

这是本次 review 认为**最值得真连测试专门验证**的一条。构造一个多轮问题，让第一轮工具调用的参数里出现一个具体 device/card（例如 Vero 自己决定调 `aggregate_probe_card_tester_performance` 并带了 `device: "WA03P02G"`），且**第二轮用户原始问题文本里完全不提这个 device**。观察：

- 第二轮是否正常再次调用 Vero（说明 gate 生效，未被直连路由抢答）？
- 如果你想主动构造反例来"压力测试"这个修复，可以临时把 `veroAgentLoop.ts` 里新加的 `if (!historyAwaitingToolSummary(history))` 判断注释掉、重跑同一问题，对比行为差异，确认修复前后确实不同（然后记得改回来，不要提交这个临时改动）。

### 3.4 超时行为（§1 第 2 条修复，本机完全无法验证）

如果你有办法模拟一次"Vero 响应很慢/挂起"（例如临时把 `VERO_BASE_URL` 指向一个会阻塞但不断开连接的地址，或者观察一次真实的慢响应），确认：60 秒后是否真的收到 SSE `error` 事件而不是无限转圈？如果没有条件模拟，就跳过，标注"未测试，需要专门场景"。

### 3.5 单轮字符预算（spec §8.2 开放问题）+ 模型身份确认（见 §0.5）

**先做 §0.5 的两步确认**（问 Vero 自己是什么模型/版本；有权限的话查 Vero Studio 后台的 AIAC 批准型号），把结果记在下面的表里——不要跳过，这决定了这条测试本身的解读方式。

然后用一个会触发**大结果集**的问题（例如让某条 lot 的全量 JB 数据、多轮 `aggregate_jb_bins` 累积），观察：

- `status` 事件里是否出现过"正在压缩历史对话…"（说明 `isVeroPromptOverBudget` 的 18 万字符阈值被触发）？
- 触发压缩后，Vero 后续轮次是否仍能正常给出合理回答（没有因为摘要丢失关键信息而答非所问）？
- 记录一次实际观察到的、未触发压缩前的单轮 prompt 大致字符量级（哪怕是估算），用于回填校准 `VERO_PROMPT_CHAR_BUDGET` / `VERO_TOOL_RESULT_MAX_HISTORY_CHARS`（当前 15000，`veroAgentLoopConfig.ts`）是否需要调整——**调整方向请结合模型身份确认的结果**：如果背后模型上下文明显大于 128K，可以放宽；如果更小，必须收紧。

### 3.6 最后一轮强约束（spec §8.4 开放问题）

把 `agentConfig.maxRounds` 临时调小（例如改测试脚本里的 `maxRounds: 2`），问一个明显需要 3+ 轮才能查清楚的问题，观察：

- Vero 在最后一轮是否遵守 system prompt 里"这是最后一轮，必须返回 `action:final`"的约束？
- 如果不遵守，落到的兜底文案（"已完成以下查询：xxx，但未能在 N 轮内给出最终结论"）是否符合预期（这是已知的 spec-vs-plan 简化点，只列出工具名，不汇总数据——不是 bug，属于已知后续优化项，不用因此判定测试失败）？

### 3.7 TLS / 网络基线

复用 Path B 已验证过的 `veroTlsInsecure()` 行为（企业 MITM 默认跳过证书校验），确认在通用循环更高的调用频次下没有新的 TLS 报错。

---

## 4. 请回填的结果表

请在这份文档（或另开一份 `HANDOFF_CURSOR_VERO_GENERIC_LOOP_TEST_RESULTS.md`）里用类似下表的格式回报，方便下一轮 Claude Code 会话直接读取：

| 测试项 | 结果 | 备注/异常日志 |
|---|---|---|
| 0.5 背后模型身份 + 真实上下文窗口 | ✅/❌/未确认 | 模型自报的版本、Vero Studio 后台 AIAC 批准的 Bedrock 型号（若有权限查）、实测上下文大小 |
| 3.1 冒烟脚本 | ✅/❌ | 是否命中了直连路由（未测到多轮） |
| 3.2 多轮 JSON 协议 | ✅/❌ | JSON 稳定性、是否需要加强 `parseJsonLoose` |
| 3.3 direct-route 劫持修复验证 | ✅/❌ | 是否复现过劫持（应复现不了） |
| 3.4 超时 | ✅/❌/未测试 | |
| 3.5 字符预算 | ✅/❌ | 实测单轮 prompt 量级，是否需要调常量（结合 0.5 的结果判断调整方向） |
| 3.6 最后一轮强约束 | ✅/❌ | 模型遵守率 |
| 3.7 TLS | ✅/❌ | |

---

## 5. Hard rules（接手勿破）

1. **no-undici**：Vero 出站只用 `node:https`（`veroSimpleAgent.ts` 已是这样，新代码不要引入 undici）。
2. **勿把 `WCHAT_ACCESS_TOKEN` 写进仓库 / 前端 / 本交接文档正文 / 测试结果回填文档**。
3. **oracledb@5.5**：勿升 6.x。
4. 测试期间发现代码 bug 请直接在本分支（`worktree-vero-generic-agent-loop`）提交修复 + 补测试，commit message 里注明是真连测试发现的，不要静默改行为。
5. **不要合并到 `mcp-branch`**——合并时机由发起这次交接的会话决定（该分支尚未合并，见文档头部"分支"字段）。

---

## 6. 根 CLAUDE.md 索引

尚未加入仓库根 `CLAUDE.md`（该文件目前只在 `mcp-branch` 上维护，本分支未合并前先不改，避免合并时冲突）。合并时请一并在 `CLAUDE.md` 补一行索引到本文档。
