# 交接文档：Code Review 修复（2026-05-28）

本次对 2026-05-28 两个 Cursor commit（`a25829b` generate_chart 修复 / `41ba3ca` JB bins 过滤 + 多片 DUT 叠加）进行了 7 角度代码审查，并修复了所有确认/高可信度问题。

---

## 修复清单

### Fix 1 — GLM `<tool_call>` 正则过宽（高危）

**文件：** `pcr-ai-api/src/lib/agent/agentLoop.ts` 第 85 行

**问题：** `GLM_TOOL_CALL_START_RE = /<tool_call>/i` 无任何锚定，任何模型正文中出现字面量 `<tool_call>`（代码示例、错误消息解释）都会触发流式 `inToken` 状态，把随后的内容路由进 `tokenBuf` 而非用户界面，导致聊天响应截断且无报错。

**修复：**
```diff
- const GLM_TOOL_CALL_START_RE = /<tool_call>/i;
+ const GLM_TOOL_CALL_START_RE = /<tool_call>[a-zA-Z_]/;
```
要求函数名首字母（字母或下划线）紧跟标签，与 GLM 实际格式 `<tool_call>generate_chart…` 匹配。去掉 `i` 标志（函数名天然小写/下划线，不需要大小写不敏感匹配）。

---

### Fix 2 — `setInfCtx(null)` 错误关闭已打开 DUT 面板（中高危）

**文件：** `pcr-ai-report/src/reports/InfcontrolReport.tsx` 第 1333 行

**问题：**
```typescript
setInfCtx(next.size > 0 ? ctx : null);
```
当用户点选了 bar（`next.size > 0`）但 `buildInfDutCtxFromDrillBarKeys` 返回 `null`（例如 `listRows` 尚未加载、选中 slot 在列表中找不到匹配行），会写入 `null`，把另一处已打开的 DUT 面板（如明细行点击打开的）也一并关闭，用户无任何提示。

**修复：**
```typescript
if (next.size === 0) {
  setInfCtx(null);
} else if (ctx !== null) {
  setInfCtx(ctx);
  // 若 ctx 为 null（listRows 未就绪等），保留现有面板不动。
}
```

---

### Fix 3 — `InfDutDistPanel` useEffect 冗余依赖引发多余请求（中危）

**文件：** `pcr-ai-report/src/components/InfDutDistPanel.tsx` 第 532 行

**问题：**
```typescript
}, [apiBase, waferKey, wafers]);
```
`waferKey = wafersFetchKey(wafers)` 完全由 `wafers` 内容推导，两者同时放进依赖数组是冗余的。父组件若每次 render 重建 `wafers` 数组（内容不变、引用变），`waferKey` 不变但 `wafers` 引用变 → effect 多余触发，发起冗余 HTTP 请求并产生 loading 闪烁。

**修复：** 移除 `wafers`，仅保留稳定的字符串 `waferKey`：
```typescript
// eslint-disable-next-line react-hooks/exhaustive-deps
}, [apiBase, waferKey]);
```

---

### Fix 4 — GLM `<arg_key>`/`<arg_value>` 按位置 zip，嵌套标签会错位（中危）

**文件：** `pcr-ai-api/src/lib/agent/agentLoop.ts` `parseGlmToolCallBody` 函数（第 107–132 行）

**问题：** 原逻辑先收集所有 `<arg_key>` 进 `keys[]`，再收集所有 `<arg_value>` 进 `vals[]`，最后按下标 zip。若某个 `<arg_value>` 的内容本身含有 `</arg_value>` 子串（如模型引用了示例格式），正则提前终止，后续所有 val 下标偏移 1，产生 key↔value 错位，且静默失败。

**修复：** 改用单个配对正则，每次匹配一个 `<arg_key>…</arg_key>` 与紧随其后的 `<arg_value>…</arg_value>`：
```typescript
const pairRe = /<arg_key>([\s\S]*?)<\/arg_key>[\s\S]*?<arg_value>([\s\S]*?)<\/arg_value>/gi;
while ((km = pairRe.exec(inner)) !== null) {
  const key = km[1].trim();
  const raw = km[2].trim();
  // …JSON 解析或 string 赋值
}
```
消除了位置依赖，即使内容含 XML 子串也不会错位。

---

### Fix 5 — `selectionSummary` 计数包含解析失败行（低中危）

**文件：** `pcr-ai-report/src/utils/infDutSelection.ts` 第 132 行、第 263 行

**问题：**
- `buildInfDutCtxFromDetailListIndices`：`${indexList.length} 行` 是用户选中的行数，若某些行 `waferSpecFromJbRow` 解析失败（`DEVICE`/`LOT`/`SLOT` 缺失），实际 wafer 数会少于 `indexList.length`。
- `buildInfDutCtxFromDrillBarKeys`：`${keys.length} 项` 是点选的 bar 数，若部分 slot 在 `listRows` 中找不到（`resolveDeviceLotFromListRows` 返回 null），实际 wafer 数会少于 `keys.length`。

**修复：** 两处均改为用 `wafers.length`（实际成功解析的 wafer 数），并将「行/项」改为「片」：
```diff
- selectionSummary: `${indexList.length} 行 · Slot ${slots}`
+ selectionSummary: `${wafers.length} 片 · Slot ${slots}`

- selectionSummary: `${keys.length} 项 · Slot ${slots}`
+ selectionSummary: `${wafers.length} 片 · Slot ${slots}`
```

---

### Fix 6 — `normalizeBinToken` 在两个文件中重复定义（维护问题）

**文件：** `pcr-ai-report/src/utils/infDutSelection.ts` + `pcr-ai-report/src/reports/InfcontrolReport.tsx`

**问题：** `raw.replace(/^bin\s*/i, "").trim()` 在两处各有独立私有函数实现，未来若规则变更必须同步两处，否则行为悄然分叉。

**修复：** 
- `infDutSelection.ts` 的 `normalizeBinToken` 改为 `export function normalizeBinToken`
- `InfcontrolReport.tsx` 移除本地定义，改从 `"../utils/infDutSelection"` 导入

---

## 未修复项（说明）

| 编号 | 问题 | 原因 |
|------|------|------|
| 明细行跨 lot 返回 null | `buildInfDutCtxFromDetailListIndices` 遇跨 lot 行静默返回 null | 测试 `infDutSelection.test.ts` 第 53 行明确断言该行为为预期（"requires same device+lot"）；逻辑不变 |
| N 个 HTTP 请求 | `InfDutDistPanel` 每片 wafer 独立请求而不用 lot 聚合端点 | 性能优化（非 bug），且批量端点返回数据需设计 URL 参数变更，超出本次修复范围 |
| `mergeSiteBinPasses` 重复 API 逻辑 | 前后端各有独立实现 | 前端无法直接复用后端 TypeScript（包隔离），且两者存在有意的行为差异（前端过滤 `dieCount=0`） |

---

## 测试结果

- 后端 `npm test`：**176 通过，0 失败，2 skipped**
- 前端 `npm run build`（tsc + vite）：**通过，无类型错误**
- 影响文件：6 个（`agentLoop.ts`、`InfDutDistPanel.tsx`、`InfcontrolReport.tsx`、`infDutSelection.ts`）
