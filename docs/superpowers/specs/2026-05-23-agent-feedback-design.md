# Agent 反馈系统设计

**日期**：2026-05-23  
**范围**：`pcr-ai-api` + `pcr-ai-report`  
**不影响**：现有任何功能、SSE 事件格式、消息渲染逻辑

---

## 背景

AI Agent 回答质量参差不齐，需要一个轻量反馈闭环：
- 用户点赞 → 好的 Q→A 对存到服务器，未来相似问题时注入 prompt 参考
- 用户点踩 → 用户填写原因，存到服务器，未来相似问题时提示 agent 避免

理论基础：RLHF 的工程简化版（无重训，用 few-shot 注入模拟学习效果）。

---

## 第一节：数据层

### 存储文件

`pcr-ai-api/data/feedback.json` — 运行时自动创建目录和文件。

```typescript
interface FeedbackRecord {
  id: string;        // crypto.randomUUID()
  kind: "good" | "bad";
  question: string;  // 用户问题原文
  answer: string;    // AI 回答（截断至 1500 字符）
  category?: string; // bad 时必填：回答不准确 | 数据有误 | 回答不完整 | 其他
  comment?: string;  // 自由文本（选填）
  timestamp: string; // ISO 8601
  sessionId: string;
}
```

文件格式：JSON 数组，每次写入读取全文件、追加、整体写回（低并发环境，无需文件锁）。

### API 端点

```
POST /api/v4/agent/feedback
Content-Type: application/json

Body:
{
  sessionId: string,
  question: string,
  answer: string,
  kind: "good" | "bad",
  category?: string,
  comment?: string
}

Response 200: { ok: true }
Response 400: { error: "VALIDATION_ERROR", message: "..." }
```

**实现位置**：追加在 `pcr-ai-api/src/routes/agent.ts` 同文件（`agentRouter.post("/feedback", ...)`），不新建路由文件。

**验证规则**：
- `kind` 必须是 `"good"` 或 `"bad"`
- `question` 和 `answer` 非空字符串
- `sessionId` 非空字符串
- `kind === "bad"` 时 `category` 必须是四个选项之一

---

## 第二节：Agent 注入

### 新文件

`pcr-ai-api/src/lib/agent/agentFeedback.ts` — 封装所有反馈 IO 和匹配逻辑，对外只暴露两个函数：

```typescript
// 写入一条反馈
export async function saveFeedback(record: FeedbackRecord): Promise<void>

// 对当前问题做关键词匹配，返回注入片段（无匹配返回空字符串）
export async function buildFeedbackInjection(question: string): Promise<string>
```

### 关键词匹配（Jaccard 相似度）

```
tokens(text):
  按 /[\s，。？！、：；,.?!:;\-_/\\]+/ 分割
  过滤长度 < 2 的 token
  转小写

score(q1, q2) = |tokens(q1) ∩ tokens(q2)| / max(|tokens(q1)|, |tokens(q2)|)
```

取 good 记录中 score ≥ 0.15 的前 2 条；取 bad 记录中 score ≥ 0.15 的前 2 条。

### 注入格式

追加在 `agentLoop.ts` 构建的 system prompt 末尾（不修改 `agentPrompt.ts` 原始模板）：

```
【历史反馈参考】
以下是用户对类似问题满意的回答示例，请参考其风格和深度：
Q: <question>
A: <answer 截断至 500 字符>

以下类型的回答曾被标记为不好，请注意避免：
- [<category>] 曾问：<question 前 60 字符>，反馈：<comment>
```

无匹配时不追加任何内容，系统提示与现在完全相同。

### agentLoop.ts 修改

仅在 `runAgentLoop` 函数顶部增加一行：

```typescript
const feedbackInjection = await buildFeedbackInjection(message);
// 已有的 systemPrompt 构建后追加：
const systemPrompt = buildSystemPrompt(...) + feedbackInjection;
```

其余 loop 逻辑不动。

---

## 第三节：前端 UI

### AiMessage 接口扩展

```typescript
interface AiMessage {
  kind: "ai";
  text: string;
  streaming: boolean;
  hasToolContext?: boolean;  // 新增：此消息是工具调用后的 AI 总结
}
```

### hasToolContext 设置时机

在 `handleSseEvent` 的 `text` case，当 `last.kind !== "ai"`（即上一条是 tool 消息）时创建新 AI 气泡：

