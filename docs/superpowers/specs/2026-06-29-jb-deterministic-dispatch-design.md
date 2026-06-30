# 阶段三:决策驱动的确定性派发 —— 根治 turn1 选错工具

> 日期:2026-06-29
> 分支建议:沿用 `feat/jb-route-resolver`
> 状态:设计已与用户逐节确认,待 spec 审阅后转写实施计划
> 前序:阶段一+二(`2026-06-29-jb-semantic-router-design.md`,已实现并终审 Ready-to-merge)建立了单一语义决策 `classifyJbIntent`。本设计在其上做"深拔根"。

---

## 1. 背景:为什么阶段一+二修不了 turn1

实证(log `mqygf9mq` turn1):用户问「n55z 哪个卡测出bin35 多」,模型**第一轮选错工具**(`query_jb_bins(mask)` 而非 `aggregate_jb_bins`),确定性层照实渲染了单 lot 表 → 所答非所问;重问一次模型选对了 → 正常。

阶段一+二把**渲染/bail** 收敛到 `classifyJbIntent` 单一决策,但**选哪个工具仍是模型在主循环里读 tool schema 自己决定的**——语义决策器只决定"取数回来怎么渲染",根本没轮到上场。所以这是模型工具选择的固有抖动,阶段一+二**结构上够不着**。

### 1.1 但骨架已存在

`agentLoop.ts:2715` 的 `PRE_LLM_DIRECT_ROUTES` 是一组在 **LLM 之前**运行的 `tryRunXxxDirectRoute`:命中 `canRunXxx` 门控就**服务端 `runTool(...)` 直发查询 + 出确定性表,完全跳过 LLM 选工具**(模板见 `tryRunScopedBadBinDirectRoute`,`agentLoop.ts:1359`)。

turn1 的 bug 正是因为 **`bin_card_attribution`(哪个卡 binN 多)这类跨实体聚合 mode 没有对应的 pre-LLM 路由**,于是落到 LLM,LLM 选错工具。

**阶段三 = 给缺失的跨实体确定性 mode 补 pre-LLM 路由,由 `classifyJbIntent` 决策驱动,藏默认 OFF flag 后。** 这样可分类的 JB 问句永远不给模型选错工具的机会。

---

## 2. 决策(已与用户逐节确认)

| 项 | 决定 |
|---|---|
| 范围 | **补齐所有缺失的、可单查询派发的跨实体聚合类 mode**(见 §4),并把现有 5 条 direct route 的 `canRunXxx` 正则门控改由 `classifyJbIntent` 决策驱动 |
| 红线保护 | **仅 `confidence==="high"` 才确定性派发**;否则 `return false` 照旧交 LLM(不确定不抢) |
| dark-launch | 全部藏 **新 flag `JB_DETERMINISTIC_DISPATCH`(默认 OFF)** 后,与 `JB_LLM_INTENT_CLASSIFIER` 分开。**BUILD 零生产变更** |
| FLIP 归属 | **用户的决定**,前置:黄金集≥80 + 实测 LLM 误分类率 < 阈值(初定 **≤2%**)。实测需真 LLM/真库环境,本环境(NJS-116、无确认 key)跑不了 → 靠用户 Cursor 真库实测;**Claude 不翻 flag** |
| 空/出错兜底 | 查询空或渲染失败 → `return false` 落回 LLM,**绝不 dead-end** |
| card_dut_question 等 INF 依赖 | **本期不做**(需多步 INF 派发,另算) |
| 硬规则 | 纯路由/派发层,**不碰 SQL/WHERE/响应形状**;`npm test` + `typecheck` 每阶段必过 |

---

## 3. 架构 —— 决策驱动的派发表

新增一条 `tryRunSemanticDispatchDirectRoute`,挂进 `PRE_LLM_DIRECT_ROUTES`(在现有专用路由**之后**,作为兜底统一派发):

```
tryRunSemanticDispatchDirectRoute(sessionId, userQuestion, agentConfig, emit):
  if (process.env.JB_DETERMINISTIC_DISPATCH !== "true") return false   // dark-launch
  const decision = await classifyJbIntent(userQuestion, ctx, agentConfig, …, history)
  if (decision.confidence !== "high") return false                     // 红线:不确定不抢
  const plan = DISPATCH_TABLE[decision.mode]
  if (!plan) return false                                              // 不在派发表 → 交 LLM
  const args = plan.buildArgs(decision, userQuestion, history)         // 复用 agentQueryScope 等
  if (!args) return false
  const raw = await runTool(plan.queryTool, args, {toolResultMaxChars, history})  // 服务端直发
  appendMessages(sessionId, {role:"tool", name:plan.queryTool, …})
  const ok = await plan.render(sessionId, userQuestion, raw/payload, agentConfig, emit)
  return ok                                                            // 渲染空 → false 落回 LLM
```

### 3.1 派发表(mode → 查询 + 渲染,均已存在)

