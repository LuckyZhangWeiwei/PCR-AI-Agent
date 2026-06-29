# JB 语义路由彻底化 —— 单一语义决策 `classifyJbIntent` + eval 黄金集闸门

> 日期:2026-06-29
> 分支建议:沿用 `feat/jb-route-resolver`(本设计是 `2026-06-28-jb-route-resolver-design.md` 的"走完"版)
> 状态:设计已与用户逐节确认,待 spec 审阅后转写实施计划
> 前序:`resolveJbRoute` / `resolveJbRouteAsync` / `callJbIntentClassifier` 已落地但**未走完**——LLM 兜底仅在 `mode==="generic"` 且无 lot 时触发,且只决定"渲染哪张表",不收编散落的 bail 分类器,默认 flag 关闭。

---

## 1. 背景与问题(打地鼠的真根)

`2026-06-28` 那次把"渲染哪张表"的判定收敛到了 `resolveJbRoute` 单一真相源,但只统一了**路由层**。真根更深:**整套系统里有 N 个各自独立的关键字分类器,每个都在用表面字面去猜意图。**

| 分类器 | 位置 | 职责 |
|---|---|---|
| `classifyIntent` | `agentPrompt.ts` | 选注入哪些 prompt 段(7 意图) |
| `detectJbReplyMode` / `resolveJbRoute` | `agentJbDeterministicReply.ts` / `jbRouteResolver.ts` | 选渲染哪张表(18 mode) |
| `isMultiCardComparisonQuestion` | `agentLoop.ts` | 多卡对比 bail |
| `isMultiLotComparisonQuestion` | `agentLoop.ts` | 多 lot bail |
| `equipmentRouteDutLevelBail` | `agentLoop.ts` | equipment 路由 DUT 级 bail |
| `extractBin/Slot/Lot/Card` | 多处 | 参数抽取 |

每个都是正则。**每一种新说法都是一只新地鼠:** 补了"哪张卡",下一句"哪片卡 / 这卡 / 用的哪张针卡"又漏。这是结构性的,不是手速问题。

### 1.1 触发本设计的实证(log `mqygf9mq` turn1,2026-06-29)

用户问「n55z 哪个卡测出bin35 多」:
- **turn1**:模型调 `query_jb_bins(mask:N55Z)` → 返回 142 lot 的 `multiLotYieldScope` → 确定性层照实渲染**最新单 lot** 的机台/卡/逐片表 → **所答非所问**。
- **turn2**(同一句、同一 prompt):模型改调 `aggregate_jb_bins(groupBy:"bin,cardId")` → 正确出 BIN35×卡 排名。

诊断结论(已与用户确认):
1. 此次根因是**模型在主循环里选错了工具**(`query_jb_bins` 而非 `aggregate_jb_bins`),属热路径 LLM 工具选择抖动,**任何路由改造都修不了**——语义路由器只决定"取数回来怎么渲染",根本没轮到上场。
2. 关键字分类器(`classifyIntent`)此次其实**判对了**(`bin35`→`lot_bin`,`SEC_BIN_ON_CARD` 已注入),正则层这次没背锅。
3. 但用户的更深诉求是:**彻底消灭"关键字猜意图"这一整类脆弱性**,而不是再补一个同义词。

### 1.2 已有安全网

`pcr-ai-api/test/eval/`——routing/factcheck/summary/empty/insight 五类回归台。`evalTypes.ts` 已立原则:**真实日志只是种子,不是 ground truth(日志里的答案本身可能就是错的);什么叫对由我们定义。** routing 场景已断言 `classifyIntent`/`resolveJbRoute`/`buildJbScopeArgs`/`detectPendingQuery`。支持 `live: true`(dummy 后端 + 真 LLM,`AGENT_EVAL_LIVE=1` 才跑,不进 CI)。

---

## 2. 决策(已与用户逐节确认)

