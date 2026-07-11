# 真库测试任务（给 Cursor）— 探针卡/测试机组合良率排名新工具

> **执行者：** Cursor Agent（有真库 / 真实 Oracle 访问）
> **被测代码：** 已合并至 `main`，commit 范围 `80b6475..8c90f89`（8 个提交，功能名 `aggregate_probe_card_tester_performance`）
> **背景：** 这是一个全新的 AI Agent 工具（不是修复），本地开发全程在 `INFCONTROL_LAYER_BINS_DUMMY=true` 下用 `docs/JBStart.xlsx` 样本数据验证，**从未跑过真实 Oracle 路径**。Claude Code 沙箱没有真库访问权限，以下问题必须由 Cursor 用真实数据回答。
> **前置阅读：**
> - `docs/superpowers/specs/2026-07-09-probe-card-tester-performance-ranking-design.md`（设计文档，含评分规则、置信度档位、月度趋势、坏 bin 频率表的完整定义）
> - `docs/HANDOFF_AGENT_PROBE_CARD_TESTER_PERFORMANCE.md`（实现交接文档，含 Dummy 模式端到端验证记录，可对照真库结果的验证方法）

---

## 0. 这次要回答的问题（先看这张表，再展开细节）

| # | 问题 | 为什么需要真库 |
|---|---|---|
| Q1 | Oracle 路径（COUNT 保护 → 全量拉取 → Node 内聚合）能否在真实数据上正常跑通，不报错、不超时？ | Dummy 模式从未真正执行过 `withConnection`/`conn.execute` 这两段 SQL |
| Q2 | 真实数据下算出的良率、置信度档位、探针卡排名是否与手工核算一致？ | Dummy 样本行数太少（单 device 仅 5 行），无法验证多 lot/多月场景下的聚合是否正确 |
| Q3 | `MEMORY_AGG_ORACLE_MAX_ROWS` 行数保护在真实大数据量下是否按预期触发/不误触发？ | 需要真实的「匹配行数很大」场景 |
| Q4 | 月度良率趋势表、坏 bin Top3 频率表在真实多月历史数据上是否合理？ | Dummy 样本每卡仅 1 条记录，趋势表在 Dummy 模式下从未真正产出过非空数据 |
| Q5 | Agent 对话里用自然语言问（不是直接调工具）能否正确路由到这个新工具？ | 这依赖 SiliconFlow 真实模型的工具选择行为，本地无法验证 |
| Q6 | 中途换卡/中断（TEST INTERRUPT）的 wafer 在真实数据里良率是否始终非负、没有报错？ | 本次修复了「坏 die 超过 GROSSDIE 时良率可能算出负数」的边界（见 §5 修复记录），需要真实中断数据验证 |

---

## 1. 部署被测代码

```bash
git fetch origin && git checkout main && git pull
git log --oneline -10   # 顶部应含 8c90f89(fix final review findings) 及以上 8 个 probe-card-perf 提交
cd pcr-ai-api && npm ci && npm run build && npm test
```

`npm test` 期望：**573 个测试，567 pass / 2 fail（已知本地预置问题，见下）/ 4 skip**。2 个失败固定是 `test/jbRouteResolver.test.ts` 里「开关关 → 不调分类器」相关的 2 个用例，根因是 git 追踪的 `pcr-ai-api/runtime-config.json` 里 `jbDeterministicDispatch`/`jbLlmIntentClassifier` 已设 `true`（见 `docs/HANDOFF_CURSOR_JB_CARD_LISTING_SCOPE_2026-07-10.md` §4），与本次改动无关。**如果失败数/失败用例不是这两个，先停下来报告，不要继续验证。**

```bash
npm run pm2:reload   # 或你机器上实际的 pm2 进程名/部署方式
```

确认 `PCR_AI_LOCAL_DUMMY` / `INFCONTROL_LAYER_BINS_DUMMY` 在部署环境里是 **false**（生产/dist 下这两个 dummy 开关本来就会被 `listDummyRuntime.ts` 强制关闭，正常部署无需手动设置，但如果你在自己机器上临时起服务测试，注意不要带 `INFCONTROL_LAYER_BINS_DUMMY=true`，否则又会走回 Dummy 路径，测不出真库问题）。

---

## 2. Q1 — Oracle 路径基本可用性

先挑一个你确认在库里有较多历史数据的真实 `device`（可以先跑一下 `query_jb_bins` 或 `get_filter_values` 之类你熟悉的既有工具/接口摸一个出来，或者直接查库）：

```bash
cd pcr-ai-api
NODE_ENV=production npx tsx -e "
import('./src/lib/agent/agentToolHandlers.js').then(async (m) => {
  const t0 = Date.now();
  const out = await m.runTool('aggregate_probe_card_tester_performance', { device: '<真实device>' });
  console.log('elapsed ms:', Date.now() - t0);
  console.log(out);
});
"
```

（`NODE_ENV=production` 确保 `listDummyRuntime.ts` 强制走 Oracle，不受本机 `.env` 里开发默认 Dummy 开关影响；如果你的机器本来就没设那两个 Dummy 环境变量，也可以不加这个前缀，效果一样。）

