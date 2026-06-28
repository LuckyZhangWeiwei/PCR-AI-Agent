# JB 路由收敛设计 —— 单一真相源 `resolveJbRoute` + 混合(正则快路 / LLM 兜底)

> 日期:2026-06-28
> 分支建议:`feat/jb-route-resolver`
> 状态:设计已与用户逐节确认,待 spec 审阅后转写实施计划
> 相关重构前序:`5df7c9a`(多卡对比 bail 收口到 `emitDeterministicJbTablesReply`)——本设计是其根因的彻底版

---

## 1. 背景与问题(打地鼠的根)

JB 确定性回复的意图判定,目前是**三套重叠的正则系统 + 顺序敏感的调度**:

| 层 | 位置 | 职责 | 规模 |
|---|---|---|---|
| `classifyIntent` | `agentPrompt.ts` | 选注入哪些 prompt 段 | 7 意图 |
| `detectJbReplyMode` | `agentJbDeterministicReply.ts` | 选吐哪张确定性表 | 18 mode |
| 直连调度 | `agentLoop.ts` (~2650–2768) | 13 条 `tryRunXxxDirectRoute`,各带 `isXxxQuestion` 门槛 | 顺序敏感 |

合计约 **28 个 `isXxx/extract` 检测器** + **32 个 `emit done` 出口** + **2 套意图分类法**。

**病根具象:** 同一个 `userQuestion` 一轮内被**重复分类 3+ 次**——每条直连门槛各算一次、`emitDeterministicJbTablesReply`([agentLoop.ts:944])算一次、`buildDeterministicJbTables`([agentJbDeterministicReply.ts:1265])又算一次,且每处可能算出**不同**结果。

**后果(反复发生):** "同一意图、另一条路绕过" 类 bug。P-C 是典型——修了 `detectJbReplyMode`、又补 `tryRunEquipmentDirectRoute`、再补 summary 轮,三层补丁才堵住一只地鼠。每加一种用户问法,就可能误吞(补 bail)或漏接(扩分支),且检测器互相干扰(`extractLotFromUserText` 把 `9416-01` 误判为 lot)。

**安全网(已存在):** `pcr-ai-api/test/eval/`——routing/factcheck/summary/empty/insight 五类回归台,支持 `live: true` 真 LLM 场景。`routing.scenarios.ts` 已断言 `classifyIntent`/`buildJbScopeArgs`/`detectPendingQuery`/`canRunLotListingDirectRoute`。

---

## 2. 决策(已与用户确认)

| 项 | 决定 | 备注 |
|---|---|---|
| 路由大脑 | **混合:正则快路 + LLM 兜底** | 高置信度问法保 0.0s;模糊长尾交 LLM,不靠正则硬猜 |
| 爆炸半径 | **只收 JB 表路由** | `classifyIntent`(prompt 段)与 YM 侧**不动** |
| 硬规则 | 纯路由层,**不碰 SQL/WHERE/响应形状** | 不触发 dummy-parity;但 `npm test` + `typecheck` 每阶段必过 |

---

## 3. 架构 —— 单一真相源

把"一轮内反复猜、各处可能矛盾"换成"一轮只算一次、全程透传"。

```
userQuestion ─→ resolveJbRoute(q, history, payload?) ──→ JbRouteDecision
                  ① 高置信度正则规则(有序表)命中 → 立即返回 (0.0s,等同今天)
                  ② 没命中(模糊长尾)→ 调便宜模型分类 → 同一套 mode 枚举
                  ③ LLM 不可用/低置信 → mode="generic"(交回完整 LLM,现有安全行为)
                       ▼
              一张声明式 dispatch 表: mode ─→ handler
                       ▼
        agentLoop 调度、summary 轮、buildDeterministicJbTables 都消费 decision.mode
```

**为什么能拔根:**
1. 只有一条路、一次判定——"改对一条路漏了另一条"的结构性 bug 消失。
2. 新问法不再需要加正则 #29:高置信度→加一条规则;否则自动落 LLM 兜底(零代码)。
3. 一套意图枚举、一个判定点、一张 dispatch 表;28 个检测器从"调度逻辑"降级为"高置信度快路规则库",不确定时不硬猜。
4. `classifyIntent` 与 YM 不动,爆炸半径锁死。

