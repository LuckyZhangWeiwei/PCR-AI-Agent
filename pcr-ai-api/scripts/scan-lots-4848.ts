const API = process.env.API_BASE ?? "http://10.192.130.89:30008";

async function main(): Promise<void> {
  const { buildSlotYieldSummary } = await import("../src/lib/jbYieldCalc.js");
  const lots = await fetch(`${API}/api/v4/agent/filter-values?domain=jb&field=lot&limit=200`)
    .then((r) => r.json())
    .then((j: { values?: string[] }) => j.values ?? [])
    .catch(() => [] as string[]);

  const toScan = lots.length > 0 ? lots.slice(0, 80) : [];
  if (!toScan.length) {
    console.log("no filter-values, scanning recent 500 only");
    const res = await fetch(`${API}/api/v4/infcontrol-layer-bins/v4?limit=500`);
    const body = (await res.json()) as { rows?: Record<string, unknown>[] };
    const byLot = new Map<string, Record<string, unknown>[]>();
    for (const r of body.rows ?? []) {
      const lot = String(r.LOT ?? "").trim();
      if (!lot) continue;
      if (!byLot.has(lot)) byLot.set(lot, []);
      byLot.get(lot)!.push(r);
    }
    for (const [lot, rs] of byLot) await report(lot, rs, buildSlotYieldSummary);
    return;
  }

  for (const lot of toScan) {
    const res = await fetch(
      `${API}/api/v4/infcontrol-layer-bins/v4?lot=${encodeURIComponent(lot)}&limit=500`
    );
    if (!res.ok) continue;
    const body = (await res.json()) as { rows?: Record<string, unknown>[] };
    const rows = body.rows ?? [];
    if (!rows.length) continue;
    const maxGross = Math.max(...rows.map((r) => Number(r.GROSSDIE ?? 0)));
    if (maxGross !== 4848) continue;
    await report(lot, rows, buildSlotYieldSummary);
  }
}

async function report(
  lot: string,
  rows: Record<string, unknown>[],
  buildSlotYieldSummary: (r: Record<string, unknown>[]) => ReturnType<
    typeof import("../src/lib/jbYieldCalc.js").buildSlotYieldSummary
  >
): Promise<void> {
  const summary = buildSlotYieldSummary(rows);
  const s1 = summary.find((s) => s.slot === 1);
  const s3 = summary.find((s) => s.slot === 3);
  if (!s1 || !s3) return;
  console.log(
    lot,
    "slots",
    summary.length,
    "s1",
    s1.yieldPct?.toFixed(2),
    "s3",
    s3.yieldPct?.toFixed(2),
    "rows",
    rows.length
  );
}

main().catch(console.error);
