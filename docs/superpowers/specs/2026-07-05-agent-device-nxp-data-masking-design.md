# Agent Device/NXP 数据脱敏 — 设计文档

## 背景与目标

AI Agent（`pcr-ai-api/src/lib/agent/`）会把用户提问、对话历史、工具查询结果发送给第三方 LLM（SiliconFlow）。这些内容里可能包含真实的 device 产品代码（如 `NF12595.1A`、`WA03P02G`）以及公司名 "NXP"。

新增一个 Settings 开关"是否数据脱敏"，打开后：

1. 默认关闭（不脱敏）。
2. 打开后，任何发送给第三方 LLM 的文本中出现的 device 值 / "NXP" 都要替换为不可逆推的令牌。
3. LLM 返回的内容（流式文本、工具调用参数）中出现的令牌，要在到达我们自己的工具执行逻辑 / 页面展示之前还原成真实值。
4. 页面上任何时候都不能出现令牌本身，只能出现真实值。
5. 只脱敏 device 和 "NXP" 这两类，其它字段不动。

脱敏范围仅覆盖**动态数据**（用户消息、历史消息、工具结果、系统提示词中动态插入的数据库快照片段），不覆盖系统提示词里固定的规则/说明性文字（这些是我们自己写的，不含真实数据）。

令牌方案采用**一致性令牌替换**（同一真实值永远映射到同一令牌），不是真正的加密算法——足以满足"LLM 看不到真实值、我方系统能查库、页面只显示真实值"的要求，避免真正加解密带来的密钥管理和长令牌可读性问题。

## 现状调研结论

- 全仓库所有对 SiliconFlow 的调用（主对话循环、历史摘要 `summarizeHistory`、JB 表格解读小模型调用 `emitDeterministicJbTablesReply`）都唯一经过 `pcr-ai-api/src/lib/agent/agentStream.ts` 的 `streamSiliconFlow()` 函数。因此脱敏/还原可以完全封装在这一个文件里，`agentLoop.ts`（4000+ 行、数十条 JB 直连路由函数）**不需要任何改动**——它们通过 `runTool()` 拿到的工具调用参数、通过 `onChunk` 拿到的流式文本，届时已经是还原后的真实值。
- 会话历史由后端在内存中维护（`agentHistory.ts` 的 `sessions: Map<string, Session>`，2 小时 TTL），存的始终是**真实值**，不做脱敏落盘。脱敏只发生在“即将发给 LLM”这一瞬间，且每次请求都基于当时的真实历史现算，不需要维护跨请求的令牌状态。
- 系统提示词 `agentPrompt.ts` 的 `buildSystemPrompt()` 会把当前 top device 列表（来自 `agentManifest.ts` 的数据库快照）动态拼进 system 消息里 —— 这属于动态数据，必须和 user/assistant/tool 消息一样被脱敏，不能因为角色是 system 就跳过。
- 现有的 `pcr-ai-api/src/lib/deviceMask.ts` 里的 `deviceMask` / `deviceBaseMask` 是 JB STAR 领域里"设备型号后缀"的概念（与本设计的"脱敏"完全无关），**必须避免在新代码里复用"mask"这个词**，防止和这个既有领域术语混淆。新模块命名为 `agentDataMasking.ts`。
- 现有 `get_filter_values` 工具的 `field=device` 必须携带一个 4 位 `mask`（设备型号后缀）才能查，**不存在无条件返回全量 distinct device 列表的能力**。本设计需要新增一条全量查询。
- 经与用户确认，distinct device 数量级为"上千"，可以全量常驻内存缓存，每天刷新一次即可（不需要 30 分钟级别的高频刷新）。

## 架构

### 令牌方案

- **Device**：从全量 distinct device 字典生成确定性令牌 `DEV_` + 该真实值 SHA-256 哈希的前 10 位十六进制字符（如 `DEV_a1b2c3d4e5`）。字典刷新（每天一次）后同一真实值永远映射到同一令牌。若两个不同真实值哈希前 10 位冲突（理论上极小概率），冲突双方自动加长到 12 位，直至唯一。
- **NXP**：固定单一替换，不进字典，不区分大小写：正则 `/nxp/gi` → 固定占位符 `COMPANY_X`。

### 字典构建与缓存（`agentDataMasking.ts`）

- **Oracle 路径**：
  ```sql
  SELECT DISTINCT DEVICE FROM YMWEB_YIELDMONITORTRIGGER WHERE <非空判断>
  UNION
  SELECT DISTINCT DEVICE FROM INFCONTROL WHERE <非空判断>
  ```
  （沿用 `oracleStringSql.ts` 里已有的 `oracleNonEmptyTrimmedColumn` 处理 Oracle 的 `TRIM(col)!=''` 陷阱。）
