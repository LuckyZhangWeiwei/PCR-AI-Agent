# Claude Code 交接：mask 多 lot 良率/中断误算 + Agent 会话缓存 + pivot 简表

**分支：** `feat/agent-improvements`  
**读者：** Claude Code / Cursor Agent 接手 JB Agent 良率、mask 查询、确定性表时优先阅读。  
**前置文档：** [`HANDOFF_JB_INTERRUPT_YIELD.md`](HANDOFF_JB_INTERRUPT_YIELD.md)（半片规则）、[`HANDOFF_AGENT_JB_DETERMINISTIC_SUMMARY.md`](HANDOFF_AGENT_JB_DETERMINISTIC_SUMMARY.md)（服务端直出表）

**术语：** JB 字段 **`slot`** = **waferId**；对用户回复用 waferId，API 仍传 `slot`。

---

## 1. 背景：用户反馈与错误会话

| 会话 / 场景 | 现象 |
| --- | --- |
| `mqc531re`（mask N94W） | `get_filter_values` / `query_jb_bins` 返回 0 行后仍吐出 NF13136 整批表；简表用整片合并而非首段 TEST |
| `mqd4sram`（mask **P11C**） | TR22422.1J：**25 片全有中断**、pass1 **90.57%**、后半段 **8190 die**；与 Oracle 实测不符 |
| NF13137.1H | TEST+RETESTBIN 被当中断分段（已在 `0682f24` 修复） |

**P11C 根因（本批核心）：** `query_jb_bins(mask:P11C, …)` 一次返回 **多个 lot**（例：182 行 / 7 lot）。`buildSlotYieldSummary` 原按 **`(slot, passId)`** 分组，**未带 `lot`**，把不同 lot 的同名 slot 当成同一片 wafer 的多次续测 → 假中断、假 8190 die 后半段、`yieldByPassId` 跨 lot 累加出 **90.57%**。

**Oracle 实测 TR22422.1J（`lot=TR22422.1J`）：**

- pass1 **23 片**，批次良率约 **92.25%**
- 真中断仅 **slot 11 / 12 / 21**（中断次数 2 / 1 / 1）
- slot1：**92.67%**，**无中断**

---

## 2. 本批修复（未部署前请 `git pull` + `pm2 reload`）

### 2.1 分组键含 `lot`（`jbYieldCalc.ts`）

- `slotPassGroupKey(lot, slot, passId)` — 禁止跨 lot 合并
- `SlotYieldSummaryEntry` 增加可选 **`lot`**
- `lotFromJbRow()` 辅助函数
- 单测：`does not merge rows from different lots into fake interrupt`

### 2.2 mask / 多 lot 查询：良率表仅 primary lot（`agentJbBinFormat.ts`）

- `rowsForYieldAggregates()`：`distinctLotCount > 1` 且非 `lotScopedFullRows` 时，**良率/中断/探针卡/BIN 警示** 只用 **primary lot**（`rows[0]` 的 LOT，即 TESTEND DESC 最新批）
- `multiLotYieldScope: true` + `_multiLotYieldScopeGuide` 写入工具 JSON
- `recentLotsByTestEnd` / `lotYieldRankByTestEnd` / `testerByLot` 仍用**全量行**（列全部 lot）
- mask 多 lot 时也生成 `lotYieldOverviewMarkdown`（仅 primary lot 的表）

### 2.3 空查询不清缓存、简表用首段 TEST（`484ce92`，已推送）

| 项 | 说明 |
| --- | --- |
| `storeJbQuerySessionCache` | `count=0` 时 `clearJbToolRawJson`，禁止空 mask 查询后直出旧 lot 表 |
| `jbWrappedIsEmptyQuery` | 确定性表 guard |
| `slotPivotDisplayMetrics` | 有中断时简表用 **`interruptHalf`**（首段 TEST），整片见中断明细表 |
| `AGENT_JB_CACHE_VERSION` | **5**（`GET /health` → `agentJbCacheVersion`） |

### 2.4 pivot 简表 UI（`agentJbHistoryCompact.ts`）

- 多 pass 时不再只输出 `!hasInterrupt` 的片（曾导致只显示 pass2 slot5）
- 始终输出完整 `formatSlotYieldPivotMarkdown(..., summary)`，单列/多列均走 `pivotCellFromSummary` → `interruptHalf`

### 2.5 NF13137 / RETESTBIN（`0682f24`）

- 单次 TEST + RETESTBIN → **不**分段；良率取满片 TEST 行
- 见 `jbYieldCalc.test.ts` `NF13137 pattern`

### 2.6 mask / device 解析（`d2fa8e2` / `213a8a9`）

- `get_filter_values(domain:both, mask:…)` 合并 Yield+JB device
- `query_jb_bins` / v3/v4 列表支持 `mask` 参数（`deviceMaskOracleWhere`）

