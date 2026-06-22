// pcr-ai-api/src/lib/agent/agentJbDistinctLots.ts
/** DB-level distinct lot list for multi-lot query_jb_bins (mask/device/cardId, no lot). */
import oracledb from "oracledb";
import { withConnection } from "../../oracle.js";
import { buildInfcontrolLayerBinsV3DistinctLotsSql } from "../apiV3ListSql.js";
import {
  buildRecentLotsByTestEnd,
  type RecentLotByTestEndEntry,
} from "./agentJbBinFormat.js";

export const JB_DISTINCT_LOTS_TOP = 50;

export type JbDistinctLotsResult = {
  lots: RecentLotByTestEndEntry[];
  totalDistinct: number;
};

export function buildDistinctLotsFromMatchingRows(
  rows: Record<string, unknown>[],
  topN = JB_DISTINCT_LOTS_TOP
): JbDistinctLotsResult {
  const totalDistinct = new Set(
    rows
      .map((r) => String(r["LOT"] ?? r["lot"] ?? "").trim())
      .filter(Boolean)
  ).size;
  const lots = buildRecentLotsByTestEnd(rows, topN);
  return { lots, totalDistinct };
}

export async function fetchOracleDistinctLotsForJb(
  whereAndSql: string,
  binds: Record<string, string | number | Date>,
  topN = JB_DISTINCT_LOTS_TOP
): Promise<JbDistinctLotsResult> {
  const sql = buildInfcontrolLayerBinsV3DistinctLotsSql(whereAndSql);
  const dbRows = await withConnection(async (conn) => {
    const result = await conn.execute(
      sql,
      { ...binds, lot_lim: topN },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    return (result.rows ?? []) as Record<string, unknown>[];
  });

  if (dbRows.length === 0) {
    return { lots: [], totalDistinct: 0 };
  }

  const totalDistinct = Number(dbRows[0]!["TOTAL_DISTINCT"] ?? dbRows.length);
  const lots: RecentLotByTestEndEntry[] = dbRows.map((row) => {
    const lot = String(row["LOT"] ?? "").trim();
    const device = String(row["DEVICE"] ?? "").trim();
    const teRaw = row["LAST_TESTEND"];
    const testEnd =
      teRaw instanceof Date
        ? teRaw.toISOString()
        : teRaw != null && String(teRaw).trim() !== ""
          ? String(teRaw)
          : null;
    const slotCount = Number(row["SLOT_COUNT"] ?? 0);
    return {
      lot,
      device,
      cardIds: [],
      hasCardChangeInLot: false,
      cardId: "",
      testEnd,
      slots: [],
      slotCount: Number.isFinite(slotCount) && slotCount > 0 ? slotCount : 0,
    };
  });

  return { lots, totalDistinct };
}