| 项 | 决定 | 备注 |
|---|---|---|
| 终极目标 | **拔根**:把 N 个关键字分类器收敛成一个语义决策点 | 用户原话「我就是要彻底解决这种打地鼠的问题」 |
| 分阶段 | **第一期 = 阶段一 + 阶段二**;阶段三留作 Phase 2 | 见 §6 |
| 爆炸半径 | 第一期只收 **JB 表路由 + 三处 bail**;`classifyIntent`(prompt 段)与 YM 侧**不动** | 与前序一致,锁死半径 |
| 红线 | 全程藏 flag 后,**默认 off**;eval 黄金集闸门绿了才翻默认 | 守「不要影响现在 agent 的回复质量」 |
| 硬规则 | 纯路由层,**不碰 SQL/WHERE/响应形状** | 不触发 dummy-parity;`npm test` + `typecheck` 每阶段必过 |

**诚实边界(写在最前):** 第一期(阶段一+二)消灭的是"渲染错表 / 漏拦截"这一整类**关键字地鼠**;它**不**根治 §1.1 那种 turn1 选错工具的抖动——那需要阶段三(Phase 2)。本期不夸大为"turn1 也修好了"。

---

## 3. 架构 —— 单一语义决策 `classifyJbIntent`

### 3.1 决策契约

新增唯一入口(扩展现有 `jbRouteResolver.ts` / `jbIntentClassifier.ts`,不另起炉灶):

```ts
export interface JbIntentDecision {
  mode: JbReplyMode;                 // lot_overview / bin_card_attribution / ...(沿用 VALID_MODES)
  focusBin?: number;
  lot?: string;
  cardId?: string;
  slot?: number;
  passId?: number;
  isMultiCardCompare: boolean;       // 收编 isMultiCardComparisonQuestion
  isMultiLotCompare: boolean;        // 收编 isMultiLotComparisonQuestion
  isDutLevel: boolean;              // 收编 equipmentRouteDutLevelBail
  source: "regex-fast" | "llm" | "regex-fallback";
  confidence: "high" | "low";
  reason: string;
}
```

### 3.2 三段式(正则不删、降级为快路 + 兜底)

```
classifyJbIntent(question, ctx) ──→ JbIntentDecision
  ① 快路:正则抽到明确 lot/card 且 mode 无歧义 → 立即返回(高置信,0.0s,不调 LLM)
  ② 语义:否则调 callJbIntentClassifier(扩成输出 §3.1 全部字段)
  ③ 兜底:LLM 4s 超时 / 解析失败 → 退回正则 base(现有逻辑,保留)
```

**为什么能拔根:**
1. 一个语义理解点产出全部路由信号;下游不再各自跑正则。
2. 新问法不再需要加正则 #N:高置信→加快路规则;否则 LLM 自动覆盖(零代码)。新增说法只需在黄金集补一条断言。
3. 正则从"主脑"降级为"高置信快路 + LLM 不可用时的兜底",不确定时不再硬猜。

### 3.3 下游消费点(阶段二接线)

全部改读这**一个** `decision`,删除各自的 inline 关键字判定:
- `emitDeterministicJbTablesReply`([agentLoop.ts:940/952]):`isMultiCardComparisonQuestion` → `decision.isMultiCardCompare`;多 lot bail 的 `isMultiLotComparisonQuestion` → `decision.isMultiLotCompare`。
- equipment 路由的 `equipmentRouteDutLevelBail` → `decision.isDutLevel`。
- `resolveJbRoute` 的现有调用方 → `classifyJbIntent` 返回的 `mode`/`params`。

> 收编时**保留**原关键字函数的内部正则作为 §3.2 快路规则的实现,只是不再被各调用点**单独**调用;以此保证快路行为与今天逐位一致(零回退的前提)。

---

## 4. eval 黄金集 —— 判断"拔根 vs 挪坑"的仪器

### 4.1 数据

`pcr-ai-api/test/eval/scenarios/routing-golden.ts` —— 一张声明式标注表:

```ts
{ question: "n55z 哪个卡测出bin35 多",
  expected: { mode: "bin_card_attribution", focusBin: 35,
              isMultiCardCompare: false, isMultiLotCompare: false, isDutLevel: false },
  seed: "log mqygf9mq turn1 所答非所问" }
```

