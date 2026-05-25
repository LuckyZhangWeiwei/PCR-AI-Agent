/**
 * 按 jbYieldCalc 逻辑输出 slot 1–25 良率。
 * 用法: LOT=NF12615.1X npx tsx scripts/print-slot-yield.ts
 * 或:   npx tsx scripts/print-slot-yield.ts NF12615.1X
 */
import "../src/loadEnv.js";
import oracledb from "oracledb";
import { parseInfcontrolLayerBinsV3Query } from "../src/lib/infcontrolLayerBinFilters.js";
import { buildInfcontrolLayerBinsV3SqlFullMatching } from "../src/lib/apiV3ListSql.js";
import { enrichInfcontrolLayerBinRowV2 } from "../src/lib/passBinSemantics.js";
import { buildSlotYieldSummary } from "../src/lib/jbYieldCalc.js";
import { withConnection, initOraclePool, closeOraclePool } from "../src/oracle.js";
import {
  filterInfcontrolLayerBinV3DummyRowsMatching,
  infcontrolLayerBinsUseDummy,
} from "../src/lib/infcontrolLayerBinDummy.js";
import { probeCardTypeLeadingSegment } from "../src/lib/probeCardTypeLeadingSegment.js";

const lot = (process.argv[2] ?? process.env.LOT ?? "").trim();
if (!lot) {
  console.error("请提供 lot: LOT=xxx npx tsx scripts/print-slot-yield.ts");
  process.exit(1);
}

function enrichRow(row: Record<string, unknown>): Record<string, unknown> {
  const e = enrichInfcontrolLayerBinRowV2(row);
  return {
    ...e,
    PROBECARDTYPE: probeCardTypeLeadingSegment(e.CARDID ?? e.cardid),
  };
}

async function loadRows(): Promise<Record<string, unknown>[]> {
  const params: Record<string, unknown> = { lot, limit: 500 };
  const parsed = parseInfcontrolLayerBinsV3Query(params);
  if (!parsed.ok) throw new Error(parsed.error);

  if (infcontrolLayerBinsUseDummy()) {
    return filterInfcontrolLayerBinV3DummyRowsMatching(parsed.applied).map((r) =>
      enrichRow(r as Record<string, unknown>)
    );
  }

  const sql = buildInfcontrolLayerBinsV3SqlFullMatching(parsed.whereAndSql);
  await initOraclePool();
  return withConnection(async (conn) => {
    const result = await conn.execute(sql, parsed.binds, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    });
    return ((result.rows ?? []) as Record<string, unknown>[]).map(enrichRow);
  });
}

async function main(): Promise<void> {
  const rows = await loadRows();
  const summary = buildSlotYieldSummary(rows);
  const bySlot = new Map(summary.map((s) => [s.slot, s]));
  const device =
    rows.length > 0 ? String(rows[0]!.DEVICE ?? rows[0]!.device ?? "").trim() : "";

  console.log(`LOT: ${lot}${device ? `  DEVICE: ${device}` : ""}`);
  console.log(`明细行数: ${rows.length}  有数据的 slot: ${summary.length}`);
  console.log("");
  console.log(
    ["Slot", "好Die", "总Die", "坏Die", "良率%", "行数", "中断"].join("\t")
  );
  for (let slot = 1; slot <= 25; slot++) {
    const s = bySlot.get(slot);
    if (!s) {
      console.log([slot, "—", "—", "—", "—", 0, ""].join("\t"));
      continue;
    }
    const y =
      s.yieldPct === null ? "—" : s.yieldPct.toFixed(2);
    console.log(
      [
        slot,
        s.goodDie,
        s.grossDie,
        s.badDie,
        y,
        s.rowCount,
        s.hasInterrupt ? "Y" : "",
      ].join("\t")
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => closeOraclePool().catch(() => {}));