```typescript
copy.push({ kind: "ai", text: event.delta ?? "", streaming: true, hasToolContext: true });
```

### FeedbackBar（内联在 AiAgentReport.tsx）

显示条件：`msg.kind === "ai" && !msg.streaming && msg.hasToolContext === true && findLastUserText(messages.slice(0, i)) !== undefined`

状态管理：`feedbackState: Record<number, "good" | "bad" | "pending">` — `useState`，用消息 index 做 key，不污染 `messages` 数组。

UI：
- 默认：两个小图标按钮 👍 👎（灰色，`.ai-feedback-btn`）
- 点赞后：👍 高亮，👎 禁用，显示 "已记录，谢谢！"
- 点踩后：打开 FeedbackModal
- FeedbackModal 提交后：👎 高亮，👍 禁用，显示 "感谢反馈"

question 提取：向前遍历 `messages.slice(0, i)`，找最近的 `user` 消息。若找不到则不显示 FeedbackBar（防止 Welcome 消息场景）。

**New Chat 重置**：`newSession()` 调用时需同时 `setFeedbackState({})`，防止 index 错位。

### FeedbackModal（新建 pcr-ai-report/src/components/FeedbackModal.tsx）

```
┌─ 这条回答哪里不好？ ──────────────────── ✕ ─┐
│                                              │
│  [ 回答不准确 ] [ 数据有误 ]                 │
│  [ 回答不完整 ] [ 其他 ]                     │
│                                              │
│  详细说明（选填）                             │
│  ┌──────────────────────────────────────┐   │
│  │                                      │   │
│  └──────────────────────────────────────┘   │
│                                              │
│                         [ 取消 ] [ 提交反馈 ] │
└──────────────────────────────────────────────┘
```

- 样式：深色，使用现有 CSS 变量 `--text`、`--border`、`--bg-card`
- 点击遮罩或 ✕ 取消，不提交
- 提交时 `category` 未选则提示选择一项

### 样式（追加到 AiAgentReport.css，不修改现有规则）

新增类：`.ai-feedback-bar`、`.ai-feedback-btn`、`.ai-feedback-btn--active`、`.ai-feedback-thanks`  
新增文件：`FeedbackModal.css`（随组件新建）

---

## 不改动的内容

| 内容 | 状态 |
|------|------|
| 现有 `ChatMessage` 类型的渲染逻辑 | 不动 |
| SSE 事件格式（text/tool/done/error 等） | 不动 |
| 现有 CSS 规则 | 只追加，不修改 |
| `agentPrompt.ts` 原始模板 | 不动 |
| 所有现有 API 端点 | 不动 |
| Dummy / Oracle 双路径 | feedback 端点纯文件 IO，与 Oracle 无关 |

---

## 文件清单

### 新建
- `pcr-ai-api/data/.gitkeep`（确保目录进 git，feedback.json 加入 .gitignore）
- `pcr-ai-api/src/lib/agent/agentFeedback.ts`
- `pcr-ai-report/src/components/FeedbackModal.tsx`
- `pcr-ai-report/src/components/FeedbackModal.css`

### 修改
- `pcr-ai-api/src/routes/agent.ts` — 追加 `POST /feedback` 路由
- `pcr-ai-api/src/lib/agent/agentLoop.ts` — 顶部调用 `buildFeedbackInjection`
- `pcr-ai-report/src/reports/AiAgentReport.tsx` — `AiMessage` 扩展 + FeedbackBar + feedbackState
- `pcr-ai-report/src/reports/AiAgentReport.css` — 追加反馈相关样式
- `pcr-ai-api/.gitignore` — 追加 `data/feedback.json`

---

## 测试验证

1. 发一条触发工具调用的问题（如"最近 7 天 WA03P02G 触发次数"）
2. AI 总结气泡底部出现 👍 👎
3. 点 👍 → 按钮高亮，显示感谢，`data/feedback.json` 有新记录
4. 再发一条相似问题，`agentLoop` 日志里应能看到注入了参考内容
5. 点 👎 → 弹出 Modal，选类别，填文字，提交，`feedback.json` 有 bad 记录
6. 纯文字 AI 回复（无工具前驱）不出现反馈按钮
7. Welcome 消息不出现反馈按钮
8. New Chat 后 feedbackState 清空
