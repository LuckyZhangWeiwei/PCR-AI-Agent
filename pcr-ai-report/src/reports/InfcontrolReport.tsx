import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
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
import { DataTable } from "../components/DataTable";
import {
  DraggableReportBlocks,
  DraggableReportSections,
  JB_START_LAYOUT_STORAGE_KEYS,
  ReportLayoutResetButton,
  resetReportLayoutStorage,
} from "../components/DraggableReportSections";
import { DrillDownPanel } from "../components/DrillDownPanel";
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
import { datetimeLocalToIso, formatDatetimeChinaTime } from "../utils/datetimeLocal";
import { drillFromTree, storeDrillTab } from "../utils/drillAggregate";
import {
  collectGoodBinNumbersFromJbRow,
  HARD_GOOD_BIN,
  JB_DETAIL_GOOD_BINS,
  JB_DETAIL_LIST_INDEX,
  parseBinLabelNumber,
} from "../utils/infGoodBins";
import {
  buildInfDutCtxFromDetailListIndices,
  buildInfDutCtxFromDrillBarKeys,
  normalizeBinToken,
  sameDeviceLot,
  waferSpecFromJbRow,
  type InfDutAnchor,
  type InfDutSelectionCtx,
  type InfDutWaferSpec,
} from "../utils/infDutSelection";
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
  mask: string;
  lot: string;
  slot: string;
  probeCardType: string;
  cardId: string;
  tstype: string;
  testerId: string;
  bins: string;
  passId: string;
  meslot: string;
  testEndFrom: string;
  testEndTo: string;
};

const initialForm: FormState = {
  device: "",
  mask: "",
  lot: "",
  slot: "",
  probeCardType: "",
  cardId: "",
  tstype: "",
  testerId: "",
  bins: "",
  passId: "",
  meslot: "",
  testEndFrom: "",
  testEndTo: "",
};

