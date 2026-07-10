# Agent 探针卡/测试机组合良率排名交接文档

> **执行者：** Claude Code
> **前置阅读：** `docs/superpowers/specs/2026-07-09-probe-card-tester-performance-ranking-design.md`
> **分支：** `worktree-feat+probe-card-tester-performance`

## 0. 一眼结论

| 项 | 状态 | 说明 |
|---|---|---|
| 新工具 `aggregate_probe_card_tester_performance` | ✅ 已实现 | `probeCardTesterPerformance.ts` 纯函数 + `agentToolHandlers.ts` 分派 |
| 组合排名 / 探针卡排名 / 置信度档位 | ✅ 已实现 | 见 §4.1-4.3 |
| 月度良率趋势表 | ✅ 已实现 | 仅 ≥2 个月数据的卡 |
| 坏 bin Top3 频率表 | ✅ 已实现 | 频率统计，非坐标分布 |
| `npm test` | ✅ 564/570（564 pass / 2 fail / 4 skip） | 新增 4 个测试文件全部通过；2 个失败为已知本地预置问题（见下） |
| 真库回归 | ⏭ 待做 | 部署后用真实 device 验证 Oracle 路径 COUNT + 全量拉取 |

**关于 2 个失败用例：** `test/jbRouteResolver.test.ts` 的「开关关 → 不调分类器,等于同步结果」与「classifyJbIntent: flag off 时纯正则,flag 来自正则 base」两个 flag-off 用例失败，原因是本地 `pcr-ai-api/runtime-config.json`（被 git 追踪的文件，非本次改动引入）已设 `"jbDeterministicDispatch": true` / `"jbLlmIntentClassifier": true`，这两个用例期望的「flag 关闭」状态实际读到的是共享配置文件里的「开启」值，与 `jbRouteResolver.ts` 是否直连 `process.env` 无关。该问题已在 `docs/HANDOFF_CURSOR_JB_CARD_LISTING_SCOPE_2026-07-10.md` §4「注意」中记录为已知本地预置问题（与 CI/隔离 `RUNTIME_CONFIG_PATH` 无关，可复现绿）。已确认 `pcr-ai-api/runtime-config.json` 自 Task 1（`c44404d`）以来未被本 feature 的任何提交修改（`git diff c44404d^ -- pcr-ai-api/runtime-config.json` 为空），故此失败与本次新增的 `aggregate_probe_card_tester_performance` 功能无关，非回归。

## 1. 架构

`aggregate_probe_card_tester_performance` 走的是 **v4 风格「Oracle COUNT 保护 + 全量拉取 + Node 内聚合」** 路径，而不是 `aggregate_jb_bins`（v3 风格 `groupBy` 在 Oracle 内 `GROUP BY`/`UNPIVOT` 聚合、Dummy 侧对应 `aggregateInfcontrolLayerBinV3DummyRows` 镜像）路径：

