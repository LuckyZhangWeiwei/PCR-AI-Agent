import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import ReactECharts from "echarts-for-react";
import { apiGetJson } from "../api/client";
import { INFCONTROL_AGGREGATE_PATH, INFCONTROL_COMBINED_PATH } from "../api/paths";
import type {
  AggregateGroup,
  InfcontrolAggregateBlock,
  InfcontrolAggregateResponse,
  InfcontrolCombinedResponse,
  InfcontrolLayerBinsV3Response,
  InfcontrolLayerBinV3Row,
} from "../api/types";
import { ChartDrillSplit } from "../components/ChartDrillSplit";
import { CollapsibleQueryPanel } from "../components/CollapsibleQueryPanel";
import { DarkChart } from "../components/DarkChart";
import { DataTable } from "../components/DataTable";
import {
  DraggableReportBlocks,
  DraggableReportSections,
  JB_START_LAYOUT_STORAGE_KEYS,
  ReportLayoutResetButton,
  resetReportLayoutStorage,
} from "../components/DraggableReportSections";
import { DrillDownPanel, formatGroupLabel } from "../components/DrillDownPanel";
import { InfDutDistPanel } from "../components/InfDutDistPanel";
import { KpiCard } from "../components/KpiCard";
import { TreeTable } from "../components/TreeTable";
import {
  chartAxisColor,
  chartSplitLine,
  horizontalBarCategoryAxisLabel,
  horizontalBarCategoryAxisLabelFull,
  horizontalBarChartBase,
  JB_SLOT_TREND_CHART_HEIGHT,
  rankBarChartHeight,
  verticalBarChartGrid,
} from "../theme/chartTheme";
import { datetimeLocalToIso } from "../utils/datetimeLocal";
import { drillFromTree, storeDrillTab } from "../utils/drillAggregate";
import {
  collectGoodBinNumbersFromJbRow,
  collectGoodBinNumbersFromJbRows,
  goodBinNumbersFromDetailRow,
  JB_DETAIL_GOOD_BINS,
  JB_DETAIL_LIST_INDEX,
} from "../utils/infGoodBins";
import {
  buildTree,
  computeYieldPct,
  dateShortcutLast7Days,
  dateShortcutThisMonth,
  dateShortcutToday,
  yieldColor,
  type TreeNode,
} from "../utils/yieldCalc";
import type { ReportListLimits } from "../hooks/usePersistedReportLimits";
import type { EChartsOption } from "echarts";

const TSTYPE_OPTIONS = ["UFLEX", "J750", "PS16", "MST", "FLEX", "93K", "J971"] as const;

type Props = { apiBase: string; listLimits: ReportListLimits };

type FormState = {
  device: string;
  lot: string;
  slot: string;
  probeCardType: string;
  cardId: string;
  tstype: string;
  testerId: string;
  passId: string;
  meslot: string;
  testEndFrom: string;
  testEndTo: string;
};

const initialForm: FormState = {
  device: "",
  lot: "",
  slot: "",
  probeCardType: "",
  cardId: "",
  tstype: "",
  testerId: "",
  passId: "",
  meslot: "",
  testEndFrom: "",
  testEndTo: "",
};

function buildCoreParams(f: FormState): Record<string, string | number | undefined> {
  return {
    device:        f.device        || undefined,
    lot:           f.lot           || undefined,
    slot:          f.slot          ? Number(f.slot)   : undefined,
    probeCardType: f.probeCardType || undefined,
    cardId:        f.cardId        || undefined,
    tstype:        f.tstype        || undefined,
    testerId:      f.testerId      || undefined,
    passId:        f.passId        ? Number(f.passId) : undefined,
    meslot:        f.meslot        || undefined,
    testEndFrom:   datetimeLocalToIso(f.testEndFrom),
    testEndTo:     datetimeLocalToIso(f.testEndTo),
  };
}

function buildListParams(
  f: FormState,
  limits: ReportListLimits,
): Record<string, string | number | undefined> {
  return {
    ...buildCoreParams(f),
    limit: limits.defaultLimit,
  };
}

/** infcontrol v3 aggregate 要求 groupBy 恰含一个 `bin`（见 API manifest） */
function jbAggregateGroupBy(...dims: string[]): string {
  const out: string[] = [];
  for (const d of dims) {
    if (!out.includes(d)) out.push(d);
  }
  if (!out.includes("bin")) out.push("bin");
  return out.join(",");
}

const HIDE_CHIPS = new Set(["testEndFrom", "testEndTo"]);
function activeChips(
  f: FormState,
  limits: ReportListLimits,
): { key: string; label: string }[] {
  const chips: { key: string; label: string }[] = [];
  for (const [k, v] of Object.entries(buildCoreParams(f))) {
    if (v === undefined || HIDE_CHIPS.has(k)) continue;
    chips.push({ key: k, label: `${k} = ${v}` });
  }
  if (f.testEndFrom || f.testEndTo) {
    const label =
      f.testEndFrom && f.testEndTo
        ? `testEnd ${f.testEndFrom} → ${f.testEndTo}`
        : f.testEndFrom
        ? `testEnd ≥ ${f.testEndFrom}`
        : `testEnd ≤ ${f.testEndTo}`;
    chips.push({ key: "__time__", label });
  }
  chips.push({
    key: "limit",
    label: `limit = ${limits.defaultLimit}（最多 ${limits.maxLimit}）`,
  });
  return chips;
}

const FREE_DIMS: { label: string; value: string }[] = [
  { label: "Bin",          value: "bin"          },
  { label: "Lot",          value: "lot"          },
  { label: "Device",       value: "device"       },
  { label: "ProbeCardType",value: "probeCardType"},
  { label: "CardId",       value: "cardId"       },
  { label: "Slot",         value: "slot"         },
  { label: "TsType",       value: "tstype"       },
  { label: "PassId",       value: "passId"       },
  { label: "TesterId",     value: "testerId"     },
];

const JB_REPORT_SECTION_ORDER = [
  "kpi",
  "lotYield",
  "chartsGrid",
  "tree",
  "detail",
] as const;

const JB_KPI_BLOCK_ORDER = ["jbWafer", "jbYieldPct", "jbWorstType", "jbTopBin"] as const;

const JB_CHART_BLOCK_ORDER = ["jbDevice", "jbBin", "jbPcType", "jbSlot", "jbFreeDim"] as const;

// Sub-dimension options per parent drill
const DRILL_FROM_DEVICE_JB: { label: string; value: string }[] = [
  { label: "LOT",    value: "lot"    },
  { label: "Pass",   value: "passId" },
  { label: "CardId", value: "cardId" },
  { label: "Slot",   value: "slot"   },
];

const DRILL_FROM_CARDTYPE: { label: string; value: string }[] = [
  { label: "CardId", value: "cardId" },
  { label: "Device", value: "device" },
  { label: "Slot",   value: "slot"   },
  { label: "Bin",    value: "bin"    },
  { label: "Lot",    value: "lot"    },
];

const DRILL_FROM_CARD: { label: string; value: string }[] = [
  { label: "Slot",   value: "slot"   },
  { label: "Bin",    value: "bin"    },
  { label: "Device", value: "device" },
  { label: "Lot",    value: "lot"    },
];

const DRILL_FROM_SLOT: { label: string; value: string }[] = [
  { label: "Bin",    value: "bin"    },
  { label: "CardId", value: "cardId" },
  { label: "Device", value: "device" },
  { label: "Lot",    value: "lot"    },
];

const DRILL_FROM_BIN: { label: string; value: string }[] = [
  { label: "CardId", value: "cardId" },
  { label: "Device", value: "device" },
  { label: "Lot",    value: "lot"    },
  { label: "Slot",   value: "slot"   },
];

const DRILL_FROM_LOT: { label: string; value: string }[] = [
  { label: "CardId",       value: "cardId"       },
  { label: "ProbeCardType",value: "probeCardType"},
  { label: "Slot",         value: "slot"         },
  { label: "Bin",          value: "bin"          },
];

type DrillState = {
  parentDimKey: string;
  parentDimVal: string;
  subDim: string;
  groups: AggregateGroup[];
  loading: boolean;
  error: string | null;
};

// Dimensions available in aggTree parts (device→lot→probeCardType→cardId→bin).
// Any drill where both the filter key and all subDim keys are in this set
// can be served from the cached aggTree without hitting Oracle.
const TREE_DRILL_DIMS = new Set(["device", "lot", "probeCardType", "cardId", "bin"]);

const JB_DRILL_KEY_SEP = "|";

function rowMatchesJbDrillParent(
  row: InfcontrolLayerBinV3Row,
  parentDimKey: string,
  parentDimVal: string
): boolean {
  const val = parentDimVal.trim();
  switch (parentDimKey) {
    case "device":
      return String(row.DEVICE ?? "").trim() === val;
    case "lot":
      return String(row.LOT ?? "").trim() === val;
    case "cardId":
      return String(row.CARDID ?? "").trim() === val;
    case "probeCardType": {
      const cardId = String(row.CARDID ?? "").trim();
      if (!cardId) return false;
      const dash = cardId.indexOf("-");
      const prefix = (dash > 0 ? cardId.slice(0, dash) : cardId).toLowerCase();
      return prefix === val.toLowerCase();
    }
    case "bin":
      return true;
    default:
      return true;
  }
}

