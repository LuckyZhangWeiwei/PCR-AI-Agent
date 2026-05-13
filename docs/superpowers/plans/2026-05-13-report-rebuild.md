# Report Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `YieldMonitorReport` and `InfcontrolReport` with compound filters, KPI cards, two-level drill-down charts, and collapsible tree tables; add `AiAgentReport` placeholder tab.

**Architecture:** All data from existing v3 API endpoints; parallel `Promise.allSettled` fetches; shared `KpiCard`, `TreeTable`, `DrillDownPanel` components; Yield% computed client-side from `bins[].isGoodBin` + `GROSSDIE`; tree table builds from flat aggregate rows using `device → lot → card/slot → bin` hierarchy.

**Tech Stack:** React 19, TypeScript, ECharts (via `echarts-for-react`), existing `apiGetJson` client, `datetimeLocalToIso` util, CSS variables from `index.css`.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `pcr-ai-report/src/hooks/useCountUp.ts` | count-up animation hook |
| Create | `pcr-ai-report/src/utils/yieldCalc.ts` | Yield% calc, DUT parse, tree build, date shortcuts |
| Modify | `pcr-ai-report/src/api/types.ts` | Add `YieldMonitorV3Row`, `InfcontrolBinCell`, `InfcontrolLayerBinV3Row` |
| Create | `pcr-ai-report/src/components/KpiCard.tsx` | KPI card with glow + count-up |
| Create | `pcr-ai-report/src/components/TreeTable.tsx` | Collapsible tree table (generic) |
| Create | `pcr-ai-report/src/components/DrillDownPanel.tsx` | Drill-down bar chart panel |
| Create | `pcr-ai-report/src/reports/AiAgentReport.tsx` | AI chat placeholder |
| Modify | `pcr-ai-report/src/App.tsx` | Add AI tab (5th tab) |
| Rebuild | `pcr-ai-report/src/reports/YieldMonitorReport.tsx` | Yield monitor: compound filters, KPIs, charts, tree, table |
| Rebuild | `pcr-ai-report/src/reports/InfcontrolReport.tsx` | JB START: compound filters, KPIs, charts, tree, table |

---

## Task 1: Utility Functions

**Files:**
- Create: `pcr-ai-report/src/hooks/useCountUp.ts`
- Create: `pcr-ai-report/src/utils/yieldCalc.ts`
- Modify: `pcr-ai-report/src/api/types.ts`

- [ ] **Step 1.1: Create `useCountUp` hook**

Create `pcr-ai-report/src/hooks/useCountUp.ts`:

```typescript
import { useEffect, useState } from "react";

/** Animates a numeric value from 0 to `target` over `duration` ms. */
export function useCountUp(target: number, duration = 600): number {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    if (!Number.isFinite(target)) {
      setDisplay(0);
      return;
    }
    let startTs = 0;
    let raf = 0;
    const step = (ts: number) => {
      if (!startTs) startTs = ts;
      const progress = Math.min((ts - startTs) / duration, 1);
      setDisplay(Math.round(progress * target));
      if (progress < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return display;
}
```

- [ ] **Step 1.2: Create `yieldCalc.ts` utility**

Create `pcr-ai-report/src/utils/yieldCalc.ts`:

```typescript
/** Pure utilities for Yield% computation, DUT label parsing, tree building, and date shortcuts. */

// ── Yield% ─────────────────────────────────────────────────────────────────

export type BinCell = { n: number; value: number; isGoodBin: boolean };

/**
 * Compute Yield% for an array of v3 list rows.
 * Formula: 1 - totalBadDie / totalGrossDie
 * Returns null when grossDie sum is 0.
 */
export function computeYieldPct(
  rows: Array<{ bins?: BinCell[]; GROSSDIE?: number; grossDie?: number }>
): number | null {
  let totalBad = 0;
  let totalGross = 0;
  for (const row of rows) {
    const gross = Number(row.GROSSDIE ?? row.grossDie ?? 0);
    if (Number.isFinite(gross) && gross > 0) totalGross += gross;
    if (Array.isArray(row.bins)) {
      for (const b of row.bins) {
        if (!b.isGoodBin && Number.isFinite(b.value)) totalBad += b.value;
      }
    }
  }
  return totalGross > 0 ? (1 - totalBad / totalGross) * 100 : null;
}

/** Color class based on yield%: ≥95 green, 80-95 yellow/orange, <80 red. */
export function yieldColor(pct: number | null): string {
  if (pct === null) return "#8b949e";
  if (pct >= 95) return "#3fb950";
  if (pct >= 80) return "#d29922";
  return "#ff7b72";
}

// ── DUT parsing ────────────────────────────────────────────────────────────

const DUT_RE = /on\s+dut#\s*(\d+)/i;

/** Parse dutNumber from TRIGGER_LABEL "on dut# N". Returns null if no match. */
export function parseDutNumber(label: unknown): number | null {
  if (typeof label !== "string") return null;
  const m = label.match(DUT_RE);
  return m ? Number(m[1]) : null;
}

/** Tally DUT numbers from a list of rows, returning top-N entries. */
export function tallyDutNumbers(
  rows: Array<{ dutNumber?: number | null }>,
  top = 20
): Array<{ dut: number; count: number }> {
  const m = new Map<number, number>();
  for (const row of rows) {
    const d = row.dutNumber;
    if (d !== null && d !== undefined && Number.isFinite(d)) {
      m.set(d, (m.get(d) ?? 0) + 1);
    }
  }
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([dut, count]) => ({ dut, count }));
}

// ── Tree building ──────────────────────────────────────────────────────────

export type TreeNode = {
  id: string;
  dimKey: string;
  dimValue: string;
  total: number;
  children: TreeNode[];
};

/**
 * Build a tree from flat aggregate groups.
 * `dims` is an ordered array of part keys, e.g. ["device", "lotId", "probeCard"].
 * Each group's `parts` must contain values for all dims listed.
 */
export function buildTree(
  groups: Array<{ key: string; count: number; parts: Record<string, string> }>,
  dims: string[]
): TreeNode[] {
  if (dims.length === 0) return [];

  const roots = new Map<string, TreeNode>();

  for (const g of groups) {
    let current: Map<string, TreeNode> = roots;
    let pathSoFar = "";

    for (let di = 0; di < dims.length; di++) {
      const dimKey = dims[di];
      const dimValue = g.parts[dimKey] ?? "—";
      pathSoFar = pathSoFar ? `${pathSoFar}|${dimValue}` : dimValue;

      if (!current.has(pathSoFar)) {
        current.set(pathSoFar, {
          id: pathSoFar,
          dimKey,
          dimValue,
          total: 0,
          children: [],
        });
      }
      const node = current.get(pathSoFar)!;
      node.total += g.count;

      if (di === dims.length - 1) break;

      // Recurse into children map (reconstruct from children array)
      const childMap = new Map<string, TreeNode>(
        node.children.map((c) => [c.id, c])
      );
      current = childMap;
      // Sync back after modifications
      node.children = [...childMap.values()];
      // Re-point current to childMap so next iteration modifies correctly
      current = new Map(node.children.map((c) => [c.id, c]));
      // Attach a setter so changes propagate back
      // (simple approach: rebuild at end)
    }
  }

  // Sort each level by total desc, recursively
  function sortTree(nodes: TreeNode[]): TreeNode[] {
    return nodes
      .sort((a, b) => b.total - a.total)
      .map((n) => ({ ...n, children: sortTree(n.children) }));
  }

  return sortTree([...roots.values()]);
}

// ── Date shortcuts ─────────────────────────────────────────────────────────

function padDate(n: number): string {
  return String(n).padStart(2, "0");
}

function toDatetimeLocal(d: Date): string {
  return (
    `${d.getFullYear()}-${padDate(d.getMonth() + 1)}-${padDate(d.getDate())}` +
    `T${padDate(d.getHours())}:${padDate(d.getMinutes())}`
  );
}

export function dateShortcutToday(): [string, string] {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return [toDatetimeLocal(start), toDatetimeLocal(now)];
}

export function dateShortcutLast7Days(): [string, string] {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - 7);
  return [toDatetimeLocal(start), toDatetimeLocal(now)];
}

export function dateShortcutThisMonth(): [string, string] {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return [toDatetimeLocal(start), toDatetimeLocal(now)];
}
```

- [ ] **Step 1.3: Fix the `buildTree` function — the map-sync logic has a bug (children get detached). Replace it with a cleaner recursive approach:**

Replace the `buildTree` function in `yieldCalc.ts` with:

```typescript
export function buildTree(
  groups: Array<{ key: string; count: number; parts: Record<string, string> }>,
  dims: string[]
): TreeNode[] {
  if (dims.length === 0) return [];

  // Build nested map: dim value → { total, subGroups }
  type Bucket = { total: number; children: Map<string, Bucket> };
  const root: Map<string, Bucket> = new Map();

  function ensureBucket(
    map: Map<string, Bucket>,
    key: string
  ): Bucket {
    if (!map.has(key)) map.set(key, { total: 0, children: new Map() });
    return map.get(key)!;
  }

  for (const g of groups) {
    let currentMap: Map<string, Bucket> = root;
    for (let di = 0; di < dims.length; di++) {
      const dimVal = g.parts[dims[di]] ?? "—";
      const bucket = ensureBucket(currentMap, dimVal);
      bucket.total += g.count;
      currentMap = bucket.children;
    }
  }

  function toNodes(
    map: Map<string, Bucket>,
    dimIndex: number,
    parentId: string
  ): TreeNode[] {
    const nodes: TreeNode[] = [];
    for (const [dimValue, bucket] of map.entries()) {
      const id = parentId ? `${parentId}|${dimValue}` : dimValue;
      nodes.push({
        id,
        dimKey: dims[dimIndex],
        dimValue,
        total: bucket.total,
        children:
          dimIndex + 1 < dims.length
            ? toNodes(bucket.children, dimIndex + 1, id)
            : [],
      });
    }
    return nodes.sort((a, b) => b.total - a.total);
  }

  return toNodes(root, 0, "");
}
```

- [ ] **Step 1.4: Add new types to `api/types.ts`**

Append to `pcr-ai-report/src/api/types.ts`:

