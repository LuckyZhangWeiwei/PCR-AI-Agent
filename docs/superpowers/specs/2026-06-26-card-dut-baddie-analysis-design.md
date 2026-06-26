# 设计：卡↔DUT↔坏die 关系检测（Agent 隐性规律增强）

**日期**：2026-06-26
**分支**：feat/dynamic-prompt-injection（或新建 feat/card-dut-baddie-analysis）
**状态**：设计已与用户对齐，待 review → 实现计划

## 1. 背景与目标

Agent 当前能按 slot 序列检出坏 BIN 的**突增/聚集/递升**（`agentJbBadBinCluster.ts` →
`clusteredBadBinAlerts`），但这是「片间」维度。**DUT 维度的规律尚未检测**——尤其是
工程上最关键的一个判别：**某个坏 BIN 的坏 die 是集中在少数 DUT（探针卡针点问题），
还是均匀分散（工艺/批次问题）**。

用户要求：加强「人难发现的规律」检测，重点是**卡、DUT、坏die 三者之间的关系**。

本 spec 范围（子项目 1）：
- **Phase 1（旗舰，本次实现）**：DUT 集中度检测（卡 vs 工艺判别），关联 CARDID。
- **Phase 2（同子项目，后续）**：跨片系统性 DUT、换卡前后失效变化——需逐片 DUT 数据。

**不在本 spec**（另起子项目 2）：跨 pass/温度档隐性关联（纯 JB 统计，数据路径独立）。

## 2. 数据来源（已核实）

| 数据 | 来源 | 形状 |
| --- | --- | --- |
| 坏 BIN × DUT die 分布 | `query_lot_dut_bin_agg`（INF 磁盘 Perl，lot 内 ≤25 片**求和**） | `passes[].bins[].duts:[{site, dieCount}]` + `totalDieCount` / `avgPerDut`（坏 BIN 取 top 8 DUT） |
| 各 pass 用了哪张卡 | JB `query_jb_bins(lot)` → `cardByPassId:[{passId, cardIds, hasCardChange}]` | 已有 |
| 可疑坏 BIN | 现有 `clusteredBadBinAlerts` / `topBadBins` | 已有 |

**关键约束**：`query_lot_dut_bin_agg` 把 lot 内多片**求和**，不保留逐片明细。
Phase 1（DUT 集中度）只需 lot 汇总的 `duts` 数组，**现有数据足够**。
Phase 2（系统性 DUT / 换卡前后）需逐片×DUT 数据，**需扩展 INF 聚合保留逐片，或受控逐片调用**——
故置于 Phase 2。

## 3. 架构

沿用现有 `clusteredBadBinAlerts` 模式：**确定性纯函数检测器 → 结构化 Insight + 预计算 markdown →
注入确定性 JB 总结 → 模型只在「数据解读/专业建议」叙述结论**（数字由服务端算，防幻觉）。

```
agentDutConcentration.ts      # Phase 1：DUT 集中度检测（本 spec 核心）
  - buildDutConcentrationInsights(passes, cardByPassId, opts) → DutConcentrationInsight[]
  - formatDutConcentrationMarkdown(insights) → string
  - DUT_CONCENTRATION_GUIDE（注入 system prompt 的判别口径）

agentDutInsightTrigger.ts     # 智能触发编排：何时拉 INF + 跑检测
  - shouldRunDutAnalysis(userText, jbPayload) → boolean

（Phase 2，后续）agentSystematicDut.ts / agentCardChangeImpact.ts
```

每个模块单一职责、可独立测试，不互相依赖内部实现。

## 4. Phase 1 详细设计：DUT 集中度

### 4.1 输入

- `passes`：`query_lot_dut_bin_agg` 返回的 `passes[]`（每 pass 每坏 BIN 的 `duts:[{site,dieCount}]`）。
- `cardByPassId`：JB 该 lot 各 pass 的 CARDID。
- `opts.topShareThreshold`：默认 **0.70**（top DUT 占比阈值，已与用户确认）。
- `opts.minTotalDie`：默认 **8**——总坏 die 过小不判（统计不显著，避免噪声）。

### 4.2 计算（每个可疑坏 BIN × pass）

1. `total = Σ dieCount`；若 `total < minTotalDie` → **跳过，不产 insight**。
2. 按 dieCount 降序排序 DUT；`K = min(3, dutCount)`；
   `topShare = (top K 个 DUT 的 dieCount 之和) / total`；
   `topDuts` = 这 K 个 DUT（含各自 `share = dieCount/total`）。
