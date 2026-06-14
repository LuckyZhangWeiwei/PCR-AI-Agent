# ask_clarification 选项按钮 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 当用户给出 device mask（如 "N06Z"）且 `get_filter_values` 返回多个候选完整 device 时，agent 通过 `ask_clarification(question, options)` 让前端渲染可点选按钮，用户点击即提交选择，agent 继续查询。

**Architecture:** 扩展 `ask_clarification` 工具：schema 加可选 `options` 字段 → handler 写入 `ClarificationSentinel` → agentLoop emit 时透传 → `AgentSseEvent` 类型扩展 → 前端 SSE handler + 渲染层增加按钮 chip。Prompt 仅在 mask 消歧场景指示使用 `options`。

**Tech Stack:** Node.js + TypeScript（后端），React 19 + TypeScript + Vite（前端）。测试框架：`node:test` + `node:assert/strict`；运行命令 `npm test`（在 `pcr-ai-api/` 下）。

---

## File Map

| 文件 | 操作 | 说明 |
|---|---|---|
| `pcr-ai-api/src/lib/agent/agentChartTool.ts` | Modify | `ClarificationSentinel` 加 `__clarification_options?` |
| `pcr-ai-api/src/lib/agent/agentToolSchemas.ts` | Modify | `ask_clarification` schema 加 `options` 参数 |
| `pcr-ai-api/src/lib/agent/agentToolHandlers.ts` | Modify | handler 读取并透传 `options` |
| `pcr-ai-api/src/lib/agent/agentLoop.ts` | Modify | `AgentSseEvent` clarification 加 `options?`；emit 时透传 |
| `pcr-ai-api/src/lib/agent/agentPrompt.ts` | Modify | mask 消歧场景补充 `options` 使用说明 |
| `pcr-ai-api/test/agentTools.clarification.test.ts` | Create | handler 单元测试 |
| `pcr-ai-report/src/reports/AiAgentReport.tsx` | Modify | 类型 + SSE handler + 按钮渲染 |
| `pcr-ai-report/src/reports/AiAgentReport.css` | Modify | 按钮 chip 样式 |

---

## Task 1: 写失败测试（后端 handler）

**Files:**
- Create: `pcr-ai-api/test/agentTools.clarification.test.ts`

- [ ] **Step 1: 创建测试文件**

```ts
// pcr-ai-api/test/agentTools.clarification.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runTool } from "../src/lib/agent/agentToolHandlers.js";

describe("ask_clarification tool", () => {
  it("no options: returns sentinel with only __clarification", async () => {
    const result = await runTool("ask_clarification", { question: "请问您查哪个 device？" });
    assert.ok(typeof result === "object" && result !== null && "__clarification" in result);
    const r = result as Record<string, unknown>;
    assert.strictEqual(r["__clarification"], "请问您查哪个 device？");
    assert.strictEqual(r["__clarification_options"], undefined);
  });

  it("with options: returns sentinel with __clarification_options array", async () => {
    const result = await runTool("ask_clarification", {
      question: "请选择要查询的完整 device 代码",
      options: ["WC13N06Z", "WC07N06Z"],
    });
    assert.ok(typeof result === "object" && result !== null && "__clarification" in result);
    const r = result as Record<string, unknown>;
    assert.strictEqual(r["__clarification"], "请选择要查询的完整 device 代码");
    assert.deepStrictEqual(r["__clarification_options"], ["WC13N06Z", "WC07N06Z"]);
  });

  it("filters empty strings from options", async () => {
    const result = await runTool("ask_clarification", {
      question: "选择",
      options: ["WC13N06Z", "", "WC07N06Z"],
    });
    const r = result as Record<string, unknown>;
    assert.deepStrictEqual(r["__clarification_options"], ["WC13N06Z", "WC07N06Z"]);
  });

  it("empty options array → __clarification_options is undefined", async () => {
    const result = await runTool("ask_clarification", {
      question: "选择",
      options: [],
    });
    const r = result as Record<string, unknown>;
    assert.strictEqual(r["__clarification_options"], undefined);
  });

  it("empty question → returns error string", async () => {
    const result = await runTool("ask_clarification", { question: "" });
    assert.strictEqual(typeof result, "string");
    assert.ok((result as string).includes("question 不能为空"));
  });
});
```

- [ ] **Step 2: 确认测试失败**

```bash
cd pcr-ai-api && npm test 2>&1 | grep -A5 "ask_clarification"
```

预期：`__clarification_options` 相关断言失败（`undefined !== ["WC13N06Z","WC07N06Z"]`）；no-options 和 error-string 用例应 PASS。

---

## Task 2: 后端实现（5 个文件）

**Files:**
- Modify: `pcr-ai-api/src/lib/agent/agentChartTool.ts:15-17`
- Modify: `pcr-ai-api/src/lib/agent/agentToolSchemas.ts`
- Modify: `pcr-ai-api/src/lib/agent/agentToolHandlers.ts`
- Modify: `pcr-ai-api/src/lib/agent/agentLoop.ts:72-80`
- Modify: `pcr-ai-api/src/lib/agent/agentPrompt.ts`