function jbRowDimValue(row: InfcontrolLayerBinV3Row, dim: string): string | undefined {
  switch (dim) {
    case "device":
      return String(row.DEVICE ?? "").trim() || undefined;
    case "lot":
      return String(row.LOT ?? "").trim() || undefined;
    case "slot":
      return row.SLOT !== undefined && row.SLOT !== null ? String(row.SLOT) : undefined;
    case "passId":
      return row.PASSID !== undefined && row.PASSID !== null
        ? String(row.PASSID)
        : undefined;
    case "cardId":
      return String(row.CARDID ?? "").trim() || undefined;
    case "probeCardType": {
      const pct = row.PROBECARDTYPE;
      if (pct !== undefined && pct !== null && String(pct).trim()) {
        return String(pct).trim();
      }
      const cardId = String(row.CARDID ?? "").trim();
      if (!cardId) return undefined;
      const dash = cardId.indexOf("-");
      return dash > 0 ? cardId.slice(0, dash) : cardId;
    }
    default:
      return undefined;
  }
}

/** 查询区已填 Lot 时，用已加载明细行做 slot/pass 下钻（避免 aggregate Top-N 漏组） */
function drillFromJbListRows(
  rows: InfcontrolLayerBinV3Row[],
  parentDimKey: string,
  parentDimVal: string,
  subDimKeys: string[]
): AggregateGroup[] {
  const binFilter = parentDimKey === "bin" ? normalizeBinToken(parentDimVal) : undefined;
  const sums = new Map<string, number>();
  const partsMap = new Map<string, Record<string, string>>();

  for (const row of rows) {
    if (!rowMatchesJbDrillParent(row, parentDimKey, parentDimVal)) continue;
    const bins = row.bins;
    if (!Array.isArray(bins)) continue;

    for (const cell of bins) {
      if (cell.isGoodBin === true) continue;
      const binN = String(cell.n ?? "");
      if (!binN) continue;
      if (binFilter && binN !== binFilter) continue;
      const v = cell.value ?? 0;
      if (!Number.isFinite(v) || v <= 0) continue;

      const parts: Record<string, string> = {};
      let valid = true;
      for (const k of subDimKeys) {
        if (k === "bin") {
          parts.bin = binN;
        } else {
          const dv = jbRowDimValue(row, k);
          if (dv === undefined) {
            valid = false;
            break;
          }
          parts[k] = dv;
        }
      }
      if (!valid) continue;

      const key = subDimKeys.map((k) => parts[k] ?? "").join(JB_DRILL_KEY_SEP);
      sums.set(key, (sums.get(key) ?? 0) + v);
      if (!partsMap.has(key)) partsMap.set(key, parts);
    }
  }

  return [...sums.entries()]
    .map(([key, count]) => ({ key, count, parts: partsMap.get(key)! }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 50);
}

function parseSlotFromDrillClick(
  clickedKey: string,
  groups: AggregateGroup[]
): number | null {
  const g = groups.find((x) => x.key === clickedKey);
  if (g?.parts.slot != null && String(g.parts.slot).trim() !== "") {
    const n = parseInt(String(g.parts.slot), 10);
    if (Number.isFinite(n)) return n;
  }
  return parseSlotFromDrillBarLabel(clickedKey);
}

function lotYields(
  rows: InfcontrolLayerBinV3Row[]
): Array<{ lot: string; passId: string; slot: string; device: string; label: string; yieldPct: number }> {
  const byKey = new Map<string, InfcontrolLayerBinV3Row[]>();
  for (const r of rows) {
    const lot    = r.LOT    ?? "—";
    const passId = r.PASSID !== undefined && r.PASSID !== null ? String(r.PASSID) : "";
    const slot   = r.SLOT   !== undefined && r.SLOT   !== null ? String(r.SLOT)   : "";
    const key    = `${lot}__P${passId}__S${slot}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(r);
  }
  const result: Array<{ lot: string; passId: string; slot: string; device: string; label: string; yieldPct: number }> = [];
  for (const [key, keyRows] of byKey.entries()) {
    const yp = computeYieldPct(keyRows);
    if (yp === null) continue;
    const r0     = keyRows[0];
    const lot    = r0.LOT    ?? "—";
    const device = r0.DEVICE ?? "";
    const passId = r0.PASSID !== undefined && r0.PASSID !== null ? String(r0.PASSID) : "";
    const slot   = r0.SLOT   !== undefined && r0.SLOT   !== null ? String(r0.SLOT)   : "";
    let label = device ? `${device} · ${lot}` : lot;
    if (passId) label += ` [P${passId}]`;
    if (slot)   label += ` S${slot}`;
    result.push({ lot, passId, slot, device, label, yieldPct: yp });
    void key;
  }
  return result.sort((a, b) => a.yieldPct - b.yieldPct);
}

function infcontrolTreeYieldExtra(
  rows: InfcontrolLayerBinV3Row[] | undefined,
  node: TreeNode,
  depth: number,
): ReactNode {
  if (depth > 1) return null;
  const device = node.dimKey === "device" ? node.dimValue : undefined;
  const lot = node.dimKey === "lot" ? node.dimValue : undefined;
  if (!rows?.length) return null;
  const filtered = rows.filter((r) => {
    if (device && r.DEVICE !== device) return false;
    if (lot && r.LOT !== lot) return false;
    return true;
  });
  const byPass = new Map<string, InfcontrolLayerBinV3Row[]>();
  for (const r of filtered) {
    const p = r.PASSID !== undefined && r.PASSID !== null ? String(r.PASSID) : "—";
    if (!byPass.has(p)) byPass.set(p, []);
    byPass.get(p)!.push(r);
  }
  if (byPass.size === 0) return null;
  return (
    <span style={{ fontSize: 11, display: "flex", gap: 6, flexWrap: "wrap" }}>
      {[...byPass.entries()].map(([p, rs]) => {
        const yp = computeYieldPct(rs);
        if (yp === null) return null;
        return (
          <span key={p} style={{ color: yieldColor(yp) }}>
            P{p} {yp.toFixed(1)}%
          </span>
        );
      })}
    </span>
  );
}

type InfCtxData = {
  device: string;
  lot: string;
  slot: number;
  passIds: number[];
  cardId?: string;
  focusBin?: string;
  goodBinNumbers: Set<number>;
  /** 明细表行索引（list.rows 原始下标）；钻取打开时为 undefined */
  detailRowIndex?: number;
  /** DUT 面板锚点：显示在触发源下方 */
  anchor: InfDutAnchor;
};

type InfCtx = InfCtxData | null;

type JbChartBlockId = (typeof JB_CHART_BLOCK_ORDER)[number];

type InfDutAnchor =
  | { source: "detail" }
  | { source: "lotYield" }
  | { source: "chartsGrid"; block: JbChartBlockId };

function infDutAnchorForParentDimKey(parentDimKey: string): InfDutAnchor | null {
  switch (parentDimKey) {
    case "lot":
      return { source: "lotYield" };
    case "device":
      return { source: "chartsGrid", block: "jbDevice" };
    case "bin":
      return { source: "chartsGrid", block: "jbBin" };
    case "probeCardType":
      return { source: "chartsGrid", block: "jbPcType" };
    case "slot":
      return { source: "chartsGrid", block: "jbSlot" };
    default:
      return null;
  }
}

function infDutAnchorsMatch(a: InfDutAnchor, b: InfDutAnchor): boolean {
  if (a.source !== b.source) return false;
  if (a.source === "chartsGrid" && b.source === "chartsGrid") {
    return a.block === b.block;
  }
  return true;
}

function infDutAnchorFromDrill(d: DrillState): InfDutAnchor {
  return (
    infDutAnchorForParentDimKey(d.parentDimKey) ?? {
      source: "chartsGrid",
      block: "jbSlot",
    }
  );
}

function InfDutAnchorRow({
  infCtx,
  match,
  apiBase,
  onClose,
}: {
  infCtx: InfCtx;
  match: (anchor: InfDutAnchor) => boolean;
  apiBase: string;
  onClose: () => void;
}) {
  if (!infCtx || !match(infCtx.anchor)) return null;
  return (
    <div className="inf-dut-standalone-row">
      <InfDutDistPanel
        device={infCtx.device}
        lot={infCtx.lot}
        slot={infCtx.slot}
        passIds={infCtx.passIds}
        cardId={infCtx.cardId}
        focusBin={infCtx.focusBin}
        goodBinNumbers={infCtx.goodBinNumbers}
        apiBase={apiBase}
        onClose={onClose}
      />
    </div>
  );
}

/** 图表钻取打开 INF DUT 时须在查询区填写 Lot。 */
function queryLotRequired(form: FormState): string | null {
  const lot = form.lot.trim();
  return lot || null;
}

type InfCtxForSlotOpts = {
  device?: string;
  /** 明细行点击时传入该行 LOT；钻取路径不传，须依赖查询区 Lot */
  lot?: string;
  passIds?: number[];
  cardId?: string;
  focusBin?: string;
  detailRowIndex?: number;
  binFilter?: string;
  anchor: InfDutAnchor;
  /** 明细行等附加良品 bin（如当前行 PASSBIN） */
  extraGoodBinNumbers?: ReadonlySet<number>;
};

/** 按 slot 组装 INF DUT 上下文：明细行用 opts.lot，图表钻取用查询区 Lot。 */
function buildInfCtxForSlot(
  form: FormState,
  listRows: InfcontrolLayerBinV3Row[] | undefined,
  slot: number,
  opts: InfCtxForSlotOpts
): InfCtxData | null {
  const lot = (opts.lot?.trim() || queryLotRequired(form)) ?? null;
  if (!lot) return null;

  let device = (opts.device ?? form.device.trim()) || "";
  let passIds =
    opts.passIds ??
    (form.passId ? [Number(form.passId)] : [1, 3, 5]);
  let cardId = opts.cardId ?? (form.cardId.trim() || undefined);

  if (!device) {
    const fromList = resolveDeviceLotFromListRows(
      listRows,
      slot,
      opts.binFilter,
      lot
    );
    if (!fromList) return null;
    device = fromList.device;
    if (opts.passIds == null && fromList.passIds) passIds = fromList.passIds;
    if (!cardId && fromList.cardId) cardId = fromList.cardId;
  }

  const goodBinNumbers = collectGoodBinNumbersFromJbRows(
    listRows,
    device,
    lot,
    slot,
    passIds
  );
  if (opts.extraGoodBinNumbers) {
    for (const n of opts.extraGoodBinNumbers) goodBinNumbers.add(n);
  }

  return {
    device,
    lot,
    slot,
    passIds,
    cardId,
    focusBin: opts.focusBin,
    goodBinNumbers,
    detailRowIndex: opts.detailRowIndex,
    anchor: opts.anchor,
  };
}

/** DrillDownPanel 条形 click 传的是 y 轴文案（如 `Slot 5` 或 `LOT NF12615.1X · Slot 20 · Bin 4`）。 */
function parseSlotFromDrillBarLabel(clickedKey: string): number | null {
  const t = clickedKey.trim();
  const m = /\bslot\s*(\d+)/i.exec(t);
  if (m) return parseInt(m[1], 10);
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : null;
}

/** 从 BIN 下钻到 slot 时按 lot+slot 聚合，条形上显示 LOT。 */
function drillSubDimKeysForFetch(parentDimKey: string, subDim: string): string[] {
  const parts = subDim.split(",").map((s) => s.trim()).filter(Boolean);
  if (parentDimKey === "bin" && parts.length === 1 && parts[0] === "slot") {
    return jbAggregateGroupBy("lot", "slot").split(",");
  }
  return jbAggregateGroupBy(...parts).split(",");
}

function normalizeBinToken(raw: string): string {
  return raw.replace(/^bin\s*/i, "").trim();
}

function rowMatchesBinFilter(row: InfcontrolLayerBinV3Row, binToken: string | undefined): boolean {
  if (!binToken) return true;
  for (const c of row.bins ?? []) {
    if (String(c.n) === binToken && (c.value ?? 0) > 0 && !c.isGoodBin) return true;
  }
  return false;
}

/** 从明细行反查 device（lot 须与查询区填写的一致）。 */
function resolveDeviceLotFromListRows(
  rows: InfcontrolLayerBinV3Row[] | undefined,
  slot: number,
  binFilter?: string,
  requiredLot?: string
): Pick<InfCtxData, "device" | "lot" | "passIds" | "cardId"> | null {
  if (!rows?.length) return null;
  const binToken = binFilter ? normalizeBinToken(binFilter) : undefined;
  const lotNeed = requiredLot?.trim();
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
    const cardId = String(r.CARDID ?? "").trim() || undefined;
    return { device, lot, passIds, cardId };
  }
  return null;
}

function resolveInfCtxFromDrill(
  parentDimKey: string,
  parentDimVal: string,
  subDim: string,
  clickedKey: string,
  form: FormState,
  listRows: InfcontrolLayerBinV3Row[] | undefined,
  anchor: InfDutAnchor,
  drillGroups: AggregateGroup[]
): InfCtxData | null {
  if (!queryLotRequired(form)) return null;
  if (subDim !== "slot") return null;
  const slot = parseSlotFromDrillClick(clickedKey, drillGroups);
  if (slot === null) return null;

  const binFilter = parentDimKey === "bin" ? parentDimVal : undefined;
  const focusBin =
    parentDimKey === "bin" && parentDimVal
      ? /^bin/i.test(parentDimVal)
        ? parentDimVal.toLowerCase()
        : `bin${normalizeBinToken(parentDimVal)}`
      : undefined;

  const deviceHint =
    parentDimKey === "device" ? parentDimVal.trim() : form.device.trim() || undefined;

  return buildInfCtxForSlot(form, listRows, slot, {
    device: deviceHint,
    binFilter,
    focusBin,
    anchor,
  });
}

export function InfcontrolReport({ apiBase, listLimits }: Props) {
  const [form, setForm] = useState<FormState>(initialForm);
  const [list,        setList]        = useState<InfcontrolLayerBinsV3Response | null>(null);
  const [aggBin,      setAggBin]      = useState<InfcontrolAggregateBlock | null>(null);
  // probeCardType,bin aggregate — chart shows type-level; cardId accessed via drill
  const [aggCardType, setAggCardType] = useState<InfcontrolAggregateBlock | null>(null);
  const [aggSlot,     setAggSlot]     = useState<InfcontrolAggregateBlock | null>(null);
  const [aggTree,     setAggTree]     = useState<InfcontrolAggregateBlock | null>(null);
  const [aggDevice,   setAggDevice]   = useState<InfcontrolAggregateBlock | null>(null);
  const [aggFree,     setAggFree]     = useState<InfcontrolAggregateResponse | null>(null);
  const [freeDim, setFreeDim] = useState("bin");

  const [loadingList, setLoadingList] = useState(false);
  const [loadingAgg,  setLoadingAgg]  = useState(false);
  const [errorList,   setErrorList]   = useState<string | null>(null);
  const [errorAgg,    setErrorAgg]    = useState<string | null>(null);
  const [drills,      setDrills]      = useState<Record<string, DrillState>>({});
  // Cache per parent-dim key: stores results for every tab fetched in the current query window.
  // Keyed by parentDimKey → { val: parentDimVal, tabs: { subDim → groups } }.
  // Stored in a ref so cache hits never trigger re-renders and fetchDrill stays dep-free of drills.
  const drillCacheRef = useRef<Record<string, { val: string; tabs: Record<string, AggregateGroup[]> }>>({});
  const [showTree,   setShowTree]   = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const [selectedLotLabel, setSelectedLotLabel] = useState<string | null>(null);
  const [selectedBin,      setSelectedBin]      = useState<string | null>(null);
  const [selectedCardType, setSelectedCardType] = useState<string | null>(null);
  const [selectedSlot,     setSelectedSlot]     = useState<string | null>(null);
  const [selectedDevice,   setSelectedDevice]   = useState<string | null>(null);
  const [infCtx, setInfCtx] = useState<InfCtx>(null);
  const [layoutEpoch, setLayoutEpoch] = useState(0);

  const resetReportLayout = useCallback(() => {
    resetReportLayoutStorage(JB_START_LAYOUT_STORAGE_KEYS);
    setLayoutEpoch((n) => n + 1);
  }, []);

  const setField = useCallback(
    <K extends keyof FormState>(k: K, v: FormState[K]) => {
      setForm((f) => ({ ...f, [k]: v }));
    },
    []
  );

  const clearFilter = useCallback((key: string) => {
    if (key === "limit") return;
    if (key === "__time__")
      setForm((f) => ({ ...f, testEndFrom: "", testEndTo: "" }));
    else setForm((f) => ({ ...f, [key]: "" } as FormState));
  }, []);

  const clearAll = useCallback(() => {
    setForm(initialForm);
    setList(null);
    setAggBin(null);
    setAggCardType(null);
    setAggSlot(null);
    setAggTree(null);
    setAggDevice(null);
    setAggFree(null);
    setDrills({});
    drillCacheRef.current = {};
    setSelectedLotLabel(null);
    setSelectedBin(null);
    setSelectedCardType(null);
    setSelectedSlot(null);
    setSelectedDevice(null);
    setInfCtx(null);
    setErrorList(null);
    setErrorAgg(null);
    setLoadingList(false);
    setLoadingAgg(false);
  }, []);

  const applyDateShortcut = useCallback((fn: () => [string, string]) => {
    const [from, to] = fn();
    setForm((f) => ({ ...f, testEndFrom: from, testEndTo: to }));
  }, []);

  const fetchDrill = useCallback(
    async (
      parentDimKey: string,
      parentDimVal: string,
      subDim: string,
      currentForm: FormState
    ) => {
      const subDimKeys = drillSubDimKeysForFetch(parentDimKey, subDim);
      const listRows = (list?.rows ?? []) as InfcontrolLayerBinV3Row[];

      // ── Tab cache: reuse already-fetched results for the same bar + tab ──────
      const cached = drillCacheRef.current[parentDimKey];
      if (cached?.val === parentDimVal && subDim in cached.tabs) {
        setDrills((prev) => ({
          ...prev,
          [parentDimKey]: { parentDimKey, parentDimVal, subDim, groups: cached.tabs[subDim], loading: false, error: null },
        }));
        return;
      }

      // ── In-memory path: derive from cached aggTree (no Oracle call) ──────────
      // Works when both the filter key and all child dim keys are dimensions
      // present in the aggTree parts: device / lot / probeCardType / cardId / bin.
      // Falls back to Oracle when slot or passId appear, or when the requested
      // value is absent from the cached rows.
      const treeGroups = aggTree?.groups;
      if (
        treeGroups != null &&
        TREE_DRILL_DIMS.has(parentDimKey) &&
        subDimKeys.every((k) => TREE_DRILL_DIMS.has(k))
      ) {
        const groups = drillFromTree(treeGroups, parentDimKey, parentDimVal, subDimKeys);
        if (groups.length > 0) {
          storeDrillTab(parentDimKey, parentDimVal, subDim, groups, drillCacheRef, setDrills);
          return;
        }
        // Zero results → value not in cached rows → fall through below.
      }

      // ── In-memory path: derive from cached list rows (no Oracle call) ─────────
      if (listRows.length > 0) {
        const fromList = drillFromJbListRows(
          listRows,
          parentDimKey,
          parentDimVal,
          subDimKeys
        );
        if (fromList.length > 0) {
          storeDrillTab(
            parentDimKey,
            parentDimVal,
            subDim,
            fromList,
            drillCacheRef,
            setDrills
          );
          return;
        }
      }

      // ── Oracle fallback ───────────────────────────────────────────────────────
      // Used for slot / passId sub-dimensions, or when the cache missed the value.
      setDrills((prev) => ({
        ...prev,
        [parentDimKey]: { parentDimKey, parentDimVal, subDim, groups: [], loading: true, error: null },
      }));
      try {
        // When probeCardType is the parent dim and cardId is not already in subDims,
        // inject cardId into the groupBy so we can filter by card prefix client-side,
        // then re-aggregate back to the original sub-dimensions.
        const needCardIdInjection =
          parentDimKey === "probeCardType" && !subDimKeys.includes("cardId");
        const requestGroupBy = needCardIdInjection
          ? [...subDimKeys, "cardId"]
          : subDimKeys;

        const params = {
          ...buildCoreParams(currentForm),
          [parentDimKey]: parentDimVal,
          groupBy: requestGroupBy.join(","),
          groupTop: 50,
        };
        const res = await apiGetJson<InfcontrolAggregateResponse>(
          apiBase,
          INFCONTROL_AGGREGATE_PATH,
          params
        );
        // probeCardType and bin are not real DB WHERE-clause columns — API ignores them.
        // Filter client-side after fetching.
        let groups = res.groups;

        if (parentDimKey === "probeCardType") {
          const typeLower = parentDimVal.trim().toLowerCase();
          const filtered = groups.filter((g) => {
            const cardId = (g.parts.cardId ?? "").trim();
            if (!cardId) return false;
            const dash = cardId.indexOf("-");
            const prefix = (dash > 0 ? cardId.slice(0, dash) : cardId).toLowerCase();
            return prefix === typeLower;
          });
          if (needCardIdInjection) {
            // Re-aggregate to original subDimKeys, stripping the injected cardId.
            const sums = new Map<string, number>();
            const partsMap = new Map<string, Record<string, string>>();
            for (const g of filtered) {
              const subParts: Record<string, string> = {};
              for (const k of subDimKeys) subParts[k] = g.parts[k] ?? "";
              const key = subDimKeys.map((k) => subParts[k]).join("\x00");
              sums.set(key, (sums.get(key) ?? 0) + g.count);
              if (!partsMap.has(key)) partsMap.set(key, subParts);
            }
            groups = [...sums.entries()]
              .map(([k, count]) => ({ key: k, count, parts: partsMap.get(k)! }))
              .sort((a, b) => b.count - a.count);
          } else {
            groups = filtered;
          }
        }

        if (parentDimKey === "bin") {
          // bin is an UNPIVOT virtual column — filter groups to the clicked bin value.
          groups = groups.filter((g) => g.parts.bin === parentDimVal);
        }

        if (groups.length === 0 && listRows.length > 0) {
          groups = drillFromJbListRows(
            listRows,
            parentDimKey,
            parentDimVal,
            subDimKeys
          );
        }

        setDrills((prev) => {
          const d = prev[parentDimKey];
          if (!d || d.parentDimVal !== parentDimVal) return prev;
          if (!drillCacheRef.current[parentDimKey] || drillCacheRef.current[parentDimKey].val !== parentDimVal)
            drillCacheRef.current[parentDimKey] = { val: parentDimVal, tabs: {} };
          drillCacheRef.current[parentDimKey].tabs[subDim] = groups;
          return { ...prev, [parentDimKey]: { ...d, groups, loading: false } };
        });
      } catch (e) {
        setDrills((prev) => {
          const d = prev[parentDimKey];
          if (!d || d.parentDimVal !== parentDimVal) return prev;
          return { ...prev, [parentDimKey]: { ...d, loading: false, error: e instanceof Error ? e.message : String(e) } };
        });
      }
    },
    [apiBase, aggTree, list?.rows]
  );

  const fetchFreeAgg = useCallback(
    async (dim: string, currentForm: FormState) => {
      try {
        const gby = jbAggregateGroupBy(dim);
        const res = await apiGetJson<InfcontrolAggregateResponse>(
          apiBase,
          INFCONTROL_AGGREGATE_PATH,
          { ...buildCoreParams(currentForm), groupBy: gby, groupTop: 30 }
        );
        setAggFree(res);
      } catch {
        setAggFree(null);
      }
    },
    [apiBase]
  );

  const query = useCallback(async () => {
    setLoadingList(true);
    setLoadingAgg(true);
    setErrorList(null);
    setErrorAgg(null);
    setDrills({});
    drillCacheRef.current = {};
    setSelectedLotLabel(null);
    setSelectedBin(null);
    setSelectedCardType(null);
    setSelectedSlot(null);
    setList(null);
    setAggBin(null);
    setAggCardType(null);
    setAggSlot(null);
    setAggTree(null);
    setAggDevice(null);
    setSelectedDevice(null);
    setInfCtx(null);
    setAggFree(null);

    try {
      const res = await apiGetJson<InfcontrolCombinedResponse>(
        apiBase,
        INFCONTROL_COMBINED_PATH,
        {
          ...buildListParams(form, listLimits),
          aggs: [
            `${jbAggregateGroupBy("bin")}:30`,
            `${jbAggregateGroupBy("probeCardType")}:25`,
            `${jbAggregateGroupBy("slot")}:50`,
            `${jbAggregateGroupBy("device", "lot", "probeCardType", "cardId")}:1000`,
            `${jbAggregateGroupBy("device")}:30`,
          ].join("|"),
        }
      );
      setList(res);
      setAggBin(res.aggregates[jbAggregateGroupBy("bin")] ?? null);
      setAggCardType(res.aggregates[jbAggregateGroupBy("probeCardType")] ?? null);
      setAggSlot(res.aggregates[jbAggregateGroupBy("slot")] ?? null);
      setAggTree(
        res.aggregates[jbAggregateGroupBy("device", "lot", "probeCardType", "cardId")] ?? null
      );
      setAggDevice(res.aggregates[jbAggregateGroupBy("device")] ?? null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorList(msg);
      setErrorAgg(msg);
    } finally {
      setLoadingList(false);
      setLoadingAgg(false);
    }

    void fetchFreeAgg(freeDim, form);
  }, [apiBase, form, freeDim, fetchFreeAgg, listLimits]);

  const handleFreeDimChange = useCallback(
    (dim: string) => {
      setFreeDim(dim);
      if (list || aggBin) fetchFreeAgg(dim, form);
    },
    [list, aggBin, form, fetchFreeAgg]
  );

  // ── KPI derivations ──────────────────────────────────────────────────────

  const totalWafers = useMemo(() => {
    const rawRows = list?.rows;
    if (!rawRows?.length) return aggBin?.totalRowsMatching ?? null;
    const rows = rawRows as InfcontrolLayerBinV3Row[];
    const seen = new Set<number>();
    for (const row of rows) {
      if (row.KEYNUMBER != null && String(row.PASSTYPE ?? "").toUpperCase().trim() !== "INTERRUPT") {
        seen.add(row.KEYNUMBER);
      }
    }
    return seen.size > 0 ? seen.size : (aggBin?.totalRowsMatching ?? null);
  }, [list?.rows, aggBin?.totalRowsMatching]);

  const overallYield = useMemo(() => {
    if (!list?.rows?.length) return null;
    return computeYieldPct(list.rows as InfcontrolLayerBinV3Row[]);
  }, [list]);

  // Worst probeCardType by total bad-die count
  const worstCardType = useMemo(() => {
    if (!aggCardType?.groups?.length) return null;
    const typeBad = new Map<string, number>();
    for (const g of aggCardType.groups) {
      const t = g.parts.probeCardType ?? "";
      if (t) typeBad.set(t, (typeBad.get(t) ?? 0) + g.count);
    }
    if (typeBad.size === 0) return null;
    return [...typeBad.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }, [aggCardType]);

  const topBin = useMemo(() => {
    const groups = aggBin?.groups ?? [];
    if (!groups.length) return null;
    return `Bin ${groups[0].parts.bin ?? groups[0].key}`;
  }, [aggBin]);

  // ── Chart options ────────────────────────────────────────────────────────

  const lotYieldData = useMemo(() => {
    if (!list?.rows?.length) return [];
    return lotYields(list.rows as InfcontrolLayerBinV3Row[]);
  }, [list]);

  const lotYieldOption = useMemo((): EChartsOption => {
    // reverse: lowest yield ends up at top → reads low-to-high from top to bottom
    const data = lotYieldData.slice(0, 10).reverse();
    return {
      ...horizontalBarChartBase(),
      xAxis: {
        type: "value",
        max: 100,
        axisLabel: { color: chartAxisColor, formatter: "{value}%" },
        splitLine: { lineStyle: { color: chartSplitLine } },
      },
      grid: {
        left: 8,
        right: 52,
        top: 8,
        bottom: 8,
        containLabel: true,
      },
      yAxis: {
        type: "category",
        data: data.map((d) => d.label),
        axisLabel: { ...horizontalBarCategoryAxisLabelFull, interval: 0 },
      },
      series: [
        {
          type: "bar",
          data: data.map((d) => {
            const base   = d.yieldPct >= 95 ? "#238636" : d.yieldPct >= 80 ? "#9e6a03" : "#da3633";
            const bright = d.yieldPct >= 95 ? "#3fb950" : d.yieldPct >= 80 ? "#d29922" : "#f85149";
            const dim    = d.yieldPct >= 95 ? "rgba(35,134,54,0.3)" : d.yieldPct >= 80 ? "rgba(158,106,3,0.3)" : "rgba(218,54,51,0.3)";
            const isSel  = selectedLotLabel === d.label;
            return {
              value: Number(d.yieldPct.toFixed(2)),
              itemStyle: {
                color: isSel ? bright : selectedLotLabel !== null ? dim : base,
                borderRadius: [0, 4, 4, 0] as unknown as number,
              },
            };
          }),
          label: {
            show: true,
            position: "right",
            color: chartAxisColor,
            fontSize: 10,
            formatter: "{c}%",
          },
          animationDuration: 600,
        },
      ],
    };
  }, [lotYieldData, selectedLotLabel]);

  const binRankOption = useMemo((): EChartsOption => {
    const sorted = [...(aggBin?.groups ?? [])]
      .sort((a, b) => a.count - b.count)
      .slice(-10);
    const COL = "#ff7b72", COL_B = "#ff5050", COL_D = "rgba(255,123,114,0.3)";
    return {
      ...horizontalBarChartBase(),
      xAxis: {
        type: "value",
        axisLabel: { color: chartAxisColor },
        splitLine: { lineStyle: { color: chartSplitLine } },
      },
      yAxis: {
        type: "category",
        data: sorted.map((g) => `Bin ${g.parts.bin ?? g.key}`),
        axisLabel: { ...horizontalBarCategoryAxisLabel, interval: 0 },
      },
      series: [
        {
          type: "bar",
          data: sorted.map((g) => {
            const key = `Bin ${g.parts.bin ?? g.key}`;
            const isSel = selectedBin !== null && key === `Bin ${selectedBin}`;
            return {
              value: g.count,
              itemStyle: {
                color: isSel ? COL_B : selectedBin !== null ? COL_D : COL,
                borderRadius: [0, 4, 4, 0] as unknown as number,
              },
            };
          }),
          label: {
            show: true,
            position: "right",
            color: chartAxisColor,
            fontSize: 10,
          },
          animationDuration: 600,
        },
      ],
    };
  }, [aggBin, selectedBin]);

  // ProbeCard Type — sum bad-die per type (aggregate over bin dimension)
  const cardTypeOption = useMemo((): EChartsOption => {
    const typeBad = new Map<string, number>();
    for (const g of aggCardType?.groups ?? []) {
      const t = g.parts.probeCardType ?? "—";
      typeBad.set(t, (typeBad.get(t) ?? 0) + g.count);
    }
    const sorted = [...typeBad.entries()].sort((a, b) => a[1] - b[1]).slice(-10);
    const COL = "#e6b450", COL_B = "#ffd070", COL_D = "rgba(230,180,80,0.3)";
    return {
      ...horizontalBarChartBase(),
      xAxis: {
        type: "value",
        axisLabel: { color: chartAxisColor },
        splitLine: { lineStyle: { color: chartSplitLine } },
      },
      yAxis: {
        type: "category",
        data: sorted.map(([t]) => t),
        axisLabel: { ...horizontalBarCategoryAxisLabel, interval: 0 },
      },
      series: [
        {
          type: "bar",
          data: sorted.map(([t, v]) => {
            const isSel = selectedCardType !== null && t === selectedCardType;
            return {
              value: v,
              itemStyle: {
                color: isSel ? COL_B : selectedCardType !== null ? COL_D : COL,
                borderRadius: [0, 4, 4, 0] as unknown as number,
              },
            };
          }),
          label: {
            show: true,
            position: "right",
            color: chartAxisColor,
            fontSize: 10,
          },
          animationDuration: 600,
        },
      ],
    };
  }, [aggCardType, selectedCardType]);

  const slotOption = useMemo((): EChartsOption => {
    const slotBad = new Map<string, number>();
    for (const g of aggSlot?.groups ?? []) {
      const s = g.parts.slot ?? "—";
      slotBad.set(s, (slotBad.get(s) ?? 0) + g.count);
    }
    const sorted = [...slotBad.entries()]
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .slice(0, 10);
    const COL = "#79c0ff", COL_B = "#4da6ff", COL_D = "rgba(121,192,255,0.3)";
    return {
      ...horizontalBarChartBase(),
      grid: verticalBarChartGrid,
      xAxis: {
        type: "category",
        data: sorted.map(([s]) => `Slot ${s}`),
        axisLabel: { color: chartAxisColor, fontSize: 10, rotate: 30 },
      },
      yAxis: {
        type: "value",
        axisLabel: { color: chartAxisColor },
        splitLine: { lineStyle: { color: chartSplitLine } },
      },
      series: [
        {
          type: "bar",
          data: sorted.map(([s, v]) => {
            const key = `Slot ${s}`;
            const isSel = selectedSlot !== null && key === selectedSlot;
            return {
              value: v,
              itemStyle: {
                color: isSel ? COL_B : selectedSlot !== null ? COL_D : COL,
                borderRadius: [4, 4, 0, 0] as unknown as number,
              },
            };
          }),
          animationDuration: 600,
        },
      ],
    };
  }, [aggSlot, selectedSlot]);

  const deviceOption = useMemo((): EChartsOption => {
    const devBad = new Map<string, number>();
    for (const g of aggDevice?.groups ?? []) {
      const d = g.parts.device ?? "—";
      devBad.set(d, (devBad.get(d) ?? 0) + g.count);
    }
    const sorted = [...devBad.entries()].sort((a, b) => a[1] - b[1]).slice(-10);
    const COL = "#79c0ff", COL_B = "#58a6ff", COL_D = "rgba(121,192,255,0.2)";
    return {
      ...horizontalBarChartBase(),
      xAxis: {
        type: "value",
        axisLabel: { color: chartAxisColor },
        splitLine: { lineStyle: { color: chartSplitLine } },
      },
      yAxis: {
        type: "category",
        data: sorted.map(([d]) => d),
        axisLabel: { ...horizontalBarCategoryAxisLabel, interval: 0 },
      },
      series: [
        {
          type: "bar",
          data: sorted.map(([d, v]) => {
            const isSel = selectedDevice !== null && d === selectedDevice;
            return {
              value: v,
              itemStyle: {
                color: isSel ? COL_B : selectedDevice !== null ? COL_D : COL,
                borderRadius: [0, 4, 4, 0] as unknown as number,
              },
            };
          }),
          label: {
            show: true,
            position: "right",
            color: chartAxisColor,
            fontSize: 10,
          },
          animationDuration: 600,
        },
      ],
    };
  }, [aggDevice, selectedDevice]);

  const freeOption = useMemo((): EChartsOption => {
    const sorted = [...(aggFree?.groups ?? [])]
      .sort((a, b) => a.count - b.count)
      .slice(-10);
    return {
      ...horizontalBarChartBase(),
      xAxis: {
        type: "value",
        axisLabel: { color: chartAxisColor },
        splitLine: { lineStyle: { color: chartSplitLine } },
      },
      yAxis: {
        type: "category",
        data: sorted.map((g) => formatGroupLabel(g.parts) || g.key),
        axisLabel: { ...horizontalBarCategoryAxisLabel, interval: 0 },
      },
      series: [
        {
          type: "bar",
          cursor: "default",
          data: sorted.map((g) => g.count),
          itemStyle: { color: "#58a6ff", borderRadius: [0, 4, 4, 0] as unknown as number },
          animationDuration: 600,
        },
      ],
    };
  }, [aggFree]);

  // ── Tree: Device → LOT → ProbeCard Type → CardId ─────────────────────────

  const treeRoots = useMemo(() => {
    if (!aggTree?.groups?.length) return [];
    return buildTree(aggTree.groups, ["device", "lot", "probeCardType", "cardId"]);
  }, [aggTree]);

  // ── Detail rows ──────────────────────────────────────────────────────────

  const detailRows = useMemo(() => {
    if (!list?.rows?.length) return [];
    const mapped = (list.rows as InfcontrolLayerBinV3Row[]).map((r, index) => {
      const yp = computeYieldPct([r]);
      const goodBins = collectGoodBinNumbersFromJbRow(r);
      return {
        row: {
          [JB_DETAIL_LIST_INDEX]: index,
          [JB_DETAIL_GOOD_BINS]: [...goodBins],
          TESTEND:       r.TESTEND ?? "",
          DEVICE:        r.DEVICE ?? "",
          LOT:           r.LOT ?? "",
          SLOT:          r.SLOT ?? "",
          PROBECARDTYPE: r.PROBECARDTYPE ?? "—",
          CARDID:        r.CARDID ?? "",
          PASSID:        r.PASSID ?? "",
          "Yield%":      yp !== null ? `${yp.toFixed(1)}%` : "—",
        },
        yieldSort: yp ?? Number.POSITIVE_INFINITY,
      };
    });
    mapped.sort((a, b) => a.yieldSort - b.yieldSort);
    return mapped.map((m) => m.row);
  }, [list]);

  /** 明细排序后，用 list 行号反查当前表中的选中行 */
  const detailSelectedRowIndex = useMemo(() => {
    if (infCtx?.detailRowIndex == null) return null;
    const i = detailRows.findIndex(
      (r) => Number(r[JB_DETAIL_LIST_INDEX]) === infCtx.detailRowIndex
    );
    return i >= 0 ? i : null;
  }, [detailRows, infCtx?.detailRowIndex]);

  const chips = useMemo(() => activeChips(form, listLimits), [form, listLimits]);
  const hasData = !!(list || aggBin || aggCardType);
  const noTestEndFilter = !form.testEndFrom && !form.testEndTo;

  const listRowsForInf = list?.rows as InfcontrolLayerBinV3Row[] | undefined;

  const openInfFromDrill = useCallback(
    (d: DrillState, clickedKey: string) => {
      if (!queryLotRequired(form)) return;
      const ctx = resolveInfCtxFromDrill(
        d.parentDimKey,
        d.parentDimVal,
        d.subDim,
        clickedKey,
        form,
        listRowsForInf,
        infDutAnchorFromDrill(d),
        d.groups
      );
      if (ctx) setInfCtx(ctx);
    },
    [form, listRowsForInf]
  );

  const closeInfDut = useCallback(() => setInfCtx(null), []);

  /** 关闭下钻面板时，若 DUT 由该下钻打开则一并关闭 */
  const closeDrillPanel = useCallback((parentDimKey: string, before?: () => void) => {
    before?.();
    setDrills((prev) => {
      const n = { ...prev };
      delete n[parentDimKey];
      return n;
    });
    const drillAnchor = infDutAnchorForParentDimKey(parentDimKey);
    if (!drillAnchor) return;
    setInfCtx((prev) => {
      if (!prev) return null;
      return infDutAnchorsMatch(prev.anchor, drillAnchor) ? null : prev;
    });
  }, []);

  const jbReportSections = useMemo(() => {
    if (!hasData) return {};

    const kpiSection = (
      <DraggableReportBlocks
        storageKey="pcr-ai-report:jb-start-kpi-blocks"
        defaultOrder={JB_KPI_BLOCK_ORDER}
        layoutEpoch={layoutEpoch}
        axis="x"
        groupClassName="report-reorder-group--kpis"
        labels={{
          jbWafer: "匹配 Wafer 数",
          jbYieldPct: "综合 Yield%",
          jbWorstType: "最差探针卡类型",
          jbTopBin: "Top 不良 Bin",
        }}
        sections={{
          jbWafer: (
            <KpiCard label="匹配 Wafer 数" value={totalWafers} color="blue" subtext="匹配 Wafer 数" showLabel={false} />
          ),
          jbYieldPct: (
            <KpiCard
              label="综合 Yield%"
              value={overallYield !== null ? `${overallYield.toFixed(1)}%` : null}
              color={
                overallYield !== null
                  ? overallYield >= 95 ? "green" : overallYield >= 80 ? "yellow" : "red"
                  : "white"
              }
              subtext="好品率"
              showLabel={false}
            />
          ),
          jbWorstType: (
            <KpiCard
              label="最差探针卡类型"
              value={worstCardType}
              color="red"
              subtext="坏 die 最多"
              showLabel={false}
            />
          ),
          jbTopBin: (
            <KpiCard
              label="Top 不良 Bin"
              value={topBin}
              color="yellow"
              subtext="全量最高"
              showLabel={false}
            />
          ),
        }}
      />
    );

    const lotYieldSection =
      lotYieldData.length > 0 ? (
        <>
          <div className="report-chart-panel">
            <ChartDrillSplit
            hint={
              <>
                <span>绿≥95% · 黄80–95% · 红&lt;80%</span>
                <span style={{ marginLeft: 8, fontSize: 11, color: "#6e7681" }}>
                  点击条形钻取
                </span>
              </>
            }
            chart={
              <ReactECharts
                option={lotYieldOption}
                style={{
                  height: rankBarChartHeight(lotYieldData.length, 10, "medium"),
                  width: "100%",
                }}
                opts={{ renderer: "canvas" }}
                notMerge
                lazyUpdate
                onEvents={{
                  click: (params: { name: string }) => {
                    const entry = lotYieldData.find((d) => d.label === params.name);
                    if (!entry) return;
                    setSelectedLotLabel(params.name);
                    fetchDrill("lot", entry.lot, "cardId", form);
                  },
                }}
              />
            }
            drill={
              drills["lot"] != null ? (
                <DrillDownPanel
                  chartSize="medium"
                  layout="side"
                  title={`LOT: ${drills["lot"]!.parentDimVal} · 下钻：按 ${drills["lot"]!.subDim}`}
                  groups={drills["lot"]!.groups}
                  loading={drills["lot"]!.loading}
                  error={drills["lot"]!.error}
                  activeSubDim={drills["lot"]!.subDim}
                  subDimOptions={DRILL_FROM_LOT}
                  onSubDimChange={(d) =>
                    fetchDrill("lot", drills["lot"]!.parentDimVal, d, form)
                  }
                  onBarClick={(key) => openInfFromDrill(drills["lot"]!, key)}
                  onClose={() => closeDrillPanel("lot", () => setSelectedLotLabel(null))}
                />
              ) : null
            }
          />
          </div>
          <InfDutAnchorRow
            infCtx={infCtx}
            match={(a) => a.source === "lotYield"}
            apiBase={apiBase}
            onClose={closeInfDut}
          />
        </>
      ) : null;

    const chartsGridSection = (
      <DraggableReportBlocks
        storageKey="pcr-ai-report:jb-start-chart-blocks"
        defaultOrder={JB_CHART_BLOCK_ORDER}
        layoutEpoch={layoutEpoch}
        axis="grid"
        fullRowIds={["jbDevice", "jbBin", "jbPcType", "jbSlot", "jbFreeDim"]}
        groupClassName="report-reorder-group--chartgrid"
        labels={{
          jbDevice: "Device 不良分析",
          jbBin: "不良 BIN 全量排名",
          jbPcType: "ProbeCard Type 不良对比",
          jbSlot: "Slot 趋势（Wafer 间）",
          jbFreeDim: "自由维度聚合",
        }}
        sections={{
          jbDevice: (
            <>
            <div className="report-chart-panel">
              <ChartDrillSplit
                hint="点击 Device 钻取"
                chart={
                  aggDevice ? (
                    <ReactECharts
                      option={deviceOption}
                      style={{
                        height: rankBarChartHeight(aggDevice.groups?.length ?? 0, 10, "medium"),
                        width: "100%",
                      }}
                      opts={{ renderer: "canvas" }}
                      notMerge
                      lazyUpdate
                      onEvents={{
                        click: (params: { name: string }) => {
                          setSelectedDevice(params.name);
                          fetchDrill("device", params.name, "lot", form);
                        },
                      }}
                    />
                  ) : null
                }
                drill={
                  drills["device"] != null ? (
                    <DrillDownPanel
                      chartSize="medium"
                      layout="side"
                      title={`Device: ${drills["device"]!.parentDimVal} · 下钻：按 ${drills["device"]!.subDim}`}
                      groups={drills["device"]!.groups}
                      loading={drills["device"]!.loading}
                      error={drills["device"]!.error}
                      activeSubDim={drills["device"]!.subDim}
                      subDimOptions={DRILL_FROM_DEVICE_JB}
                      onSubDimChange={(d) =>
                        fetchDrill("device", drills["device"]!.parentDimVal, d, form)
                      }
                      onBarClick={(key) => openInfFromDrill(drills["device"]!, key)}
                      onClose={() => closeDrillPanel("device", () => setSelectedDevice(null))}
                    />
                  ) : null
                }
              />
              </div>
              <InfDutAnchorRow
                infCtx={infCtx}
                match={(a) => a.source === "chartsGrid" && a.block === "jbDevice"}
                apiBase={apiBase}
                onClose={closeInfDut}
              />
            </>
          ),
          jbBin: (
            <>
            <div className="report-chart-panel">
              <ChartDrillSplit
                hint="点击钻取"
                chart={
                  aggBin ? (
                    <ReactECharts
                      option={binRankOption}
                      style={{
                        height: rankBarChartHeight(aggBin.groups?.length ?? 0, 10, "medium"),
                        width: "100%",
                      }}
                      opts={{ renderer: "canvas" }}
                      notMerge
                      lazyUpdate
                      onEvents={{
                        click: (params: { name: string }) => {
                          const bin = params.name.replace(/^Bin /, "");
                          setSelectedBin(bin);
                          fetchDrill("bin", bin, "cardId", form);
                        },
                      }}
                    />
                  ) : null
                }
                drill={
                  drills["bin"] != null ? (
                    <DrillDownPanel
                      chartSize="medium"
                      layout="side"
                      title={`Bin ${drills["bin"]!.parentDimVal} · 下钻：按 ${drills["bin"]!.subDim}`}
                      groups={drills["bin"]!.groups}
                      loading={drills["bin"]!.loading}
                      error={drills["bin"]!.error}
                      activeSubDim={drills["bin"]!.subDim}
                      subDimOptions={DRILL_FROM_BIN}
                      onSubDimChange={(d) =>
                        fetchDrill("bin", drills["bin"]!.parentDimVal, d, form)
                      }
                      onBarClick={(key) => openInfFromDrill(drills["bin"]!, key)}
                      onClose={() => closeDrillPanel("bin", () => setSelectedBin(null))}
                    />
                  ) : null
                }
              />
              </div>
              <InfDutAnchorRow
                infCtx={infCtx}
                match={(a) => a.source === "chartsGrid" && a.block === "jbBin"}
                apiBase={apiBase}
                onClose={closeInfDut}
              />
            </>
          ),
          jbPcType: (
            <>
            <div className="report-chart-panel">
              <ChartDrillSplit
                hint="点击类型 → 钻取具体 CardId"
                chart={
                  aggCardType ? (
                    <ReactECharts
                      option={cardTypeOption}
                      style={{
                        height: rankBarChartHeight(
                          new Map(
                            aggCardType.groups?.map((g) => [g.parts.probeCardType, 1]) ?? []
                          ).size,
                          10,
                          "medium"
                        ),
                        width: "100%",
                      }}
                      opts={{ renderer: "canvas" }}
                      notMerge
                      lazyUpdate
                      onEvents={{
                        click: (params: { name: string }) => {
                          setSelectedCardType(params.name);
                          fetchDrill("probeCardType", params.name, "cardId", form);
                        },
                      }}
                    />
                  ) : null
                }
                drill={
                  drills["probeCardType"] != null || drills["cardId"] != null ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, height: "100%" }}>
                      {drills["probeCardType"] != null ? (
                        <DrillDownPanel
                          chartSize="medium"
                          layout="side"
                          title={`Type: ${drills["probeCardType"]!.parentDimVal} · 下钻：按 ${drills["probeCardType"]!.subDim}`}
                          groups={drills["probeCardType"]!.groups}
                          loading={drills["probeCardType"]!.loading}
                          error={drills["probeCardType"]!.error}
                          activeSubDim={drills["probeCardType"]!.subDim}
                          subDimOptions={DRILL_FROM_CARDTYPE}
                          onSubDimChange={(d) =>
                            fetchDrill("probeCardType", drills["probeCardType"]!.parentDimVal, d, form)
                          }
                          onBarClick={(key) => openInfFromDrill(drills["probeCardType"]!, key)}
                          onClose={() =>
                            closeDrillPanel("probeCardType", () => setSelectedCardType(null))
                          }
                        />
                      ) : null}
                      {drills["cardId"] != null ? (
                        <DrillDownPanel
                          chartSize="medium"
                          layout="side"
                          title={`CardId: ${drills["cardId"]!.parentDimVal} · 下钻：按 ${drills["cardId"]!.subDim}`}
                          groups={drills["cardId"]!.groups}
                          loading={drills["cardId"]!.loading}
                          error={drills["cardId"]!.error}
                          activeSubDim={drills["cardId"]!.subDim}
                          subDimOptions={DRILL_FROM_CARD}
                          onSubDimChange={(d) =>
                            fetchDrill("cardId", drills["cardId"]!.parentDimVal, d, form)
                          }
                          onClose={() => setDrills((prev) => { const n = { ...prev }; delete n["cardId"]; return n; })}
                        />
                      ) : null}
                    </div>
                  ) : null
                }
              />
              </div>
              <InfDutAnchorRow
                infCtx={infCtx}
                match={(a) => a.source === "chartsGrid" && a.block === "jbPcType"}
                apiBase={apiBase}
                onClose={closeInfDut}
              />
            </>
          ),
          jbSlot: (
            <>
            <div className="report-chart-panel">
              <ChartDrillSplit
                hint="点击 Slot 钻取；查看 DUT 分布须先在查询条件填写 Lot"
                chart={
                  aggSlot && (aggSlot.groups?.length ?? 0) > 0 ? (
                    <ReactECharts
                      option={slotOption}
                      style={{ height: JB_SLOT_TREND_CHART_HEIGHT, width: "100%" }}
                      opts={{ renderer: "canvas" }}
                      notMerge
                      lazyUpdate
                      onEvents={{
                        click: (params: { name: string }) => {
                          const slotNum = params.name.replace(/^Slot /i, "").trim();
                          setSelectedSlot(params.name);
                          fetchDrill("slot", slotNum, "bin", form);
                          const slotN = parseSlotFromDrillBarLabel(params.name);
                          if (slotN !== null) {
                            const ctx = buildInfCtxForSlot(
                              form,
                              listRowsForInf,
                              slotN,
                              {
                                anchor: { source: "chartsGrid", block: "jbSlot" },
                              }
                            );
                            if (ctx) setInfCtx(ctx);
                          }
                        },
                      }}
                    />
                  ) : aggSlot ? (
                    <p className="muted small">当前筛选下无 Slot 聚合数据</p>
                  ) : null
                }
                drill={
                  drills["slot"] != null ? (
                    <DrillDownPanel
                      chartSize="medium"
                      layout="side"
                      title={`Slot ${drills["slot"]!.parentDimVal} · 下钻：按 ${drills["slot"]!.subDim}`}
                      groups={drills["slot"]!.groups}
                      loading={drills["slot"]!.loading}
                      error={drills["slot"]!.error}
                      activeSubDim={drills["slot"]!.subDim}
                      subDimOptions={DRILL_FROM_SLOT}
                      onSubDimChange={(d) =>
                        fetchDrill("slot", drills["slot"]!.parentDimVal, d, form)
                      }
                      onBarClick={(key) => openInfFromDrill(drills["slot"]!, key)}
                      onClose={() => closeDrillPanel("slot", () => setSelectedSlot(null))}
                    />
                  ) : null
                }
              />
              </div>
              <InfDutAnchorRow
                infCtx={infCtx}
                match={(a) => a.source === "chartsGrid" && a.block === "jbSlot"}
                apiBase={apiBase}
                onClose={closeInfDut}
              />
            </>
          ),
          jbFreeDim: (
            <div className="report-chart-panel">
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 4 }}>
                {FREE_DIMS.map((d) => (
                  <button
                    key={d.value}
                    type="button"
                    className="chip"
                    style={
                      d.value === freeDim
                        ? {
                            background: "rgba(56,139,253,0.2)",
                            borderColor: "#388bfd",
                            color: "#58a6ff",
                          }
                        : undefined
                    }
                    onClick={() => handleFreeDimChange(d.value)}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
              {aggFree && (
                <DarkChart
                  option={freeOption}
                  height={rankBarChartHeight(aggFree.groups?.length ?? 0, 10, "medium")}
                />
              )}
            </div>
          ),
        }}
      />
    );

    const treeSection =
      treeRoots.length > 0 ? (
        <div
          style={{
            background: "#0d1117",
            border: "1px solid rgba(240,246,252,0.1)",
            borderRadius: 8,
            padding: 16,
          }}
        >
          <div
            style={{
              fontSize: 12,
              color: "#8b949e",
              marginBottom: showTree ? 10 : 0,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
              userSelect: "none",
            }}
            onClick={() => setShowTree((s) => !s)}
          >
            <span style={{ fontSize: 10, opacity: 0.6 }}>{showTree ? "▼" : "▶"}</span>
            Device → LOT → ProbeCard Type → CardId
            <span style={{ fontSize: 11, color: "#6e7681", fontWeight: 400 }}>
              {showTree ? "" : `— ${treeRoots.length} 组，点击展开`}
            </span>
          </div>
          {showTree && (
            <TreeTable
              roots={treeRoots}
              totalHeader="坏 die"
              renderExtra={(node, depth) =>
                infcontrolTreeYieldExtra(list?.rows as InfcontrolLayerBinV3Row[], node, depth)
              }
            />
          )}
        </div>
      ) : null;

    const detailSection =
      detailRows.length > 0 ? (
        <>
        <div
          style={{
            background: "#0d1117",
            border: "1px solid rgba(240,246,252,0.1)",
            borderRadius: 8,
            padding: 16,
          }}
        >
          <div
            style={{
              fontSize: 12,
              color: "#8b949e",
              marginBottom: showDetail ? 8 : 0,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
              userSelect: "none",
            }}
            onClick={() => setShowDetail((s) => !s)}
          >
            <span style={{ fontSize: 10, opacity: 0.6 }}>{showDetail ? "▼" : "▶"}</span>
            共 {list?.count ?? 0} 条（含 PROBECARDTYPE / Yield%）· 点击行查看 DUT 分布
          </div>
          {showDetail && (
            <DataTable
              rows={detailRows}
              maxHeight={400}
              selectedRowIndex={detailSelectedRowIndex}
              omitKeys={[JB_DETAIL_LIST_INDEX, JB_DETAIL_GOOD_BINS]}
              columnOrder={[
                "TESTEND",
                "DEVICE",
                "LOT",
                "SLOT",
                "PROBECARDTYPE",
                "CARDID",
                "PASSID",
                "Yield%",
              ]}
              onRowClick={(row) => {
                const device = String(row["DEVICE"] ?? "").trim();
                const lot    = String(row["LOT"]    ?? "").trim();
                const slot   = parseInt(String(row["SLOT"]   ?? ""), 10);
                const passId = parseInt(String(row["PASSID"] ?? ""), 10);
                const cardId = String(row["CARDID"] ?? "").trim() || undefined;
                if (device && lot && Number.isFinite(slot)) {
                  const passIds = Number.isFinite(passId) ? [passId] : [1, 3, 5];
                  const listIdx = Number(row[JB_DETAIL_LIST_INDEX]);
                  const ctx = buildInfCtxForSlot(form, listRowsForInf, slot, {
                    device,
                    lot,
                    passIds,
                    cardId,
                    detailRowIndex: Number.isInteger(listIdx) ? listIdx : undefined,
                    anchor: { source: "detail" },
                    extraGoodBinNumbers: goodBinNumbersFromDetailRow(row),
                  });
                  if (ctx) setInfCtx(ctx);
                }
              }}
            />
          )}
        </div>
        <InfDutAnchorRow
          infCtx={infCtx}
          match={(a) => a.source === "detail"}
          apiBase={apiBase}
          onClose={closeInfDut}
        />
        </>
      ) : null;

    return {
      kpi: kpiSection,
      lotYield: lotYieldSection,
      chartsGrid: chartsGridSection,
      tree: treeSection,
      detail: detailSection,
    };
  }, [
    hasData,
    totalWafers,
    overallYield,
    worstCardType,
    topBin,
    lotYieldData,
    lotYieldOption,
    drills,
    form,
    fetchDrill,
    aggBin,
    binRankOption,
    aggCardType,
    cardTypeOption,
    aggSlot,
    slotOption,
    aggDevice,
    deviceOption,
    selectedDevice,
    aggFree,
    freeOption,
    freeDim,
    handleFreeDimChange,
    treeRoots,
    showTree,
    list,
    detailRows,
    detailSelectedRowIndex,
    showDetail,
    layoutEpoch,
    openInfFromDrill,
    closeInfDut,
    closeDrillPanel,
    listRowsForInf,
    infCtx,
    apiBase,
  ]);

  return (
    <div className="report-panel">
      {/* ── Header ── */}
      <div className="report-panel-header">
        <div>
          <h2>🔬 JB STAR</h2>
          <p className="report-desc">
            Layer BIN data (<code>PASSTYPE = TEST</code>). Single query fetches detail rows + BIN ranking +
            probe card type comparison + slot trend. Click any chart to drill down.
            Yield% is calculated in-browser from <code>bins[].isGoodBin</code> / <code>GROSSDIE</code>.
          </p>
        </div>
      </div>

      <CollapsibleQueryPanel
        storageKey="pcr-ai-report:jb-start-query-open"
        filters={
        <div className="filter-grid">
          {(
            [
              ["Device", "device"],
              ["Lot", "lot"],
              ["Slot", "slot"],
              ["ProbeCard Type", "probeCardType"],
              ["CardId", "cardId"],
              ["TesterID", "testerId"],
              ["PassID", "passId"],
              ["MES Slot", "meslot"],
            ] as [string, keyof FormState][]
          ).map(([label, key]) => (
            <label key={key}>
              <span>{label}</span>
              <input
                type="text"
                value={form[key]}
                onChange={(e) => setField(key, e.target.value)}
                placeholder="留空不筛"
              />
            </label>
          ))}

          <label>
            <span>Tester Type</span>
            <select
              value={form.tstype}
              onChange={(e) => setField("tstype", e.target.value)}
            >
              <option value="">全部</option>
              {TSTYPE_OPTIONS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </label>

          <label className="span-2">
            <span>测试结束时间（testEnd）</span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="datetime-local"
              value={form.testEndFrom}
              onChange={(e) => setField("testEndFrom", e.target.value)}
              style={{ flex: 1 }}
            />
            <span style={{ color: "#8b949e", fontSize: 12 }}>→</span>
            <input
              type="datetime-local"
              value={form.testEndTo}
              onChange={(e) => setField("testEndTo", e.target.value)}
              style={{ flex: 1 }}
            />
          </div>
          <div className="preset-chips" style={{ marginTop: 6 }}>
            {(
              [
                ["今天", dateShortcutToday],
                ["近7天", dateShortcutLast7Days],
                ["本月", dateShortcutThisMonth],
              ] as const
            ).map(([lbl, fn]) => (
              <button
                key={lbl}
                type="button"
                className="chip"
                onClick={() => applyDateShortcut(fn)}
              >
                {lbl}
              </button>
            ))}
          </div>
        </label>
        </div>
        }
        footer={
          <>
            {chips.length > 0 && (
              <div className="query-panel-chips">
              <span className="query-panel-chips-label">生效筛选：</span>
              {chips.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  className="query-chip"
                  onClick={() => clearFilter(c.key)}
                >
                  {c.label} ✕
                </button>
              ))}
            </div>
          )}
          <div className="query-panel-actions-buttons">
            <button
              type="button"
              className="btn primary query-panel-submit"
              disabled={loadingList || loadingAgg}
              onClick={query}
            >
              {loadingList || loadingAgg ? "查询中…" : "查询"}
            </button>
            <button
              type="button"
              className="btn ghost query-panel-clear"
              disabled={loadingList || loadingAgg}
              onClick={clearAll}
            >
              清空
            </button>
            {hasData ? (
              <ReportLayoutResetButton onReset={resetReportLayout} />
            ) : null}
          </div>
          </>
        }
      />

      {(errorList || errorAgg) && (
        <div
          style={{
            color: "#ff7b72",
            fontSize: 13,
            background: "rgba(248,81,73,0.08)",
            padding: "8px 12px",
            borderRadius: 6,
          }}
        >
          {errorList || errorAgg}
        </div>
      )}

      {noTestEndFilter && !loadingList ? (
        <p className="field-hint" style={{ margin: "0 0 8px" }}>
          未设置 testEnd 时间时，API 默认统计近 <strong>1 年</strong>匹配行；图表聚合较慢，与明细 limit 无关。建议先点「近7天」或「本月」再查询。
        </p>
      ) : null}

      {loadingAgg && list ? (
        <p className="field-hint" style={{ margin: "0 0 8px" }}>
          明细已返回（limit={listLimits.defaultLimit}）；图表聚合仍在加载（Oracle 全量匹配行统计）…
        </p>
      ) : null}

      {hasData && (
        <DraggableReportSections
          storageKey="pcr-ai-report:jb-start-modules"
          defaultOrder={JB_REPORT_SECTION_ORDER}
          sections={jbReportSections}
          layoutEpoch={layoutEpoch}
        />
      )}
    </div>
  );
}