3. 集中度判别（明确、互斥）：
   - `dutCount < 3` → `verdict: "inconclusive"`（DUT 太少，无法区分集中/分散）。
   - 否则 `topShare ≥ topShareThreshold`（默认 0.70）→ `verdict: "probe_card"`
     （坏 die 集中在少数 DUT → 探针卡针点/接触问题）。
   - 否则 → `verdict: "process"`（分散在多数 DUT → 工艺/批次问题）。
4. 关联 CARDID：从 `cardByPassId` 取该 pass 的卡号，写入 insight，使结论落到
   「卡 X 的 DUT a/b/c」；`cardByPassId` 缺该 pass → `cardId: null`。

### 4.3 输出结构

```ts
type DutConcentrationVerdict = "probe_card" | "process" | "inconclusive";
type DutConcentrationInsight = {
  bin: number;
  passId: number;
  sortLabel: string;        // pass1/3/5
  cardId: string | null;    // 来自 cardByPassId
  totalDie: number;
  topDuts: Array<{ site: number; dieCount: number; share: number }>;
  topShare: number;         // top DUT 累计占比
  verdict: DutConcentrationVerdict;
  detail: string;           // 中文一句话结论
};
```

`formatDutConcentrationMarkdown` 产出表：BIN | pass | 卡号 | 总坏die | top DUT(占比) | 判别。
表头**不得含内部字段名**（遵守近期「不暴露内部标识符」修复；eval 已有回归场景）。

### 4.4 判别口径（注入 prompt 的 GUIDE）

- 坏 die 集中在少数 DUT → 优先**探针卡**：查该卡对应 DUT 的 INF map、安排针尖检查/清针。
- 坏 die 均匀分散 → 优先**工艺/批次**：对比同期其它 lot、查工艺参数；非单卡问题。
- 与失效模式表（CLAUDE.md 探针卡章节）一致：同 DUT 跨卡复现→查机台；换卡后失效 DUT 变→卡缺陷。

## 5. 智能触发编排

- **触发条件**（满足任一即跑 Phase 1 DUT 分析）：
  1. 当前 lot 分析已检出可疑坏 BIN（`clusteredBadBinAlerts` 非空，或 `topBadBins` 中存在
     高占比 BIN）。
  2. 用户问题涉及卡/DUT/「是卡还是工艺」（复用现有意图判别 + 关键词）。
- **拉取**：触发时调用 `query_lot_dut_bin_agg(device, lot, passIds)`（仅可疑 BIN 的 pass），
  跑检测器，结果并入确定性总结。
- **不触发**（无可疑 BIN 且用户没问卡/DUT）→ **不碰 INF**，零额外延迟。

## 6. 集成点

- `agentJbDeterministicReply.ts`：在产出确定性总结时，按触发条件追加 DUT 集中度表 +
  把 `DUT_CONCENTRATION_GUIDE` 纳入模型叙述依据。
- `agentToolHandlers.ts` / 触发编排：负责在需要时发起 `query_lot_dut_bin_agg` 并把结果喂给检测器。
- `agentPrompt.ts`：新增「DUT 集中度：卡 vs 工艺判别」专节（精简，引用 GUIDE）。

## 7. 测试

- **单元/eval**（`npm run agent:eval`，category `summary` 或新 category `insight`）：
  - 集中分布（top1 DUT 占 90%）→ `verdict: "probe_card"`。
  - 均匀分布（10 个 DUT 各占 ~10%）→ `verdict: "process"`。
  - `total < minTotalDie` → 跳过（不产 insight）。
  - 关联 CARDID 正确（从 cardByPassId 取对应 pass）。
  - markdown 输出不含内部字段名。
- **回归**：并入 `npm test`（`test/agentEval.test.ts` 包装）。
- 触发编排：用户问「BIN11 是卡还是工艺问题」→ `shouldRunDutAnalysis` 为真；
  普通良率问题且无可疑 BIN → 为假。

## 8. 错误处理

- `query_lot_dut_bin_agg` 失败/INF 不可读/Dummy 缺数据 → 检测器返回空，总结正常进行
  （不阻断主流程，与现有确定性总结的降级一致）。
- `cardByPassId` 缺失 → `cardId: null`，结论用「该 pass 探针卡」措辞，不捏造卡号。

## 9. 范围边界（YAGNI）

- 本 spec **只做 Phase 1（DUT 集中度 + 触发）**。Phase 2（系统性 DUT / 换卡前后）需先解决
  逐片 DUT 数据，待 Phase 1 落地后单独排期。
- 跨 pass 隐性关联（#4）为独立子项目，不在本 spec。
- 阈值（0.70 / minTotalDie 8）可配，给默认；不做自适应阈值。
