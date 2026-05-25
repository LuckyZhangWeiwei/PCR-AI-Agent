// pcr-ai-api/src/lib/agent/agentJbBinFormat.ts
/** Agent 工具回传：与 aggregate_jb_bins 的 bin/count 语义对齐，避免 n/value 被模型对调。 */

import {
  buildSlotYieldSummary,
  slotYieldSummaryFieldGuide,
} from "../jbYieldCalc.js";

export type AgentJbBinEntry = {
  bin: number;
  dieCount: number;
  isGoodBin: boolean;
};

const BIN_SCHEMA_HINT =
  "每条: bin=BINDie编号(通常较小), dieCount=该BIN的die颗数(可很大); 禁止写成 BIN{dieCount} {bin}颗";

export function normalizeBinsForAgent(bins: unknown): AgentJbBinEntry[] {
  if (!Array.isArray(bins)) return [];
  const out: AgentJbBinEntry[] = [];
  for (const item of bins) {
    if (item == null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const binRaw = row["bin"] ?? row["n"] ?? row["binNumber"];
    const countRaw = row["dieCount"] ?? row["count"] ?? row["value"];
    const bin = Number(binRaw);
    const dieCount = Number(countRaw);
    if (!Number.isFinite(bin) || !Number.isFinite(dieCount)) continue;
    out.push({
      bin,
      dieCount,
      isGoodBin: Boolean(row["isGoodBin"] ?? row["isGood"]),
    });
  }
  out.sort((a, b) => a.bin - b.bin);
  return out;
}

/** 将 query_jb_bins 行内的 bins[] 改为 badBins / goodBins（bin + dieCount）。 */
export function formatJbRowsForAgent(
  rows: Record<string, unknown>[]
): Record<string, unknown>[] {
  return rows.map((row) => {
    const { bins: _bins, ...rest } = row;
    const all = normalizeBinsForAgent(_bins);
    const badBins = all.filter((b) => !b.isGoodBin);
    const goodBins = all.filter((b) => b.isGoodBin);
    return { ...rest, badBins, goodBins } as Record<string, unknown>;
  });
}

export function wrapJbQueryResultForAgent(
  rows: Record<string, unknown>[]
): Record<string, unknown> {
  const slotSet = new Set<number>();
  for (const r of rows) {
    const v = r["SLOT"] ?? r["slot"];
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) slotSet.add(n);
  }
  const distinctSlots = [...slotSet].sort((a, b) => a - b);
  const slotYieldSummary = buildSlotYieldSummary(rows);
  return {
    _binFieldGuide: BIN_SCHEMA_HINT,
    _slotYieldGuide: slotYieldSummaryFieldGuide(),
    count: rows.length,
    distinctSlots,
    slotYieldSummary,
    rows: formatJbRowsForAgent(rows),
  };
}