function buildCoreParams(f: FormState): Record<string, string | number | undefined> {
  return {
    device:        f.device        || undefined,
    mask:          f.mask          || undefined,
    lot:           f.lot           || undefined,
    slot:          f.slot          ? Number(f.slot)   : undefined,
    probeCardType: f.probeCardType || undefined,
    cardId:        f.cardId        || undefined,
    tstype:        f.tstype        || undefined,
    testerId:      f.testerId      || undefined,
    bins:          f.bins          || undefined,
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


const JB_REPORT_SECTION_ORDER = [
  "kpi",
  "funnel",
  "device",
  "lotYield",
  "pcType",
  "tree",
  "detail",
] as const;

const JB_KPI_BLOCK_ORDER = ["jbDevice", "jbLot", "jbWorstType", "jbWorstCard", "jbTopBin"] as const;


// Sub-dimension options per parent drill
const DRILL_FROM_DEVICE_JB: { label: string; value: string }[] = [
  { label: "LOT",      value: "lot"      },
  { label: "CardId",   value: "cardId"   },
  { label: "BinNo#",   value: "bin"      },
  { label: "Hostname", value: "testerId" },
];

const DRILL_FROM_CARDTYPE: { label: string; value: string }[] = [
  { label: "CardId", value: "cardId" },
  { label: "Device", value: "device" },
  { label: "Bin",    value: "bin"    },
  { label: "Lot",    value: "lot"    },
];

const DRILL_FROM_CARD: { label: string; value: string }[] = [
  { label: "Slot",   value: "slot"   },
  { label: "Bin",    value: "bin"    },
  { label: "Device", value: "device" },
  { label: "Lot",    value: "lot"    },
];


const DRILL_FROM_LOT: { label: string; value: string }[] = [
  { label: "CardId",  value: "cardId"  },
  { label: "Slot",    value: "slot"    },
  { label: "Bin",     value: "bin"     },
  { label: "PassId",  value: "passId"  },
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
const TREE_DRILL_DIMS = new Set(["mask", "device", "lot", "probeCardType", "cardId", "bin"]);

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
    case "mask": {
      const dev = String(row.DEVICE ?? "").trim();
      if (!dev) return false;
      return dev.slice(-4).toUpperCase() === val.toUpperCase();
    }
    case "bin":
      return true;
    default:
      return true;
  }
}

function jbRowDimValue(row: InfcontrolLayerBinV3Row, dim: string): string | undefined {
  switch (dim) {
    case "mask": {
      const m = row.MASK;
      if (m != null && String(m).trim()) return String(m).trim();
      const dev = String(row.DEVICE ?? "").trim();
      return dev ? dev.slice(-4).toUpperCase() : undefined;
    }
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
    case "testerId":
      return String(row.TESTERID ?? "").trim() || undefined;
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
    const label  = `${lot}__P${passId}__S${slot}`;
    result.push({ lot, passId, slot, device, label, yieldPct: yp });
    void key;
  }
  return result.sort((a, b) => a.yieldPct - b.yieldPct);
}

function topBadBinForLot(
  groups: AggregateGroup[] | undefined,
  lotValue: string,
  lotTotalBad: number,
): { bin: string; pct: number } | null {
  if (!groups?.length || !lotValue || lotTotalBad <= 0) return null;
  const binTotals = new Map<string, number>();
  for (const g of groups) {
    if (g.parts.lot !== lotValue) continue;
    const bin = g.parts.bin;
    if (!bin) continue;
    if (parseBinLabelNumber(bin) === HARD_GOOD_BIN) continue;
    binTotals.set(bin, (binTotals.get(bin) ?? 0) + g.count);
  }
  if (binTotals.size === 0) return null;
  let topBin = "";
  let topCount = 0;
  for (const [bin, count] of binTotals) {
    if (count > topCount) { topCount = count; topBin = bin; }
  }
  const binNum = parseBinLabelNumber(topBin);
  const binLabel = binNum !== null ? `BIN${binNum}` : topBin.toUpperCase();
  return { bin: binLabel, pct: Math.round((topCount / lotTotalBad) * 100) };
}

function infcontrolTreeYieldExtra(
  rows: InfcontrolLayerBinV3Row[] | undefined,
  aggGroups: AggregateGroup[] | undefined,
  node: TreeNode,
  depth: number,
): ReactNode {
  void depth;
  const device = node.dimKey === "device" ? node.dimValue : undefined;
  const lot = node.dimKey === "lot" ? node.dimValue : undefined;
  if (!device && !lot) return null;
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
  const topBin = lot ? topBadBinForLot(aggGroups, lot, node.total) : null;
  return (
    <span style={{ fontSize: 11, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
      {[...byPass.entries()].map(([p, rs]) => {
        const yp = computeYieldPct(rs);
        if (yp === null) return null;
        return (
          <span key={p} style={{ color: yieldColor(yp) }}>
            P{p} {yp.toFixed(1)}%
          </span>
        );
      })}
      {topBin && (
        <span style={{ color: "#e0824a", opacity: 0.85 }}>
          · 主坏{topBin.bin}({topBin.pct}%)
        </span>
      )}
    </span>
  );
}

type InfCtx = InfDutSelectionCtx | null;

function infDutAnchorForParentDimKey(parentDimKey: string): InfDutAnchor | null {
  switch (parentDimKey) {
    case "lot":
      return { source: "lotYield" };
    case "device":
      return { source: "chartsGrid", block: "jbDevice" };
    case "bin":
      return { source: "binDist" };
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
        wafers={infCtx.wafers}
        device={infCtx.device}
        lot={infCtx.lot}
        selectionSummary={infCtx.selectionSummary}
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

/** 从 BIN 下钻到 slot 时按 lot+slot 聚合，条形上显示 LOT。 */
function drillSubDimKeysForFetch(parentDimKey: string, subDim: string): string[] {
  const parts = subDim.split(",").map((s) => s.trim()).filter(Boolean);
  if (parentDimKey === "bin" && parts.length === 1 && parts[0] === "slot") {
    return jbAggregateGroupBy("lot", "slot").split(",");
  }
  return jbAggregateGroupBy(...parts).split(",");
}

/**
 * API always returns (dim, bin) pairs because infcontrol aggregate requires bin.
 * When the user's intended sub-dim doesn't include bin, sum across all bins
 * so each bar represents the total for that dimension value.
 */
function reAggByUserDims(groups: AggregateGroup[], userDims: string[]): AggregateGroup[] {
  if (userDims.includes("bin") || userDims.length === 0) return groups;
  const sums = new Map<string, number>();
  const partsMap = new Map<string, Record<string, string>>();
  for (const g of groups) {
    const sub: Record<string, string> = {};
    for (const k of userDims) sub[k] = g.parts[k] ?? "";
    const key = userDims.map(k => sub[k]).join("\x00");
    sums.set(key, (sums.get(key) ?? 0) + g.count);
    if (!partsMap.has(key)) partsMap.set(key, sub);
  }
  return [...sums.entries()]
    .map(([key, count]) => ({ key, count, parts: partsMap.get(key)! }))
    .sort((a, b) => b.count - a.count);
}

// ── Funnel drill-down ─────────────────────────────────────────────────────────

type FunnelChainStep = { level: string; value: string };

const FUNNEL_LEVEL_DEFS: ReadonlyArray<{ key: string; label: string; color: string }> = [
  { key: "mask",   label: "Mask",      color: "#79c0ff" },
  { key: "device", label: "Device",    color: "#d2a8ff" },
  { key: "lot",    label: "Lot",       color: "#3fb950" },
  { key: "passId", label: "Pass",      color: "#ff7b72" },
  { key: "slot",   label: "Wafer ID",  color: "#e6b450" },
  { key: "cardId", label: "ProbeCard", color: "#58a6ff" },
];

function funnelBadDie(row: InfcontrolLayerBinV3Row): number {
  if (!Array.isArray(row.bins)) return 0;
  return row.bins.reduce((s, b) => (b.isGoodBin ? s : s + (b.value ?? 0)), 0);
}

function funnelFilter(
  rows: InfcontrolLayerBinV3Row[],
  chain: FunnelChainStep[],
): InfcontrolLayerBinV3Row[] {
  return chain.reduce<InfcontrolLayerBinV3Row[]>((acc, { level, value }) => {
    switch (level) {
      case "mask":   return acc.filter(r => (jbRowDimValue(r, "mask") ?? "") === value);
      case "device": return acc.filter(r => String(r.DEVICE ?? "").trim() === value);
      case "lot":    return acc.filter(r => String(r.LOT ?? "").trim() === value);
      case "slot":   return acc.filter(r => String(r.SLOT ?? "") === value);
      case "passId": return acc.filter(r => String(r.PASSID ?? "") === value);
      case "cardId": return acc.filter(r => String(r.CARDID ?? "").trim() === value);
      default:       return acc;
    }
  }, rows);
}

type FunnelBarItem = { value: string; badDie: number; waferCount: number; extraLabel: string };

function computeFunnelBars(rows: InfcontrolLayerBinV3Row[], levelKey: string): FunnelBarItem[] {
  const groups = new Map<string, InfcontrolLayerBinV3Row[]>();
  for (const row of rows) {
    let key: string | undefined;
    switch (levelKey) {
      case "mask":   key = jbRowDimValue(row, "mask"); break;
      case "device": key = String(row.DEVICE ?? "").trim() || undefined; break;
      case "lot":    key = String(row.LOT ?? "").trim() || undefined; break;
      case "slot":   key = row.SLOT != null ? String(row.SLOT) : undefined; break;
      case "passId": key = row.PASSID != null ? String(row.PASSID) : undefined; break;
      case "cardId": key = String(row.CARDID ?? "").trim() || undefined; break;
    }
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }
  return [...groups.entries()]
    .map(([value, gRows]) => {
      const badDie = gRows.reduce((s, r) => s + funnelBadDie(r), 0);
      const keynums = new Set(gRows.map(r => r.KEYNUMBER).filter((n): n is number => n != null));
      let extraLabel = "";
      if (levelKey === "lot") {
        const testers = [...new Set(gRows.map(r => String(r.TESTERID ?? "").trim()).filter(Boolean))];
        extraLabel = testers.join(" / ") || "—";
      } else if (levelKey === "slot") {
        const yp = computeYieldPct(gRows);
        extraLabel = yp != null ? `${yp.toFixed(1)}%` : "—";
      } else if (levelKey === "passId") {
        const cards = new Set(gRows.map(r => String(r.CARDID ?? "").trim()).filter(Boolean));
        extraLabel = `${cards.size} card${cards.size !== 1 ? "s" : ""}`;
      } else if (levelKey === "cardId") {
        const binBad = new Map<string, number>();
        for (const r of gRows) {
          if (!Array.isArray(r.bins)) continue;
          for (const b of r.bins) {
            if (b.isGoodBin) continue;
            const n = String(b.n ?? ""); if (!n) continue;
            binBad.set(n, (binBad.get(n) ?? 0) + (b.value ?? 0));
          }
        }
        if (binBad.size > 0) {
          const top = [...binBad.entries()].sort((a, b) => b[1] - a[1])[0][0];
          extraLabel = `Top BIN${top}`;
        }
      }
      return { value, badDie, waferCount: keynums.size, extraLabel };
    })
    .sort((a, b) => b.badDie - a.badDie);
}

// FUNNEL_LEVEL_DEFS index at which a fresh DB fetch is used instead of list.rows
const FUNNEL_DB_FETCH_FROM = 3; // passId (index 3) and deeper

function FunnelDrillSection({
  rows, chain, onChainChange, apiBase,
  lotRows, lotLoading, lotError,
}: {
  rows: InfcontrolLayerBinV3Row[];
  chain: FunnelChainStep[];
  onChainChange: (chain: FunnelChainStep[]) => void;
  apiBase: string;
  lotRows: InfcontrolLayerBinV3Row[] | null;
  lotLoading: boolean;
  lotError: string | null;
}) {
  const isDut = chain.length >= FUNNEL_LEVEL_DEFS.length;
  const levelDef = isDut ? undefined : FUNNEL_LEVEL_DEFS[chain.length];

  // For slot/passId/probecard levels: use freshly-fetched lotRows (all wafers, no limit).
  // For mask/device/lot levels: derive from existing list.rows.
  const filteredRows = useMemo(() => {
    if (chain.length >= FUNNEL_DB_FETCH_FROM && lotRows !== null) {
      // lotRows already filtered to device+lot by the API call;
      // apply only the slot/passId/cardId steps from the chain
      return funnelFilter(lotRows, chain.slice(FUNNEL_DB_FETCH_FROM));
    }
    return funnelFilter(rows, chain);
  }, [rows, lotRows, chain]);

  const bars = useMemo(
    () => {
      if (isDut || !levelDef) return [];
      if (chain.length >= FUNNEL_DB_FETCH_FROM && (lotLoading || lotError)) return [];
      return computeFunnelBars(filteredRows, levelDef.key);
    },
    [filteredRows, levelDef, isDut, chain.length, lotLoading, lotError],
  );

  const { chartOption, displayItems } = useMemo((): { chartOption: EChartsOption; displayItems: FunnelBarItem[] } => {
    if (!levelDef || !bars.length) return { chartOption: {}, displayItems: [] };
    const color = levelDef.color;

    if (levelDef.key === "slot") {
      const sorted = [...bars].sort((a, b) => Number(a.value) - Number(b.value));
      return {
        displayItems: sorted,
        chartOption: {
          ...horizontalBarChartBase(),
          grid: verticalBarChartGrid,
          tooltip: {
            trigger: "axis",
            backgroundColor: "#161b22",
            borderColor: "#30363d",
            textStyle: { color: "#e6edf3", fontSize: 12 },
            formatter: (p: unknown) => {
              const d = sorted[(p as Array<{ dataIndex: number }>)[0].dataIndex];
              return d ? `Wafer ID: <b>${d.value}</b><br/>Bad die: <b>${d.badDie}</b><br/>Yield: ${d.extraLabel}` : "";
            },
          },
          xAxis: {
            type: "category",
            data: sorted.map(d => d.value),
            axisLabel: { color: chartAxisColor, fontSize: 10, rotate: 30 },
          },
          yAxis: {
            type: "value",
            axisLabel: { color: chartAxisColor },
            splitLine: { lineStyle: { color: chartSplitLine } },
          },
          series: [{
            type: "bar",
            data: sorted.map(d => ({ value: d.badDie, itemStyle: { color, borderRadius: [4, 4, 0, 0] as unknown as number } })),
            animationDuration: 600,
          }],
        },
      };
    }

    const sorted = [...bars].sort((a, b) => a.badDie - b.badDie).slice(-20);
    const extraKey = levelDef.key === "lot" ? "机台"
      : levelDef.key === "passId" ? "Cards"
      : levelDef.key === "cardId" ? "Top Bin"
      : undefined;
    return {
      displayItems: sorted,
      chartOption: {
        ...horizontalBarChartBase(),
        tooltip: {
          trigger: "axis",
          backgroundColor: "#161b22",
          borderColor: "#30363d",
          textStyle: { color: "#e6edf3", fontSize: 12 },
          formatter: (p: unknown) => {
            const d = sorted[(p as Array<{ dataIndex: number }>)[0].dataIndex];
            if (!d) return "";
            const lines = [
              `${levelDef.label}: <b>${d.value}</b>`,
              `Bad die: <b>${d.badDie}</b>`,
              `Wafers: ${d.waferCount}`,
            ];
            if (d.extraLabel && extraKey) lines.push(`${extraKey}: ${d.extraLabel}`);
            return lines.join("<br/>");
          },
        },
        xAxis: {
          type: "value",
          axisLabel: { color: chartAxisColor },
          splitLine: { lineStyle: { color: chartSplitLine } },
        },
        yAxis: {
          type: "category",
          data: sorted.map(d => d.value),
          axisLabel: { ...horizontalBarCategoryAxisLabel, interval: 0 },
        },
        series: [{
          type: "bar",
          data: sorted.map(d => ({ value: d.badDie, itemStyle: { color, borderRadius: [0, 4, 4, 0] as unknown as number } })),
          label: { show: true, position: "right", color: chartAxisColor, fontSize: 10 },
          animationDuration: 600,
        }],
      },
    };
  }, [bars, levelDef]);

  const handleBarClick = useCallback(
    (params: { dataIndex: number }) => {
      if (isDut || !levelDef) return;
      const item = displayItems[params.dataIndex];
      if (!item) return;
      onChainChange([...chain, { level: levelDef.key, value: item.value }]);
    },
    [displayItems, chain, isDut, levelDef, onChainChange],
  );

  const { dutWafers, dutDevice, dutLot, dutGoodBins } = useMemo(() => {
    const empty = { dutWafers: [] as InfDutWaferSpec[], dutDevice: "", dutLot: "", dutGoodBins: new Set<number>([HARD_GOOD_BIN]) };
    if (!isDut || !filteredRows.length) return empty;
    const deviceStep = chain.find(s => s.level === "device");
    const lotStep    = chain.find(s => s.level === "lot");
    if (!deviceStep || !lotStep) return empty;
    const waferMap = new Map<string, InfDutWaferSpec>();
    const goodBins = new Set<number>([HARD_GOOD_BIN]);
    for (const row of filteredRows) {
      const spec = waferSpecFromJbRow(row);
      if (!spec) continue;
      const key = `${spec.device}|${spec.lot}|${spec.slot}`;
      const ex = waferMap.get(key);
      if (!ex) {
        waferMap.set(key, { ...spec, passIds: [...spec.passIds] });
      } else {
        for (const p of spec.passIds) { if (!ex.passIds.includes(p)) ex.passIds.push(p); }
      }
      for (const n of collectGoodBinNumbersFromJbRow(row)) goodBins.add(n);
    }
    return { dutWafers: [...waferMap.values()], dutDevice: deviceStep.value, dutLot: lotStep.value, dutGoodBins: goodBins };
  }, [isDut, filteredRows, chain]);

  const chartHeight = !levelDef ? 0
    : levelDef.key === "slot"
      ? JB_SLOT_TREND_CHART_HEIGHT
      : rankBarChartHeight(Math.min(bars.length, 20), 20, "medium");

  return (
    <div className="funnel-section">
      {/* Step chain */}
      <div className="funnel-steps">
        {FUNNEL_LEVEL_DEFS.map((def, idx) => {
          const step = chain[idx];
          const isCurrent  = idx === chain.length && !isDut;
          const isCompleted = idx < chain.length;
          const isFuture   = !isCompleted && !isCurrent;
          return (
            <Fragment key={def.key}>
              {idx > 0 && <span className="funnel-arrow">›</span>}
              <button
                type="button"
                className={
                  "funnel-step" +
                  (isCompleted ? " funnel-step--done"   : "") +
                  (isCurrent   ? " funnel-step--active" : "") +
                  (isFuture    ? " funnel-step--future" : "")
                }
                style={(isCompleted || isCurrent) ? ({ "--step-color": def.color } as CSSProperties) : undefined}
                onClick={isCompleted ? () => onChainChange(chain.slice(0, idx)) : undefined}
                disabled={isFuture}
              >
                <span className="funnel-step-name">{def.label}</span>
                {step && <span className="funnel-step-val">{step.value}</span>}
                {isCurrent && !step && <span className="funnel-step-selecting">▼ 选择中</span>}
              </button>
            </Fragment>
          );
        })}
        {isDut && (
          <Fragment key="dut">
            <span className="funnel-arrow">›</span>
            <button type="button" className="funnel-step funnel-step--active" style={{ "--step-color": "#ff9500" } as CSSProperties} disabled>
              <span className="funnel-step-name">DUT × BIN</span>
            </button>
          </Fragment>
        )}
      </div>

      {/* Header row */}
      <div className="funnel-chart-header">
        <span className="funnel-chart-title">
          {isDut
            ? `DUT × BIN — ${chain.map(s => s.value).join(" › ")}`
            : chain.length === 0
              ? "点击条形开始钻取"
              : `${chain.map(s => s.value).join(" › ")} — 选择 ${levelDef?.label ?? ""}`
          }
        </span>
        {chain.length > 0 && (
          <button type="button" className="funnel-back-btn" onClick={() => onChainChange(chain.slice(0, -1))}>
            ← 返回上一级
          </button>
        )}
      </div>

      {/* Chart */}
      {!isDut && levelDef && (
        chain.length >= FUNNEL_DB_FETCH_FROM && lotLoading ? (
          <p className="muted small" style={{ margin: "12px 0" }}>正在从数据库加载批次所有 Wafer…</p>
        ) : chain.length >= FUNNEL_DB_FETCH_FROM && !!lotError ? (
          <p style={{ color: "#ff7b72", fontSize: 12, margin: "12px 0" }}>{lotError}</p>
        ) : displayItems.length > 0 ? (
          <div className="report-chart-panel">
            <ReactECharts
              option={chartOption}
              style={{ height: chartHeight, width: "100%" }}
              opts={{ renderer: "canvas" }}
              notMerge
              lazyUpdate
              onEvents={{ click: handleBarClick }}
            />
          </div>
        ) : (
          <p className="muted small" style={{ margin: "12px 0" }}>当前筛选下无数据</p>
        )
      )}

      {/* DUT panel */}
      {isDut && dutWafers.length > 0 && (
        <div className="inf-dut-standalone-row">
          <InfDutDistPanel
            wafers={dutWafers}
            device={dutDevice}
            lot={dutLot}
            selectionSummary={chain.map(s => s.value).join(" › ")}
            goodBinNumbers={dutGoodBins}
            apiBase={apiBase}
            onClose={() => onChainChange(chain.slice(0, -1))}
          />
        </div>
      )}
      {isDut && dutWafers.length === 0 && (
        <p className="muted small" style={{ margin: "12px 0" }}>无法构建 DUT 上下文（需要 device 及 lot 路径）</p>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export function InfcontrolReport({ apiBase, listLimits }: Props) {
  const [form, setForm] = useState<FormState>(initialForm);
  const [list,        setList]        = useState<InfcontrolLayerBinsV3Response | null>(null);
  const [aggBin,      setAggBin]      = useState<InfcontrolAggregateBlock | null>(null);
  // probeCardType,bin aggregate — chart shows type-level; cardId accessed via drill
  const [aggCardType, setAggCardType] = useState<InfcontrolAggregateBlock | null>(null);
  const [aggTree,     setAggTree]     = useState<InfcontrolAggregateBlock | null>(null);
  const [aggDevice,   setAggDevice]   = useState<InfcontrolAggregateBlock | null>(null);

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
  const [selectedCardType, setSelectedCardType] = useState<string | null>(null);
  const [selectedDevice,   setSelectedDevice]   = useState<string | null>(null);
  const [infCtx, setInfCtx] = useState<InfCtx>(null);
  const [detailSelectedListIndices, setDetailSelectedListIndices] = useState<
    Set<number>
  >(() => new Set());
  const [drillBarSelectedKeys, setDrillBarSelectedKeys] = useState<
    Record<string, Set<string>>
  >({});
  const [selectionHint, setSelectionHint] = useState<string | null>(null);
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  const [showMore, setShowMore] = useState(false);
  const [funnelChain, setFunnelChain] = useState<FunnelChainStep[]>([]);
  const [funnelLotRows,    setFunnelLotRows]    = useState<InfcontrolLayerBinV3Row[] | null>(null);
  const [funnelLotLoading, setFunnelLotLoading] = useState(false);
  const [funnelLotError,   setFunnelLotError]   = useState<string | null>(null);

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
    setAggTree(null);
    setAggDevice(null);
    setDrills({});
    drillCacheRef.current = {};
    setSelectedLotLabel(null);
    setSelectedCardType(null);
    setSelectedDevice(null);
    setInfCtx(null);
    setDetailSelectedListIndices(new Set());
    setDrillBarSelectedKeys({});
    setSelectionHint(null);
    setErrorList(null);
    setErrorAgg(null);
    setLoadingList(false);
    setLoadingAgg(false);
    setFunnelChain([]);
    setFunnelLotRows(null);
    setFunnelLotLoading(false);
    setFunnelLotError(null);
  }, []);

  // Extract device+lot from funnel chain so the effect only re-runs when they actually change
  const funnelDeviceVal = useMemo(
    () => funnelChain.find(s => s.level === "device")?.value,
    [funnelChain],
  );
  const funnelLotVal = useMemo(
    () => funnelChain.find(s => s.level === "lot")?.value,
    [funnelChain],
  );

  // Fetch all rows for the selected device+lot from DB (no limit) when drilling to slot level
  useEffect(() => {
    if (!funnelDeviceVal || !funnelLotVal) {
      setFunnelLotRows(null);
      setFunnelLotError(null);
      setFunnelLotLoading(false);
      return;
    }
    let cancelled = false;
    setFunnelLotLoading(true);
    setFunnelLotError(null);
    setFunnelLotRows(null);
    apiGetJson<InfcontrolLayerBinsV3Response>(apiBase, INFCONTROL_COMBINED_PATH, {
      device: funnelDeviceVal,
      lot: funnelLotVal,
      limit: 2000,
    })
      .then(res => { if (!cancelled) setFunnelLotRows((res.rows ?? []) as InfcontrolLayerBinV3Row[]); })
      .catch(e  => { if (!cancelled) setFunnelLotError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setFunnelLotLoading(false); });
    return () => { cancelled = true; };
  }, [funnelDeviceVal, funnelLotVal, apiBase]);

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
      // User-intended dimensions (without the API-forced bin).
      // Used to re-aggregate (dim,bin) pairs into totals per dim.
      const userDims = subDim.split(",").map(s => s.trim()).filter(Boolean);
      const listRows = (list?.rows ?? []) as InfcontrolLayerBinV3Row[];

      setDrillBarSelectedKeys((prev) => ({
        ...prev,
        [parentDimKey]: new Set<string>(),
      }));
      const drillAnchorOnFetch = infDutAnchorForParentDimKey(parentDimKey);
      if (drillAnchorOnFetch) {
        setInfCtx((prev) =>
          prev && infDutAnchorsMatch(prev.anchor, drillAnchorOnFetch) ? null : prev
        );
      }

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
        const groups = reAggByUserDims(
          drillFromTree(treeGroups, parentDimKey, parentDimVal, subDimKeys),
          userDims,
        );
        if (groups.length > 0) {
          storeDrillTab(parentDimKey, parentDimVal, subDim, groups, drillCacheRef, setDrills);
          return;
        }
        // Zero results → value not in cached rows → fall through below.
      }

      // ── In-memory path: derive from cached list rows (no Oracle call) ─────────
      if (listRows.length > 0) {
        const fromList = reAggByUserDims(
          drillFromJbListRows(listRows, parentDimKey, parentDimVal, subDimKeys),
          userDims,
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
          groups = drillFromJbListRows(listRows, parentDimKey, parentDimVal, subDimKeys);
        }

        // Re-aggregate: sum (dim, bin) pairs into totals per user-intended dim
        groups = reAggByUserDims(groups, userDims);

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


  const query = useCallback(async () => {
    setLoadingList(true);
    setLoadingAgg(true);
    setErrorList(null);
    setErrorAgg(null);
    setDrills({});
    drillCacheRef.current = {};
    setSelectedLotLabel(null);
    setSelectedCardType(null);
    setList(null);
    setAggBin(null);
    setAggCardType(null);
    setAggTree(null);
    setAggDevice(null);
    setSelectedDevice(null);
    setInfCtx(null);
    setDetailSelectedListIndices(new Set());
    setDrillBarSelectedKeys({});
    setSelectionHint(null);

    try {
      const res = await apiGetJson<InfcontrolCombinedResponse>(
        apiBase,
        INFCONTROL_COMBINED_PATH,
        {
          ...buildListParams(form, listLimits),
          aggs: [
            `${jbAggregateGroupBy("bin")}:30`,
            `${jbAggregateGroupBy("probeCardType")}:25`,
            `${jbAggregateGroupBy("device", "lot", "probeCardType", "cardId")}:1000`,
            `${jbAggregateGroupBy("device")}:30`,
          ].join("|"),
        }
      );
      setList(res);
      setAggBin(res.aggregates[jbAggregateGroupBy("bin")] ?? null);
      setAggCardType(res.aggregates[jbAggregateGroupBy("probeCardType")] ?? null);
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

  }, [apiBase, form, listLimits]);

  // ── KPI derivations ──────────────────────────────────────────────────────

  const deviceSummary = useMemo(() => {
    if (!list?.rows?.length) return null;
    const rows = list.rows as InfcontrolLayerBinV3Row[];
    const devices = new Set(rows.map((r) => String(r.DEVICE ?? "").trim()).filter(Boolean));
    if (devices.size === 0) return null;
    if (devices.size === 1) return [...devices][0];
    return `${devices.size} devices`;
  }, [list?.rows]);

  const lotSummary = useMemo(() => {
    if (!list?.rows?.length) return null;
    const rows = list.rows as InfcontrolLayerBinV3Row[];
    const lots = new Set(rows.map((r) => String(r.LOT ?? "").trim()).filter(Boolean));
    if (lots.size === 0) return null;
    if (lots.size === 1) return [...lots][0];
    return `${lots.size} lots`;
  }, [list?.rows]);

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

  const worstCardId = useMemo(() => {
    const groups = aggTree?.groups ?? [];
    if (!groups.length) return null;
    const cardBad = new Map<string, number>();
    for (const g of groups) {
      const c = g.parts.cardId;
      if (!c) continue;
      cardBad.set(c, (cardBad.get(c) ?? 0) + g.count);
    }
    if (cardBad.size === 0) return null;
    return [...cardBad.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }, [aggTree]);

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
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        backgroundColor: "#161b22",
        borderColor: "#30363d",
        textStyle: { color: "#e6edf3", fontSize: 12 },
        formatter: (params: unknown) => {
          const p = (params as Array<{ dataIndex: number }>)[0];
          const d = data[p.dataIndex];
          if (!d) return "";
          return [
            `LOT: <b>${d.lot}</b>`,
            d.device ? `Device: ${d.device}` : null,
            `Pass: P${d.passId}`,
            d.slot ? `Wafer ID: 1-${d.slot}` : null,
            `Yield: <b style="color:${yieldColor(d.yieldPct)}">${d.yieldPct.toFixed(1)}%</b>`,
          ].filter(Boolean).join("<br/>");
        },
      },
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
        data: data.map((d) => d.lot),
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


  // ── Tree: Mask → Device → LOT → ProbeCard Type → CardId ─────────────────

  const treeRoots = useMemo(() => {
    if (!aggTree?.groups?.length) return [];
    return buildTree(aggTree.groups, ["mask", "device", "lot", "probeCardType", "cardId"]);
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
          MASK:          r.MASK ?? "—",
          LOT:           r.LOT ?? "",
          SLOT:          r.SLOT ?? "",
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

  const listRowsForInf = list?.rows as InfcontrolLayerBinV3Row[] | undefined;

  const toggleDetailListKey = useCallback(
    (listIdx: number) => {
      const row = listRowsForInf?.[listIdx];
      if (!row) return;
      const spec = waferSpecFromJbRow(row);
      if (!spec) return;

      setDrillBarSelectedKeys({});
      setDetailSelectedListIndices((prev) => {
        const next = new Set(prev);
        if (next.has(listIdx)) {
          next.delete(listIdx);
        } else {
          if (next.size > 0) {
            const firstIdx = [...next][0]!;
            const firstRow = listRowsForInf?.[firstIdx];
            const firstSpec = firstRow ? waferSpecFromJbRow(firstRow) : null;
            if (firstSpec && !sameDeviceLot(firstSpec, spec)) {
              setSelectionHint("仅可选同一 Device + LOT 的行");
              return prev;
            }
          }
          next.add(listIdx);
        }
        const ctx = buildInfDutCtxFromDetailListIndices(next, listRowsForInf, {
          source: "detail",
        });
        setInfCtx(next.size > 0 ? ctx : null);
        setSelectionHint(null);
        return next;
      });
    },
    [listRowsForInf]
  );

  const toggleDetailAllVisible = useCallback(
    (keys: (string | number)[], select: boolean) => {
      const indices = keys
        .map((k) => Number(k))
        .filter((n) => Number.isInteger(n));
      if (!select) {
        setDetailSelectedListIndices(new Set());
        setInfCtx(null);
        return;
      }
      if (!listRowsForInf?.length) return;
      const next = new Set<number>();
      let device = "";
      let lot = "";
      for (const idx of indices) {
        const row = listRowsForInf[idx];
        if (!row) continue;
        const spec = waferSpecFromJbRow(row);
        if (!spec) continue;
        if (!device) {
          device = spec.device;
          lot = spec.lot;
        } else if (!sameDeviceLot({ device, lot }, spec)) {
          setSelectionHint("仅可选同一 Device + LOT 的行");
          return;
        }
        next.add(idx);
      }
      setDrillBarSelectedKeys({});
      setDetailSelectedListIndices(next);
      const ctx = buildInfDutCtxFromDetailListIndices(next, listRowsForInf, {
        source: "detail",
      });
      setInfCtx(ctx);
      setSelectionHint(null);
    },
    [listRowsForInf]
  );

  const toggleDrillBarKey = useCallback(
    (parentDimKey: string, drill: DrillState, key: string) => {
      if (drill.subDim !== "slot") return;
      if (!queryLotRequired(form)) {
        setSelectionHint("查看 DUT 分布须先在查询条件填写 Lot");
        return;
      }
      setDetailSelectedListIndices(new Set());
      const cur = drillBarSelectedKeys[parentDimKey] ?? new Set<string>();
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      setDrillBarSelectedKeys((prev) => ({ ...prev, [parentDimKey]: next }));
      const anchor =
        infDutAnchorForParentDimKey(parentDimKey) ??
        infDutAnchorFromDrill(drill);
      const ctx = buildInfDutCtxFromDrillBarKeys({
        parentDimKey: drill.parentDimKey,
        parentDimVal: drill.parentDimVal,
        subDim: drill.subDim,
        selectedKeys: next,
        drillGroups: drill.groups,
        formLot: form.lot,
        formDevice: form.device,
        formPassId: form.passId,
        listRows: listRowsForInf,
        anchor,
      });
      if (next.size === 0) {
        setInfCtx(null);
      } else if (ctx !== null) {
        setInfCtx(ctx);
        // If ctx is null (e.g. listRows not yet loaded), leave the existing panel open.
      }
      setSelectionHint(null);
    },
    [drillBarSelectedKeys, form, listRowsForInf]
  );

  const chips = useMemo(() => activeChips(form, listLimits), [form, listLimits]);
  const hasData = !!(list || aggBin || aggCardType);
  const noTestEndFilter = !form.testEndFrom && !form.testEndTo;

  const closeInfDut = useCallback(() => {
    setInfCtx(null);
    setDetailSelectedListIndices(new Set());
    setDrillBarSelectedKeys({});
    setSelectionHint(null);
  }, []);

  /** 关闭下钻面板时，若 DUT 由该下钻打开则一并关闭 */
  const closeDrillPanel = useCallback((parentDimKey: string, before?: () => void) => {
    before?.();
    setDrills((prev) => {
      const n = { ...prev };
      delete n[parentDimKey];
      return n;
    });
    setDrillBarSelectedKeys((prev) => {
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
          jbDevice: "Device",
          jbLot: "Lot",
          jbWorstType: "最差探针卡类型",
          jbTopBin: "Top 不良 Bin",
          jbWorstCard: "坏 die 最多的卡",
        }}
        sections={{
          jbDevice: (
            <KpiCard label="Device" value={deviceSummary} color="blue" subtext="匹配设备" showLabel={false} />
          ),
          jbLot: (
            <KpiCard label="Lot" value={lotSummary} color="green" subtext="匹配批次" showLabel={false} />
          ),
          jbWorstType: (
            <KpiCard
              label="最差探针卡类型"
              value={worstCardType}
              color="yellow"
              subtext="坏 die 最多"
              showLabel={false}
            />
          ),
          jbWorstCard: (
            <KpiCard
              label="坏 die 最多的卡"
              value={worstCardId}
              color="red"
              subtext="实测最差 CardId"
              showLabel={false}
            />
          ),
          jbTopBin: (
            <KpiCard
              label="Top 不良 Bin"
              value={topBin}
              color="white"
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
                  click: (params: { dataIndex: number }) => {
                    const entry = lotYieldData.slice(0, 10).reverse()[params.dataIndex];
                    if (!entry) return;
                    setSelectedLotLabel(entry.label);
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
                  multiSelect={drills["lot"]!.subDim === "slot"}
                  selectedKeys={drillBarSelectedKeys["lot"]}
                  onBarToggle={(key) => toggleDrillBarKey("lot", drills["lot"]!, key)}
                  interactive={drills["lot"]!.subDim === "slot"}
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

    const pcTypeSection = (
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
                      multiSelect={drills["probeCardType"]!.subDim === "slot"}
                      selectedKeys={drillBarSelectedKeys["probeCardType"]}
                      onBarToggle={(key) =>
                        toggleDrillBarKey("probeCardType", drills["probeCardType"]!, key)
                      }
                      interactive={drills["probeCardType"]!.subDim === "slot"}
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
            Mask → Device → LOT → ProbeCard Type → CardId
            <span style={{ fontSize: 11, color: "#6e7681", fontWeight: 400 }}>
              {showTree ? "" : `— ${treeRoots.length} 组，点击展开`}
            </span>
          </div>
          {showTree && (
            <TreeTable
              roots={treeRoots}
              totalHeader="坏 die"
              renderExtra={(node, depth) =>
                infcontrolTreeYieldExtra(list?.rows as InfcontrolLayerBinV3Row[], aggTree?.groups, node, depth)
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
            共 {list?.count ?? 0} 条（含 PROBECARDTYPE / Yield%）· 勾选多行叠加 DUT 分布（须同一 Device + LOT）
            {detailSelectedListIndices.size > 0 ? (
              <span style={{ marginLeft: 8, color: "#58a6ff" }}>
                已选 {detailSelectedListIndices.size} 行
              </span>
            ) : null}
          </div>
          {selectionHint ? (
            <p className="field-hint" style={{ color: "#f85149", margin: "0 0 8px" }}>
              {selectionHint}
            </p>
          ) : null}
          {showDetail && (
            <DataTable
              rows={detailRows}
              maxHeight={400}
              filterRow
              multiSelect
              selectedRowKeys={detailSelectedListIndices}
              getRowKey={(row) => Number(row[JB_DETAIL_LIST_INDEX])}
              onToggleRowKey={(key) => toggleDetailListKey(Number(key))}
              onToggleAllVisible={toggleDetailAllVisible}
              omitKeys={[JB_DETAIL_LIST_INDEX, JB_DETAIL_GOOD_BINS]}
              columnOrder={[
                "TESTEND",
                "DEVICE",
                "LOT",
                "SLOT",
                "CARDID",
                "PASSID",
                "Yield%",
              ]}
              columnFormatters={{ TESTEND: (v) => formatDatetimeChinaTime(String(v ?? "")) }}
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


    const deviceSection = (
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
                  multiSelect={drills["device"]!.subDim === "slot"}
                  selectedKeys={drillBarSelectedKeys["device"]}
                  onBarToggle={(key) =>
                    toggleDrillBarKey("device", drills["device"]!, key)
                  }
                  interactive={drills["device"]!.subDim === "slot"}
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
    );

    const funnelSection = (
      <FunnelDrillSection
        rows={(list?.rows ?? []) as InfcontrolLayerBinV3Row[]}
        chain={funnelChain}
        onChainChange={setFunnelChain}
        apiBase={apiBase}
        lotRows={funnelLotRows}
        lotLoading={funnelLotLoading}
        lotError={funnelLotError}
      />
    );

    return {
      kpi: kpiSection,
      funnel: funnelSection,
      device: deviceSection,
      lotYield: lotYieldSection,
      pcType: pcTypeSection,
      tree: treeSection,
      detail: detailSection,
    };
  }, [
    hasData,
    deviceSummary,
    lotSummary,
    worstCardType,
    topBin,
    worstCardId,
    lotYieldData,
    lotYieldOption,
    drills,
    form,
    fetchDrill,
    aggCardType,
    cardTypeOption,
    aggDevice,
    deviceOption,
    selectedDevice,
    treeRoots,
    showTree,
    list,
    detailRows,
    detailSelectedListIndices,
    drillBarSelectedKeys,
    selectionHint,
    showDetail,
    layoutEpoch,
    toggleDetailListKey,
    toggleDetailAllVisible,
    toggleDrillBarKey,
    closeInfDut,
    closeDrillPanel,
    listRowsForInf,
    infCtx,
    apiBase,
    funnelChain,
    funnelLotRows,
    funnelLotLoading,
    funnelLotError,
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
              ["Mask", "mask"],
              ["Device", "device"],
              ["Lot", "lot"],
              ["ProbecardType", "probeCardType"],
              ["Probecard", "cardId"],
              ["TesterId", "testerId"],
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
            <span>Platform</span>
            <select
              value={form.tstype}
              onChange={(e) => setField("tstype", e.target.value)}
            >
              <option value="">All</option>
              {TSTYPE_OPTIONS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </label>

          <label className="span-2">
            <span>Test Finish Time</span>
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
                  ["Today", dateShortcutToday],
                  ["Last 7 days", dateShortcutLast7Days],
                  ["This month", dateShortcutThisMonth],
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

          <div
            className="filter-grid-more-toggle"
            onClick={() => setShowMore((s) => !s)}
          >
            <span className="filter-grid-more-arrow">{showMore ? "▼" : "▶"}</span>
            more
          </div>

          {showMore && (
            <>
              <label>
                <span>Wafer ID</span>
                <select
                  value={form.slot}
                  onChange={(e) => setField("slot", e.target.value)}
                >
                  <option value="">All</option>
                  {Array.from({ length: 25 }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={String(n)}>{n}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>PassId</span>
                <select
                  value={form.passId}
                  onChange={(e) => setField("passId", e.target.value)}
                >
                  <option value="">All</option>
                  {Array.from({ length: 5 }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={String(n)}>{n}</option>
                  ))}
                </select>
              </label>
              <label className="span-2">
                <span>BinNo#</span>
                <input
                  type="text"
                  value={form.bins}
                  onChange={(e) => setField("bins", e.target.value)}
                  placeholder="8, 11, 131 (comma-separated)"
                />
              </label>
              <label>
                <span>MesLotId</span>
                <input
                  type="text"
                  value={form.meslot}
                  onChange={(e) => setField("meslot", e.target.value)}
                  placeholder="留空不筛"
                />
              </label>
            </>
          )}
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
              {loadingList || loadingAgg ? "🔍 查询中…" : "🔍 查询"}
            </button>
            <button
              type="button"
              className="btn ghost query-panel-clear"
              disabled={loadingList || loadingAgg}
              onClick={clearAll}
            >
              ✕ 清空
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