---

## 3. 良率分组规则（更新后）

| 场景 | 分组键 | 备注 |
| --- | --- | --- |
| 单 lot 查询 `query_jb_bins(lot, …)` | `(lot, slot, passId)` | `lotScopedFullRows: true`，拉全量行 |
| mask/device 多 lot | 汇总用 **primary lot 行子集**；`slotYieldSummary` 内仍 `(lot,slot,passId)` | 读 `recentLotsByTestEnd` 列其它 lot |
| 中断判定 | 同 **lot** 内同 (slot, passId) | 见 `HANDOFF_JB_INTERRUPT_YIELD.md` |
| 简表良率 | 有中断 → **`interruptHalf`** | 明细表：前半→后半→整片 |

---

## 4. 验证

### 4.1 单测

```bash
cd pcr-ai-api
npm test
# 重点：test/jbYieldCalc.test.ts、test/agentJbBinFormat.test.ts（multi-lot scope）
```

### 4.2 无 LLM 模拟（推荐）

```bash
cd pcr-ai-api
npm run build
node scripts/simulate-agent-p11c-mask.mjs
# 可选问题：node scripts/simulate-agent-p11c-mask.mjs "P11C 的测试情况"
```

**通过标准（P11C / TR22422.1J）：**

- pass1 批次良率 **> 91%**（非 90.57%）
- 中断片 **≤ 5**（约 11/12/21）
- 无「后半段 8190 die」
- 各片良率简表含 **pass1 slot1 ~92%**

### 4.3 生产 API 抽样

```bash
curl "http://10.192.130.89:30008/health"
# agentJbCacheVersion 部署本批后仍为 5；逻辑变更靠 git 版本

curl "http://10.192.130.89:30008/api/v4/infcontrol-layer-bins/v4?lot=TR22422.1J&limit=5"
curl "http://10.192.130.89:30008/api/v4/infcontrol-layer-bins/v4?mask=P11C&testEndFrom=2026-05-31&limit=200"
```

```bash
npx tsx scripts/print-lot-slot-yield.ts TR22422.1J WB01P11C tmp-tr22422.json
```

### 4.4 部署

```bash
cd pcr-ai-api
git pull
npm ci && npm run build && npm run pm2:reload
```

---

## 5. 已知未决 / 可选后续

- [ ] **`get_filter_values(mask:P11C)` 返回空**，但 `query_jb_bins(mask:P11C)` 有数据（WB01P11C）— 需查 `agentFilterValuesTool.ts` Oracle `deviceByMask` 与 JB 列表 filter 是否一致（默认一年 TESTEND 窗口？）
- [ ] mask 概览类问题：prompt 是否应**优先** `recentLotsByTestEnd` 列表，而非只展开 primary lot 的 25 片表
- [ ] `buildJbSessionCacheJson` 是否持久化 `multiLotYieldScope` / `distinctLotCount`（当前 `resolveJbToolPayload` 从 cache 可能缺字段，模拟脚本用 `wrapped` 校验）
- [ ] 报表侧 `yieldCalc.ts` 仍未暴露 `interruptHalf`（见 `HANDOFF_JB_INTERRUPT_YIELD.md` §8）

---

## 6. 改动文件清单（本 commit）

| 文件 | 变更 |
| --- | --- |
| `pcr-ai-api/src/lib/jbYieldCalc.ts` | `lot` 分组键、`lotFromJbRow`、`slotPivotDisplayMetrics`（前批） |
| `pcr-ai-api/src/lib/agent/agentJbBinFormat.ts` | `rowsForYieldAggregates`、`storeJbQuerySessionCache`、multiLot 提示 |
| `pcr-ai-api/src/lib/agent/agentJbHistoryCompact.ts` | pivot 简表、overview 标题简化 |
| `pcr-ai-api/src/lib/agent/agentLoop.ts` | 缓存 wiring、空查询 guard（`484ce92`） |
| `pcr-ai-api/src/lib/agent/agentJbDeterministicReply.ts` | `jbWrappedIsEmptyQuery` guard |
| `pcr-ai-api/test/jbYieldCalc.test.ts` | 跨 lot / RETESTBIN 断言 |
| `pcr-ai-api/test/agentJbBinFormat.test.ts` | multi-lot scope 回归 |
| `pcr-ai-api/scripts/simulate-agent-p11c-mask.mjs` | 无 LLM 对话模拟 + 断言 |
| `docs/HANDOFF_JB_MULTI_LOT_MASK_YIELD.md` | 本文档 |

**近期 commit 链（`feat/agent-improvements`）：**  
`0682f24` interrupt/RETESTBIN → `484ce92` 空缓存+pivot → **本 commit** multi-lot mask

**入口索引：** 根 [`CLAUDE.md`](../CLAUDE.md) 交接链接表。