- **数据取数**（`agentToolHandlers.ts` 的 `toolAggregateProbeCardTesterPerformance`）：复用既有的 `parseInfcontrolLayerBinsV3Query` 解析 `device`/`passId`/`testEndFrom`/`testEndTo`（自动继承 `PASSTYPE='TEST'` 基础 WHERE、`v3DefaultOneYearWindow` 一年默认窗口、`kk`/`gg`/`c` LOT 前缀排除）。Dummy 侧调用 `filterInfcontrolLayerBinV3DummyRowsMatching` 拿全集匹配行；Oracle 侧先跑 `buildInfcontrolLayerBinMatchingCountSql` 做行数保护（超过 `MEMORY_AGG_ORACLE_MAX_ROWS` 时拒绝并提示缩小范围，与 v4 aggregate 的保护逻辑一致），再用 `buildInfcontrolLayerBinsV3SqlFullMatching` 拉全量明细行。两条路径拿到的都是**原始行数组**，不是预聚合结果——这一步与 v3 的「聚合发生在 SQL 里」根本不同，是本工具能与 Dummy 共用同一段聚合代码（dummy-parity 更容易维护）的关键。
- **聚合计算**（`probeCardTesterPerformance.ts` 的 `computeProbeCardTesterPerformance`）：纯函数，输入统一是 `enrichJbRow`（`enrichInfcontrolLayerBinRowV2` + `PROBECARDTYPE`/`MASK`）处理过的行数组，Oracle 与 Dummy 两条路径在传入这个函数之前已经完全等价，聚合逻辑本身不需要关心数据来自哪条路径——按 `PASSID`（仅保留 1/3/5）分组，组内再按 `(cardId, testerId)` 做组合排名、按 `cardId` 做探针卡排名/月度趋势/坏 bin Top3，全部在内存里完成，产出 `PassGroupResult[]`（含结构化字段与拼好的 Markdown 表）。
- **对比 `aggregate_jb_bins`/v4 聚合**：`aggregate_jb_bins` 的分组维度（bin/lot/cardId 等）与聚合方式（COUNT/SUM）在 Oracle 侧用 SQL `GROUP BY`/`UNPIVOT` 完成，Dummy 侧必须用另一套 Node 代码（`aggregateInfcontrolLayerBinV3DummyRows`）**独立复现**同样的分组逻辑，两套实现容易漂移（`dummy-parity` 规则的高风险区）。本工具把"取数"和"聚合"拆成两段：取数复用现成的 v3 parser/SQL/Dummy filter（本身已符合 dummy-parity），聚合是**单一纯函数**处理两条路径共用的、已 enrich 的行数组，天然消除了聚合逻辑本身的 Oracle/Dummy 分叉风险，只需保证两条取数路径返回的行 schema 一致（`enrichJbRow` 已统一处理）。

## 2. 关键文件

| 文件 | 改动 |
|---|---|
| `pcr-ai-api/src/lib/probeCardTesterPerformance.ts`（新） | 分组聚合纯函数 + markdown 构建 |
| `pcr-ai-api/src/lib/agent/agentToolHandlers.ts` | 新工具分派 `toolAggregateProbeCardTesterPerformance` |
| `pcr-ai-api/src/lib/agent/agentToolSchemas.ts` | 新增 schema |
| `pcr-ai-api/src/lib/agent/agentPrompt.ts` | `SEC_CARD_TESTER_PERFORMANCE` + classifyIntent 扩展 |
| `pcr-ai-api/test/probeCardTesterPerformance.test.ts`（新） | 纯函数单测 |
| `pcr-ai-api/test/agentAggregateProbeCardTesterPerformance.test.ts`（新） | Dummy 模式工具路由测试 |
| `pcr-ai-api/test/agentToolSchemas.test.ts`（新） | schema 存在性测试 |
| `pcr-ai-api/test/agentPrompt.test.ts`（新） | classifyIntent + 内容包含测试 |

对应提交（均在当前分支，`main` 之上）：

| 任务 | 提交 | 主题 |
|---|---|---|
| Task 1 | `c44404d` | feat(probe-card-perf): add stats helpers and per-row yield via badDieFromJbRow reuse |
| Task 2 | `a9680ea` | feat(probe-card-perf): add combo/card ranking, confidence tier, trend, bad-bin tables |
| Task 3 | `1fcb24b` | feat(probe-card-perf): wire aggregate_probe_card_tester_performance agent tool |
| Task 4 | `8a44b06` | feat(probe-card-perf): add aggregate_probe_card_tester_performance tool schema |
| Task 5 | `eb97f2d` | feat(probe-card-perf): add prompt trigger rules and bad-bin spatial-claim guardrail |

## 3. 测试

```bash
cd pcr-ai-api
npm run typecheck
npx tsx --test test/probeCardTesterPerformance.test.ts test/agentAggregateProbeCardTesterPerformance.test.ts test/agentToolSchemas.test.ts test/agentPrompt.test.ts
npm test
```

`npm run typecheck` 与 `npm run build` 均无错误；`npm test` 实测 **46 个 suite 共 570 个测试，564 pass / 2 fail / 4 skip**，4 个新增测试文件（`probeCardTesterPerformance.test.ts`、`agentAggregateProbeCardTesterPerformance.test.ts`、`agentToolSchemas.test.ts`、`agentPrompt.test.ts`）全部通过；2 个失败均为 `test/jbRouteResolver.test.ts` 的 flag-off 用例，属于 §0 所述已知本地预置问题，与本 feature 无关。

## 4. 手工 Dummy 模式端到端验证（2026-07-10 实测）