**期望：**
- 命令能跑完，不报 Oracle 连接错误、不报 SQL 语法错误、不超时（记录一下 elapsed ms，如果超过 30 秒，在回传里注明，可能需要在 §3 里进一步调查是不是行数保护阈值设太高）。
- 返回合法 JSON，顶层 `device`/`totalRowsMatching`/`groups` 字段齐全。
- 服务端日志（`logAgentSql` 输出，通常在 stdout/pm2 log 里）应该能看到 `aggregate_probe_card_tester_performance` 对应的 SQL 语句被打印出来，可以贴一段确认 SQL 长相正常（有 `INFCONTROL`/`INFLAYERBINLIST` JOIN，WHERE 里有 `DEVICE = :device` 之类的绑定）。

---

## 3. Q2/Q3 — 数字核对 + 行数保护

### 3.1 数字核对

挑一个 `groups[]` 里任意一个 `passId` 分组，从返回的 `cardRanking`（或 `comboRanking`）里挑 2-3 张卡，去真库里手动核对：

```sql
-- 伪 SQL 示意，实际按你熟悉的方式查
SELECT lb.CARDID, lb.TESTERID, lb.GROSSDIE, lb.PASSBIN, lb.BIN0, lb.BIN1, ...
FROM INFCONTROL ic JOIN INFLAYERBINLIST lb ON ic.KEYNUMBER = lb.KEYNUMBER
WHERE ic.DEVICE = '<真实device>' AND lb.CARDID = '<抽查的cardId>' AND lb.PASSID = <抽查的passId>
```

对每一行手工算 `良率 = (GROSSDIE - 非良品bin颗数之和) / GROSSDIE * 100`（良品 bin = `PASSBIN` 里列出的下标 ∪ `BIN1`），几行取平均，跟工具输出的 `avgYieldPct` 比对（允许浮点误差）。

**期望：** 手工核算结果与工具输出的 `avgYieldPct`/`stdDevYieldPct`/`recordCount`/`lotCount` 一致。若不一致，记录具体的 cardId/passId + 手工数字 + 工具数字，不要自行改代码。

### 3.2 行数保护（`MEMORY_AGG_ORACLE_MAX_ROWS`）

默认阈值 20 万行（`MEMORY_AGG_ORACLE_MAX_ROWS_DEFAULT`），真实场景大概率不会自然触发。为了验证保护逻辑本身没写错，可以临时调低阈值再测一次：

```bash
cd pcr-ai-api
MEMORY_AGG_ORACLE_MAX_ROWS=5 NODE_ENV=production npx tsx -e "
import('./src/lib/agent/agentToolHandlers.js').then(async (m) => {
  const out = await m.runTool('aggregate_probe_card_tester_performance', { device: '<一个匹配行数明显>5的真实device>' });
  console.log(out);
});
"
```

**期望：** 返回一条中文错误提示（形如「匹配行数 (N) 超过上限 (5)，请缩小 passId 或 testEndFrom/testEndTo 时间范围」），**不是**抛未捕获异常、**不是**把全部行硬塞进内存。确认后把 `MEMORY_AGG_ORACLE_MAX_ROWS` 环境变量还原（删除或改回默认），不要带着这个改动进生产。

---

## 4. Q4 — 月度趋势表 + 坏 bin 频率表

Dummy 样本里每张卡只有 1 条记录，月度趋势表在本地测试里从未产出过非空结果。找一个真实场景：

1. 挑一张 `cardId`，确认它在真库里跨至少 2 个不同自然月有测试记录（同一 `device`+`passId` 范围内）。
2. 用该 `device` 跑一次工具调用，检查返回的 `groups[].cardTrend`：
   - 该 `cardId` 是否出现在 `cardTrend` 里，且按月份列出多行？
   - 每个月的 `avgYieldPct`/`recordCount` 跟你手动按月分组核算的是否一致？
   - 再找一张**只有单月数据**的卡，确认它**不出现**在 `cardTrend` 里（设计要求：少于 2 个月不收录）。
3. 挑一张坏 bin 种类比较多的卡（比如同一张卡历史上出现过 BIN7/BIN12/BIN23 等多种失效），检查 `cardBadBin`：
   - Top3 的 bin 编号和占比是否与你手工统计的「该卡历史坏 die 按 bin 编号汇总、取前三」一致？
   - 三个占比之和是否 ≤ 100%（正常情况下小于等于，因为可能还有排名 4+ 的 bin 没展示）？

**期望：** 上述核对都吻合。若发现按月分桶用的是 UTC 月份而你们业务上惯用本地时区导致跨月边界的记录被分到"错误"的月份，记录下来，先不要改代码——这是设计层面要不要改用本地时区的问题，需要 Claude Code/产品侧确认（`monthKeyFromTestEnd` 目前固定用 `getUTCFullYear()`/`getUTCMonth()`）。

---

## 5. Q5 — Agent 对话自然语言路由

