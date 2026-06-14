# Design: ask_clarification 选项按钮

**日期**: 2026-06-14  
**分支**: feat/agent-improvements  
**状态**: 待实现

---

## 背景

现有 `ask_clarification` 工具只接受 `question: string`，前端渲染为纯文字气泡（❓），用户必须手动输入回复。当 agent 查到多个候选 device（或 tester、lot 等）时，体验较差——用户需要复制粘贴候选值。

目标：agent 可选传 `options: string[]`，前端渲染为可点选按钮 chip，点击直接提交该值作为用户消息，agent 继续下一轮查询。

---

## 数据流

```
Agent 调用 ask_clarification(question="请选择 device", options=["WC13N06Z","WC07N06Z"])
  ↓
agentToolHandlers：返回 { __clarification: "...", __clarification_options: ["WC13N06Z","WC07N06Z"] }
  ↓
agentLoop：emit({ type:"clarification", question:"...", options:["WC13N06Z","WC07N06Z"] })
  ↓
AiAgentReport SSE handler：写入 ClarificationMessage{ kind:"clarification", question, options }
  ↓
渲染：❓ 气泡 + 按钮 chip 行
  ↓
用户点击 "WC13N06Z"
  ↓
submitAgentRequest({ text:"WC13N06Z" }) + 标记 chosen → 按钮禁用
  ↓
Agent 下一轮以 "WC13N06Z" 为用户输入，查询 yield/bin/DUT
```

---

## 后端改动（4 处）

### 1. `agentToolSchemas.ts`

在 `ask_clarification` 的 `parameters.properties` 中新增：

```ts
options: {
  type: "array",
  items: { type: "string" },
  description: "可选的候选值列表，前端将渲染为可点选按钮；每项为用户选择后发送的文本",
},
```

`required` 保持只含 `["question"]`，`options` 完全可选。

### 2. `agentToolHandlers.ts`

- `ClarificationSentinel` 类型加字段：`__clarification_options?: string[]`
- `ask_clarification` case：读取 `args["options"]`，验证为字符串数组后写入 sentinel：

```ts
case "ask_clarification": {
  const question = String(args["question"] ?? "").trim();
  if (!question) return "ask_clarification 参数错误: question 不能为空";
  const rawOpts = args["options"];
  const options: string[] | undefined =
    Array.isArray(rawOpts) && rawOpts.length > 0
      ? rawOpts.map(String).filter(Boolean)
      : undefined;
  return { __clarification: question, __clarification_options: options };
}
```

### 3. `agentLoop.ts`

- `ClarificationSentinel` 类型同步加 `__clarification_options?: string[]`
- emit 时透传：

```ts
emit({ type: "clarification", question, options: toolResult.__clarification_options });
```

### 4. `agentPrompt.ts`

在 `ask_clarification` 使用说明段落末尾补充：

> 有明确候选列表时（如 `get_filter_values` 返回多个 device），可传 `options` 数组；前端会将每项渲染为可点按钮，用户点击即提交该值。无候选时省略 `options`。

---

## 前端改动（2 处）

### 5. `AiAgentReport.tsx`

**类型**：

```ts
interface ClarificationMessage {
  kind: "clarification";
  question: string;
  options?: string[];
  chosen?: string;   // 用户已点选的值，用于禁用按钮组
}
```

**SSE handler**（clarification case）：

```ts
case "clarification": {
  const question = event.question ?? "";
  const options = Array.isArray(event.options) ? event.options : undefined;
  setMessages((prev) => {
    // ... 同现有逻辑，加上 options
    copy.push({ kind: "clarification", question, options });
    return copy;
  });
  break;
}
```

**渲染**（clarification 气泡下方）：

```tsx
{msg.options && msg.options.length > 0 && (
  <div className="ai-clarification-options">
    {msg.options.map((opt) => (
      <button
        key={opt}
        type="button"
        className={`ai-clarification-option${msg.chosen ? " ai-clarification-option--disabled" : ""}`}
        disabled={!!msg.chosen}
        onClick={() => {
          // 标记已选，禁用按钮组
          setMessages((prev) =>
            prev.map((m, idx) =>
              idx === msgIndex ? { ...m, chosen: opt } : m
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
```

用户仍可跳过按钮、在输入框手动输入任意回复。

### 6. `AiAgentReport.css`

```css
.ai-clarification-options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.ai-clarification-option {
  padding: 4px 12px;
  border-radius: 999px;
  border: 1px solid var(--color-accent, #4a9eff);
  background: transparent;
  color: var(--color-accent, #4a9eff);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.ai-clarification-option:hover:not(:disabled) {
  background: var(--color-accent, #4a9eff);
  color: #fff;
}

.ai-clarification-option--disabled,
.ai-clarification-option:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
```

---

## 边界情况

| 场景 | 处理 |
|---|---|
| `options` 为空数组 | handler 过滤为 `undefined`，前端不渲染按钮行 |
| `options` 含非字符串 | `map(String).filter(Boolean)` 统一转换 |
| 用户点按钮后再次点击 | `disabled` 属性阻止；`chosen` 已设置不触发二次提交 |
| 用户跳过按钮手动输入 | `submitAgentRequest` 正常调用；按钮组不影响输入框 |
| `ask_clarification` 不传 `options` | 完全向后兼容，渲染与现在相同 |

---

## 不在范围内

- 前端直接调用 REST API 绕过 agent（已确认走 A 路径：agent 继续下一轮）
- 多选（checkbox）模式
- 图标/描述文字等富选项格式