### Step 1: 扩展 `ClarificationSentinel` 类型

`agentChartTool.ts` 第 15-17 行：

```ts
// 改前：
export interface ClarificationSentinel {
  __clarification: string;
}

// 改后：
export interface ClarificationSentinel {
  __clarification: string;
  __clarification_options?: string[];
}
```

- [ ] 用 Edit 工具替换该 interface。

### Step 2: 在 schema 中加 `options` 参数

`agentToolSchemas.ts` 中找到 `ask_clarification` 的 `parameters.properties`，在 `question` 之后添加：

```ts
options: {
  type: "array",
  items: { type: "string" },
  description:
    "候选 device 列表（mask 查到多个完整 device 时使用）；前端渲染为可点选按钮，每项为用户选择后发送的文本；其他场景不传",
},
```

`required` 保持 `["question"]` 不变。

- [ ] 用 Edit 工具在 `question` 属性块后插入 `options` 块。

### Step 3: 更新 handler 读取并透传 `options`

`agentToolHandlers.ts` 中 `ask_clarification` case，将：

```ts
case "ask_clarification": {
  const question = String(args["question"] ?? "").trim();
  if (!question) return "ask_clarification 参数错误: question 不能为空";
  return { __clarification: question };
}
```

改为：

```ts
case "ask_clarification": {
  const question = String(args["question"] ?? "").trim();
  if (!question) return "ask_clarification 参数错误: question 不能为空";
  const rawOpts = args["options"];
  const options: string[] | undefined =
    Array.isArray(rawOpts) && rawOpts.length > 0
      ? rawOpts.map(String).filter(Boolean)
      : undefined;
  return { __clarification: question, ...(options ? { __clarification_options: options } : {}) };
}
```

- [ ] 用 Edit 工具替换该 case 块。

### Step 4: 扩展 `AgentSseEvent` 并在 emit 处透传

`agentLoop.ts` 第 78 行（`AgentSseEvent` clarification 变体）：

```ts
// 改前：
  | { type: "clarification"; question: string }

// 改后：
  | { type: "clarification"; question: string; options?: string[] }
```

同文件，找到 emit clarification 的代码块：

```ts
// 改前：
const question = (toolResult as ClarificationSentinel).__clarification;
emit({ type: "clarification", question });
historyContent = `[已向用户提问：${question}]`;

// 改后：
const question = (toolResult as ClarificationSentinel).__clarification;
const clarOptions = (toolResult as ClarificationSentinel).__clarification_options;
emit({ type: "clarification", question, ...(clarOptions ? { options: clarOptions } : {}) });
historyContent = `[已向用户提问：${question}]`;
```

- [ ] 先 Edit `AgentSseEvent` 类型行，再 Edit emit 块。

### Step 5: 更新 `agentPrompt.ts` mask 消歧说明

找到 `agentPrompt.ts` 中「情况 A — mask + 宽泛意图」的处理步骤（约第 459-464 行），在第 1 条 `get_filter_values` 调用说明后添加：

```
  2. 若返回 `totalDistinct > 1`，调用：
     `ask_clarification(question:"请选择要查询的完整 device 代码", options: devices)`
     将 `devices[].device` 列表传入 `options`，前端渲染为按钮供用户点选。
     **`options` 仅用于此 mask 消歧场景，其他 ask_clarification 调用不传 options。**
```

- [ ] 找到对应段落，用 Edit 工具在第 1 条（`get_filter_values` 调用）后插入第 2 条说明；原来的序号 2/3/4/5/6 顺延为 3/4/5/6/7。

---

## Task 3: 运行测试 + typecheck + 提交后端

- [ ] **Step 1: 运行后端测试**

```bash
cd pcr-ai-api && npm test 2>&1 | tail -30
```

预期：`ask_clarification tool` 下所有 5 条用例 PASS；其余已有测试不回退。

- [ ] **Step 2: typecheck**

```bash
cd pcr-ai-api && npm run typecheck
```

预期：`0 errors`。

- [ ] **Step 3: 提交后端变更**

```bash
cd pcr-ai-api && git add \
  src/lib/agent/agentChartTool.ts \
  src/lib/agent/agentToolSchemas.ts \
  src/lib/agent/agentToolHandlers.ts \
  src/lib/agent/agentLoop.ts \
  src/lib/agent/agentPrompt.ts \
  ../pcr-ai-api/test/agentTools.clarification.test.ts
git commit -m "feat(agent): add options to ask_clarification for mask device disambiguation"
```

---

## Task 4: 前端 — 类型 + SSE handler + 渲染

**Files:**
- Modify: `pcr-ai-report/src/reports/AiAgentReport.tsx`

### Step 1: 扩展 `ClarificationMessage` 接口

找到文件中 `interface ClarificationMessage` 定义：

