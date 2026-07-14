import {
  type InfcontrolLayerBinDummyRow,
  type InfcontrolLayerBinDummyAggregateGroup,
  getInfcontrolLayerBinDummyRows,
  forEachBadBinDieContribution,
  valueForInfcontrolDimension,
} from "./infcontrolLayerBinDummy.js";
import {
  INFCONTROL_LAYER_BIN_AGGREGATE_KEY_SEP,
  type InfcontrolLayerBinGroupBy,
} from "./infcontrolLayerBinAggregate.js";
import { INFCONTROL_LAYER_BIN_TOP } from "./infcontrolLayerBinFilters.js";
import { probeCardTypeLeadingSegment } from "../probeCardTypeLeadingSegment.js";
import { deviceBaseMask, deviceMatchesMask } from "../deviceMask.js";
import { infcontrolLayerBinV3PasstypeMatches } from "../infcontrolLayerBinPasstypeScope.js";
import { rowMatchesInfcontrolBinColumnFilters } from "../infcontrolBinColumnFilters.js";

/** v3：与 `parseInfcontrolLayerBinsV3Query` 的 applied 键一致；**PASSTYPE=TEST**；字符串等价 Oracle **`UPPER(TRIM)`**（Dummy 内用 trim + toUpperCase）。每行附 **`PROBECARDTYPE`**（与列表 / 聚合维度同源）。 */
export function filterInfcontrolLayerBinV3DummyRowsMatching(
  applied: Record<string, unknown>
): Array<InfcontrolLayerBinDummyRow & { PROBECARDTYPE: string | null }> {
  let rows = [...getInfcontrolLayerBinDummyRows()].filter((r) => {
    return (
      infcontrolLayerBinV3PasstypeMatches(r.PASSTYPE) &&
      String(r.LAYERNAME ?? "").trim().toUpperCase() !== "ABANDONED" &&
      !["kk", "gg", "c"].some((pfx) =>
        String(r.LOT ?? "").trim().toLowerCase().startsWith(pfx)
      )
    );
  });

  const ci = (col: string, param: string) => {
    const v = applied[param];
    if (v === undefined) return;
    const want = String(v).trim().toUpperCase();
    rows = rows.filter((r) => String(r[col]).trim().toUpperCase() === want);
  };

  ci("DEVICE", "device");
  ci("LOT", "lot");
  ci("MESLOT", "meslot");
  ci("TESTERID", "testerId");
  ci("TSTYPE", "tstype");
  ci("CARDID", "cardId");

  if (applied.mask !== undefined) {
    const want = String(applied.mask).trim().toUpperCase();
    rows = rows.filter((r) => deviceMatchesMask(r.DEVICE, want));
  }

  if (applied.probeCardType !== undefined) {
    const want = String(applied.probeCardType).trim().toUpperCase();
    rows = rows.filter((r) => {
      const cid = String(r.CARDID).trim().toUpperCase();
      return cid === want || cid.startsWith(want + "-");
    });
  }

  if (applied.slot !== undefined) {
    const n = Number(applied.slot);
    rows = rows.filter((r) => Number(r.SLOT) === n);
  }
  if (applied.passId !== undefined) {
    const n = Number(applied.passId);
    rows = rows.filter((r) => Number(r.PASSID) === n);
  }

  const tsLo = applied.testStartBegin ?? applied.testStartFrom;
  const tsHi = applied.testStartEnd ?? applied.testStartTo;
  const teLo = applied.testEndBegin ?? applied.testEndFrom;
  const teHi = applied.testEndEnd ?? applied.testEndTo;

  if (tsLo !== undefined || tsHi !== undefined || teLo !== undefined || teHi !== undefined) {
    // Dummy data has fixed historical timestamps. Shift filter bounds so that
    // relative queries like "last 7 days" always hit data in dummy mode.
    const maxTs = rows.reduce(
      (m, r) => Math.max(m, new Date(String(r.TESTEND)).getTime()), 0
    );
    const offset = maxTs > 0 ? Date.now() - maxTs : 0;
    if (tsLo !== undefined) {
      const from = new Date(String(tsLo)).getTime() - offset;
      rows = rows.filter((r) => new Date(String(r.TESTSTART)).getTime() >= from);
    }
    if (tsHi !== undefined) {
      const to = new Date(String(tsHi)).getTime() - offset;
      rows = rows.filter((r) => new Date(String(r.TESTSTART)).getTime() <= to);
    }
    if (teLo !== undefined) {
      const from = new Date(String(teLo)).getTime() - offset;
      rows = rows.filter((r) => new Date(String(r.TESTEND)).getTime() >= from);
    }
    if (teHi !== undefined) {
      const to = new Date(String(teHi)).getTime() - offset;
      rows = rows.filter((r) => new Date(String(r.TESTEND)).getTime() <= to);
    }
  }

  rows = rows.filter((r) => rowMatchesInfcontrolBinColumnFilters(r, applied));

  return rows.map((r) => ({
    ...r,
    PROBECARDTYPE: probeCardTypeLeadingSegment(r.CARDID),
    MASK: deviceBaseMask(r.DEVICE),
  }));
}

