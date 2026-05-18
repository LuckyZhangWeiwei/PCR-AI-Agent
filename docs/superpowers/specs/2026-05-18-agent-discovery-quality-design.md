# Design Spec: AI Agent 可选值发现 + 回答质量提升

**日期：** 2026-05-18  
**状态：** 已批准，待实现  
**背景：** 用户反馈 AI Agent 两大痛点：① 不知道数据库里有哪些 device/探针卡/批次，只能猜参数；② 回答缺乏数字深度，结论不够具体。

---

## 1. 目标

1. AI 在查询前能获取可选值（device 列表、时间范围、probeCard、lot 等），减少猜参数导致的空结果
2. AI 回答强制包含"数字 → 对比 → 下一步"三要素，提升分析深度
3. 不引入新的外部依赖，不改动前端

---

## 2. 范围

**仅修改 `pcr-ai-api`。前端无需改动。**

新增文件：
- `src/lib/agent/agentManifest.ts`
- `src/lib/agent/agentFilterValuesTool.ts`

修改文件：
- `src/lib/agent/agentToolSchemas.ts`
- `src/lib/agent/agentToolHandlers.ts`
- `src/lib/agent/agentPrompt.ts`
- `src/lib/agent/agentLoop.ts`
- `test/agentManifest.test.ts`（新增）
- `test/agentFilterValues.test.ts`（新增）

---

## 3. 架构

```
agentLoop.ts（每次调用）
  │
  ├─ 首轮前：fetchOrCacheManifest()
  │   └─ agentManifest.ts
  │       ├─ 全局内存缓存，TTL = 1h
  │       ├─ Oracle 路径：两个 SELECT（yield + jb）
  │       └─ Dummy 路径：从 Excel 内存数组计算
  │
  ├─ buildSystemPrompt(manifest) → 注入数据快照 + 加强质量规则
  │
  └─ ReAct 循环（已有）
      └─ get_filter_values 工具（新增）
          └─ agentFilterValuesTool.ts
              ├─ Oracle：DISTINCT + COUNT，带 filterBy 条件
              └─ Dummy：对 Excel 内存数组 distinct + count
```

---

## 4. agentManifest.ts — 数据快照

### 4.1 查询内容

**Yield Monitor（probeweb 连接池）：**
```sql
-- 时间范围
SELECT MIN(t.TIME_STAMP) AS ts_min, MAX(t.TIME_STAMP) AS ts_max
FROM YMWEB_YIELDMONITORTRIGGER t
WHERE UPPER(TRIM(t."TYPE")) = 'DELTA_DIFF'
  AND NOT REGEXP_LIKE(t.LOTID, '^(kk|gg|c)', 'i')

-- top device
SELECT t.DEVICE, COUNT(*) AS cnt
FROM YMWEB_YIELDMONITORTRIGGER t
WHERE UPPER(TRIM(t."TYPE")) = 'DELTA_DIFF'
  AND NOT REGEXP_LIKE(t.LOTID, '^(kk|gg|c)', 'i')
GROUP BY t.DEVICE
ORDER BY cnt DESC
FETCH FIRST 10 ROWS ONLY
```

**JB STAR（主连接池）：**
```sql
-- 时间范围
SELECT MIN(t2.TESTEND) AS ts_min, MAX(t2.TESTEND) AS ts_max
FROM INFCONTROL t1
JOIN INFLAYERBINLIST t2 ON t1.ID = t2.INFCONTROLID
WHERE t2.PASSTYPE = 'TEST'
  AND NOT REGEXP_LIKE(t1.LOT, '^(kk|gg|c)', 'i')

-- top device
SELECT t1.DEVICE, COUNT(*) AS cnt
FROM INFCONTROL t1
JOIN INFLAYERBINLIST t2 ON t1.ID = t2.INFCONTROLID
WHERE t2.PASSTYPE = 'TEST'
  AND NOT REGEXP_LIKE(t1.LOT, '^(kk|gg|c)', 'i')
GROUP BY t1.DEVICE
ORDER BY cnt DESC
FETCH FIRST 10 ROWS ONLY
```

### 4.2 缓存策略

```typescript
interface DataManifest {
  fetchedAt: number;         // Date.now()
  yield: {
    timeMin: string | null;  // ISO 8601
    timeMax: string | null;
    topDevices: Array<{ device: string; count: number }>;
  };
  jb: {
    timeMin: string | null;
    timeMax: string | null;
    topDevices: Array<{ device: string; count: number }>;
  };
}

const MANIFEST_TTL_MS = 60 * 60 * 1000; // 1 hour
let cachedManifest: DataManifest | null = null;

export async function fetchOrCacheManifest(): Promise<DataManifest>
```

- 失败时返回空 manifest（`timeMin: null`，`topDevices: []`），不抛异常
- Dummy 模式：从 `dummyRowsFromExcel` 内存数组计算（与 Oracle 路径结构对等）

### 4.3 注入 prompt 格式

```
## 数据库现有数据快照（约每小时刷新）

Yield Monitor 数据时间范围：2025-02-10 ~ 2026-05-17
主要 device（按触发量降序）：WA03P02G (1234), WA04P01G (856), ...

JB STAR 数据时间范围：2025-06-01 ~ 2026-05-17
主要 device（按记录量降序）：WA03P02G (5678), ...

⚠️ 以上为近似统计，精确数字以工具查询结果为准。
```