```ts
// 改前：
interface ClarificationMessage {
  kind: "clarification";
  question: string;
}

// 改后：
interface ClarificationMessage {
  kind: "clarification";
  question: string;
  options?: string[];
  chosen?: string;
}
```

- [ ] 用 Edit 工具替换该 interface。

### Step 2: 更新 SSE clarification handler

找到 `case "clarification":` 处理块：

```ts
// 改前：
case "clarification": {
  const question = event.question ?? "";
  setMessages((prev) => {
    const copy = [...prev];
    const last = copy[copy.length - 1];
    if (last && last.kind === "ai" && last.text === "") {
      copy[copy.length - 1] = { kind: "clarification", question };
    } else {
      copy.push({ kind: "clarification", question });
    }
    return copy;
  });
  break;
}

// 改后：
case "clarification": {
  const question = event.question ?? "";
  const options = Array.isArray(event.options) ? (event.options as string[]) : undefined;
  setMessages((prev) => {
    const copy = [...prev];
    const last = copy[copy.length - 1];
    if (last && last.kind === "ai" && last.text === "") {
      copy[copy.length - 1] = { kind: "clarification", question, options };
    } else {
      copy.push({ kind: "clarification", question, options });
    }
    return copy;
  });
  break;
}
```

- [ ] 用 Edit 工具替换该 case 块。

### Step 3: 更新渲染层，加按钮 chip

找到 `if (msg.kind === "clarification")` 渲染块：

```tsx
// 改前：
if (msg.kind === "clarification") {
  rendered.push(
    <div key={i} className="ai-msg ai-msg--clarification">
      <div className="ai-avatar ai-avatar--ai"><RobotAvatar /></div>
      <div className="ai-clarification-bubble">❓ {msg.question}</div>
    </div>
  );
  i++;
  continue;
}

// 改后：
if (msg.kind === "clarification") {
  const clarIdx = i;
  rendered.push(
    <div key={i} className="ai-msg ai-msg--clarification">
      <div className="ai-avatar ai-avatar--ai"><RobotAvatar /></div>
      <div className="ai-clarification-bubble">
        <span>❓ {msg.question}</span>
        {msg.options && msg.options.length > 0 && (
          <div className="ai-clarification-options">
            {msg.options.map((opt) => (
              <button
                key={opt}
                type="button"
                className={`ai-clarification-option${msg.chosen ? " ai-clarification-option--chosen" : ""}`}
                disabled={!!msg.chosen}
                onClick={() => {
                  setMessages((prev) =>
                    prev.map((m, idx) =>
                      idx === clarIdx ? { ...m, chosen: opt } : m
                    )
                  );
                  void submitAgentRequest({ text: opt });
                }}
              >
                {opt}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
  i++;
  continue;
}
```

- [ ] 用 Edit 工具替换该渲染块。

---

## Task 5: 前端 CSS — 按钮 chip 样式

**Files:**
- Modify: `pcr-ai-report/src/reports/AiAgentReport.css`

- [ ] **Step 1: 在文件末尾追加样式**

在 `AiAgentReport.css` 末尾加入：

```css
/* ── ask_clarification option buttons ─────────────────────────── */
.ai-clarification-options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.ai-clarification-option {
  padding: 4px 14px;
  border-radius: 999px;
  border: 1px solid #4a9eff;
  background: transparent;
  color: #4a9eff;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
  white-space: nowrap;
}

.ai-clarification-option:hover:not(:disabled) {
  background: #4a9eff;
  color: #fff;
}

.ai-clarification-option--chosen,
.ai-clarification-option:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
```

---

## Task 6: 前端 typecheck + 提交

- [ ] **Step 1: typecheck**

```bash
cd pcr-ai-report && npm run typecheck 2>&1 | tail -20
```

预期：`0 errors`。若报 `event.options` 未知属性，在 SSE event 解析处用 `(event as Record<string, unknown>).options` 强转。

- [ ] **Step 2: 提交前端变更**

```bash
git add \
  pcr-ai-report/src/reports/AiAgentReport.tsx \
  pcr-ai-report/src/reports/AiAgentReport.css
git commit -m "feat(report): render ask_clarification options as clickable device buttons"
```

- [ ] **Step 3: 推送**

```bash
git push origin feat/agent-improvements
```

---

## Self-Review Checklist

- [x] **Spec coverage**: 背景（mask 消歧）、数据流、后端 4 处、前端 2 处 均有对应任务
- [x] **Placeholder scan**: 无 TBD/TODO；所有代码块完整
- [x] **Type consistency**: `__clarification_options` 在 `ClarificationSentinel`、handler return、agentLoop emit 三处命名一致；`options` 在 `AgentSseEvent`、前端 `ClarificationMessage`、SSE handler 三处一致；`clarIdx` 正确捕获循环变量
- [x] **Backward compat**: 不传 `options` 时所有路径与现有行为相同（handler 返回无 `__clarification_options`，emit 不含 `options`，前端不渲染按钮行）