---

## 4. 接口骨架

### 4.1 决策对象

```ts
type JbRouteSource = "regex" | "llm" | "default";

interface JbRouteDecision {
  mode: JbReplyMode;          // 复用现有 18 个 mode 枚举,不新造
  source: JbRouteSource;      // 谁判的——日志/eval 区分快路 vs 兜底
  confidence: "high" | "low"; // regex 命中=high;llm 带自评;default=low
  params: {                   // 集中一处抽净,handler 直接读,不再各自重抽/互相误判
    focusBin?: number;
    slot?: number;
    lot?: string;
    cardId?: string;
    passId?: number;
  };
  reason: string;             // 人类可读:命中哪条规则 / LLM 理由——日志直接打
}
```

> `params` 一次性抽净是关键:现 `extractBinFromUserText`/`extractSlotFromUserText`/`extractLotFromUserText` 散在各 handler 重复调、互相误判(P-C 即此)。

### 4.2 声明式 dispatch 表(取代 13 条顺序敏感 if)

```ts
const JB_ROUTE_TABLE: Record<JbReplyMode, JbRouteHandler> = {
  equipment:            { handler: emitEquipmentTables,    needsPayload: true  },
  lot_overview:         { handler: emitLotOverviewTables,  needsPayload: true  },
  lot_listing:          { handler: emitLotListingTables,   needsPayload: false },
  bin_card_attribution: { handler: emitBinCardAttribution, needsPayload: true  },
  per_slot_bin_ranking: { handler: emitPerSlotBinRanking,  needsPayload: true  },
  bad_bin_ranking:      { handler: emitBadBinRanking,      needsPayload: true  },
  // ... 其余 mode
  generic:              { handler: null /* 交回 LLM ReAct */, needsPayload: false },
};
```

调度:
```ts
const decision = resolveJbRoute(userQuestion, history, payload);
const route = JB_ROUTE_TABLE[decision.mode];
if (route.handler) return route.handler(sessionId, decision, agentConfig, emit);
// generic / handler 为 null → 落入既有 LLM 流程
```

### 4.3 bail 上移
散落的 `multiCardCompare` / `crossLot` / `staleCache` / `singleWaferCluster` 等 bail → **全部上移为 `resolveJbRoute` 里的规则**,命中即把 `mode` 判 `generic`。不再是 handler 里的暗门,而是路由前的显式规则。

### 4.4 优先级即有序规则表
现 `detectJbReplyMode` 的 18 行 if 顺序保留为**显式优先级数组**,不再隐含在控制流:
```ts
const HIGH_CONFIDENCE_RULES: Array<{ test: (q, p) => boolean; mode: JbReplyMode; reason: string }> = [ ... ];
```

---

## 5. 混合 resolver 内部

### 5.1 三段式

```
resolveJbRoute(q, history, payload):
  ① HIGH_CONFIDENCE_RULES 逐条 test;命中 → {mode, source:"regex", confidence:"high"}   ← 0.0s
  ② 无命中 → callJbIntentClassifier(q, history) → {mode, source:"llm", confidence: 自评}
  ③ 失败/超时/低置信 → {mode:"generic", source:"default", confidence:"low"}            ← 交回 LLM
```

### 5.2 边界纪律(防"双倍打地鼠")
**正则只在几乎不可能误判时抢答**:明确 lot 号 + 明确动词;明确 bin + 明确范围词。
**出现以下信号就不抢答、直接落 LLM**:多实体并列(≥2 卡号/≥2 lot)、对比词("对比/分别/各自")、口语无锚点("这几张卡怎样")、正则间会打架的。
原则:**正则负责"明显的",LLM 负责"模糊的";宁可多落给 LLM(慢 300ms 答对),不让正则硬猜(0.0s 答错)。**

### 5.3 LLM 分类器
- 模型:复用 `agentConfig.subAgentModel`(便宜档)。
- 输入:问题 + 极简上下文(上一条工具名 / 缓存 lot);**不传**大块历史。
- 输出:强制结构化 `{ mode:<枚举>, focusBin?, slot?, lot?, cardId?, confidence }`;用 `agentToolValidator` 校验,非法即视失败走 ③。
- 延迟:独立短超时(≈4s),超时即 ③,绝不阻塞整轮。

