# site-bin-bylot Lot / Device 聚合 — Claude Code 交接

**日期：** 2026-05-25  
**分支：** `feat/report-ux-dut-bin-agg`（合并前以源码为准）  
**REST：** `GET /api/v1/inf-analysis/site-bin-bylot`（亦 `/api/v3`、`/api/v4`）

---

## 1. 给下一位的一句话

在**不破坏单片 `infPath` 模式**的前提下，同一接口支持 **Lot 级**与 **Device 级** INF 累加（按 `passId` 合并 `dieCount`）。**Device 级生产调用只需 `device` + `passId`**；`probeCardType` 可选，省略时由 JB Oracle 推断唯一卡型。

---

## 2. 三种查询模式

| 模式 | 必填 query | 可选 | `meta.aggregateScope` | 说明 |
| --- | --- | --- | --- | --- |
| **单片** | `infPath`, `passId` | — | `wafer`（或无 scope） | 原有行为；报表 `InfDutDistPanel` 仍用此模式 |
| **Lot** | `device`, `lot`, `passId` | `probeCardType` | `lot` | 无卡型：扫 `{INF_STORAGE_ROOT}/{DEVICE}/{LOT}/` 下全部 `r_1-{slot}`（兼容旧行为）。有卡型：JB `PASSTYPE=TEST` + `CARDID` 前缀匹配后读 INF |
| **Device** | `device`, `passId` | `probeCardType`, `topN` | `device` | **勿传 `lot`**。默认 **`topN=10`**：在 TESTEND 窗内取 **最新 10 个 lot**（`topN` 最大 **50**），再聚合这些 lot 下 wafer。响应 `selectedLots`、`topN`。 |

**INF 只读：** Node `readdir` / `access(R_OK)` + Perl `LoadINF`；无写删。

**路径根：** `INF_STORAGE_ROOT`（默认 `/data/INF`）→ `{root}/{DEVICE}/{LOT}/r_1-{slot}`（`buildInfPath.ts`）。

---

## 3. 生产 URL（Oracle，`10.192.130.89:30008`）

```text
# Device 聚合（常用）
http://10.192.130.89:30008/api/v4/inf-analysis/site-bin-bylot?device=WA03P02G&passId=1

# Device + 显式卡型（JB 存在多种卡时）
http://10.192.130.89:30008/api/v4/inf-analysis/site-bin-bylot?device=WA03P02G&probeCardType=8037&passId=1

# Lot 聚合（无卡型 = 扫 lot 目录全部 slot）
http://10.192.130.89:30008/api/v4/inf-analysis/site-bin-bylot?device=WA03P02G&lot=NF12551.1N&passId=1

# 单片（报表下钻）
http://10.192.130.89:30008/api/v4/inf-analysis/site-bin-bylot?infPath=/data/INF/WA03P02G/NF12551.1N/r_1-3&passId=3
```

**sort 映射：** sort1/2/3 → `passId` 1/3/5。

---

## 4. 实现入口（改功能从这里进）

| 文件 | 职责 |
| --- | --- |
| `pcr-ai-api/src/routes/infAnalysisRoutes.ts` | 路由分支：wafer / lot（有/无 `probeCardType`）/ device |
| `pcr-ai-api/src/lib/outputSiteBinByLot.ts` | Perl 调用、`mergeSiteBinByLotData`、`runOutputSiteBinByLotForLot*`、`runOutputSiteBinByLotForDevice` |
| `pcr-ai-api/src/lib/siteBinByLotWaferResolve.ts` | JB/Dummy 解析 wafer 列表；`inferProbeCardTypeForDeviceScope`；`cardIdMatchesProbeCardType` |
| `pcr-ai-api/src/lib/buildInfPath.ts` | `buildInfPath`, `buildInfLotDir`, `buildInfDeviceDir` |
| `pcr-ai-api/src/lib/outputSiteBinByLotDummy.ts` | Dummy 聚合；`tryResolveSiteBinByLotDummyForDevice` 支持可选 `probeCardType` |
| `pcr-ai-api/src/perlscripts/output_site_bin_bylot.pl` | 单片 Perl；`PASS_TYPE='TEST'` |
| `pcr-ai-api/src/lib/apiManifest.ts` | manifest 条目与 example |
| `pcr-ai-api/test/outputSiteBinByLot.test.ts` | 校验 + 路由 Dummy 测试（含 device 仅 device+passId） |

**上限（env）：**

- Lot：`SITE_BIN_BY_LOT_MAX_WAFERS`（默认 25）
- Device：`SITE_BIN_BY_LOT_MAX_WAFERS_DEVICE`（默认 100）

---

## 5. 响应字段（聚合）

除 `passes[]`（与单片相同：`bin` / `duts[].dut` / `dieCount`）外：

- `waferCount`, `waferSlots`, `waferLots`（device）
- `probeCardType`（传入或推断）
- `skippedInfPaths`（JB 命中但 INF 不可读）
- `meta.aggregateScope`: `"lot"` | `"device"`

---

## 6. 与报表 / Agent 的边界

| 场景 | 做法 |
| --- | --- |
| `InfDutDistPanel`（已实现） | 仅 **单片** `buildInfPath` + `infPath` + `passId` |
| 报表 Lot/Device 级 DUT 图 | **未做**；若做需新 UI，勿占 JB 顶层聚合图 |
| Agent `query_inf_site_bin_by_dut` | **未改**；仍 wafer 级；Device 聚合可将来加新工具或扩参 |

产品模型与 prompt 附录：**[`SITE_BIN_BY_LOT_INTEGRATION.md`](SITE_BIN_BY_LOT_INTEGRATION.md)**。  
可复制 curl：**[`pcr-ai-api/docs/SITE_BIN_BY_LOT_API.md`](../pcr-ai-api/docs/SITE_BIN_BY_LOT_API.md)**。

---

## 7. 修改后必跑

```bash
cd pcr-ai-api
npm run typecheck
npx tsx --test test/outputSiteBinByLot.test.ts
```

发布：`npm run build`（含 `copy-perlscripts`）；主机需 Perl + INFAnalysis。

---

## 8. 交接检查清单

- [ ] 已读本文 + `pcr-ai-api/CLAUDE.md` §6 / §11.7 + `SITE_BIN_BY_LOT_API.md` §2
- [ ] 改路由时同步 **Oracle 路径 + Dummy 路径**（`outputSiteBinByLotDummy.ts`）
- [ ] 改 JB 过滤时同步 **`siteBinByLotWaferResolve.ts`** 与 **`infcontrolLayerBinDummy`**
- [ ] 未破坏 `infPath` 单片与 `InfDutDistPanel`
- [ ] 更新 **`apiManifest.ts`** example（若改 query 语义）
- [ ] `npm test` / `outputSiteBinByLot.test.ts` 通过

---

*与 `SITE_BIN_BY_LOT_INTEGRATION.md`（wafer 级产品/Agent）互补；冲突以源码为准。*