/** v3 列表 Dummy：在 **`filterInfcontrolLayerBinV3DummyRowsMatching`** 结果上排序，再 **`limit`** 截断（**`PROBECARDTYPE`** 已在 matching 阶段写入）。 */
export function filterInfcontrolLayerBinV3DummyRows(
  applied: Record<string, unknown>,
  limit: number
): Array<InfcontrolLayerBinDummyRow & { PROBECARDTYPE: string | null }> {
  let rows = filterInfcontrolLayerBinV3DummyRowsMatching(applied);
  rows.sort((a, b) => {
    const tb = new Date(String(b.TESTEND)).getTime();
    const ta = new Date(String(a.TESTEND)).getTime();
    if (tb !== ta) return tb - ta;
    if (Number(b.SLOT) !== Number(a.SLOT)) return Number(b.SLOT) - Number(a.SLOT);
    if (Number(b.PASSID) !== Number(a.PASSID))
      return Number(b.PASSID) - Number(a.PASSID);
    return Number(b.PASSNUM) - Number(a.PASSNUM);
  });
  const cap =
    Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : INFCONTROL_LAYER_BIN_TOP;
  return rows.slice(0, cap);
}

/**
 * 在**已筛选**的行集上执行与 **`/infcontrol-layer-bins/v3/aggregate`** Dummy / Oracle **`v3-hyphen-tokens`** 等价的坏-bin **SUM**（**`forEachBadBinDieContribution`**）。
 * 行须仍含顶层 **`BINn`** 与 **`PASSBIN`**（未经过 **`enrichInfcontrolLayerBinRowV2`** 剥离 BIN 列）。
 */
export function aggregateInfcontrolLayerBinV3FromRows(
  rows: InfcontrolLayerBinDummyRow[],
  groupBy: InfcontrolLayerBinGroupBy[],
  groupTop: number
): {
  totalRowsMatching: number;
  groups: InfcontrolLayerBinDummyAggregateGroup[];
} {
  const sums = new Map<string, number>();
  const firstParts = new Map<string, Record<string, string>>();

  for (const row of rows) {
    forEachBadBinDieContribution(row, (binIdx, add) => {
      const parts: Record<string, string> = {};
      for (const d of groupBy) {
        if (d === "bin") {
          parts[d] = String(binIdx);
        } else {
          parts[d] = valueForInfcontrolDimension(row, d);
        }
      }
      if (groupBy.includes("device")) {
        parts["mask"] = deviceBaseMask(String(row.DEVICE ?? "")) ?? "";
      }
      const key = groupBy
        .map((d) => parts[d])
        .join(INFCONTROL_LAYER_BIN_AGGREGATE_KEY_SEP);
      sums.set(key, (sums.get(key) ?? 0) + add);
      if (!firstParts.has(key)) {
        firstParts.set(key, parts);
      }
    });
  }

  const groups = [...sums.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, groupTop)
    .map(([key, count]) => ({
      key,
      count,
      parts: firstParts.get(key) ?? {},
    }));

  return { totalRowsMatching: rows.length, groups };
}

/** v3 聚合 Dummy：与 Oracle **`v3-hyphen-tokens`** 及 **`forEachBadBinDieContribution`**（同 v2 top-bad-bins dummy）一致。 */
export function aggregateInfcontrolLayerBinV3DummyRows(
  applied: Record<string, unknown>,
  groupBy: InfcontrolLayerBinGroupBy[],
  groupTop: number
): {
  totalRowsMatching: number;
  groups: InfcontrolLayerBinDummyAggregateGroup[];
} {
  return aggregateInfcontrolLayerBinV3FromRows(
    filterInfcontrolLayerBinV3DummyRowsMatching(applied),
    groupBy,
    groupTop
  );
}
