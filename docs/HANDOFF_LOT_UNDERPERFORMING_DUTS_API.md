# Claude Code 交接：Lot 低良率 DUT 筛选 API

**日期：** 2026-07-01（产品口径确认版）  
**读者：** Claude Code / Cursor Agent  
**前置：** [`SITE_BIN_BY_LOT_INTEGRATION.md`](SITE_BIN_BY_LOT_INTEGRATION.md)、[`pcr-ai-api/docs/SITE_BIN_BY_LOT_API.md`](../pcr-ai-api/docs/SITE_BIN_BY_LOT_API.md)

---

## 1. 产品口径（已确认）

| 决策项 | 结论 |
| --- | --- |
| **lot 平均 yield 基准** | **B — lot 整体良率**：该 pass 全部 DUT 的 `sum(goodDie)/sum(totalDie)`，**不是**各 DUT 算术平均（A），**不是** JB 最差片良率（C） |
| **必填参数** | 仅 **`lot`**；`device`、`probeCardType` 由服务端从 JB STAR 反查 |
| **pass 维度** | **按 pass 分开**；默认 `passId=1,3,5` 各一组 |
| **probeCardType** | 不传；JB 按 lot+pass 取**出现次数最多**的卡型首段，再 JB 过滤 wafer 读 INF |
| **DUT 样本量下限** | **无**（不排除小样本 DUT） |
| **阈值** | **`thresholdRatio` 可配**，默认 **0.75** → `DUT_yield < lotOverall × 0.75` |
| **消费方** | **REST + JB 报表面板 + Agent 工具** |

---

## 2. HTTP

```
GET /api/v4/inf-analysis/lot-underperforming-duts?lot=DR43782.1A
GET /api/v4/inf-analysis/lot-underperforming-duts?lot=DR43782.1A&thresholdRatio=0.8&passId=1
```

| 参数 | 必填 | 默认 |
| --- | --- | --- |
| `lot` | 是 | — |
| `device` | 否 | JB 反查 |
| `passId` | 否 | 1,3,5 |
| `probeCardType` | 否 | JB 反查（ dominant ） |
| `thresholdRatio` | 否 | 0.75 |

响应：`filters.baselineMethod = "lotOverall"`；`passes[].baseline.yieldPct` 为 lot 整体良率；`underperformingDuts[]` 为低于阈值的 DUT。

---

## 3. 源码

| 文件 | 职责 |
| --- | --- |
| `src/lib/lotUnderperformingDuts.ts` | 良率计算、`lotOverall` 基准、markdown 格式化 |
| `src/lib/lotUnderperformingDutsResolve.ts` | JB 反查 device/卡型、INF 取数、`runLotUnderperformingDuts()` |
| `src/routes/infAnalysisRoutes.ts` | REST 路由 |
| `src/lib/agent/agentToolHandlers.ts` | `query_lot_underperforming_duts` |
| `src/lib/agent/agentToolSchemas.ts` | 工具 schema |
| `pcr-ai-report/src/components/LotUnderperformingDutsPanel.tsx` | JB 报表：查询区填 **Lot** 后显示 |
| `pcr-ai-report/src/reports/InfcontrolReport.tsx` | 模块 id `underperformingDuts` |

---

## 4. Agent

工具名：**`query_lot_underperforming_duts`**

- 必填：`lot`
- 可选：`device`、`passId`/`passIds`、`thresholdRatio`
- 返回：前置 `underperformingDutsMarkdown` + JSON（`passes`、`probeCardType` 等）

与 **`query_lot_dut_bin_agg`**：后者是 bad bin **颗数**/集中度；本工具是 **DUT 良率阈值**。

---

## 5. 测试

```bash
cd pcr-ai-api
npm run typecheck
npx tsx --test test/lotUnderperformingDuts.test.ts
```

---

## 6. 部署

```bash
cd pcr-ai-api && npm run build && pm2 reload
cd pcr-ai-report && npm run build   # 含新面板
```

---

## 7. 常见坑

1. **勿与 JB LOT Yield% 混淆** — 报表 LOT 条形图是最差片；本 API 是 **INF DUT 级 + lot 整体基准**。
2. **多 device 同 lot** — 仍须显式传 `device`（400）。
3. **Dummy 联调** — `NODE_ENV=test` 或 `INFCONTROL_LAYER_BINS_DUMMY=true`。
