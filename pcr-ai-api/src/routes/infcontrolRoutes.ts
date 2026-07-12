import { Router } from "express";
import {
  handleInfcontrolLayerBins,
  handleInfcontrolLayerBinsV2,
  handleInfcontrolLayerBinsV3,
  handleInfcontrolLayerBinsV3Aggregate,
  handleInfcontrolLayerBinsV2TopBadBins,
  handleInfcontrolLayerBinsAggregate,
  handleInfcontrolLayerBinsV4,
  handleInfcontrolLayerBinsV4Aggregate,
  handleInfcontrolLayerBinsV4Combined,
} from "../lib/infcontrol/handlers/infcontrolLayerBinsHandlers.js";

export const infcontrolRouter = Router();

infcontrolRouter.get("/infcontrol-layer-bins", handleInfcontrolLayerBins);

/**
 * **v2** INFCONTROL ⋈ INFLAYERBINLIST（**`KEYNUMBER`**）。精简列；**`PASSBIN`** 为 **`1-2-55`** 形式（`-` 分隔 good bin 下标）；
 * 响应 **`bins`**：`{ value, n, isGoodBin }[]`（仅非空 BIN 列）。**无** `bin*` / **`passBin`** 筛选；**`limit`** 默认 200、上限见响应 **`limitMax`**。
 * 排序：`TESTEND DESC NULLS LAST`，`KEYNUMBER DESC NULLS LAST`。
 */
infcontrolRouter.get("/infcontrol-layer-bins/v2", handleInfcontrolLayerBinsV2);

/**
 * **v3** 层控 + 层 BIN：INFCONTROL ⋈ INFLAYERBINLIST（`PASSTYPE='TEST'`）。**`INFCONTROL_LAYER_BINS_DUMMY=true`**（且非 `dist`/production 强制走库）时走 **`docs/JBStart.xlsx`** 内存样本；否则 **主库 Oracle**。
 * 支持 **`limit`**（默认 200，最大 **`limitMax`**；键名不区分大小写）及 **device, lot, slot, meslot, testerId, tstype, cardId, passId** 与 **TESTSTART / TESTEND** 时间窗。
 * 若请求**未带**任一 **testStart\*** / **testEnd\*** 查询键，服务端追加 **`t2.TESTEND`** 在 **UTC 当前起向前一个日历年**内（与 **`parseInfcontrolLayerBinsV3Query`** 默认一致）。
 * 字符串筛选 Dummy 侧等价 **`UPPER(TRIM)`**（trim + 大小写不敏感）。行形状与 **v2** 一致，并多 **`PROBECARDTYPE`**（**`CARDID`** 按首个 **`-`** 拆出的前段）。
 */
infcontrolRouter.get("/infcontrol-layer-bins/v3", handleInfcontrolLayerBinsV3);

/**
 * **v3 层控 BIN 聚合**：与 **`/infcontrol-layer-bins/v3`** 相同筛选语义。**SUM** 仅累计 **坏 bin** die：与 v3 列表 **`bins[].isGoodBin`** 一致。**Dummy** 在 Node 内聚合；**Oracle** 在库内 **UNPIVOT + SUM**（**`v3-hyphen-tokens`** good-bin 规则）。无 **`MEMORY_AGG_ORACLE_MAX_ROWS`** 上限（与 v4 内存聚合不同）。
 * 响应体含 **`documentation`**。详见 manifest 与 **`docs/AI_AGENT_API.md`**。
 */
infcontrolRouter.get(
  "/infcontrol-layer-bins/v3/aggregate",
  handleInfcontrolLayerBinsV3Aggregate
);

/**
 * 与 **infcontrol-layer-bins/v2** 相同 **WHERE**（无列表 **`limit`**）：对匹配全表按行用 **PASSBIN**（`-` 分隔 good bin）
 * 判定 bad，对每个 **BINn** 累计 **SUM**（die 数），返回 bad 合计最高的前 **`rankTop`** 个下标（**5–10**，默认 **10**）。
 */
infcontrolRouter.get(
  "/infcontrol-layer-bins/v2/top-bad-bins",
  handleInfcontrolLayerBinsV2TopBadBins
);

/**
 * 与列表相同筛选（device、lot、slot、tstype、cardId、testEndFrom/To 等）；对 BIN0…BIN255 先 UNPIVOT 再 SUM，
 * 取合计最大的 Top **groupTop** 个 BIN（默认 groupBy=`bin`；可选复合维度见 manifest）。
 * **BIN1**（硬良品）列不计入 SUM；**PASSBIN** 为 **N-M** 时两端 BIN 列亦不计入（与 **passBinPair** 一致）。
 */
infcontrolRouter.get(
  "/infcontrol-layer-bins/aggregate",
  handleInfcontrolLayerBinsAggregate
);

/**
 * **v4** 层控列表：筛选 / 排序 / **`limit`** 与 **v3** 相同；**`meta.apiVersion`** 为 **`"4"`**。
 */
infcontrolRouter.get("/infcontrol-layer-bins/v4", handleInfcontrolLayerBinsV4);

/**
 * **v4 层控 BIN 聚合**：**`groupBy` / `groupTop`** 与 v3 相同；在**与 v4 列表同一套筛选**下先 **COUNT** 匹配行（超过 **`MEMORY_AGG_ORACLE_MAX_ROWS`** 则 **422**），再拉全量行（无 **`FETCH FIRST`**）在 Node 内 **SUM**。
 */
infcontrolRouter.get(
  "/infcontrol-layer-bins/v4/aggregate",
  handleInfcontrolLayerBinsV4Aggregate
);

/**
 * **v4 层控合并查询**：一次 Oracle 查询（top N 明细行）同时返回 **rows**（展示用）与
 * **aggregates**（各维度在 top N 行上的内存聚合）。
 * 聚合在 Node 内对原始行（含 BIN0…BIN255）完成；展示行在聚合后 enrich（BIN 列已剥离）。
 * 无 MEMORY_AGG_ORACLE_MAX_ROWS 限制（固定 top N，不拉全量行）。
 * `aggregates[x].totalRowsMatching` 等于本次 **top N 拉取的行数**，非 Oracle 全量匹配行数（与列表共用同一批数据，语义一致）。
 */
infcontrolRouter.get(
  "/infcontrol-layer-bins/v4/combined",
  handleInfcontrolLayerBinsV4Combined
);
