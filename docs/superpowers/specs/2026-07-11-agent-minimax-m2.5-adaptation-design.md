# AI Agent 适配 MiniMax-M2.5（多模型白名单 + 大上下文档位）

**日期**：2026-07-11
**范围**：`pcr-ai-api`（`src/lib/agent/agentConfig.ts`、`.env.example`）、`pcr-ai-report`（`App.tsx` Settings 文案）

## 背景

AI Agent 当前主力模型固定为硅基流动 `deepseek-ai/DeepSeek-V4-Flash`。`agentConfig.ts` 里 `resolveAgentConfig()` 对 `model`/`subAgentModel` 有一条硬编码：无论前端 Settings 填什么、`AGENT_MODEL`/`AGENT_SUB_MODEL` 环境变量填什么，最终都被强制覆盖为唯一允许值。这导致 Settings 页的"模型"输入框实际不生效。

同时，`agentLoop.ts` 里已经实现了一整套 MiniMax-M2.5 的响应格式适配（`<minimax:tool_call>…</minimax:tool_call>` 嵌入式工具调用解析、DSML/孤立标签泄漏过滤、总结轮嵌入调用处理，见 `pcr-ai-api/CLAUDE.md` §11 条目 16），是 2026-05-27/29 做的历史工作，代码仍在，只是从未真正跑起来过。

**目标模型固定为两个**：`DeepSeek-V4-Flash`、`MiniMax-M2.5`。但供应商不固定——目前是硅基流动，未来可能切到七牛云等提供同名模型的其它平台，且不同平台上模型 ID 的命名前缀/组织名可能不同（例如硅基流动是 `Pro/MiniMaxAI/MiniMax-M2.5`，其它平台可能没有 `Pro/` 前缀或用不同组织名）。

## 设计

### 1. 模型白名单：按模型族模糊匹配

不再要求 model ID 与某个供应商的完整字符串精确相等，改为对 Settings 里配置的 `model`/`subAgentModel` 字符串做归一化后按"模型族"子串匹配：

```ts
function normalizeModelId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isDeepSeekV4Flash(model: string): boolean {
  return normalizeModelId(model).includes("deepseekv4flash");
}

function isMiniMaxM25(model: string): boolean {
  return normalizeModelId(model).includes("minimaxm25"); // "M2.5" 去符号后是 "m25"
}

export function isAllowedAgentModel(model: string): boolean {
  return isDeepSeekV4Flash(model) || isMiniMaxM25(model);
}
```

`resolveAgentConfig()` 中 `model`/`subAgentModel` 的解析顺序改为：

```
override.model → 校验 isAllowedAgentModel → 通过则用，否则忽略
  → process.env.AGENT_MODEL → 同样校验
  → 默认 DEFAULT_MODEL ("deepseek-ai/DeepSeek-V4-Flash")
```

`subAgentModel` 走同样的独立解析链（默认 `DEFAULT_SUB_MODEL`，同为 DeepSeek-Flash）。

`apiBase`（供应商地址）本来就是自由文本、已支持任意 OpenAI 兼容 endpoint，不需要改动——切换到七牛云只需在 Settings 改 `agentApiBase` + `agentModel`。

七牛云的实际 model ID 字符串目前未知；模糊匹配已经能覆盖"同一模型换了个前缀/组织名"的常见情况，不需要提前硬编码。

### 2. `detectLargeContext()`：MiniMax-M2.5 纳入大上下文档位

现状：只识别 GLM 系列（`bigmodel.cn` 或模型名含 `glm-4.6/4.7/5/z1`）为大上下文，命中后 `summarize` 阈值→80、`max_tokens`→16384、`toolResultMaxHistoryChars`→20000。

MiniMax-M2.5 是 192K 上下文，虽不到注释里写的"≥200K"门槛，但足够支撑同一套参数，且直接服务于"提高回答质量、不要过早截断历史"的目标。改动：

```ts
export function detectLargeContext(model: string, apiBase: string): boolean {
  if (apiBase.includes("bigmodel.cn")) return true;
  const m = model.toLowerCase();
  if (isMiniMaxM25(model)) return true; // 192K，有意放宽到大上下文档位
  return (
    m.includes("glm-4.7") ||
    m.includes("glm-4.6") ||
    m.includes("glm-5") ||
    m.includes("glm-z1")
  );
}
```

判断只依赖模型名（`isMiniMaxM25` 复用同一归一化匹配），与供应商/`apiBase` 无关，天然跨供应商生效。

### 3. `.env.example` 注释更新

`AGENT_MODEL`/`AGENT_SUB_MODEL` 相关注释更新为反映新行为：说明允许的两个模型族、模糊匹配规则、以及不支持的值会静默回退默认值这一点（避免用户改了 env 却没生效还不知道为什么）。

### 4. 前端 Settings 文案更新（`pcr-ai-report/src/App.tsx`）

「模型」输入框下方的 `field-hint` 目前举例是过时的 `deepseek-ai/DeepSeek-V3`、`MiniMax/MiniMax-M1`（均不在实际白名单里）。改为准确说明：只要模型名里包含 "DeepSeek-V4-Flash" 或 "MiniMax-M2.5"（大小写、分隔符不敏感）即可生效，供应商（API 地址）可自由更换，默认硅基流动。

### 5. 不改动

`agentLoop.ts` 里 MiniMax 嵌入式工具调用解析逻辑（`parseMinimaxInvokeBody`、`tryExtractFromMinimaxBuf`、`createDeepSeekFilter` 的 `minimax` tokenKind 分支等）——现有实现完整，只需确认 `npm test` 中相关用例仍通过，不需要重写。

## 测试

`pcr-ai-api/test/agentConfig.test.ts` 新增：
- `isAllowedAgentModel` / 内部 `resolveAgentConfig` 对 `"Pro/MiniMaxAI/MiniMax-M2.5"`、假设的不同前缀变体（如 `"MiniMaxAI/MiniMax-M2.5"`）均通过校验并直接采用。
- 不在白名单内的字符串（如 `"my-model"`）仍回退默认值（复用现有断言，验证未破坏）。
- `subAgentModel` 独立校验：单独传 MiniMax 而不改 `model`（或反之）时两者互不影响。
- `detectLargeContext("Pro/MiniMaxAI/MiniMax-M2.5", "https://api.siliconflow.cn/v1")` 返回 `true`。

`npm test` 全量跑一遍，确认 `agentLoop.test.ts` 里已有的 MiniMax 相关用例仍是绿的（不修改这些用例本身）。

## 文档

- `pcr-ai-api/CLAUDE.md` §11 追加一条 2026-07-11 变更纪要。
- `docs/DEV_LOG.md` 追加对应条目。
