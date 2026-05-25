/** 在 API 上扫描近期 JB 列表，找出 slot1≈96.16% 且 slot3≈94.91% 的 lot */
const API = process.env.API_BASE ?? "http://10.192.130.89:30008";
const PREFIX = "/api/v4/infcontrol-layer-bins/v4";

type Row = {
  LOT?: string;
  SLOT?: number;
  GROSSDIE?: number;
  bins?: Array<{ n: number; value: number; isGoodBin: boolean }>;
};

async function main(): Promise<void> {
  const url = `${API}${PREFIX}?limit=500`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const body = (await res.json()) as { rows?: Row[] };
  const rows = body.rows ?? [];
  const { buildSlotYieldSummary } = await import("../src/lib/jbYieldCalc.js");

  const byLot = new Map<string, Row[]>();
  for (const r of rows) {
    const lot = String(r.LOT ?? "").trim();
    if (!lot) continue;
    if (!byLot.has(lot)) byLot.set(lot, []);
    byLot.get(lot)!.push(r);
  }

  const ranked: Array<{ lot: string; slotCount: number; rows: number }> = [];
  for (const [lot, rs] of byLot) {
    const summary = buildSlotYieldSummary(rs as Record<string, unknown>[]);
    ranked.push({ lot, slotCount: summary.length, rows: rs.length });
    const s1 = summary.find((s) => s.slot === 1);
    const s3 = summary.find((s) => s.slot === 3);
    if (!s1 || !s3 || s1.yieldPct == null || s3.yieldPct == null) continue;
    const m1 = Math.abs(s1.yieldPct - 96.16) < 0.08;
    const m3 = Math.abs(s3.yieldPct - 94.91) < 0.08;
    const g1 = s1.grossDie === 4848;
    const g3 = s3.grossDie === 4848;
    if (m1 && m3 && g1 && g3) {
      console.log("CANDIDATE", lot, "s1", s1, "s3", s3, "slots", summary.length);
    }
  }
  ranked.sort((a, b) => b.slotCount - a.slotCount || b.rows - a.rows);
  console.log("TOP_LOTS", ranked.slice(0, 15));
  console.log("rows", rows.length, "lots", byLot.size);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