```typescript
/** Single bin cell from v3 list row `bins[]` */
export type InfcontrolBinCell = {
  n: number;
  value: number;
  isGoodBin: boolean;
};

/** Typed v3 list row for JB START (infcontrol-layer-bins/v3) */
export type InfcontrolLayerBinV3Row = {
  KEYNUMBER?: number;
  DEVICE?: string;
  LOT?: string;
  SLOT?: number;
  MESLOT?: string;
  TESTERID?: string;
  TSTYPE?: string;
  CARDID?: string;
  PIBID?: string;
  PROBE?: string;
  GROSSDIE?: number;
  PASSID?: number;
  SESSIONNUMBER?: string;
  TESTSTART?: string;
  TESTEND?: string;
  LAYERNAME?: string;
  PASSTYPE?: string;
  PASSBIN?: string;
  passBinPair?: [number, number] | null;
  bins: InfcontrolBinCell[];
};

/** Typed v3 list row for yield monitor (yield-monitor-triggers/v3) */
export type YieldMonitorV3Row = {
  ID?: string | number;
  HOSTNAME?: string;
  DEVICE?: string;
  LOTID?: string;
  WAFER?: string;
  PASS?: number;
  TYPE?: string;
  TRIGGER_LABEL?: string;
  TIME_STAMP?: string;
  PROBECARD?: string;
  dutNumber?: number | null;
};

/** GET …/yield-monitor-triggers/v3 (typed rows) */
export type YieldMonitorV3Response = {
  meta?: ApiMeta;
  limit: number;
  limitMax?: number;
  orderBy: string;
  filters: Record<string, unknown>;
  count: number;
  rows: YieldMonitorV3Row[];
};
```

- [ ] **Step 1.5: Verify TypeScript compiles**

```bash
cd pcr-ai-report
npm run typecheck
```

Expected: no errors (the new types are additions, nothing removed).

- [ ] **Step 1.6: Commit**

```bash
git add pcr-ai-report/src/hooks/useCountUp.ts pcr-ai-report/src/utils/yieldCalc.ts pcr-ai-report/src/api/types.ts
git commit -m "feat: add useCountUp hook, yieldCalc utils, and typed v3 row types"
```

---

## Task 2: KpiCard Component

**Files:**
- Create: `pcr-ai-report/src/components/KpiCard.tsx`

- [ ] **Step 2.1: Create `KpiCard.tsx`**

Create `pcr-ai-report/src/components/KpiCard.tsx`:

```tsx
import { useCountUp } from "../hooks/useCountUp";

export type KpiColor = "blue" | "green" | "red" | "yellow" | "white";

const COLOR_MAP: Record<
  KpiColor,
  { border: string; glow: string; text: string }
> = {
  blue:   { border: "#388bfd", glow: "rgba(56,139,253,0.3)",   text: "#58a6ff" },
  green:  { border: "#238636", glow: "rgba(63,185,80,0.25)",   text: "#3fb950" },
  red:    { border: "#da3633", glow: "rgba(248,81,73,0.3)",    text: "#ff7b72" },
  yellow: { border: "#9e6a03", glow: "rgba(210,153,34,0.3)",   text: "#d29922" },
  white:  { border: "rgba(240,246,252,0.1)", glow: "transparent", text: "#e6edf3" },
};

type Props = {
  label: string;
  /** Numeric → animated count-up. String → displayed as-is. null → "—". */
  value: number | string | null;
  subtext?: string;
  color?: KpiColor;
};

function AnimatedNumber({ value }: { value: number }) {
  const n = useCountUp(value);
  return <>{n.toLocaleString()}</>;
}

export function KpiCard({ label, value, subtext, color = "white" }: Props) {
  const c = COLOR_MAP[color];
  return (
    <div
      style={{
        background: "#0d1117",
        border: `1px solid ${c.border}`,
        borderRadius: 8,
        padding: "12px 16px",
        textAlign: "center",
        boxShadow: `0 0 12px ${c.glow}`,
      }}
    >
      <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 4 }}>
        {label}
      </div>
      <div
        style={{ fontSize: 22, fontWeight: 700, color: c.text, margin: "2px 0" }}
      >
        {value === null || value === undefined
          ? "—"
          : typeof value === "number"
          ? <AnimatedNumber value={value} />
          : value}
      </div>
      {subtext && (
        <div style={{ fontSize: 11, color: "#8b949e", marginTop: 2 }}>
          {subtext}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2.2: Verify TypeScript**

```bash
cd pcr-ai-report && npm run typecheck
```

Expected: no errors.

- [ ] **Step 2.3: Commit**

```bash
git add pcr-ai-report/src/components/KpiCard.tsx
git commit -m "feat: add KpiCard component with count-up animation and glow border"
```

---

## Task 3: TreeTable Component

**Files:**
- Create: `pcr-ai-report/src/components/TreeTable.tsx`

- [ ] **Step 3.1: Create `TreeTable.tsx`**

Create `pcr-ai-report/src/components/TreeTable.tsx`:

```tsx
import { useState } from "react";
import type { TreeNode } from "../utils/yieldCalc";

type TreeTableProps = {
  roots: TreeNode[];
  /** Human-readable label for the "Total" column header */
  totalHeader?: string;
  /** Optional: render extra content next to a node's total */
  renderExtra?: (node: TreeNode, depth: number) => React.ReactNode;
};

const INDENT_PX = 16;
const DEPTH_COLORS = ["#58a6ff", "#a371f7", "#3fb950", "#d29922"];

function depthColor(depth: number): string {
  return DEPTH_COLORS[depth % DEPTH_COLORS.length];
}