### 5.4 安全降级
LLM 分类失败 → `mode:"generic"` → 完整 LLM ReAct(= 无此优化时的原始行为)。**最坏情况不劣于今天。** 高置信度正则快路不依赖 LLM,SiliconFlow 403 时照常 0.0s 出表。

### 5.5 缓存
session 内 `(归一化问题 → decision)` 短缓存;重试/续跑/短追问命中,不重复调分类器。

---

## 6. 迁移策略(绞杀者 + 开关 + 等价比对,绝不大爆炸)

| 阶段 | 内容 | 行为 | 验证 |
|---|---|---|---|
| **0 抽取** | 现 `detectJbReplyMode` + 散落 bail/参数抽取 → 收敛成 `resolveJbRoute` **纯正则版**(仅第 1 段) | 与今天**逐字节等价** | 398 测试 + eval + parity 测试 |
| **1 接管调度** | agentLoop 13 条直连改消费 `decision.mode` + dispatch 表;`buildDeterministicJbTables` 改吃 `decision` | 仍等价(三处重算→一次透传) | eval + parity |
| **2 加 LLM 兜底** | 加第 2/3 段 + `JB_LLM_INTENT_CLASSIFIER` 开关,**默认关** | 关闭=阶段 1,线上零变化 | 单测 mock 分类器 |
| **3 灰度切换** | 开关打开,eval live + 真库 curl 比对开/关两版 | 长尾接住且不破坏原本对的 | live eval + curl |

> 每阶段独立提交、独立可回退;任何一步 eval 掉点即停在上一步。

---

## 7. 测试 / 成功标准

1. **回归锁**:历史每个痛点(P-A~F、多卡对比、卡型 vs 单 lot、单片聚集、多 lot 对比…)写成 `routing.scenarios.ts` 断言,断言 **`resolveJbRoute().mode`**。地鼠墓碑,冒头即红。
2. **等价比对(parity)**:阶段 0/1,一批问题上新 `resolveJbRoute`(纯正则)与旧 `detectJbReplyMode` 输出必须一致——防无声漂移。
3. **兜底验证**:阶段 2/3,`live` eval + 真库 curl,验模糊问题走 LLM 路由正确、403 降级回 generic 不报错。
4. **成功量化**:routing eval 通过率 + 一批"故意刁钻/口语化"新问句命中率(把"整体回复质量 60(猜)"变成有据数字)。

---

## 8. 不做什么(YAGNI / 范围围栏)

- **范围 = `detectJbReplyMode` 的 18 个 mode 所驱动的确定性表路由。** 仅这部分进 `resolveJbRoute` + dispatch 表。
- **不并入** 以下 agentLoop 直连(它们不属于 `detectJbReplyMode` 体系,调 `inf_draw`/工具而非确定性表):wafermap 自动取 device(`tryRunWaferMapWithAutoDeviceLookup` / `applyWaferMapRoutePlan`)、DUT-bin map(`tryRunDutBinMapDirectRoute`)、test-item-mapping。它们**保留为 `resolveJbRoute` 之前的独立前置检查**,顺序不变;本设计不重排、不收编它们(避免范围蔓延)。`resolveJbRoute` 只在这些前置检查都未命中后才接管。
- **不动** `classifyIntent`(prompt 段选择)与其 prompt 注入逻辑。
- **不动** YM 侧路由(YM 确定性摘要是独立 TODO)。
- **不碰** 任何 SQL / WHERE / 响应形状(不触发 dummy-parity)。
- **不新造** mode 枚举,复用现有 18 个。
- **不重写** 各 `emitXxxTables` 表生成逻辑,仅改其"如何被选中"。

---

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 重构无声漂移(阶段 0/1) | parity 测试 + 398 测试 + eval 锁定逐字节等价 |
| LLM 分类器误判长尾 | 输出结构化校验 + 低置信降级 generic;live eval 比对 |
| SiliconFlow 403 / 余额 | 安全降级链,最坏=今天的 LLM 路径;正则快路不依赖 LLM |
| 延迟增加 | 仅模糊问题走 LLM;独立 4s 超时;session 缓存;高置信仍 0.0s |
| 接线遗漏某出口 | dispatch 表穷举 mode;`emitDeterministicJbTablesReply` 既有收口点保留为最后防线 |
