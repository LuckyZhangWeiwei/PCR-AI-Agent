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
