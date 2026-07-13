import type { AggregateGroup, InfcontrolLayerBinV3Row } from "../api/types";
import {
  collectGoodBinNumbersFromJbRow,
  collectGoodBinNumbersFromJbRows,
  goodBinNumbersFromDetailRow,
  HARD_GOOD_BIN,
} from "./infGoodBins";

export type InfDutWaferSpec = {
  device: string;
  lot: string;
  slot: number;
  passIds: number[];
  probeCardType: string;
  /** JB 明细行 KEYNUMBER；有值时 site-bin-bylot 按层取 map，不合并同 slot 其它层。 */
  keynumber?: number;
};

export type InfDutAnchor =
  | { source: "detail" }
  | { source: "lotYield" }
  | { source: "binDist" }
  | { source: "chartsGrid"; block: string };

export type InfDutSelectionCtx = {
  wafers: InfDutWaferSpec[];
  device: string;
  lot: string;
  goodBinNumbers: Set<number>;
  focusBin?: string;
  detailListIndices?: number[];
  anchor: InfDutAnchor;
  selectionSummary: string;
};

function waferSpecKey(w: InfDutWaferSpec): string {
  return `${w.device}|${w.lot}|${w.slot}`;
}

function mergePassIdsIntoMap(
  map: Map<string, InfDutWaferSpec>,
  spec: InfDutWaferSpec
): void {
  const key = waferSpecKey(spec);
  const existing = map.get(key);
  if (!existing) {
    map.set(key, { ...spec, passIds: [...spec.passIds] });
    return;
  }
  const set = new Set(existing.passIds);
  for (const p of spec.passIds) set.add(p);
  existing.passIds = [...set].sort((a, b) => a - b);
}

export function collectGoodBinNumbersForWafers(
  rows: InfcontrolLayerBinV3Row[] | undefined,
  wafers: InfDutWaferSpec[]
): Set<number> {
  const good = new Set<number>([HARD_GOOD_BIN]);
  for (const w of wafers) {
    for (const n of collectGoodBinNumbersFromJbRows(
      rows,
      w.device,
      w.lot,
      w.slot,
      w.passIds
    )) {
      good.add(n);
    }
  }
  return good;
}

/** CARDID 首个 `-` 前段兜底，与 API `enrichInfcontrolLayerBinV3ListRow` 注入的 PROBECARDTYPE 口径一致。 */
export function probeCardTypeFromJbRow(row: InfcontrolLayerBinV3Row): string {
  const pct = row.PROBECARDTYPE;
  if (pct !== undefined && pct !== null && String(pct).trim()) return String(pct).trim();
  const cardId = String(row.CARDID ?? "").trim();
  if (!cardId) return "";
  const dash = cardId.indexOf("-");
  return dash > 0 ? cardId.slice(0, dash) : cardId;
}

export function waferSpecFromJbRow(row: InfcontrolLayerBinV3Row): InfDutWaferSpec | null {
  const device = String(row.DEVICE ?? "").trim();
  const lot = String(row.LOT ?? "").trim();
  const slot = Number(row.SLOT);
  if (!device || !lot || !Number.isFinite(slot)) return null;
  const passId = Number(row.PASSID);
  const passIds = Number.isFinite(passId) ? [passId] : [1, 3, 5];
  const probeCardType = probeCardTypeFromJbRow(row);
  const kn = Number(row.KEYNUMBER);
  const keynumber =
    Number.isFinite(kn) && kn > 0 ? Math.trunc(kn) : undefined;
  return { device, lot, slot, passIds, probeCardType, keynumber };
}

export function sameDeviceLot(
  a: { device: string; lot: string },
  b: { device: string; lot: string }
): boolean {
  return a.device === b.device && a.lot === b.lot;
}

/**
 * 明细表多选组内规则：同 Device 前提下，同 LOT（不同 waferId）或同探针卡类型（跨 LOT）皆可加入。
 * 以组内首行为锚点比较，与既有单锚点校验风格一致。
 */
export function canJoinDutSelectionGroup(
  anchor: { device: string; lot: string; probeCardType: string },
  candidate: { device: string; lot: string; probeCardType: string }
): boolean {
  if (anchor.device !== candidate.device) return false;
  if (anchor.lot === candidate.lot) return true;
  return Boolean(anchor.probeCardType) && anchor.probeCardType === candidate.probeCardType;
}

/** Detail table: multi-row selection — each row is one JB layer; overlay only when multiple selected. */
export function buildInfDutCtxFromDetailListIndices(
  indices: Iterable<number>,
  listRows: InfcontrolLayerBinV3Row[] | undefined,
  anchor: InfDutAnchor
): InfDutSelectionCtx | null {
  const indexList = [...indices];
  if (indexList.length === 0 || !listRows?.length) return null;

  const wafers: InfDutWaferSpec[] = [];
  const goodBinNumbers = new Set<number>([HARD_GOOD_BIN]);
  const lots = new Set<string>();
  let device = "";
  let lot = "";
  let probeCardType = "";

  for (const idx of indexList) {
    const row = listRows[idx];
    if (!row) continue;
    const spec = waferSpecFromJbRow(row);
    if (!spec) continue;
    if (!device) {
      device = spec.device;
      lot = spec.lot;
      probeCardType = spec.probeCardType;
    } else if (!canJoinDutSelectionGroup({ device, lot, probeCardType }, spec)) {
      return null;
    }
    lots.add(spec.lot);
    wafers.push(spec);
    for (const n of collectGoodBinNumbersFromJbRow(row)) goodBinNumbers.add(n);
    const extra = goodBinNumbersFromDetailRow(
      row as unknown as Record<string, unknown>
    );
    if (extra) for (const n of extra) goodBinNumbers.add(n);
  }

  if (!wafers.length || !device || !lot) return null;

  const slots = [...new Set(wafers.map((w) => w.slot))].sort((a, b) => a - b).join(", ");
  const lotLabel = lots.size > 1 ? `${lots.size} 个 LOT` : `LOT ${lot}`;
  const layerLabel =
    wafers.length === 1 ? "1 层" : `${wafers.length} 层（叠加）`;
  return {
    wafers,
    device,
    lot: lots.size > 1 ? [...lots].join(",") : lot,
    goodBinNumbers,
    detailListIndices: indexList,
    anchor,
    selectionSummary: `${layerLabel} · ${lotLabel} · Slot ${slots}`,
  };
}

