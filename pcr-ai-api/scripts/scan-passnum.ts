/** 扫描 lot 内同 slot+passId 多行。用法: npx tsx scripts/scan-passnum.ts <LOT> */
const API = process.env.API_BASE ?? "http://10.192.130.89:30008";
const lot = (process.argv[2] ?? "").trim();
if (!lot) {
  console.error("用法: npx tsx scripts/scan-passnum.ts <LOT>");
  process.exit(1);
}

async function main(): Promise<void> {
  const url = `${API}/api/v4/infcontrol-layer-bins/v4?lot=${encodeURIComponent(lot)}&limit=500`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const rows = ((await res.json()) as { rows?: Record<string, unknown>[] }).rows ?? [];
  const by = new Map<string, Record<string, unknown>[]>();
  for (const x of rows) {
    const k = `${x.SLOT}|${x.PASSID}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(x);
  }
  for (const [k, rs] of [...by.entries()].filter(([, r]) => r.length > 1).sort()) {
    console.log(
      k,
      rs.map((x) => ({
        PASSNUM: x.PASSNUM,
        PASSTYPE: x.PASSTYPE,
        GROSS: x.GROSSDIE,
        TESTEND: String(x.TESTEND ?? "").slice(0, 19),
      }))
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
