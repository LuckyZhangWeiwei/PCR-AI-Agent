/**
 * 从线上 API 拉取指定 lot 的全量列表（limit=500），按 jbYieldCalc 输出 slot 1–25。
 * 用法: npx tsx scripts/print-slot-yield-api.ts <LOT>
 */
import { buildSlotYieldSummary } from "../src/lib/jbYieldCalc.js";

const API = process.env.API_BASE ?? "http://10.192.130.89:30008";
const lot = (process.argv[2] ?? process.env.LOT ?? "").trim();
if (!lot) {
  console.error("用法: npx tsx scripts/print-slot-yield-api.ts <LOT>");
  process.exit(1);
}

type Row = Record<string, unknown> & {
  LOT?: string;
  DEVICE?: string;
  SLOT?: number;
};

async function main(): Promise<void> {
  const url = `${API}/api/v4/infcontrol-layer-bins/v4?lot=${encodeURIComponent(lot)}&limit=500`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const body = (await res.json()) as { rows?: Row[]; meta?: unknown };
  const rows = body.rows ?? [];
  const summary = buildSlotYieldSummary(rows);
  const bySlot = new Map(summary.map((s) => [s.slot, s]));
  const device = rows[0]?.DEVICE ? String(rows[0].DEVICE) : "";

  console.log(`LOT: ${lot}${device ? `  DEVICE: ${device}` : ""}`);
  console.log(`API 明细行: ${rows.length}  汇总 slot 数: ${summary.length}`);
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
    const y = s.yieldPct === null ? "—" : s.yieldPct.toFixed(2);
    console.log(
      [slot, s.goodDie, s.grossDie, s.badDie, y, s.rowCount, s.hasInterrupt ? "Y" : ""]
        .join("\t")
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