- **Dummy 路径**（遵守项目"Oracle/Dummy 双路径同步"硬规则）：直接从 `getYieldMonitorTriggerDummyRows()` 和 `getInfcontrolLayerBinDummyRows()` 内存数组里取 distinct `DEVICE` 字段，不新增查询。
- **缓存**：内存 Map，24 小时 TTL；懒加载——只有当 `dataMaskingEnabled=true` 且缓存过期/为空时才触发一次构建；构建失败（Oracle 报错）只记日志，本次请求视为字典为空（只替换 NXP，不影响 Agent 正常工作）。
- 字典构建完成后同时生成一个合并正则（所有真实值转义后按长度降序 `|` 连接，避免短值抢先命中长值的前缀），随字典一起缓存，每次刷新时重建。

### 出方向：mask（`streamSiliconFlow` 请求体组装前）

对 `request.messages` 数组的**每一条消息**（不分角色）执行：
- 若 `content` 是字符串：用合并正则做一次 `replace`，命中的真实 device 值 → 对应令牌；再对结果做一次 NXP 替换。
- 若消息带结构化 `tool_calls`（历史里 assistant 消息回显的函数调用记录）：对每个 `tool_calls[i].function.arguments` 字符串做同样处理。

只有 `getConfig().dataMaskingEnabled === true` 时才执行；为 `false` 时 `streamSiliconFlow` 行为与今天完全一致（零额外开销）。

### 入方向：unmask

- **流式文本**（`res.on("data")` 里 `onChunk({type:"delta", text})` 之前）：用一个带前瞻缓冲的 `StreamUnmasker`（结构类比 `agentLoop.ts` 里 `createDeepSeekFilter` 的 `pending`/`LOOKAHEAD` 机制）——缓冲区长度 ≥ 最长令牌长度（`DEV_` + 12 位 = 16 字符，缓冲设 20 字符打底），保证令牌不会因为跨两个网络包被截断而还原失败。`push(delta): void` 累积文本并 emit 安全前缀（已还原）；流结束时 `finalize(): string` 冲刷剩余缓冲。
- **工具调用参数**（`res.on("end")` 里 `collected[i].args` 已是累积完的完整 JSON 字符串）：一次性整体 `unmask()`，再调用 `onChunk({type:"tool_calls", calls})`。这样 `agentLoop.ts` 后续派发给 `runTool()` 执行的数据库查询用的已经是真实 device 值。

## 涉及文件

**新增：**
- `pcr-ai-api/src/lib/agent/agentDataMasking.ts` — 字典构建（Oracle+Dummy）、缓存、令牌生成、`mask()`、`unmask()`、`createStreamUnmasker()`。
- `pcr-ai-api/test/agentDataMasking.test.ts` — 字典构建两路径、mask/unmask 往返、流式边界切割、NXP 替换、冲突处理、开关关闭直通。

**修改：**
- `pcr-ai-api/src/lib/runtimeConfig.ts` — 新增 `dataMaskingEnabled: boolean`，默认 `false`，无 env 兜底（纯新功能，无历史 env 变量）。
- `pcr-ai-api/src/lib/agent/agentStream.ts` — 接入上述 mask/unmask 三处调用点。
- `pcr-ai-report/src/hooks/useServerConfig.ts` — `ServerConfig` / `SERVER_CONFIG_DEFAULTS` 加 `dataMaskingEnabled` 字段。
- `pcr-ai-report/src/App.tsx` — Settings 页新增开关行"是否数据脱敏"，复用 `.setting-toggle-row` / `toggle-switch` 样式（与 `jbDeterministicDispatch` 一致的写法）。
- `pcr-ai-api/CLAUDE.md` / `pcr-ai-report/CLAUDE.md` — 变更记录。

## 错误处理

- 字典构建失败（Oracle 连接/SQL 错误）：捕获异常记日志，本次视为空字典，不阻断 Agent 主流程（只是这次请求 device 值原样发送，NXP 仍会被替换）。
- 开关默认关闭；关闭状态下不做任何字典构建或字符串扫描，性能零影响。
- 流式还原缓冲在异常提前结束（网络错误/超时）时，`finalize()` 仍需被调用以冲刷缓冲区剩余内容，避免尾部文本丢失。

## 测试计划

- `agentDataMasking.test.ts`：
  - Oracle 路径字典构建（mock 连接）与 Dummy 路径字典构建，验证两者返回一致的字典结构。
  - `mask()` → `unmask()` 往返：同一文本脱敏后还原应完全等于原文本。
  - 流式场景：把一个完整令牌人为切成两个 `push()` 调用，验证 `StreamUnmasker` 仍能正确还原（不能提前把半个令牌当普通文本冲出去）。
  - NXP 大小写变体（`NXP`/`nxp`/`Nxp`）替换与还原。
  - 令牌哈希冲突场景（构造两个前 10 位哈希相同的值）自动加长验证唯一性。
  - `dataMaskingEnabled=false` 时 `mask()`/`unmask()` 为直通（不修改文本）。
- `agentStream.test.ts`（在现有测试基础上新增用例）：mock HTTPS 响应验证开关打开后请求体里不含真实 device 值、`onChunk` 收到的 delta/tool_calls 已还原为真实值。

## 未决假设（实现时验证）

- Distinct device 数量级"上千"——按此设计全量常驻内存 + 每日刷新一次，若实现时发现远超此量级需要重新评估缓存策略（本设计不预先处理该情况）。
