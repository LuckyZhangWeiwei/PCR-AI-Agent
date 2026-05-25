/** 在近期列表涉及的 lot 上拉满 limit=500，找 ≥23 个 slot 且 max(GROSSDIE)=4848 的批次 */
const API = process.env.API_BASE ?? "http://10.192.130.89:30008";

async function main(): Promise<void> {
  const { buildSlotYieldSummary } = await import("../src/lib/jbYieldCalc.js");
  const seed = await fetch(`${API}/api/v4/infcontrol-layer-bins/v4?limit=500`).then((r) =>
    r.json()
  ) as { rows?: { LOT?: string }[] };
  const lots = [...new Set((seed.rows ?? []).map((r) => String(r.LOT ?? "").trim()).filter(Boolean))];
  console.log("seed lots", lots.length);

  for (const lot of lots) {
    const res = await fetch(
      `${API}/api/v4/infcontrol-layer-bins/v4?lot=${encodeURIComponent(lot)}&limit=500`
    );
    if (!res.ok) continue;
    const body = (await res.json()) as { rows?: Record<string, unknown>[] };
    const rows = body.rows ?? [];
    if (rows.length < 20) continue;
    const maxG = Math.max(...rows.map((r) => Number(r.GROSSDIE ?? 0)));
    const summary = buildSlotYieldSummary(rows);
    if (summary.length < 20 || maxG !== 4848) continue;
    const s1 = summary.find((s) => s.slot === 1);
    const s3 = summary.find((s) => s.slot === 3);
    console.log(
      "FOUND",
      lot,
      "device",
      rows[0]?.DEVICE,
      "rows",
      rows.length,
      "slots",
      summary.length,
      "s1",
      s1?.goodDie,
      s1?.yieldPct?.toFixed(2),
      "s3",
      s3?.goodDie,
      s3?.yieldPct?.toFixed(2)
    );
  }
}

main().catch(console.error);