function NodeRow({
  node,
  depth,
  totalHeader,
  renderExtra,
}: {
  node: TreeNode;
  depth: number;
  totalHeader?: string;
  renderExtra?: (node: TreeNode, depth: number) => React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const hasChildren = node.children.length > 0;
  const color = depthColor(depth);

  return (
    <>
      <tr
        style={{ cursor: hasChildren ? "pointer" : "default" }}
        onClick={() => hasChildren && setExpanded((e) => !e)}
      >
        <td
          style={{
            paddingLeft: 8 + depth * INDENT_PX,
            paddingTop: 5,
            paddingBottom: 5,
            color,
            fontWeight: depth === 0 ? 600 : 400,
            fontSize: 13,
            borderBottom: "1px solid rgba(240,246,252,0.06)",
            whiteSpace: "nowrap",
          }}
        >
          {hasChildren && (
            <span style={{ marginRight: 6, fontSize: 10, opacity: 0.7 }}>
              {expanded ? "▼" : "▶"}
            </span>
          )}
          <span style={{ fontSize: 10, color: "#6e7681", marginRight: 4 }}>
            {node.dimKey}:
          </span>
          {node.dimValue}
        </td>
        <td
          style={{
            textAlign: "right",
            paddingRight: 16,
            paddingTop: 5,
            paddingBottom: 5,
            fontSize: 13,
            color: "#e6edf3",
            borderBottom: "1px solid rgba(240,246,252,0.06)",
          }}
        >
          {node.total.toLocaleString()}
        </td>
        {renderExtra && (
          <td
            style={{
              paddingTop: 5,
              paddingBottom: 5,
              borderBottom: "1px solid rgba(240,246,252,0.06)",
              fontSize: 12,
            }}
          >
            {renderExtra(node, depth)}
          </td>
        )}
      </tr>
      {expanded &&
        node.children.map((child) => (
          <NodeRow
            key={child.id}
            node={child}
            depth={depth + 1}
            totalHeader={totalHeader}
            renderExtra={renderExtra}
          />
        ))}
    </>
  );
}

export function TreeTable({ roots, totalHeader = "Count", renderExtra }: TreeTableProps) {
  if (roots.length === 0) {
    return (
      <div style={{ color: "#8b949e", fontSize: 13, padding: "12px 0" }}>
        暂无数据
      </div>
    );
  }
  return (
    <div style={{ overflowX: "auto" }}>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 13,
        }}
      >
        <thead>
          <tr>
            <th
              style={{
                textAlign: "left",
                padding: "6px 8px",
                fontSize: 11,
                color: "#8b949e",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                borderBottom: "1px solid rgba(240,246,252,0.12)",
              }}
            >
              维度
            </th>
            <th
              style={{
                textAlign: "right",
                paddingRight: 16,
                padding: "6px 16px 6px 8px",
                fontSize: 11,
                color: "#8b949e",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                borderBottom: "1px solid rgba(240,246,252,0.12)",
              }}
            >
              {totalHeader}
            </th>
            {renderExtra && (
              <th
                style={{
                  padding: "6px 8px",
                  fontSize: 11,
                  color: "#8b949e",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  borderBottom: "1px solid rgba(240,246,252,0.12)",
                }}
              >
                附加
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {roots.map((node) => (
            <NodeRow
              key={node.id}
              node={node}
              depth={0}
              totalHeader={totalHeader}
              renderExtra={renderExtra}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3.2: Verify TypeScript**

```bash
cd pcr-ai-report && npm run typecheck
```

Expected: no errors.

- [ ] **Step 3.3: Commit**

```bash
git add pcr-ai-report/src/components/TreeTable.tsx
git commit -m "feat: add collapsible TreeTable component"
```

---

## Task 4: DrillDownPanel Component

**Files:**
- Create: `pcr-ai-report/src/components/DrillDownPanel.tsx`

- [ ] **Step 4.1: Create `DrillDownPanel.tsx`**

Create `pcr-ai-report/src/components/DrillDownPanel.tsx`:

```tsx
import type { EChartsOption } from "echarts";
import { DarkChart } from "./DarkChart";
import {
  baseChartOption,
  chartAccent,
  chartAxisColor,
  chartTextColor,
} from "../theme/chartTheme";
import type { AggregateGroup } from "../api/types";

type SubDimOption = { label: string; value: string };

type Props = {
  /** e.g. "LOT: DR390" */
  title: string;
  groups: AggregateGroup[];
  loading: boolean;
  error?: string | null;
  /** Current active sub-dimension value (for the toggle buttons) */
  activeSubDim: string;
  subDimOptions: SubDimOption[];
  onSubDimChange: (dim: string) => void;
  onClose: () => void;
};

export function DrillDownPanel({
  title,
  groups,
  loading,
  error,
  activeSubDim,
  subDimOptions,
  onSubDimChange,
  onClose,
}: Props) {
  const sorted = [...groups].sort((a, b) => a.count - b.count).slice(-25);
  const labels = sorted.map((g) => g.key);
  const values = sorted.map((g) => g.count);

  const option: EChartsOption = {
    ...baseChartOption(),
    xAxis: {
      type: "value",
      axisLabel: { color: chartAxisColor, fontSize: 11 },
      splitLine: { lineStyle: { color: "rgba(240,246,252,0.06)" } },
    },
    yAxis: {
      type: "category",
      data: labels,
      axisLabel: { color: chartTextColor, fontSize: 11 },
    },
    series: [
      {
        type: "bar",
        data: values,
        itemStyle: {
          color: chartAccent,
          borderRadius: [0, 4, 4, 0],
        },
        label: {
          show: true,
          position: "right",
          color: chartAxisColor,
          fontSize: 10,
        },
      },
    ],
  };

  return (
    <div
      style={{
        border: "1px solid #388bfd",
        borderRadius: 8,
        background: "#0d1929",
        padding: 12,
        marginTop: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontSize: 12, color: "#58a6ff", fontWeight: 600 }}>
          ↳ {title}
        </span>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {subDimOptions.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className="chip"
              style={
                opt.value === activeSubDim
                  ? {
                      background: "rgba(56,139,253,0.2)",
                      borderColor: "#388bfd",
                      color: "#58a6ff",
                    }
                  : undefined
              }
              onClick={() => onSubDimChange(opt.value)}
            >
              {opt.label}
            </button>
          ))}
          <button
            type="button"
            className="chip"
            style={{ color: "#ff7b72", borderColor: "rgba(248,81,73,0.3)" }}
            onClick={onClose}
          >
            ✕ 关闭
          </button>
        </div>
      </div>

      {loading && (
        <div style={{ color: "#8b949e", fontSize: 12, padding: "8px 0" }}>
          加载中…
        </div>
      )}
      {error && (
        <div style={{ color: "#ff7b72", fontSize: 12, padding: "8px 0" }}>
          {error}
        </div>
      )}
      {!loading && !error && groups.length === 0 && (
        <div style={{ color: "#8b949e", fontSize: 12, padding: "8px 0" }}>
          暂无数据
        </div>
      )}
      {!loading && groups.length > 0 && (
        <DarkChart option={option} height={Math.max(160, sorted.length * 22 + 60)} />
      )}
    </div>
  );
}
```

- [ ] **Step 4.2: Verify TypeScript**

```bash
cd pcr-ai-report && npm run typecheck
```

Expected: no errors.

- [ ] **Step 4.3: Commit**

```bash
git add pcr-ai-report/src/components/DrillDownPanel.tsx
git commit -m "feat: add DrillDownPanel component for two-level chart drill-down"
```

---

## Task 5: AI Placeholder Tab + App Update

**Files:**
- Create: `pcr-ai-report/src/reports/AiAgentReport.tsx`
- Modify: `pcr-ai-report/src/App.tsx`

- [ ] **Step 5.1: Create `AiAgentReport.tsx`**

Create `pcr-ai-report/src/reports/AiAgentReport.tsx`:

```tsx
type Props = { apiBase: string };

export function AiAgentReport(_props: Props) {
  return (
    <div className="report-panel">
      <div className="report-panel-header">
        <div>
          <h2>🤖 AI 助手</h2>
          <p className="report-desc">
            下一阶段接入 Node.js Agent + 硅基流动 Function Call，通过自然语言查询
            yield monitor 和 JB START 数据。
          </p>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 16,
          marginTop: 8,
        }}
      >
        {/* Chat input placeholder */}
        <div
          style={{
            border: "1px dashed rgba(163,113,247,0.35)",
            borderRadius: 8,
            padding: 20,
            minHeight: 200,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div style={{ fontSize: 12, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            对话框（预留）
          </div>
          <div
            style={{
              flex: 1,
              background: "rgba(163,113,247,0.05)",
              borderRadius: 6,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#6e40c9",
              fontSize: 13,
            }}
          >
            自然语言输入区
          </div>
        </div>

        {/* Result placeholder */}
        <div
          style={{
            border: "1px dashed rgba(163,113,247,0.35)",
            borderRadius: 8,
            padding: 20,
            minHeight: 200,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div style={{ fontSize: 12, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            结构化结果（预留）
          </div>
          <div
            style={{
              flex: 1,
              background: "rgba(163,113,247,0.05)",
              borderRadius: 6,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#6e40c9",
              fontSize: 13,
            }}
          >
            工具调用状态 / 图表 / 表格
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5.2: Add AI tab to `App.tsx`**

In `pcr-ai-report/src/App.tsx`, make these three changes:

**1. Update the Tab type** (line 11):
```typescript
type Tab = "overview" | "yield" | "infcontrol" | "ai" | "table";
```

**2. Add import** after the TableRowsReport import:
```typescript
import { AiAgentReport } from "./reports/AiAgentReport";
```

**3. Add tab button** between JB START and 表浏览 (after the infcontrol button):
```tsx
<button
  type="button"
  className={`tab ${tab === "ai" ? "active" : ""}`}
  onClick={() => setTab("ai")}
>
  🤖 AI 助手
</button>
```

**4. Add tab panel** between infcontrol and table panels:
```tsx
<div className="tab-panel" hidden={tab !== "ai"}>
  <AiAgentReport apiBase={apiBase} />
</div>
```

- [ ] **Step 5.3: Start dev server and verify 5 tabs appear**

```bash
cd pcr-ai-report && npm run dev
```

Open browser, confirm 5 tabs: API 目录 | yield monitor | JB START | 🤖 AI 助手 | 表浏览. Click AI 助手 tab and confirm placeholder layout renders.

- [ ] **Step 5.4: Commit**

```bash
git add pcr-ai-report/src/reports/AiAgentReport.tsx pcr-ai-report/src/App.tsx
git commit -m "feat: add AI assistant placeholder tab (5th tab)"
```

---

## Task 6: Rebuild YieldMonitorReport

**Files:**
- Rebuild: `pcr-ai-report/src/reports/YieldMonitorReport.tsx`

### Step 6.1: Replace file with skeleton + types + query logic

- [ ] **Step 6.1: Write new `YieldMonitorReport.tsx` — skeleton, types, query logic**

Replace the entire contents of `pcr-ai-report/src/reports/YieldMonitorReport.tsx` with:

```tsx
import { useCallback, useMemo, useState } from "react";
import { apiGetJson } from "../api/client";
import { API_PREFIX } from "../api/paths";
import type {
  AggregateGroup,
  YieldMonitorV3AggregateResponse,
  YieldMonitorV3Response,
} from "../api/types";
import { DarkChart } from "../components/DarkChart";
import { DataTable } from "../components/DataTable";
import { DrillDownPanel } from "../components/DrillDownPanel";
import { KpiCard } from "../components/KpiCard";
import { TreeTable } from "../components/TreeTable";
import {
  baseChartOption,
  chartAccent,
  chartAccent2,
  chartAccent3,
  chartAxisColor,
  chartSplitLine,
  chartTextColor,
} from "../theme/chartTheme";
import { datetimeLocalToIso } from "../utils/datetimeLocal";
import {
  buildTree,
  dateShortcutLast7Days,
  dateShortcutThisMonth,
  dateShortcutToday,
  tallyDutNumbers,
} from "../utils/yieldCalc";
import type { EChartsOption } from "echarts";

type Props = { apiBase: string };

type FormState = {
  device: string;
  lotId: string;
  wafer: string;
  hostname: string;
  probeCard: string;
  pass: string;
  timestampFrom: string;
  timestampTo: string;
  limit: string;
};

const initialForm: FormState = {
  device: "",
  lotId: "",
  wafer: "",
  hostname: "",
  probeCard: "",
  pass: "",
  timestampFrom: "",
  timestampTo: "",
  limit: "500",
};

function buildCoreParams(f: FormState): Record<string, string | number | undefined> {
  return {
    device: f.device || undefined,
    lotId: f.lotId || undefined,
    wafer: f.wafer || undefined,
    hostname: f.hostname || undefined,
    probeCard: f.probeCard || undefined,
    pass: f.pass ? Number(f.pass) : undefined,
    timeStampFrom: datetimeLocalToIso(f.timestampFrom),
    timeStampTo: datetimeLocalToIso(f.timestampTo),
  };
}

function buildListParams(f: FormState): Record<string, string | number | undefined> {
  const lim = Number(f.limit);
  return {
    ...buildCoreParams(f),
    limit: Number.isFinite(lim) ? Math.min(500, Math.max(1, Math.floor(lim))) : 500,
  };
}

// Active filter chips — omit empty or internal params
const HIDE_KEYS = new Set(["limit", "timeStampFrom", "timeStampTo"]);
function activeChips(f: FormState): { key: string; label: string }[] {
  const chips: { key: string; label: string }[] = [];
  const core = buildCoreParams(f);
  for (const [k, v] of Object.entries(core)) {
    if (v === undefined || HIDE_KEYS.has(k)) continue;
    chips.push({ key: k, label: `${k} = ${v}` });
  }
  if (f.timestampFrom || f.timestampTo) {
    const label = f.timestampFrom && f.timestampTo
      ? `时间 ${f.timestampFrom} → ${f.timestampTo}`
      : f.timestampFrom ? `时间 ≥ ${f.timestampFrom}` : `时间 ≤ ${f.timestampTo}`;
    chips.push({ key: "__time__", label });
  }
  return chips;
}

// Free-dimension aggregate: available dimensions
const FREE_DIMS: { label: string; value: string }[] = [
  { label: "按日", value: "timeDay" },
  { label: "Device", value: "device" },
  { label: "LotId", value: "lotId" },
  { label: "ProbeCard", value: "probeCard" },
  { label: "Wafer", value: "wafer" },
  { label: "Hostname", value: "hostname" },
  { label: "Pass", value: "pass" },
];

// Drill-down sub-dim options for different primary dims
const DRILLDOWN_OPTS: { label: string; value: string }[] = [
  { label: "ProbeCard", value: "probeCard" },
  { label: "按日", value: "timeDay" },
  { label: "Device", value: "device" },
  { label: "Wafer", value: "wafer" },
];

type DrillState = {
  parentDimKey: string;   // e.g. "probeCard"
  parentDimVal: string;   // e.g. "9400-01"
  subDim: string;         // e.g. "timeDay"
  groups: AggregateGroup[];
  loading: boolean;
  error: string | null;
};

export function YieldMonitorReport({ apiBase }: Props) {
  const [form, setForm] = useState<FormState>(initialForm);
  const [list, setList]   = useState<YieldMonitorV3Response | null>(null);
  const [aggTime, setAggTime] = useState<YieldMonitorV3AggregateResponse | null>(null);
  const [aggCard, setAggCard] = useState<YieldMonitorV3AggregateResponse | null>(null);
  const [aggLot,  setAggLot]  = useState<YieldMonitorV3AggregateResponse | null>(null);
  const [aggTree, setAggTree] = useState<YieldMonitorV3AggregateResponse | null>(null);
  const [aggFree, setAggFree] = useState<YieldMonitorV3AggregateResponse | null>(null);
  const [freeDim, setFreeDim] = useState("timeDay");

  const [loadingList, setLoadingList] = useState(false);
  const [loadingAgg,  setLoadingAgg]  = useState(false);
  const [errorList, setErrorList] = useState<string | null>(null);
  const [errorAgg,  setErrorAgg]  = useState<string | null>(null);

  const [drill, setDrill] = useState<DrillState | null>(null);

  const setField = useCallback(<K extends keyof FormState>(k: K, v: FormState[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
  }, []);

  const clearFilter = useCallback((key: string) => {
    if (key === "__time__") {
      setForm((f) => ({ ...f, timestampFrom: "", timestampTo: "" }));
    } else {
      setForm((f) => ({ ...f, [key]: "" } as FormState));
    }
  }, []);

  const applyDateShortcut = useCallback((fn: () => [string, string]) => {
    const [from, to] = fn();
    setForm((f) => ({ ...f, timestampFrom: from, timestampTo: to }));
  }, []);

  const fetchDrill = useCallback(async (
    parentDimKey: string,
    parentDimVal: string,
    subDim: string,
    currentForm: FormState
  ) => {
    setDrill({ parentDimKey, parentDimVal, subDim, groups: [], loading: true, error: null });
    try {
      const params = {
        ...buildCoreParams(currentForm),
        [parentDimKey]: parentDimVal,
        dimensions: subDim,
        groupTop: 25,
      };
      const res = await apiGetJson<YieldMonitorV3AggregateResponse>(
        apiBase,
        `${API_PREFIX}/yield-monitor-triggers/v3/aggregate`,
        params
      );
      setDrill((d) =>
        d ? { ...d, groups: res.groups, loading: false } : null
      );
    } catch (e) {
      setDrill((d) =>
        d ? { ...d, loading: false, error: e instanceof Error ? e.message : String(e) } : null
      );
    }
  }, [apiBase]);

  const query = useCallback(async () => {
    setLoadingList(true);
    setLoadingAgg(true);
    setErrorList(null);
    setErrorAgg(null);
    setDrill(null);
    const core = buildCoreParams(form);

    const [listRes, timeRes, cardRes, lotRes, treeRes] = await Promise.allSettled([
      apiGetJson<YieldMonitorV3Response>(apiBase, `${API_PREFIX}/yield-monitor-triggers/v3`, buildListParams(form)),
      apiGetJson<YieldMonitorV3AggregateResponse>(apiBase, `${API_PREFIX}/yield-monitor-triggers/v3/aggregate`, { ...core, dimensions: "timeDay", groupTop: 60 }),
      apiGetJson<YieldMonitorV3AggregateResponse>(apiBase, `${API_PREFIX}/yield-monitor-triggers/v3/aggregate`, { ...core, dimensions: "probeCard", groupTop: 25 }),
      apiGetJson<YieldMonitorV3AggregateResponse>(apiBase, `${API_PREFIX}/yield-monitor-triggers/v3/aggregate`, { ...core, dimensions: "lotId",    groupTop: 25 }),
      apiGetJson<YieldMonitorV3AggregateResponse>(apiBase, `${API_PREFIX}/yield-monitor-triggers/v3/aggregate`, { ...core, dimensions: "device,lotId,probeCard", groupTop: 50 }),
    ]);

    setLoadingList(false);
    setLoadingAgg(false);

    if (listRes.status === "fulfilled") setList(listRes.value);
    else setErrorList(listRes.reason instanceof Error ? listRes.reason.message : String(listRes.reason));

    if (timeRes.status === "fulfilled") setAggTime(timeRes.value);
    if (cardRes.status === "fulfilled") setAggCard(cardRes.value);
    if (lotRes.status  === "fulfilled") setAggLot(lotRes.value);
    if (treeRes.status === "fulfilled") setAggTree(treeRes.value);
    if (timeRes.status === "rejected" || cardRes.status === "rejected") {
      setErrorAgg("部分聚合请求失败，图表可能不完整");
    }

    // Also load free-dim aggregate
    fetchFreeAgg(freeDim, form);
  }, [apiBase, form, freeDim]);

  const fetchFreeAgg = useCallback(async (dim: string, currentForm: FormState) => {
    try {
      const res = await apiGetJson<YieldMonitorV3AggregateResponse>(
        apiBase,
        `${API_PREFIX}/yield-monitor-triggers/v3/aggregate`,
        { ...buildCoreParams(currentForm), dimensions: dim, groupTop: 30 }
      );
      setAggFree(res);
    } catch {
      setAggFree(null);
    }
  }, [apiBase]);

  const handleFreeDimChange = useCallback((dim: string) => {
    setFreeDim(dim);
    if (list || aggTime) fetchFreeAgg(dim, form);
  }, [list, aggTime, form, fetchFreeAgg]);

  // ── KPI derivations ──────────────────────────────────────────────────────

  const totalTriggers = aggTime?.totalRowsMatching ?? aggCard?.totalRowsMatching ?? null;

  const uniqueLots = useMemo(() => {
    if (!list) return null;
    return new Set(list.rows.map((r) => r.LOTID).filter(Boolean)).size;
  }, [list]);

  const worstProbeCard = useMemo(() => {
    const groups = aggCard?.groups ?? [];
    return groups[0]?.parts?.probeCard ?? null;
  }, [aggCard]);

  const topDut = useMemo(() => {
    if (!list) return null;
    const entries = tallyDutNumbers(list.rows);
    if (entries.length === 0) return null;
    return `dut#${entries[0].dut}`;
  }, [list]);

  // ── Chart options ────────────────────────────────────────────────────────

  const timeTrendOption = useMemo((): EChartsOption => {
    const groups = (aggTime?.groups ?? []).slice().sort((a, b) =>
      (a.parts.timeDay ?? "").localeCompare(b.parts.timeDay ?? "")
    );
    const dates  = groups.map((g) => g.parts.timeDay ?? g.key);
    const counts = groups.map((g) => g.count);
    return {
      ...baseChartOption(),
      xAxis: { type: "category", data: dates, axisLabel: { color: chartAxisColor, fontSize: 10, rotate: 30 } },
      yAxis: { type: "value", axisLabel: { color: chartAxisColor }, splitLine: { lineStyle: { color: chartSplitLine } } },
      series: [{
        type: "line",
        data: counts,
        smooth: true,
        areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: "rgba(88,166,255,0.3)" }, { offset: 1, color: "rgba(88,166,255,0.02)" }] } },
        lineStyle: { color: chartAccent, width: 2 },
        itemStyle: { color: chartAccent },
        animationDuration: 600,
      }],
      tooltip: { trigger: "axis" },
    };
  }, [aggTime]);

  const probeCardOption = useMemo((): EChartsOption => {
    const sorted = [...(aggCard?.groups ?? [])].sort((a, b) => a.count - b.count).slice(-20);
    return {
      ...baseChartOption(),
      xAxis: { type: "value", axisLabel: { color: chartAxisColor }, splitLine: { lineStyle: { color: chartSplitLine } } },
      yAxis: { type: "category", data: sorted.map((g) => g.parts.probeCard ?? g.key), axisLabel: { color: chartTextColor, fontSize: 11 } },
      series: [{
        type: "bar",
        data: sorted.map((g) => g.count),
        itemStyle: { color: chartAccent2, borderRadius: [0, 4, 4, 0] },
        label: { show: true, position: "right", color: chartAxisColor, fontSize: 10 },
        animationDuration: 600,
      }],
    };
  }, [aggCard]);

  const dutOption = useMemo((): EChartsOption => {
    const entries = tallyDutNumbers(list?.rows ?? []).slice(0, 20);
    const sorted = [...entries].sort((a, b) => a.count - b.count);
    return {
      ...baseChartOption(),
      xAxis: { type: "value", axisLabel: { color: chartAxisColor }, splitLine: { lineStyle: { color: chartSplitLine } } },
      yAxis: { type: "category", data: sorted.map((e) => `dut#${e.dut}`), axisLabel: { color: chartTextColor, fontSize: 11 } },
      series: [{
        type: "bar",
        data: sorted.map((e) => e.count),
        itemStyle: { color: chartAccent3, borderRadius: [0, 4, 4, 0] },
        label: { show: true, position: "right", color: chartAxisColor, fontSize: 10 },
        animationDuration: 600,
      }],
    };
  }, [list]);

  const lotOption = useMemo((): EChartsOption => {
    const sorted = [...(aggLot?.groups ?? [])].sort((a, b) => a.count - b.count).slice(-20);
    return {
      ...baseChartOption(),
      xAxis: { type: "value", axisLabel: { color: chartAxisColor }, splitLine: { lineStyle: { color: chartSplitLine } } },
      yAxis: { type: "category", data: sorted.map((g) => g.parts.lotId ?? g.key), axisLabel: { color: chartTextColor, fontSize: 11 } },
      series: [{
        type: "bar",
        data: sorted.map((g) => g.count),
        itemStyle: { color: "#f0883e", borderRadius: [0, 4, 4, 0] },
        label: { show: true, position: "right", color: chartAxisColor, fontSize: 10 },
        animationDuration: 600,
      }],
    };
  }, [aggLot]);

  const freeOption = useMemo((): EChartsOption => {
    const sorted = [...(aggFree?.groups ?? [])].sort((a, b) => a.count - b.count).slice(-25);
    return {
      ...baseChartOption(),
      xAxis: { type: "value", axisLabel: { color: chartAxisColor }, splitLine: { lineStyle: { color: chartSplitLine } } },
      yAxis: { type: "category", data: sorted.map((g) => g.key), axisLabel: { color: chartTextColor, fontSize: 10 } },
      series: [{
        type: "bar",
        data: sorted.map((g) => g.count),
        itemStyle: { color: chartAccent, borderRadius: [0, 4, 4, 0] },
        animationDuration: 600,
      }],
    };
  }, [aggFree]);

  // ── Tree ─────────────────────────────────────────────────────────────────

  const treeRoots = useMemo(() => {
    if (!aggTree?.groups?.length) return [];
    return buildTree(aggTree.groups, ["device", "lotId", "probeCard"]);
  }, [aggTree]);

  // ── Detail table columns ─────────────────────────────────────────────────

  const detailRows = useMemo(() => {
    if (!list?.rows?.length) return [];
    return list.rows.map((r) => ({
      TIME_STAMP: r.TIME_STAMP ?? "",
      HOSTNAME: r.HOSTNAME ?? "",
      DEVICE: r.DEVICE ?? "",
      LOTID: r.LOTID ?? "",
      WAFER: r.WAFER ?? "",
      PROBECARD: r.PROBECARD ?? "",
      dutNumber: r.dutNumber ?? "—",
    }));
  }, [list]);

  // ── Render ────────────────────────────────────────────────────────────────

  const chips = useMemo(() => activeChips(form), [form]);
  const hasData = !!(list || aggTime || aggCard);

  return (
    <div className="report-panel">
      {/* ── Header ── */}
      <div className="report-panel-header">
        <div>
          <h2>⚡ Yield Monitor</h2>
          <p className="report-desc">
            产量触发分析（TYPE = delta_diff）。选填筛选条件后点「查询」，
            并行获取明细 + 时间趋势 + 探针卡/DUT/LOT 聚合。
          </p>
        </div>
      </div>

      {/* ── Filter grid ── */}
      <div className="filter-grid">
        {(
          [
            ["Device",     "device"],
            ["LotID",      "lotId"],
            ["Wafer",      "wafer"],
            ["Hostname",   "hostname"],
            ["ProbeCard",  "probeCard"],
            ["Pass",       "pass"],
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

        <label className="span-2">
          <span>时间范围（TIME_STAMP）</span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="datetime-local"
              value={form.timestampFrom}
              onChange={(e) => setField("timestampFrom", e.target.value)}
              style={{ flex: 1 }}
            />
            <span style={{ color: "#8b949e", fontSize: 12 }}>→</span>
            <input
              type="datetime-local"
              value={form.timestampTo}
              onChange={(e) => setField("timestampTo", e.target.value)}
              style={{ flex: 1 }}
            />
          </div>
          <div className="preset-chips" style={{ marginTop: 6 }}>
            {([["今天", dateShortcutToday], ["近7天", dateShortcutLast7Days], ["本月", dateShortcutThisMonth]] as const).map(([label, fn]) => (
              <button key={label} type="button" className="chip" onClick={() => applyDateShortcut(fn)}>
                {label}
              </button>
            ))}
          </div>
        </label>
      </div>

      {/* ── Active chips + Query button ── */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        {chips.length > 0 && (
          <span style={{ fontSize: 11, color: "#8b949e" }}>生效筛选：</span>
        )}
        {chips.map((c) => (
          <span
            key={c.key}
            style={{
              background: "rgba(56,139,253,0.12)",
              color: "#58a6ff",
              border: "1px solid rgba(56,139,253,0.35)",
              borderRadius: 999,
              padding: "2px 10px",
              fontSize: 12,
              cursor: "pointer",
            }}
            onClick={() => clearFilter(c.key)}
          >
            {c.label} ✕
          </span>
        ))}
        <button
          type="button"
          className="btn primary"
          style={{ marginLeft: "auto" }}
          disabled={loadingList || loadingAgg}
          onClick={query}
        >
          {loadingList || loadingAgg ? "查询中…" : "查询"}
        </button>
      </div>

      {(errorList || errorAgg) && (
        <div style={{ color: "#ff7b72", fontSize: 13, background: "rgba(248,81,73,0.08)", padding: "8px 12px", borderRadius: 6 }}>
          {errorList || errorAgg}
        </div>
      )}

      {hasData && (
        <>
          {/* ── KPI Cards ── */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
            <KpiCard label="触发总数"        value={totalTriggers}  color="blue" />
            <KpiCard label="涉及 Lot 数"     value={uniqueLots}     color="white" />
            <KpiCard label="触发最多探针卡"   value={worstProbeCard} color="red"  subtext="触发次数最多" />
            <KpiCard label="触发最多 DUT"     value={topDut}         color="white" />
          </div>

          {/* ── Time trend (full width) ── */}
          {aggTime && (
            <div style={{ background: "#0d1117", border: "1px solid rgba(240,246,252,0.1)", borderRadius: 8, padding: 16 }}>
              <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 8 }}>📈 每日触发量趋势</div>
              <DarkChart option={timeTrendOption} height={220} />
            </div>
          )}

          {/* ── Charts 2×2 grid ── */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {/* ProbeCard */}
            <div style={{ background: "#0d1117", border: "1px solid rgba(240,246,252,0.1)", borderRadius: 8, padding: 16 }}>
              <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 8 }}>🔴 ProbeCard 触发排名</div>
              {aggCard && (
                <DarkChart
                  option={{
                    ...probeCardOption,
                    series: [{
                      ...(probeCardOption.series as object[])[0],
                      // click to drill down
                    }],
                  }}
                  height={Math.max(180, (aggCard.groups.length * 22) + 60)}
                />
              )}
              {/* Drill-down on click: handled via onEvents in next step */}
              {drill?.parentDimKey === "probeCard" && (
                <DrillDownPanel
                  title={`${drill.parentDimVal} · 下钻：按 ${drill.subDim}`}
                  groups={drill.groups}
                  loading={drill.loading}
                  error={drill.error}
                  activeSubDim={drill.subDim}
                  subDimOptions={DRILLDOWN_OPTS.filter((o) => o.value !== "probeCard")}
                  onSubDimChange={(d) => fetchDrill("probeCard", drill.parentDimVal, d, form)}
                  onClose={() => setDrill(null)}
                />
              )}
            </div>

            {/* DUT distribution */}
            <div style={{ background: "#0d1117", border: "1px solid rgba(240,246,252,0.1)", borderRadius: 8, padding: 16 }}>
              <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 8 }}>🎯 DUT# 触发分布</div>
              {list && <DarkChart option={dutOption} height={Math.max(180, tallyDutNumbers(list.rows).length * 22 + 60)} />}
            </div>

            {/* LOT ranking */}
            <div style={{ background: "#0d1117", border: "1px solid rgba(240,246,252,0.1)", borderRadius: 8, padding: 16 }}>
              <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 8 }}>📦 LOT 触发排名</div>
              {aggLot && (
                <DarkChart
                  option={lotOption}
                  height={Math.max(180, (aggLot.groups.length * 22) + 60)}
                />
              )}
              {drill?.parentDimKey === "lotId" && (
                <DrillDownPanel
                  title={`${drill.parentDimVal} · 下钻：按 ${drill.subDim}`}
                  groups={drill.groups}
                  loading={drill.loading}
                  error={drill.error}
                  activeSubDim={drill.subDim}
                  subDimOptions={DRILLDOWN_OPTS.filter((o) => o.value !== "lotId")}
                  onSubDimChange={(d) => fetchDrill("lotId", drill.parentDimVal, d, form)}
                  onClose={() => setDrill(null)}
                />
              )}
            </div>

            {/* Free-dimension aggregate */}
            <div style={{ background: "#0d1117", border: "1px solid rgba(240,246,252,0.1)", borderRadius: 8, padding: 16 }}>
              <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 6 }}>🔢 自由维度聚合</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                {FREE_DIMS.map((d) => (
                  <button
                    key={d.value}
                    type="button"
                    className="chip"
                    style={d.value === freeDim ? { background: "rgba(56,139,253,0.2)", borderColor: "#388bfd", color: "#58a6ff" } : undefined}
                    onClick={() => handleFreeDimChange(d.value)}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
              {aggFree && <DarkChart option={freeOption} height={Math.max(180, (aggFree.groups.length * 22) + 60)} />}
            </div>
          </div>

          {/* ── Tree table ── */}
          {treeRoots.length > 0 && (
            <div style={{ background: "#0d1117", border: "1px solid rgba(240,246,252,0.1)", borderRadius: 8, padding: 16 }}>
              <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 10 }}>
                📊 分组汇总（Device → LOT → ProbeCard）
              </div>
              <TreeTable roots={treeRoots} totalHeader="触发次数" />
            </div>
          )}

          {/* ── Detail table ── */}
          {detailRows.length > 0 && (
            <div style={{ background: "#0d1117", border: "1px solid rgba(240,246,252,0.1)", borderRadius: 8, padding: 16 }}>
              <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 8 }}>
                明细表 — 共 {list?.count ?? 0} 条（含 dutNumber）
              </div>
              <DataTable rows={detailRows} maxHeight={400} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 6.2: Add click-to-drill-down on ProbeCard chart**

The chart click needs `onEvents`. Wrap the ProbeCard `DarkChart` to pass an event handler. Find the ProbeCard `DarkChart` block and replace it:

```tsx
{aggCard && (
  <ReactECharts
    option={probeCardOption}
    style={{ height: Math.max(180, aggCard.groups.length * 22 + 60), width: "100%" }}
    opts={{ renderer: "canvas" }}
    notMerge
    lazyUpdate
    onEvents={{
      click: (params: { name: string }) => {
        fetchDrill("probeCard", params.name, "timeDay", form);
      },
    }}
  />
)}
```

Also add `LOT` chart click drill-down in the same pattern with `lotId` and default sub-dim `"probeCard"`.

Add the import at the top:
```typescript
import ReactECharts from "echarts-for-react";
```

- [ ] **Step 6.3: Verify TypeScript and run dev server**

```bash
cd pcr-ai-report && npm run typecheck
npm run dev
```

Open yield monitor tab. Fill Device + time range, click 查询. Verify:
- 4 KPI cards appear with count-up animation
- Daily trend line chart renders
- ProbeCard / DUT / LOT / free-dim charts render
- Tree table shows DEVICE → LOT → ProbeCard hierarchy
- Detail table shows rows including `dutNumber` column

- [ ] **Step 6.4: Commit**

```bash
git add pcr-ai-report/src/reports/YieldMonitorReport.tsx
git commit -m "feat: rebuild YieldMonitorReport with KPI cards, drill-down charts, tree table"
```

---

## Task 7: Rebuild InfcontrolReport

**Files:**
- Rebuild: `pcr-ai-report/src/reports/InfcontrolReport.tsx`

- [ ] **Step 7.1: Write new `InfcontrolReport.tsx` — skeleton, types, query logic, KPIs**

Replace the entire contents of `pcr-ai-report/src/reports/InfcontrolReport.tsx` with:

```tsx
import { useCallback, useMemo, useState } from "react";
import ReactECharts from "echarts-for-react";
import { apiGetJson } from "../api/client";
import { API_PREFIX } from "../api/paths";
import type {
  AggregateGroup,
  InfcontrolAggregateResponse,
  InfcontrolLayerBinsV3Response,
  InfcontrolLayerBinV3Row,
} from "../api/types";
import { DarkChart } from "../components/DarkChart";
import { DataTable } from "../components/DataTable";
import { DrillDownPanel } from "../components/DrillDownPanel";
import { KpiCard } from "../components/KpiCard";
import { TreeTable } from "../components/TreeTable";
import {
  baseChartOption,
  chartAxisColor,
  chartSplitLine,
  chartTextColor,
} from "../theme/chartTheme";
import { datetimeLocalToIso } from "../utils/datetimeLocal";
import {
  buildTree,
  computeYieldPct,
  dateShortcutLast7Days,
  dateShortcutThisMonth,
  dateShortcutToday,
  yieldColor,
} from "../utils/yieldCalc";
import type { EChartsOption } from "echarts";

const TSTYPE_OPTIONS = ["UFLEX", "J750", "PS16", "MST", "FLEX", "93K", "J971"] as const;

type Props = { apiBase: string };

type FormState = {
  device: string;
  lot: string;
  slot: string;
  cardId: string;
  tstype: string;
  testerId: string;
  passId: string;
  meslot: string;
  testEndFrom: string;
  testEndTo: string;
  limit: string;
};

const initialForm: FormState = {
  device: "",
  lot: "",
  slot: "",
  cardId: "",
  tstype: "",
  testerId: "",
  passId: "",
  meslot: "",
  testEndFrom: "",
  testEndTo: "",
  limit: "500",
};

function buildCoreParams(f: FormState): Record<string, string | number | undefined> {
  return {
    device:      f.device   || undefined,
    lot:         f.lot      || undefined,
    slot:        f.slot     ? Number(f.slot)   : undefined,
    cardId:      f.cardId   || undefined,
    tstype:      f.tstype   || undefined,
    testerId:    f.testerId || undefined,
    passId:      f.passId   ? Number(f.passId) : undefined,
    meslot:      f.meslot   || undefined,
    testEndFrom: datetimeLocalToIso(f.testEndFrom),
    testEndTo:   datetimeLocalToIso(f.testEndTo),
  };
}

function buildListParams(f: FormState): Record<string, string | number | undefined> {
  const lim = Number(f.limit);
  return {
    ...buildCoreParams(f),
    limit: Number.isFinite(lim) ? Math.min(500, Math.max(1, Math.floor(lim))) : 500,
  };
}

const HIDE_CHIPS = new Set(["testEndFrom", "testEndTo"]);
function activeChips(f: FormState): { key: string; label: string }[] {
  const chips: { key: string; label: string }[] = [];
  for (const [k, v] of Object.entries(buildCoreParams(f))) {
    if (v === undefined || HIDE_CHIPS.has(k)) continue;
    chips.push({ key: k, label: `${k} = ${v}` });
  }
  if (f.testEndFrom || f.testEndTo) {
    const label = f.testEndFrom && f.testEndTo
      ? `testEnd ${f.testEndFrom} → ${f.testEndTo}`
      : f.testEndFrom ? `testEnd ≥ ${f.testEndFrom}` : `testEnd ≤ ${f.testEndTo}`;
    chips.push({ key: "__time__", label });
  }
  return chips;
}

const FREE_DIMS: { label: string; value: string }[] = [
  { label: "Bin",      value: "bin"      },
  { label: "Lot",      value: "lot"      },
  { label: "Device",   value: "device"   },
  { label: "CardId",   value: "cardId"   },
  { label: "Slot",     value: "slot"     },
  { label: "TsType",   value: "tstype"   },
  { label: "PassId",   value: "passId"   },
  { label: "TesterId", value: "testerId" },
];

type DrillState = {
  parentDimKey: string;
  parentDimVal: string;
  subDim: string;
  groups: AggregateGroup[];
  loading: boolean;
  error: string | null;
};

/** Compute Yield% per lot from list rows, returns sorted array (worst first) */
function lotYields(
  rows: InfcontrolLayerBinV3Row[]
): Array<{ lot: string; yieldPct: number }> {
  const byLot = new Map<string, InfcontrolLayerBinV3Row[]>();
  for (const r of rows) {
    const lot = r.LOT ?? "—";
    if (!byLot.has(lot)) byLot.set(lot, []);
    byLot.get(lot)!.push(r);
  }
  const result: Array<{ lot: string; yieldPct: number }> = [];
  for (const [lot, lotRows] of byLot.entries()) {
    const yp = computeYieldPct(lotRows);
    if (yp !== null) result.push({ lot, yieldPct: yp });
  }
  return result.sort((a, b) => a.yieldPct - b.yieldPct);
}

export function InfcontrolReport({ apiBase }: Props) {
  const [form, setForm] = useState<FormState>(initialForm);
  const [list,     setList]     = useState<InfcontrolLayerBinsV3Response | null>(null);
  const [aggBin,   setAggBin]   = useState<InfcontrolAggregateResponse | null>(null);
  const [aggCard,  setAggCard]  = useState<InfcontrolAggregateResponse | null>(null);
  const [aggSlot,  setAggSlot]  = useState<InfcontrolAggregateResponse | null>(null);
  const [aggTree,  setAggTree]  = useState<InfcontrolAggregateResponse | null>(null);
  const [aggFree,  setAggFree]  = useState<InfcontrolAggregateResponse | null>(null);
  const [freeDim,  setFreeDim]  = useState("bin");

  const [loadingList, setLoadingList] = useState(false);
  const [loadingAgg,  setLoadingAgg]  = useState(false);
  const [errorList,   setErrorList]   = useState<string | null>(null);
  const [errorAgg,    setErrorAgg]    = useState<string | null>(null);
  const [drill,       setDrill]       = useState<DrillState | null>(null);

  const setField = useCallback(<K extends keyof FormState>(k: K, v: FormState[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
  }, []);

  const clearFilter = useCallback((key: string) => {
    if (key === "__time__") setForm((f) => ({ ...f, testEndFrom: "", testEndTo: "" }));
    else setForm((f) => ({ ...f, [key]: "" } as FormState));
  }, []);

  const applyDateShortcut = useCallback((fn: () => [string, string]) => {
    const [from, to] = fn();
    setForm((f) => ({ ...f, testEndFrom: from, testEndTo: to }));
  }, []);

  const fetchDrill = useCallback(async (
    parentDimKey: string, parentDimVal: string, subDim: string, currentForm: FormState
  ) => {
    setDrill({ parentDimKey, parentDimVal, subDim, groups: [], loading: true, error: null });
    try {
      const params = {
        ...buildCoreParams(currentForm),
        [parentDimKey]: parentDimVal,
        groupBy: subDim.includes("bin") ? subDim : `${subDim},bin`,
        groupTop: 25,
      };
      const res = await apiGetJson<InfcontrolAggregateResponse>(
        apiBase,
        `${API_PREFIX}/infcontrol-layer-bins/v3/aggregate`,
        params
      );
      setDrill((d) => d ? { ...d, groups: res.groups, loading: false } : null);
    } catch (e) {
      setDrill((d) => d ? { ...d, loading: false, error: e instanceof Error ? e.message : String(e) } : null);
    }
  }, [apiBase]);

  const query = useCallback(async () => {
    setLoadingList(true);
    setLoadingAgg(true);
    setErrorList(null);
    setErrorAgg(null);
    setDrill(null);
    const core = buildCoreParams(form);

    const [listRes, binRes, cardRes, slotRes, treeRes] = await Promise.allSettled([
      apiGetJson<InfcontrolLayerBinsV3Response>(apiBase, `${API_PREFIX}/infcontrol-layer-bins/v3`, buildListParams(form)),
      apiGetJson<InfcontrolAggregateResponse>(apiBase, `${API_PREFIX}/infcontrol-layer-bins/v3/aggregate`, { ...core, groupBy: "bin",          groupTop: 30 }),
      apiGetJson<InfcontrolAggregateResponse>(apiBase, `${API_PREFIX}/infcontrol-layer-bins/v3/aggregate`, { ...core, groupBy: "cardId,bin",   groupTop: 25 }),
      apiGetJson<InfcontrolAggregateResponse>(apiBase, `${API_PREFIX}/infcontrol-layer-bins/v3/aggregate`, { ...core, groupBy: "slot,bin",     groupTop: 50 }),
      apiGetJson<InfcontrolAggregateResponse>(apiBase, `${API_PREFIX}/infcontrol-layer-bins/v3/aggregate`, { ...core, groupBy: "device,lot,cardId,bin", groupTop: 50 }),
    ]);

    setLoadingList(false);
    setLoadingAgg(false);

    if (listRes.status === "fulfilled") setList(listRes.value);
    else setErrorList(listRes.reason instanceof Error ? listRes.reason.message : String(listRes.reason));

    if (binRes.status  === "fulfilled") setAggBin(binRes.value);
    if (cardRes.status === "fulfilled") setAggCard(cardRes.value);
    if (slotRes.status === "fulfilled") setAggSlot(slotRes.value);
    if (treeRes.status === "fulfilled") setAggTree(treeRes.value);
    if (binRes.status === "rejected") setErrorAgg("BIN 聚合请求失败，部分图表不可用");

    fetchFreeAgg(freeDim, form);
  }, [apiBase, form, freeDim]);

  const fetchFreeAgg = useCallback(async (dim: string, currentForm: FormState) => {
    try {
      const gby = dim === "bin" ? "bin" : `${dim},bin`;
      const res = await apiGetJson<InfcontrolAggregateResponse>(
        apiBase,
        `${API_PREFIX}/infcontrol-layer-bins/v3/aggregate`,
        { ...buildCoreParams(currentForm), groupBy: gby, groupTop: 30 }
      );
      setAggFree(res);
    } catch { setAggFree(null); }
  }, [apiBase]);

  const handleFreeDimChange = useCallback((dim: string) => {
    setFreeDim(dim);
    if (list || aggBin) fetchFreeAgg(dim, form);
  }, [list, aggBin, form, fetchFreeAgg]);

  // ── KPI derivations ──────────────────────────────────────────────────────

  const totalWafers = aggBin?.totalRowsMatching ?? null;

  const overallYield = useMemo(() => {
    if (!list?.rows?.length) return null;
    return computeYieldPct(list.rows as InfcontrolLayerBinV3Row[]);
  }, [list]);

  const worstCard = useMemo(() => {
    // Sum bad die per cardId from aggCard groups that include "cardId" part
    if (!aggCard?.groups?.length) return null;
    const cardBad = new Map<string, number>();
    for (const g of aggCard.groups) {
      const c = g.parts.cardId ?? "";
      if (c) cardBad.set(c, (cardBad.get(c) ?? 0) + g.count);
    }
    if (cardBad.size === 0) return null;
    return [...cardBad.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }, [aggCard]);

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
    const data = lotYieldData.slice(-30);
    return {
      ...baseChartOption(),
      xAxis: { type: "value", max: 100, axisLabel: { color: chartAxisColor, formatter: "{value}%" }, splitLine: { lineStyle: { color: chartSplitLine } } },
      yAxis: { type: "category", data: data.map((d) => d.lot), axisLabel: { color: chartTextColor, fontSize: 11 } },
      series: [{
        type: "bar",
        data: data.map((d) => ({
          value: Number(d.yieldPct.toFixed(2)),
          itemStyle: {
            color: d.yieldPct >= 95 ? "#238636" : d.yieldPct >= 80 ? "#9e6a03" : "#da3633",
            borderRadius: [0, 4, 4, 0],
          },
        })),
        label: { show: true, position: "right", color: chartAxisColor, fontSize: 10, formatter: "{c}%" },
        animationDuration: 600,
      }],
    };
  }, [lotYieldData]);

  const binRankOption = useMemo((): EChartsOption => {
    const sorted = [...(aggBin?.groups ?? [])].sort((a, b) => a.count - b.count).slice(-20);
    return {
      ...baseChartOption(),
      xAxis: { type: "value", axisLabel: { color: chartAxisColor }, splitLine: { lineStyle: { color: chartSplitLine } } },
      yAxis: { type: "category", data: sorted.map((g) => `Bin ${g.parts.bin ?? g.key}`), axisLabel: { color: chartTextColor, fontSize: 11 } },
      series: [{
        type: "bar",
        data: sorted.map((g) => g.count),
        itemStyle: { color: "#ff7b72", borderRadius: [0, 4, 4, 0] },
        label: { show: true, position: "right", color: chartAxisColor, fontSize: 10 },
        animationDuration: 600,
      }],
    };
  }, [aggBin]);

  const cardOption = useMemo((): EChartsOption => {
    // Sum bad die per cardId
    const cardBad = new Map<string, number>();
    for (const g of aggCard?.groups ?? []) {
      const c = g.parts.cardId ?? "—";
      cardBad.set(c, (cardBad.get(c) ?? 0) + g.count);
    }
    const sorted = [...cardBad.entries()].sort((a, b) => a[1] - b[1]).slice(-20);
    return {
      ...baseChartOption(),
      xAxis: { type: "value", axisLabel: { color: chartAxisColor }, splitLine: { lineStyle: { color: chartSplitLine } } },
      yAxis: { type: "category", data: sorted.map(([c]) => c), axisLabel: { color: chartTextColor, fontSize: 11 } },
      series: [{
        type: "bar",
        data: sorted.map(([, v]) => v),
        itemStyle: { color: "#e6b450", borderRadius: [0, 4, 4, 0] },
        label: { show: true, position: "right", color: chartAxisColor, fontSize: 10 },
        animationDuration: 600,
      }],
    };
  }, [aggCard]);

  const slotOption = useMemo((): EChartsOption => {
    const slotBad = new Map<string, number>();
    for (const g of aggSlot?.groups ?? []) {
      const s = g.parts.slot ?? "—";
      slotBad.set(s, (slotBad.get(s) ?? 0) + g.count);
    }
    const sorted = [...slotBad.entries()]
      .sort((a, b) => Number(a[0]) - Number(b[0]));
    return {
      ...baseChartOption(),
      xAxis: { type: "category", data: sorted.map(([s]) => `Slot ${s}`), axisLabel: { color: chartAxisColor, fontSize: 10, rotate: 30 } },
      yAxis: { type: "value", axisLabel: { color: chartAxisColor }, splitLine: { lineStyle: { color: chartSplitLine } } },
      series: [{
        type: "bar",
        data: sorted.map(([, v]) => v),
        itemStyle: { color: "#79c0ff", borderRadius: [4, 4, 0, 0] },
        animationDuration: 600,
      }],
    };
  }, [aggSlot]);

  const freeOption = useMemo((): EChartsOption => {
    const sorted = [...(aggFree?.groups ?? [])].sort((a, b) => a.count - b.count).slice(-25);
    return {
      ...baseChartOption(),
      xAxis: { type: "value", axisLabel: { color: chartAxisColor }, splitLine: { lineStyle: { color: chartSplitLine } } },
      yAxis: { type: "category", data: sorted.map((g) => g.key), axisLabel: { color: chartTextColor, fontSize: 10 } },
      series: [{
        type: "bar",
        data: sorted.map((g) => g.count),
        itemStyle: { color: "#58a6ff", borderRadius: [0, 4, 4, 0] },
        animationDuration: 600,
      }],
    };
  }, [aggFree]);

  // ── Tree ─────────────────────────────────────────────────────────────────

  const treeRoots = useMemo(() => {
    if (!aggTree?.groups?.length) return [];
    return buildTree(aggTree.groups, ["device", "lot", "cardId", "bin"]);
  }, [aggTree]);

  // ── Detail rows ──────────────────────────────────────────────────────────

  const detailRows = useMemo(() => {
    if (!list?.rows?.length) return [];
    return (list.rows as InfcontrolLayerBinV3Row[]).map((r) => {
      const yp = computeYieldPct([r]);
      return {
        TESTEND:   r.TESTEND ?? "",
        DEVICE:    r.DEVICE ?? "",
        LOT:       r.LOT ?? "",
        SLOT:      r.SLOT ?? "",
        CARDID:    r.CARDID ?? "",
        PASSID:    r.PASSID ?? "",
        "Yield%":  yp !== null ? `${yp.toFixed(1)}%` : "—",
      };
    });
  }, [list]);

  const chips = useMemo(() => activeChips(form), [form]);
  const hasData = !!(list || aggBin || aggCard);

  return (
    <div className="report-panel">
      {/* ── Header ── */}
      <div className="report-panel-header">
        <div>
          <h2>🔬 JB START</h2>
          <p className="report-desc">
            层控 BIN 数据（PASSTYPE = TEST）。复合筛选，一键触发：明细 + BIN 排名 +
            探针卡对比 + Slot 趋势。Yield% 由前端从 bins[].isGoodBin + GROSSDIE 计算。
          </p>
        </div>
      </div>

      {/* ── Filter grid ── */}
      <div className="filter-grid">
        {(
          [
            ["Device",   "device"],
            ["Lot",      "lot"],
            ["Slot",     "slot"],
            ["CardId",   "cardId"],
            ["TesterID", "testerId"],
            ["PassID",   "passId"],
            ["MES Slot", "meslot"],
          ] as [string, keyof FormState][]
        ).map(([label, key]) => (
          <label key={key}>
            <span>{label}</span>
            <input type="text" value={form[key]} onChange={(e) => setField(key, e.target.value)} placeholder="留空不筛" />
          </label>
        ))}

        <label>
          <span>Tester Type</span>
          <select value={form.tstype} onChange={(e) => setField("tstype", e.target.value)}>
            <option value="">全部</option>
            {TSTYPE_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>

        <label className="span-2">
          <span>测试结束时间（testEnd）</span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="datetime-local" value={form.testEndFrom} onChange={(e) => setField("testEndFrom", e.target.value)} style={{ flex: 1 }} />
            <span style={{ color: "#8b949e", fontSize: 12 }}>→</span>
            <input type="datetime-local" value={form.testEndTo}   onChange={(e) => setField("testEndTo",   e.target.value)} style={{ flex: 1 }} />
          </div>
          <div className="preset-chips" style={{ marginTop: 6 }}>
            {([["今天", dateShortcutToday], ["近7天", dateShortcutLast7Days], ["本月", dateShortcutThisMonth]] as const).map(([label, fn]) => (
              <button key={label} type="button" className="chip" onClick={() => applyDateShortcut(fn)}>{label}</button>
            ))}
          </div>
        </label>
      </div>

      {/* ── Chips + Query button ── */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        {chips.length > 0 && <span style={{ fontSize: 11, color: "#8b949e" }}>生效筛选：</span>}
        {chips.map((c) => (
          <span
            key={c.key}
            style={{ background: "rgba(56,139,253,0.12)", color: "#58a6ff", border: "1px solid rgba(56,139,253,0.35)", borderRadius: 999, padding: "2px 10px", fontSize: 12, cursor: "pointer" }}
            onClick={() => clearFilter(c.key)}
          >
            {c.label} ✕
          </span>
        ))}
        <button
          type="button"
          className="btn primary"
          style={{ marginLeft: "auto" }}
          disabled={loadingList || loadingAgg}
          onClick={query}
        >
          {loadingList || loadingAgg ? "查询中…" : "查询"}
        </button>
      </div>

      {(errorList || errorAgg) && (
        <div style={{ color: "#ff7b72", fontSize: 13, background: "rgba(248,81,73,0.08)", padding: "8px 12px", borderRadius: 6 }}>
          {errorList || errorAgg}
        </div>
      )}

      {hasData && (
        <>
          {/* ── KPI Cards ── */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12 }}>
            <KpiCard label="匹配 Wafer 数" value={totalWafers} color="blue" />
            <KpiCard
              label="综合 Yield%"
              value={overallYield !== null ? `${overallYield.toFixed(1)}%` : null}
              color={overallYield !== null ? (overallYield >= 95 ? "green" : overallYield >= 80 ? "yellow" : "red") : "white"}
              subtext="前端计算"
            />
            <KpiCard label="最差探针卡" value={worstCard}  color="red"    subtext="坏 die 最多" />
            <KpiCard label="Top 不良 Bin" value={topBin}   color="yellow" subtext="全量最高" />
          </div>

          {/* ── LOT Yield% bar (full width) ── */}
          {lotYieldData.length > 0 && (
            <div style={{ background: "#0d1117", border: "1px solid rgba(240,246,252,0.1)", borderRadius: 8, padding: 16 }}>
              <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 8 }}>🟢 各 LOT Yield%（绿≥95% / 黄80-95% / 红&lt;80%）</div>
              <DarkChart option={lotYieldOption} height={Math.max(180, lotYieldData.length * 22 + 60)} />
              {drill?.parentDimKey === "lot_yield" && (
                <DrillDownPanel
                  title={`${drill.parentDimVal} · 下钻：按 ${drill.subDim}`}
                  groups={drill.groups}
                  loading={drill.loading}
                  error={drill.error}
                  activeSubDim={drill.subDim}
                  subDimOptions={[
                    { label: "CardId", value: "cardId" },
                    { label: "Slot",   value: "slot"   },
                    { label: "Bin",    value: "bin"    },
                  ]}
                  onSubDimChange={(d) => fetchDrill("lot", drill.parentDimVal, d, form)}
                  onClose={() => setDrill(null)}
                />
              )}
            </div>
          )}

          {/* ── Charts 2×2 ── */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {/* BIN ranking */}
            <div style={{ background: "#0d1117", border: "1px solid rgba(240,246,252,0.1)", borderRadius: 8, padding: 16 }}>
              <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 8 }}>🔴 不良 BIN 全量排名</div>
              {aggBin && (
                <ReactECharts
                  option={binRankOption}
                  style={{ height: Math.max(180, aggBin.groups.length * 22 + 60), width: "100%" }}
                  opts={{ renderer: "canvas" }}
                  notMerge lazyUpdate
                  onEvents={{
                    click: (params: { name: string }) => {
                      const bin = params.name.replace(/^Bin /, "");
                      fetchDrill("bin", bin, "cardId", form);
                    },
                  }}
                />
              )}
              {drill?.parentDimKey === "bin" && (
                <DrillDownPanel
                  title={`Bin ${drill.parentDimVal} · 下钻：按 ${drill.subDim}`}
                  groups={drill.groups}
                  loading={drill.loading}
                  error={drill.error}
                  activeSubDim={drill.subDim}
                  subDimOptions={[{ label: "CardId", value: "cardId" }, { label: "Lot", value: "lot" }, { label: "Slot", value: "slot" }]}
                  onSubDimChange={(d) => fetchDrill("bin", drill.parentDimVal, d, form)}
                  onClose={() => setDrill(null)}
                />
              )}
            </div>

            {/* ProbeCard comparison */}
            <div style={{ background: "#0d1117", border: "1px solid rgba(240,246,252,0.1)", borderRadius: 8, padding: 16 }}>
              <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 8 }}>🃏 ProbeCard 不良对比</div>
              {aggCard && (
                <ReactECharts
                  option={cardOption}
                  style={{ height: Math.max(180, new Map(aggCard.groups.map((g) => [g.parts.cardId, 1])).size * 22 + 60), width: "100%" }}
                  opts={{ renderer: "canvas" }}
                  notMerge lazyUpdate
                  onEvents={{
                    click: (params: { name: string }) => {
                      fetchDrill("cardId", params.name, "slot", form);
                    },
                  }}
                />
              )}
              {drill?.parentDimKey === "cardId" && (
                <DrillDownPanel
                  title={`${drill.parentDimVal} · 下钻：按 ${drill.subDim}`}
                  groups={drill.groups}
                  loading={drill.loading}
                  error={drill.error}
                  activeSubDim={drill.subDim}
                  subDimOptions={[{ label: "Slot", value: "slot" }, { label: "Bin", value: "bin" }, { label: "Lot", value: "lot" }]}
                  onSubDimChange={(d) => fetchDrill("cardId", drill.parentDimVal, d, form)}
                  onClose={() => setDrill(null)}
                />
              )}
            </div>

            {/* Slot trend */}
            <div style={{ background: "#0d1117", border: "1px solid rgba(240,246,252,0.1)", borderRadius: 8, padding: 16 }}>
              <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 8 }}>📊 Slot 趋势（wafer 间比较）</div>
              {aggSlot && <DarkChart option={slotOption} height={240} />}
            </div>

            {/* Free-dim aggregate */}
            <div style={{ background: "#0d1117", border: "1px solid rgba(240,246,252,0.1)", borderRadius: 8, padding: 16 }}>
              <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 6 }}>🔢 自由维度聚合</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                {FREE_DIMS.map((d) => (
                  <button
                    key={d.value}
                    type="button"
                    className="chip"
                    style={d.value === freeDim ? { background: "rgba(56,139,253,0.2)", borderColor: "#388bfd", color: "#58a6ff" } : undefined}
                    onClick={() => handleFreeDimChange(d.value)}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
              {aggFree && <DarkChart option={freeOption} height={Math.max(180, aggFree.groups.length * 22 + 60)} />}
            </div>
          </div>

          {/* ── Tree table ── */}
          {treeRoots.length > 0 && (
            <div style={{ background: "#0d1117", border: "1px solid rgba(240,246,252,0.1)", borderRadius: 8, padding: 16 }}>
              <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 10 }}>
                📊 分组汇总（Device → LOT → CardId → Bin）
              </div>
              <TreeTable
                roots={treeRoots}
                totalHeader="坏 die"
                renderExtra={(node, depth) => {
                  if (depth > 1) return null;
                  // Show Yield% for device/lot level rows, derived from list rows
                  const device = node.dimKey === "device" ? node.dimValue : undefined;
                  const lot    = node.dimKey === "lot"    ? node.dimValue : undefined;
                  if (!list?.rows?.length) return null;
                  const filtered = (list.rows as InfcontrolLayerBinV3Row[]).filter((r) => {
                    if (device && r.DEVICE !== device) return false;
                    if (lot    && r.LOT    !== lot)    return false;
                    return true;
                  });
                  const yp = computeYieldPct(filtered);
                  if (yp === null) return null;
                  return (
                    <span style={{ fontSize: 11, color: yieldColor(yp) }}>
                      {yp.toFixed(1)}%
                    </span>
                  );
                }}
              />
            </div>
          )}

          {/* ── Detail table ── */}
          {detailRows.length > 0 && (
            <div style={{ background: "#0d1117", border: "1px solid rgba(240,246,252,0.1)", borderRadius: 8, padding: 16 }}>
              <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 8 }}>
                明细表 — 共 {list?.count ?? 0} 条（含 Yield%）
              </div>
              <DataTable rows={detailRows} maxHeight={400} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 7.2: Verify TypeScript**

```bash
cd pcr-ai-report && npm run typecheck
```

Expected: no errors. If `InfcontrolLayerBinV3Row` has a type mismatch with `list.rows` (which is `Record<string, unknown>[]`), cast it:
```typescript
// When accessing typed rows from the generic list response, cast via:
(list.rows as InfcontrolLayerBinV3Row[])
```
This is already done in the code above.

- [ ] **Step 7.3: Run dev server and test JB START tab**

```bash
cd pcr-ai-report && npm run dev
```

Open JB START tab. Test:
1. Fill Device + testEnd time range → click 查询
2. Verify 4 KPI cards: Wafer 数 / Yield% (colored) / 最差探针卡 / Top Bin
3. LOT Yield% bar chart: green/yellow/red coloring
4. BIN ranking chart: click a bin → drill-down panel appears, can switch sub-dim
5. ProbeCard comparison chart: click a card → drill-down appears
6. Slot trend bar chart renders
7. Free-dim buttons switch aggregate dimension
8. Tree table shows DEVICE → LOT → CardId → Bin hierarchy
9. Detail table shows rows with Yield% column

- [ ] **Step 7.4: Commit**

```bash
git add pcr-ai-report/src/reports/InfcontrolReport.tsx
git commit -m "feat: rebuild InfcontrolReport with Yield%, drill-down, slot trend, tree table"
```

---

## Task 8: Final Polish and Typecheck

**Files:**
- All modified files (typecheck pass)

- [ ] **Step 8.1: Full typecheck**

```bash
cd pcr-ai-report && npm run typecheck
```

Fix any remaining type errors. Common issues:
- `list.rows` typed as `Record<string, unknown>[]` — cast to specific row type with `as`
- `aggCard?.groups` could be undefined — always use `?? []`
- `node.dimKey` on `TreeNode` — ensure `TreeNode` is exported from `yieldCalc.ts`

- [ ] **Step 8.2: Lint**

```bash
cd pcr-ai-report && npm run lint
```

Fix any lint warnings. Common issues: unused imports, missing keys on mapped elements.

- [ ] **Step 8.3: Build check**

```bash
cd pcr-ai-report && npm run build
```

Expected: successful build with no errors. Warnings about bundle size are acceptable.

- [ ] **Step 8.4: Verify all 5 tabs work end-to-end**

Start dev server `npm run dev`. For each tab:
- **API 目录**: manifest loads
- **yield monitor**: query returns KPIs, charts, tree table, detail table; drill-down works on ProbeCard/LOT charts
- **JB START**: query returns KPIs incl. Yield%, LOT bar, BIN/Card/Slot charts, drill-down works, tree table, detail table
- **AI 助手**: placeholder panels render, no errors in console
- **表浏览**: existing functionality still works

- [ ] **Step 8.5: Commit**

```bash
git add -A
git commit -m "feat: complete report rebuild — yield monitor, JB START, AI placeholder, shared components"
```

---

## Self-Review Checklist

**Spec coverage:**
- [x] 5-tab navigation with AI placeholder — Task 5
- [x] Compound filters with AND semantics — Task 6/7 `buildCoreParams`
- [x] Quick date shortcut buttons (今天/近7天/本月) — `dateShortcuts` in `yieldCalc.ts`
- [x] Active filter chips with ✕ dismiss — both reports
- [x] Single 查询 button triggering parallel requests — `Promise.allSettled` in `query()`
- [x] 4 KPI cards per tab with count-up and glow — `KpiCard` component
- [x] `totalRowsMatching` for total count KPI — from aggregate responses
- [x] Daily trigger trend (yield monitor) — `aggTime` with `dimensions=timeDay`
- [x] ProbeCard ranking + drill-down — `aggCard` + `DrillDownPanel`
- [x] DUT# distribution (yield monitor) — `tallyDutNumbers` from list rows
- [x] LOT ranking + drill-down — `aggLot` + `DrillDownPanel`
- [x] Free-dimension aggregate with dim switcher — both reports
- [x] LOT Yield% bar with color coding — `lotYields()` in JB START
- [x] BIN full ranking + drill-down — `aggBin`
- [x] ProbeCard bad die comparison + drill-down — `aggCard` in JB START
- [x] Slot trend chart — `aggSlot` with `groupBy=slot,bin`
- [x] Yield% client-side computation — `computeYieldPct()` in `yieldCalc.ts`
- [x] DEVICE → LOT → Card → Bin tree hierarchy — `buildTree()` with 4 dims
- [x] Tree table with expand/collapse — `TreeTable` component
- [x] Yield% in tree table for device/lot levels — `renderExtra` prop
- [x] Detail table with dutNumber (yield monitor) — `detailRows`
- [x] Detail table with Yield% column (JB START) — computed per row
- [x] `dimensions=` param for yield monitor aggregate — confirmed in Task 6
- [x] `groupBy=` param for infcontrol aggregate — confirmed in Task 7
- [x] `lotId` dimension name for yield monitor — confirmed vs `lot` for infcontrol
- [x] Correct API paths (`/v3/aggregate` for infcontrol) — confirmed in Task 7

**No placeholder text or TBD sections found.**
