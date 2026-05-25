/** 打印指定 lot 若干 slot 的整片/上半/下半良率。用法: npx tsx scripts/print-slot-breakdown.ts <LOT> [slots] */
import { buildSlotYieldSummary } from "../src/lib/jbYieldCalc.js";

const API = process.env.API_BASE ?? "http://10.192.130.89:30008";
const lot = (process.argv[2] ?? "").trim();
const slotArg = process.argv[3] ?? "20-25";
if (!lot) {
  console.error("用法: npx tsx scripts/print-slot-breakdown.ts <LOT> [20-25|22,23]");
  process.exit(1);
}

function parseSlots(s: string): number[] {
  if (s.includes("-")) {
    const [a, b] = s.split("-").map(Number);
    const out: number[] = [];
    for (let i = a; i <= b; i++) out.push(i);
    return out;
  }
  return s.split(",").map((x) => Number(x.trim())).filter((n) => n > 0);
}

function fmt(m: { grossDie: number; goodDie: number; badDie: number; yieldPct: number | null }): string {
  const y = m.yieldPct === null ? "—" : `${m.yieldPct.toFixed(2)}%`;
  return `总 ${m.grossDie} / 好 ${m.goodDie} / 坏 ${m.badDie} / ${y}`;
}

async function main(): Promise<void> {
  const slots = parseSlots(slotArg);
  const url = `${API}/api/v4/infcontrol-layer-bins/v4?lot=${encodeURIComponent(lot)}&limit=500`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const rows = ((await res.json()) as { rows?: Record<string, unknown>[] }).rows ?? [];
  const device = rows[0]?.DEVICE ? String(rows[0].DEVICE) : "";
  const summary = buildSlotYieldSummary(rows);
  const bySlot = new Map(summary.map((s) => [s.slot, s]));

  console.log(`LOT: ${lot}${device ? `  DEVICE: ${device}` : ""}\n`);

  for (const slot of slots) {
    const s = bySlot.get(slot);
    if (!s) {
      console.log(`Slot ${slot}: 无数据\n`);
      continue;
    }
    console.log(`Slot ${slot}${s.hasInterrupt ? " [有中断]" : ""}`);
    if (s.hasInterrupt && s.interruptHalf) {
      console.log(`  上半片: ${fmt(s.interruptHalf)}`);
    }
    if (s.hasInterrupt && s.completionHalf) {
      console.log(`  下半片: ${fmt(s.completionHalf)}`);
    }
    console.log(`  整片正片: ${fmt(s)}`);
    console.log("");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
