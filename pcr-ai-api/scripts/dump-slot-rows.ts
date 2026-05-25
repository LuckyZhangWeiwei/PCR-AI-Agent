/** 打印某 lot 某 slot 的原始行。用法: npx tsx scripts/dump-slot-rows.ts <LOT> <SLOT> */
const API = process.env.API_BASE ?? "http://10.192.130.89:30008";
const lot = (process.argv[2] ?? "").trim();
const slot = Number(process.argv[3]);
if (!lot || !Number.isFinite(slot)) {
  console.error("用法: npx tsx scripts/dump-slot-rows.ts <LOT> <SLOT>");
  process.exit(1);
}

async function main(): Promise<void> {
  const url = `${API}/api/v4/infcontrol-layer-bins/v4?lot=${encodeURIComponent(lot)}&limit=500`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const rows = ((await res.json()) as { rows?: Record<string, unknown>[] }).rows ?? [];
  const hit = rows.filter((r) => Number(r.SLOT ?? r.slot) === slot);
  console.log(`rows for ${lot} slot ${slot}: ${hit.length}\n`);
  for (const r of hit.sort((a, b) => Number(a.PASSNUM ?? 0) - Number(b.PASSNUM ?? 0))) {
    const keys = [
      "SLOT",
      "PASSID",
      "PASSNUM",
      "PASSTYPE",
      "GROSSDIE",
      "CARDID",
      "TESTEND",
      "LAYERNAME",
    ];
    const o: Record<string, unknown> = {};
    for (const k of keys) if (r[k] !== undefined) o[k] = r[k];
    console.log(JSON.stringify(o));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