```bash
cd pcr-ai-api
INFCONTROL_LAYER_BINS_DUMMY=true npx tsx -e "
import('./src/lib/agent/agentToolHandlers.js').then(async (m) => {
  const out = await m.runTool('aggregate_probe_card_tester_performance', { device: 'WA03P02G' });
  console.log(out);
});
"
```

实测 `device=WA03P02G` 命中 `totalRowsMatching=5`，输出两个 pass 组（`passId=1` 3 条组合、`passId=3` 2 条组合；样本内该 device 无 `passId=5` 数据）。逐项核对：

- **JSON 有效性**：输出为合法 JSON，无解析错误。
- **`groups[].passId` 仅 1/3/5**：实测仅出现 `1` 和 `3`，均在允许集合内。
- **`comboRankingMarkdown` 按良率降序**：`passId=1` 组为 97.41% → 96.26% → 95.46%；`passId=3` 组为 99.79% → 99.69%；均严格降序。
- **`cardRankingMarkdown` 按良率升序（最差在前）**：`passId=1` 组为 95.46% → 96.26% → 97.41%；`passId=3` 组为 99.69% → 99.79%；均严格升序。
- **`confidenceTier` 与 `lotCount` 阈值一致**：样本中全部组合 `lotCount=1`（`confidenceTierFromLotCount`：`>=10` 高、`>=3` 中、否则低），全部标记为「低」，与代码阈值一致。
- **`cardTrendMarkdown` 不出现单月卡**：样本每张卡仅 1 条记录（单月），`cardTrend` 输出为空数组，`cardTrendMarkdown` 为 `"(无数据)"`，符合「≥2 个月才入趋势表」的过滤规则。
- **`cardBadBinMarkdown` 逐卡百分比 ≤100% 且来自该卡自身坏片总数**：另跑独立脚本，用 `enrichInfcontrolLayerBinRowV2` + `badDieFromJbRow` 对同一 5 行原始数据逐行核算坏片数，与工具输出交叉验证：
  - `8041-02`（passId1, bad=135）：topBins 42.96%/34.81%/6.67% → 反推坏片数 58/47/9，三者之和 114 ≤ 135（其余 21 片分布在未进 Top3 的 bin），总占比 84.44% ≤ 100%。
  - `8041-04`（passId1, bad=77）：topBins 53.25%/14.29%/12.99% → 反推 41/11/10，和 62 ≤ 77，总占比 80.53% ≤ 100%。
  - `8041-07`（passId1, bad=111）：topBins 59.46%/11.71%/10.81% → 反推 66/13/12，和 91 ≤ 111，总占比 81.98% ≤ 100%。
  - `8041-03`（passId3, bad=6）：topBins 50.00%/33.33%/16.67% → 反推 3/2/1，和恰为 6（该卡坏 bin 种类 ≤3，全部落入 Top3），总占比 100%。
  - `8041-06`（passId3, bad=9）：topBins 44.44%/33.33%/22.22% → 反推 4/3/2，和恰为 9，总占比 100%。
  - 各卡的 `avgYieldPct` 亦逐一用 `(1 - bad/GROSSDIE) * 100` 手工核算，与工具输出小数点后精确一致（如 `8041-02`：135/2971 → 95.45607539548973%）。

全部检查项符合预期，无异常。

## 5. 部署与真库回归

```bash
cd pcr-ai-api
npm ci && npm run build && npm run pm2:reload
```

真库验证（部署后）：用一个已知有较多 lot 历史的 device（如从 manifest `topDevices` 挑一个）在 Agent 对话里问「[device] 这个 device 下最好的探针卡+机台组合」，确认：
- 分 pass1/pass3/pass5 三组输出
- Oracle 路径的 COUNT 查询先执行（可在服务端日志 `logAgentSql` 输出确认），未超 `MEMORY_AGG_ORACLE_MAX_ROWS` 时正常拉全量行
- 数字与手工核算一致

## 6. 已知限制（v1 范围外，见设计文档 §7）

不做文件上传、不融合 Yield Monitor 数据、不做前端可视化面板、不跨 device 汇总、不做 Tester ANOVA/显著性检验、不做数值置信度分数、不做真正的 Wafer Map 坐标关联。