| mode | queryTool | 渲染路径(现成) |
|---|---|---|
| `bin_card_attribution` | `aggregate_jb_bins(groupBy:"bin,cardId", focusBin?)` | `renderAggregateJbBinsResult`(B-core,已自动选 bin/card/device 渲染器) |
| `lot_yield_ranking` | `query_jb_bins(device)` | `emitDeterministicJbTablesReply` → `buildLotYieldRankingMarkdown`(读 `lotYieldRankByTestEnd`) |
| `card_yield_compare` | `query_jb_bins(cardId/device)` | `emitDeterministicJbTablesReply`(mode 分支已有 card_yield_compare 渲染) |

> 两套子模式:**聚合查询类**(bin_card_attribution)走 `aggregate_jb_bins` + `renderAggregateJbBinsResult`(同 `tryRunScopedBadBinDirectRoute`);**列表读取类**(lot_yield_ranking / card_yield_compare)走 `query_jb_bins(device)` + `emitDeterministicJbTablesReply`(后者已按 mode 分发到对应 builder)。

### 3.2 门控统一(顺带消灭正则地鼠)

现有 5 条 direct route(lotListing / scopedBadBin / lotOverview / equipment / perSlotBinRanking)目前各自用 `canRunXxx(userQuestion)` 正则门控。阶段三把它们的门控改为读 `classifyJbIntent(q).mode`(语义),`canRunXxx` 正则降级为快路实现细节。这样新问法不再需要补正则。

> **行为保持**:`JB_DETERMINISTIC_DISPATCH` 默认 OFF 时,新路由整体短路 `return false`,5 条旧路由的门控可保留现有 `canRunXxx`(本期可只在 flag ON 时切换到决策驱动,避免动现有 OFF 行为)。门控切换的等价性由黄金集闸门把关。

### 3.3 为什么能根治 turn1

可分类、高置信的 JB 问句在 LLM 之前就被服务端确定性派发了正确的查询 —— 模型**没有机会**选错工具。剩余(低置信/不在表内)仍交 LLM,与今天一致。

---

## 4. 范围:哪些 mode 入派发表

**入表(本期)**——满足三条:① 当前无 pre-LLM 路由;② 映射到单一可服务端派发的查询;③ 有现成确定性渲染器:
- `bin_card_attribution`(turn1 实报 bug)
- `lot_yield_ranking`
- `card_yield_compare`

**不入表(本期)**:
- `card_dut_question` / `card_test_overview` 等需多步 INF 或多卡综述 → 留后续。
- 单 lot 模式(`lot_overview`/`bin_trend`/`single_slot`/`slot_pass_yield`/`interrupt_count`/`tester_machine`/`per_slot_bin_ranking`)——这些用户通常已给 lot 号,模型选 `query_jb_bins(lot)` 不易错;且多数已有 summary 轮确定性渲染。**不在阶段三引入**(YAGNI)。
- `lot_listing` / `bad_bin_ranking` / `equipment`:已有专用 pre-LLM 路由,阶段三只统一其门控(§3.2),不重写派发。

---

## 5. 黄金集与闸门(FLIP 前置)

- 黄金集 `routing-golden.ts` 从 57 **扩到 ≥80**,补足跨实体问句(尤其 bin_card_attribution / lot_yield_ranking / card_yield_compare 的口语变体与同义词)。
- 闸门复用阶段一+二的 `scoreHybridOnGolden`,**扩成"误分类率 < 阈值(≤2%)"断言**(live-gated,`AGENT_EVAL_LIVE=1`)。
- 新增**派发正确性**确定性测试(CI 可跑,不需真 LLM):对入表 mode 的代表问句,断言 `classifyJbIntent` 的 regex-fast 给出 `confidence:"high"` + 正确 mode + 正确 `buildArgs` 产出的查询参数(device/groupBy/focusBin)。

---

## 6. 验收(阶段三第一期)

- [ ] `tryRunSemanticDispatchDirectRoute` 挂入 `PRE_LLM_DIRECT_ROUTES`;`DISPATCH_TABLE` 含 §4 三个 mode;高置信门控 + flag 门控 + 空/错兜底 各有测试。
- [ ] 入表 mode 的 `buildArgs` 复用 `agentQueryScope` / 现有 args 助手,mask→device 解析正确。
- [ ] `JB_DETERMINISTIC_DISPATCH` **默认 OFF**;OFF 时全分支短路,现有行为零变更(回归证明)。
- [ ] 黄金集 ≥80;派发正确性 CI 测试绿;`scoreHybridOnGolden` 误分类率断言(live-gated)就位。
- [ ] `npm run typecheck` 通过;`npm test` 全绿;阶段一+二 既有测试不回退。
- [ ] 不碰 SQL/WHERE/响应形状(不触发 dummy-parity)。
- [ ] DEV_LOG.md / TODO.md 按 commit-with-docs 更新;**Claude 不翻 flag**(FLIP 留用户真库验证后)。

---

## 7. 不做(YAGNI / 守边界)

- 不翻 `JB_DETERMINISTIC_DISPATCH` 默认值(FLIP 是用户真库验证后的独立决定)。
- 不做 card_dut_question / INF 多步派发。
- 不把单 lot 模式纳入确定性派发。
- 不动 YM 侧、不动 `classifyIntent` prompt 段、不改任何 SQL/Dummy。
- flag OFF 时不改 5 条旧路由的现有门控(只在 ON 时切到决策驱动)。