export function parseSlotFromDrillBarLabel(clickedKey: string): number | null {
  const t = clickedKey.trim();
  const m = /\bslot\s*(\d+)/i.exec(t);
  if (m) return parseInt(m[1], 10);
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : null;
}

export function parseSlotFromDrillClick(
  clickedKey: string,
  drillGroups: AggregateGroup[]
): number | null {
  const fromLabel = parseSlotFromDrillBarLabel(clickedKey);
  if (fromLabel !== null) return fromLabel;
  const g = drillGroups.find((x) => x.key === clickedKey);
  if (g?.parts?.slot !== undefined) {
    const n = Number(g.parts.slot);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function normalizeBinToken(raw: string): string {
  return raw.replace(/^bin\s*/i, "").trim();
}

function rowMatchesBinFilter(
  row: InfcontrolLayerBinV3Row,
  binToken: string | undefined
): boolean {
  if (!binToken) return true;
  for (const c of row.bins ?? []) {
    if (String(c.n) === binToken && (c.value ?? 0) > 0 && !c.isGoodBin) return true;
  }
  return false;
}

function resolveDeviceLotFromListRows(
  rows: InfcontrolLayerBinV3Row[] | undefined,
  slot: number,
  binFilter: string | undefined,
  requiredLot: string
): Pick<InfDutWaferSpec, "device" | "lot" | "passIds"> | null {
  if (!rows?.length) return null;
  const binToken = binFilter ? normalizeBinToken(binFilter) : undefined;
  const lotNeed = requiredLot.trim();
  for (const r of rows) {
    if (Number(r.SLOT) !== slot) continue;
    if (lotNeed && String(r.LOT ?? "").trim() !== lotNeed) continue;
    if (!rowMatchesBinFilter(r, binToken)) continue;
    const device = String(r.DEVICE ?? "").trim();
    const lot = String(r.LOT ?? "").trim();
    if (!device || !lot) continue;
    const passIds =
      r.PASSID !== undefined && r.PASSID !== null && Number.isFinite(Number(r.PASSID))
        ? [Number(r.PASSID)]
        : [1, 3, 5];
    return { device, lot, passIds };
  }
  return null;
}

export function buildInfDutCtxFromDrillBarKeys(
  opts: {
    parentDimKey: string;
    parentDimVal: string;
    subDim: string;
    selectedKeys: Iterable<string>;
    drillGroups: AggregateGroup[];
    formLot: string;
    formDevice: string;
    formPassId: string;
    listRows: InfcontrolLayerBinV3Row[] | undefined;
    anchor: InfDutAnchor;
  }
): InfDutSelectionCtx | null {
  const lot = opts.formLot.trim();
  if (!lot || opts.subDim !== "slot") return null;

  const binFilter = opts.parentDimKey === "bin" ? opts.parentDimVal : undefined;
  const focusBin =
    opts.parentDimKey === "bin" && opts.parentDimVal
      ? /^bin/i.test(opts.parentDimVal)
        ? opts.parentDimVal.toLowerCase()
        : `bin${normalizeBinToken(opts.parentDimVal)}`
      : undefined;

  const deviceHint =
    opts.parentDimKey === "device"
      ? opts.parentDimVal.trim()
      : opts.formDevice.trim();

  const waferMap = new Map<string, InfDutWaferSpec>();
  const keys = [...opts.selectedKeys];
  if (keys.length === 0) return null;

  for (const key of keys) {
    const slot = parseSlotFromDrillClick(key, opts.drillGroups);
    if (slot === null) continue;
    const fromList = resolveDeviceLotFromListRows(
      opts.listRows,
      slot,
      binFilter,
      lot
    );
    let device = deviceHint || fromList?.device || "";
    if (!device) continue;
    const passIds =
      fromList?.passIds ??
      (opts.formPassId ? [Number(opts.formPassId)] : [1, 3, 5]);
    mergePassIdsIntoMap(waferMap, { device, lot, slot, passIds, probeCardType: "" });
  }

  const wafers = [...waferMap.values()].sort((a, b) => a.slot - b.slot);
  if (!wafers.length) return null;

  const device = wafers[0]!.device;
  const goodBinNumbers = collectGoodBinNumbersForWafers(opts.listRows, wafers);
  const slots = wafers.map((w) => w.slot).join(", ");

  return {
    wafers,
    device,
    lot,
    goodBinNumbers,
    focusBin,
    anchor: opts.anchor,
    selectionSummary: `${wafers.length} 片 · Slot ${slots}`,
  };
}
