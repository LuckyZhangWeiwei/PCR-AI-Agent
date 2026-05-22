# AI Agent 与 LLM 工具调用——通俗说明

> 这份文档解释 Agent 聊天功能背后的工作原理，以及我们遇到的实际问题和解决思路。  
> 目标读者：了解业务、不需要深入看代码的人。

---

## 一、OpenAI Chat Completions 是什么

我们项目里 Agent 的后端（`pcr-ai-api`）和外部 LLM（DeepSeek / MiniMax 等）通信时，走的是 **OpenAI Chat Completions API 格式**。

这不是一个网络协议，而是一套"**怎么写请求体、怎么读回复**"的约定，类似大家都说普通话，沟通起来不用翻译。

国内的硅基流动（SiliconFlow）平台上的 DeepSeek、MiniMax 等模型，都对齐了这套格式，所以我们的代码可以不改，只换个模型名就切换模型。

---

## 二、最基本的对话格式

每次调用 LLM，我们发一个 JSON，核心字段是 `messages`——一个对话历史列表，每条消息有 `role`（角色）和 `content`（内容）。

### 角色有四种

| role | 是谁说的 | 举例 |
|---|---|---|
| `system` | 给模型的"岗位职责说明" | "你是 NXP 探针卡良率分析助手，回答用中文…" |
| `user` | 用户说的话 | "6095-01 这张卡最近良率怎样？" |
| `assistant` | 模型回的话 | "我来查一下…" 或者调工具的指令 |
| `tool` | 工具执行后的返回结果 | `{ "totalRowsMatching": 24, "avgYield": 0.91 }` |

### 一次简单对话的 messages 长这样

```json
[
  { "role": "system",    "content": "你是良率分析助手…" },
  { "role": "user",      "content": "6095-01 最近良率怎样？" },
  { "role": "assistant", "content": "我来查一下数据。" }
]
```

---

## 三、工具调用（Function Calling）是什么

LLM 本身不能查数据库，只能生成文字。为了让它"查数据"，我们告诉它：**你有几个工具可以用，需要数据时告诉我你要调哪个、传什么参数，我来帮你执行，结果再告诉你。**

这就是 **Function Calling / 工具调用**。

### 我们项目里有哪些工具

| 工具名 | 作用 |
|---|---|
| `aggregate_jb_bins` | 按维度（lot / tester 等）汇总 JB STAR 的 bin 统计 |
| `query_jb_bins` | 查 JB STAR 明细数据 |
| `aggregate_yield_triggers` | 汇总产量触发器数据 |
| `get_filter_values` | 查某个字段有哪些可选值（如有哪些 lot） |

---

## 四、一次完整的工具调用长什么样

以"6095-01 测过哪些 lot"为例，完整的对话轮次是这样的：

### 第 1 轮：我们发给模型

```json
{
  "messages": [
    { "role": "system", "content": "你是良率分析助手…" },
    { "role": "user",   "content": "6095-01 测过哪些 lot，列 top15" }
  ],
  "tools": [ { "工具定义 aggregate_jb_bins": "…" } ],
  "tool_choice": "auto"
}
```

### 模型回复（它想调工具）

```json
{
  "role": "assistant",
  "content": null,
  "tool_calls": [
    {
      "id": "call_abc123",
      "type": "function",
      "function": {
        "name": "aggregate_jb_bins",
        "arguments": "{ \"cardId\": \"6095-01\", \"groupBy\": \"lot\" }"
      }
    }
  ]
}
```

模型没有直接回答，而是说"我要调 `aggregate_jb_bins`，参数是 cardId=6095-01"。

### 我们执行工具，把结果加进 messages

```json
{ "role": "tool", "tool_call_id": "call_abc123", "content": "{ top lots data... }" }
```

### 第 2 轮：带着工具结果再问模型

```json
{
  "messages": [
    { "role": "system",    "content": "你是良率分析助手…" },
    { "role": "user",      "content": "6095-01 测过哪些 lot，列 top15" },
    { "role": "assistant", "content": null, "tool_calls": [ "…上面那个…" ] },
    { "role": "tool",      "content": "{ top lots data... }" }
  ]
}
```

### 模型这次直接回答

```json
{
  "role": "assistant",
  "content": "6095-01 共测试了 47 个 lot，top15 按良率排列如下：…"
}
```

这就是一次完整的 ReAct（推理→调工具→再推理）循环。

---

## 五、`tool_choice` 参数详解

这个参数控制**模型这一轮可不可以调工具**：

| 值 | 含义 | 什么时候用 |
|---|---|---|
| `"auto"` | 模型自己决定（调或不调都行） | 正常推理轮 |
| `"none"` | 禁止调工具，只能输出文字 | 想强制模型给结论时 |
| `"required"` | 必须调工具 | 较少用 |

**重要**：`tool_choice` 只有在请求里同时带了 `tools`（工具列表）时才有意义。如果请求里根本没有 `tools`，模型本来就无法产生结构化的工具调用，`tool_choice` 是多余的。

---

## 六、我们遇到的问题

### 问题 A：DeepSeek 拿到数据后不写结论，一直调工具（卡死 270 秒）

**模型怎么决定"还要不要调工具"？**