若 manifest 为空（查询失败）：
```
## 数据库快照（暂不可用）
如需了解可查询的 device 或时间范围，请调用 get_filter_values 工具。
```

---

## 5. agentFilterValuesTool.ts — 按需发现工具

### 5.1 工具 Schema

```typescript
{
  name: "get_filter_values",
  description: "查询某个筛选维度的可用值列表（如探针卡、批次号、测试机等）。在需要精确筛选但不知道具体值时调用。不要用它查 device 或时间范围——那些已在系统提示词的数据快照中。",
  parameters: {
    domain: { type: "string", enum: ["yield", "jb"] },
    field: {
      type: "string",
      description: "yield 支持: probeCard, probeCardType, hostname, lotId；jb 支持: cardId, probeCardType, testerId, lot"
    },
    filterBy: {
      type: "object",
      description: "可选前置过滤，如 { device: 'WA03P02G' }",
      properties: {
        device: { type: "string" },
        probeCardType: { type: "string" }
      }
    },
    limit: { type: "number", description: "默认 20，最大 50" }
  },
  required: ["domain", "field"]
}
```

### 5.2 Field → Oracle 列映射

| domain | field | Oracle 列 | 备注 |
|---|---|---|---|
| yield | `probeCard` | `PROBECARD` | 直接 DISTINCT |
| yield | `probeCardType` | 计算列 | `REGEXP_SUBSTR(PROBECARD, '^[^-]+')` |
| yield | `hostname` | `HOSTNAME` | 直接 DISTINCT |
| yield | `lotId` | `LOTID` | 直接 DISTINCT |
| jb | `cardId` | `CARDID` | 直接 DISTINCT |
| jb | `probeCardType` | 计算列 | `REGEXP_SUBSTR(CARDID, '^[^-]+')` |
| jb | `testerId` | `TESTERID` | 直接 DISTINCT |
| jb | `lot` | `LOT` | 直接 DISTINCT |

未知 field 返回错误字符串，不抛异常。

### 5.3 返回格式

```json
{
  "domain": "yield",
  "field": "probeCard",
  "values": ["7772-A1 (234次)", "8041-B3 (189次)", "7772-A2 (102次)"],
  "totalDistinct": 8
}
```

括号内为触发/记录次数，帮助 AI 判断重要性。

### 5.4 Dummy 路径

对 `dummyRowsFromExcel` 内存数组做 `reduce` 统计 distinct + count，返回与 Oracle 路径相同结构。

---

## 6. agentPrompt.ts — 质量规则加强

### 6.1 数据快照注入

`buildSystemPrompt` 签名改为 `buildSystemPrompt(manifest?: DataManifest): string`，在系统提示词头部插入数据快照（见 §4.3）。

### 6.2 替换"回复质量要求"节

用以下内容替换现有该节（保留图表规则节不变）：

```
## 回复质量要求（必须遵守）

每次有数据结论时，必须包含以下三要素：

① 关键数字 — 最高/最低/总量，精确到整数，不用"大约"模糊
② 对比解读 — 至少一项：占总量的比例、与第二名的差距、与上一轮结论的变化
③ 下一步建议 — 主动给出可以继续深挖的维度或卡号（具体，不泛泛）

示例：
✅ "7772-A1 触发 17 次，占本次查询总量（40 次）的 42.5%，比第二名 8041-B3（9 次）多近一倍。
    建议按 timeDay 查趋势，确认是否近期突发；或进一步查 7772-A1 的 DUT 分布。"
❌ "7772-A1 触发了 17 次，8041-B3 触发了 9 次。"
```

### 6.3 新增"可选值发现规则"节

```
## 可选值发现规则

- 系统提示词数据快照已包含 device 列表和时间范围 → 无需调 get_filter_values 查这两项
- 用户提到具体 probeCard / cardId / lot / hostname 但值不确定时 → 先调 get_filter_values 确认
- get_filter_values 返回空列表 → 告知用户"该条件下无数据"，不继续用猜测值查询
- filterBy 参数优先使用用户已指定的 device，缩小查询范围，提升精度
```

---

## 7. agentLoop.ts — manifest 集成

```typescript
// 在 runAgentLoop 函数开头，首轮 streamSiliconFlow 之前
const manifest = await fetchOrCacheManifest().catch(() => undefined);

// 在构建 messages 时
{ role: "system", content: buildSystemPrompt(manifest) }
```

manifest fetch 失败不中断对话，仅降级为无快照的 prompt。

---

## 8. 测试计划

### agentManifest.test.ts
- Dummy 模式下返回正确的时间范围和 top device
- TTL 到期后重新 fetch
- Oracle 失败时返回空 manifest（不抛异常）

### agentFilterValues.test.ts
- Dummy 模式：yield/probeCard 返回正确的 distinct 列表和计数
- Dummy 模式：jb/cardId 带 filterBy.device 过滤
- 未知 field 返回错误字符串
- limit 截断生效

---

## 9. 不在本次范围内

- 前端修改（无需）
- Session 持久化（下一迭代）
- Oracle 查询结果缓存（manifest 的 TTL 已覆盖最高频场景）
- TableRowsReport 对齐（单独议题）