- 问句**全部来自真实日志**:桌面 `New folder (3)` 的 5+1 个 md、以及仓库内历次 session 日志 / 已知 bug commit。
- 正确答案**由我们定义**(沿用 `evalTypes.ts` 原则:日志答案只是种子)。
- 起步规模目标 **≥ 30 条**,覆盖现有 18 mode + 三个 bool flag 的代表问法与已知踩坑同义词("哪个/哪张/哪片卡"等)。

### 4.2 打分器

同一套问句分别跑三种路由,各出准确率 + 逐条 diff:
1. **纯正则**(`resolveJbRoute` + 现有 bail 正则)——锁为 **baseline**。
2. **纯 LLM**(`callJbIntentClassifier` 扩展版)。
3. **混合三段式**(`classifyJbIntent`,实际上线形态)。

### 4.3 闸门(红线的硬证据)

`agentEval.test.ts` 增断言:
- **锁定纯正则在黄金集上的通过集为 baseline。**
- **混合三段式必须 ≥ baseline、且在 baseline 已通过的每一条上零回退**,才允许把 `JB_LLM_INTENT_CLASSIFIER` 默认打开。
- LLM 相关条目走 `live`(`AGENT_EVAL_LIVE=1`),不进 CI;CI 内只跑纯正则 baseline + 混合的"快路命中"子集(确定性部分),保证 CI 仍可重复。

---

## 5. 上线与回退

- 全程藏在 `JB_LLM_INTENT_CLASSIFIER` flag 后,**默认 off**;§4.3 闸门绿了才在代码里翻默认(单独 commit,可秒回退)。
- LLM 分类用 `subAgentModel`(小模型),**仅 ambiguous 才触发**——快路覆盖大多数明确问句,热路径延迟可控;4s 超时 → 正则兜底,不阻断主流程。
- 第一期不动 `classifyIntent`(prompt 段)与 YM 侧;不碰任何 SQL/Dummy。

---

## 6. Phase 2 边界(阶段三,本期不实现)

**目标:根治 §1.1 turn1 选错工具。** 让 `JbIntentDecision` 在**高置信**时直接驱动服务端确定性发查询(可分类的 JB 问句不再靠模型选工具),把 ①②③④ 四层决策塌缩成「语义意图 → 确定性执行计划 → 渲染 → LLM 仅写解读」。

**前置条件(未达不许启动):**
1. 黄金集规模 ≥ 80 条,且混合路由在其上**误分类率 < 阈值**(具体阈值在 Phase 2 spec 定,初步设 ≤ 2%)。
2. 阶段二已默认上线并在真库观察期无回退报告。

**风险(为什么单列):** 把"选哪个工具"从模型手里拿走,路由器判错=自信地查错,直撞质量红线;故必须等黄金集证明误分类率达标再上。

---

## 7. 验收(第一期 = 阶段一 + 阶段二)

- [ ] `classifyJbIntent` 单一入口产出 §3.1 全字段;三段式快路/LLM/兜底各有单测。
- [ ] `emitDeterministicJbTablesReply` 三处 bail + equipment DUT bail 全部改读 `decision`,删除 inline 正则调用点。
- [ ] `routing-golden.ts` ≥ 30 条,种子可溯源至真实日志。
- [ ] 打分器输出三路对比 + 逐条 diff;`agentEval.test.ts` 闸门锁 baseline 零回退。
- [ ] `JB_LLM_INTENT_CLASSIFIER` 默认仍 off(翻默认是闸门绿后的独立 commit)。
- [ ] `npm run typecheck` 通过;`npm test` 全绿;现有 eval(routing 11/11 等)不回退。
- [ ] 不碰 SQL/WHERE/响应形状(不触发 dummy-parity)。
- [ ] DEV_LOG.md / TODO.md 按 commit-with-docs 更新。

---

## 8. 不做(YAGNI / 守半径)

- 不动 `classifyIntent` 与 prompt 段注入(危害低,退回 general=全量,不值得重写)。
- 不动 YM 侧路由。
- 不在第一期做服务端确定性发查询(阶段三 / Phase 2)。
- 不重写参数抽取正则(收编进快路即可,行为逐位保持)。