每一轮，我们发给模型的请求里包含两样东西：
- **对话历史**（messages）——之前说了什么、工具返回了什么
- **工具列表**（tools）——你现在可以用哪些工具

模型看着这两样东西做决定：数据够了就写结论，觉得不够就再调一个工具。

**为什么会卡死？**

工具结果已经返回后，第 2 轮请求里我们仍然带着 `tools + tool_choice: "auto"`，相当于告诉模型"你自由选择，还可以调工具"。DeepSeek 觉得"再查一次数据会更准确"，于是又调了工具，下一轮继续如此，进入死循环直到超时。

```
第1轮：调工具 ✅
第2轮：又调工具 ⚠️  ← 工具结果已经有了，应该写结论
第3轮：又调工具 ⚠️
...270秒超时 ❌
```

**怎么修的？**

第 2 轮开始，请求里**不再带工具列表**。没有工具列表，模型就无法用标准格式（`tool_calls` 字段）调工具，只能输出文字。同时在 system 里加一句提示："工具已完成，请立即给中文结论"。

**"万一第 2 轮还真的需要调工具怎么办？"**

这是个合理的担心。不带工具列表只是屏蔽了**标准格式**的工具调用，但模型仍然可以把"我要调工具"写进文字内容里（嵌入式格式，见问题 B）。我们的过滤器会识别并照样执行：

| 调工具的方式 | 第 1 轮 | 第 2 轮以后 |
|---|---|---|
| 标准 `tool_calls` 字段 | ✅ 允许 | ❌ 不发工具列表，不可能产生 |
| 嵌入在文字里（XML 等格式） | ✅ 允许 | ✅ 过滤器识别后照样执行 |

设计原则是：**尽量在第 1 轮一次性把需要的工具都调完**（system prompt 里有这条提示）。如果模型确实需要多步，过滤器允许它通过嵌入格式继续，`maxRounds`（最多 5 轮）作为最终兜底。

---

### 问题 B：MiniMax 的 `<minimax:tool_call>` XML 泄漏到聊天气泡

**为什么会这样？**

LLM 标准的工具调用格式是结构化的 `tool_calls` 字段（参考第四节）。但 MiniMax 2.5 有时不走这条路，而是把"我要调工具"这件事直接写进文字内容（`content`）里，格式是 XML：

```xml
<minimax:tool_call>
  <invoke name="aggregate_jb_bins">
    <parameter name="cardId">6095-01</parameter>
    <parameter name="groupBy">lot</parameter>
  </invoke>
</minimax:tool_call>
```

这叫**嵌入式工具调用**（embedded tool call）。DeepSeek 也有类似行为，格式不同：

```
<｜tool▁sep｜>aggregate_jb_bins
{ "cardId": "6095-01" }
<｜tool▁call▁end｜>
```

因为这些内容出现在 `content` 字段里，如果不过滤，就会原样显示在聊天气泡中。

**怎么修的？**

在内容流进入 UI 之前，加了一个过滤器（`createDeepSeekFilter`），专门识别并静默吃掉这些格式，同时把它们翻译成标准工具调用去执行。

---

### 问题 C：修了 MiniMax 格式后，又报错"总结阶段仍尝试调工具"

**为什么会这样？**

为了解决问题 A，代码里加了一条规定："如果是总结轮，模型还想调工具就报错。"

MiniMax 查复杂数据（如 top15 lot yield）**天生需要两步**：先 aggregate 汇总，再 query 拿明细。过滤器把第二个 `<minimax:tool_call>` 识别成了工具调用，触发了报错。

**怎么修的？**

删掉了"总结轮不准调工具"这条硬性报错。改用两个更合理的安全网：
- **`maxRounds`**（默认 5 轮）：最多跑 5 轮，到顶自动停
- **`SUMMARIZE_NUDGE`**：每一轮 system 里都有提示"该总结了"，引导模型最终输出结论

---

## 七、最终的工作流程（修复后）

```
用户提问
  ↓
第1轮：发给模型（带工具列表）
  ↓ 模型返回 tool_calls（或嵌入式格式）
过滤器识别，执行工具，结果存入历史
  ↓
第2轮：发给模型（不带工具列表，system 里有"请总结"提示）
  ↓ 如果模型还要调工具（MiniMax 多步）
  过滤器识别，执行工具，继续下一轮
  ↓ 如果模型输出文字结论
结束，显示给用户
  ↓ 如果超过 maxRounds（5轮）
报错"已达最大推理轮数"，让用户精简问题
```

---

## 八、各模型的嵌入式工具调用格式对照

| 模型 | 格式名 | 特征 |
|---|---|---|
| DeepSeek（旧） | DS native token | `<｜tool▁sep｜>` 特殊符号 |
| DeepSeek（新）/ SiliconFlow | DSML | `<｜DSML｜tool_calls>…` |
| MiniMax 2.5 | MiniMax XML | `<minimax:tool_call>…` |

这些格式都是各家模型在"标准结构化 tool_calls 不可用时"的备用输出方式，行为相同，只是语法不同。我们的过滤器（`createDeepSeekFilter`，文件 `agentLoop.ts`）同时支持这三种。
