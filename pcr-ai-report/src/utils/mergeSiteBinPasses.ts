import type { SiteBinDutEntry, SiteBinEntry, SiteBinPass } from "../api/types";

function dutKey(dut: SiteBinDutEntry["dut"]): string {
  return String(dut);
}

/** Sum dieCount for multiple site-bin-bylot responses (same passId × bin × dut). */
export function mergeSiteBinPasses(passLists: SiteBinPass[][]): SiteBinPass[] {
  const byPass = new Map<
    number,
    Map<string, Map<string, number>>
  >();

  for (const passes of passLists) {
    for (const pass of passes) {
      let binMap = byPass.get(pass.passId);
      if (!binMap) {
        binMap = new Map();
        byPass.set(pass.passId, binMap);
      }
      for (const binEntry of pass.bins) {
        let dutMap = binMap.get(binEntry.bin);
        if (!dutMap) {
          dutMap = new Map();
          binMap.set(binEntry.bin, dutMap);
        }
        for (const d of binEntry.duts) {
          const k = dutKey(d.dut);
          dutMap.set(k, (dutMap.get(k) ?? 0) + d.dieCount);
        }
      }
    }
  }

  const out: SiteBinPass[] = [];
  for (const passId of [...byPass.keys()].sort((a, b) => a - b)) {
    const binMap = byPass.get(passId)!;
    const bins: SiteBinEntry[] = [];
    for (const bin of [...binMap.keys()].sort((a, b) => {
      const na = Number(/^bin(\d+)$/i.exec(a)?.[1] ?? NaN);
      const nb = Number(/^bin(\d+)$/i.exec(b)?.[1] ?? NaN);
      if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
      return a.localeCompare(b);
    })) {
      const dutMap = binMap.get(bin)!;
      const duts: SiteBinDutEntry[] = [...dutMap.entries()]
        .filter(([, dieCount]) => dieCount > 0)
        .map(([dut, dieCount]) => {
          const dutVal: SiteBinDutEntry["dut"] =
            dut === "single"
              ? "single"
              : Number.isFinite(Number(dut))
              ? Number(dut)
              : "single";
          return { dut: dutVal, dieCount };
        })
        .sort((a, b) => {
          if (a.dut === "single") return 1;
          if (b.dut === "single") return -1;
          return Number(a.dut) - Number(b.dut);
        });
      if (duts.length > 0) bins.push({ bin, duts });
    }
    if (bins.length > 0) out.push({ passId, bins });
  }
  return out;
}

/**
 * When site-bin map is empty (no TESTSITELAST / unparseable CLOBs), build
 * pass×bin charts from JB layer bin totals with dut=single.
 */
export function siteBinPassesFromJbFallback(
  wafers: Array<{
    passIds: number[];
    jbFallbackBins?: Array<{ n: number; value: number }>;
  }>
): SiteBinPass[] {
  const byPass = new Map<number, Map<string, number>>();
  for (const w of wafers) {
    const bins = w.jbFallbackBins;
    if (!bins?.length) continue;
    // passIds.length > 1 means PASSID couldn't be resolved from the row (see
    // waferSpecFromJbRow's [1,3,5] fallback) — attributing to passIds[0] would
    // silently mislabel bins that may actually belong to pass3/pass5.
    if (w.passIds.length !== 1) continue;
    const passId = w.passIds[0];
    if (passId === undefined || !Number.isFinite(passId)) continue;
    let binMap = byPass.get(passId);
    if (!binMap) {
      binMap = new Map();
      byPass.set(passId, binMap);
    }
    for (const b of bins) {
      if (!Number.isFinite(b.n) || !Number.isFinite(b.value) || b.value <= 0) {
        continue;
      }
      const label = `bin${b.n}`;
      binMap.set(label, (binMap.get(label) ?? 0) + b.value);
    }
  }
  const out: SiteBinPass[] = [];
  for (const passId of [...byPass.keys()].sort((a, b) => a - b)) {
    const binMap = byPass.get(passId)!;
    const bins: SiteBinEntry[] = [...binMap.entries()]
      .sort((a, b) => {
        const na = Number(/^bin(\d+)$/i.exec(a[0])?.[1] ?? NaN);
        const nb = Number(/^bin(\d+)$/i.exec(b[0])?.[1] ?? NaN);
        if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
        return a[0].localeCompare(b[0]);
      })
      .map(([bin, dieCount]) => ({
        bin,
        duts: [{ dut: "single" as const, dieCount }],
      }));
    if (bins.length > 0) out.push({ passId, bins });
  }
  return out;
}