在报表的 AI Agent 聊天页（或你惯用的真实对话测试方式），依次问以下几句话（都不显式提工具名），确认每句话都触发了 `aggregate_probe_card_tester_performance`（可以看服务端日志或工具调用记录确认，不是看回复文字猜）：

1. 「`<真实device>` 这个 device 下最好的探针卡+机台组合是什么」
2. 「哪张探针卡表现最差」（在已经问过上一句、上下文里已经有 device 的情况下追问）
3. 「这张卡良率是不是在变差」（针对上面返回的某张具体卡追问）
4. 「这张卡常见坏 bin 是什么，是不是接触不良」

**期望：**
- 4 句话都命中新工具，不是被路由到 `aggregate_jb_bins`（旧工具）或落空到通用问答。
- 第 4 句的回复里，LLM **不应该**出现"边缘接触不良""角落 pattern""某区域集中"这类需要晶圆坐标才能下的措辞——这是设计里明确要求的边界（`agentPrompt.ts` 里 `SEC_CARD_TESTER_PERFORMANCE` 硬规则 2）。如果 LLM 编了这类说法，记录原文，这是 prompt 没管住，需要回来改。
- 完全没给 `device` 时（比如上下文清空后直接问「哪个探针卡+机台组合最好」），Agent 应该先追问 device，而不是报错崩溃或瞎编一个 device。

---

## 6. Q6 — 中断/换卡场景良率非负

本次最终审查修复了一个边界：如果某一行的坏 die 合计超过 `GROSSDIE`（理论上只可能发生在 `TEST INTERRUPT` 分段测试、`GROSSDIE` 只反映当次分段片数的情况下），良率现在会被下限钳制在 0%，而不是算出负数。

如果你知道这个 `device` 下有中途换卡/中断（`PASSTYPE IN ('INTERRUPT','TEST ISR','TEST INTERRUPT')`）的 lot，针对包含这类 wafer 的 `device` 跑一次完整工具调用，检查：
- 所有 `avgYieldPct`/`comboRanking`/`cardRanking` 里的良率数字是否都 ≥ 0（不应该出现负数或 `NaN`）。
- 如果找不到这类数据也没关系，直接说明"真库里没找到能复现这个场景的中断数据"即可，不是必须项。

---

## 7. 回传格式

写入 `scratchpad/realdb-probe-card-tester-performance-2026-07-11.txt` 或贴回对话，包含：

```
环境：main commit = <git rev-parse --short HEAD>，pm2 已 reload（时间）
npm test 结果：<X pass / Y fail / Z skip>，失败用例是否仍是那 2 个已知问题=<是/否，若否贴出具体失败>

Q1 Oracle 路径基本可用性
  测试 device=<...>，elapsed=<...>ms，返回是否正常=<是/否>
  服务端日志 SQL 摘要：<贴一小段>

Q2 数字核对
  抽查 cardId=<...> passId=<...>：手工算=<avgYield/stdDev/recordCount/lotCount> vs 工具输出=<...>，一致=<是/否>

Q3 行数保护
  临时调低 MEMORY_AGG_ORACLE_MAX_ROWS=5 后触发提示=<是/否>，提示文案=<贴实际文案>

Q4 月度趋势 + 坏bin频率
  多月卡 cardId=<...>：cardTrend 是否正确按月列出=<是/否>，数字核对=<一致/不一致>
  单月卡 cardId=<...>：确认未出现在 cardTrend=<是/否>
  坏bin Top3 核对 cardId=<...>：<一致/不一致，具体说明>
  时区问题：是否发现UTC月份分桶导致的边界差异=<是/否，具体说明>

Q5 Agent 自然语言路由
  4句问法各自是否命中新工具=<是/是/是/是 或具体哪句没命中>
  第4句回复是否出现越界的空间坐标措辞=<是/否，若是贴原文>
  无device时是否正确追问=<是/否>

Q6 中断场景良率非负
  是否找到可复现场景=<是/否>
  若找到：良率是否全部≥0=<是/否>

总判：是否发现需要改代码的真实问题？（列出，不要在这份文档里自行改代码）
```

---

## 8. 给 Cursor 的纪律提醒

- **这是一个全新的只读 Agent 工具，没有前端 UI 面板**（v1 范围明确排除，见设计文档 §7）——不需要也不应该去改 `pcr-ai-report`。
- **本次任务是验证，不是改代码。** 如果发现真实 bug（数字不一致、行数保护没触发、路由失败、月度分桶时区问题等），把具体复现步骤 + 数据带回来，交给 Claude Code 定位修复，不要自行改动 `probeCardTesterPerformance.ts` / `agentToolHandlers.ts` / `agentToolSchemas.ts` / `agentPrompt.ts`。
- 临时调整的 `MEMORY_AGG_ORACLE_MAX_ROWS` 等环境变量测完记得还原，不要带进生产配置。
- 不提交 `.claude/settings.local.json`、真实 `.env`、任何密钥。
- 若临时加调试脚本/`console.log` 验证，测完请还原或删除临时文件。
