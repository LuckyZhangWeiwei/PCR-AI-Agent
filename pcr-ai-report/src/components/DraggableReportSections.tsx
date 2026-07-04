import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  type SortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

export type DraggableSortAxis = "x" | "y" | "grid";

export type DraggableReportBlocksProps = {
  storageKey: string;
  defaultOrder: readonly string[];
  /** Use `null` / `undefined` to omit until visible */
  sections: Record<string, ReactNode | null | undefined>;
  axis?: DraggableSortAxis;
  groupClassName?: string;
  labels?: Record<string, string>;
  /** Bump after report-level reset to reload order / visibility from storage */
  layoutEpoch?: number;
  /** Show ✕ on each block (default true) */
  closable?: boolean;
  /** Block ids that always span all grid columns (e.g. free-dimension chart) */
  fullRowIds?: readonly string[];
};

export const YIELD_MONITOR_LAYOUT_STORAGE_KEYS = [
  "pcr-ai-report:yield-monitor-modules",
  "pcr-ai-report:yield-monitor-kpi-blocks",
  "pcr-ai-report:yield-monitor-chart-blocks",
] as const;

export const JB_START_LAYOUT_STORAGE_KEYS = [
  "pcr-ai-report:jb-start-modules",
  "pcr-ai-report:jb-start-kpi-blocks",
  "pcr-ai-report:jb-start-chart-blocks",
] as const;

function hiddenStorageKey(storageKey: string): string {
  return `${storageKey}:hidden`;
}

function readJsonStringArray(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

export function resetReportLayoutStorage(keys: readonly string[]): void {
  for (const key of keys) {
    localStorage.removeItem(key);
    localStorage.removeItem(hiddenStorageKey(key));
  }
}

function normalizeOrder(saved: string[], canonical: readonly string[]): string[] {
  const allowed = new Set(canonical);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of saved) {
    if (allowed.has(id) && !seen.has(id)) {
      out.push(id);
      seen.add(id);
    }
  }
  for (const id of canonical) {
    if (!seen.has(id)) {
      out.push(id);
      seen.add(id);
    }
  }
  return out;
}

function mergeOrderWithActive(
  saved: string[],
  canonical: readonly string[],
  activeIds: readonly string[],
): string[] {
  const normalized = normalizeOrder(saved, canonical);
  const have = new Set(normalized);
  const additions = activeIds.filter((id) => !have.has(id));
  if (additions.length === 0) return normalized;
  return normalizeOrder([...normalized, ...additions], canonical);
}

function applyVisibleReorder(
  fullOrder: string[],
  activeSet: Set<string>,
  newVisibleOrder: string[],
): string[] {
  let vi = 0;
  return fullOrder.map((id) => {
    if (activeSet.has(id)) {
      const next = newVisibleOrder[vi];
      vi += 1;
      return next ?? id;
    }
    return id;
  });
}

function normalizeHidden(saved: string[], activeSet: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const id of saved) {
    if (activeSet.has(id)) out.add(id);
  }
  return out;
}

/** Sortable shift animation for non-dragged items making room */
const REPORT_REORDER_TRANSITION = {
  duration: 200,
  easing: "cubic-bezier(0.25, 1, 0.5, 1)",
};

/**
 * Swap when the pointer crosses another item's midpoint (not when the dragged
 * block's huge rect overlaps). Fixes tall chart/KPI panels needing long drags.
 */
function createPointerMidpointCollision(axis: DraggableSortAxis): CollisionDetection {
  return (args) => {
    const { active, droppableContainers, droppableRects, pointerCoordinates } = args;
    if (!active || !pointerCoordinates) {
      return rectIntersection(args);
    }

    if (axis === "grid") {
      let closest: { id: UniqueIdentifier; dist: number } | null = null;
      for (const container of droppableContainers) {
        if (container.id === active.id) continue;
        const rect = droppableRects.get(container.id);
        if (!rect) continue;
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dist =
          (pointerCoordinates.x - cx) ** 2 + (pointerCoordinates.y - cy) ** 2;
        if (closest == null || dist < closest.dist) {
          closest = { id: container.id, dist };
        }
      }
      if (closest) return [{ id: closest.id }];

      const pointerHits = pointerWithin(args).filter((c) => c.id !== active.id);
      if (pointerHits.length > 0) return pointerHits;
      return rectIntersection(args).filter((c) => c.id !== active.id);
    }

    const isHorizontal = axis === "x";
    const pointer = isHorizontal ? pointerCoordinates.x : pointerCoordinates.y;

    const sorted = [...droppableContainers]
      .filter((c) => c.id !== active.id)
      .sort((a, b) => {
        const rectA = droppableRects.get(a.id);
        const rectB = droppableRects.get(b.id);
        if (!rectA || !rectB) return 0;
        return isHorizontal ? rectA.left - rectB.left : rectA.top - rectB.top;
      });

    if (sorted.length === 0) return [];

    for (const container of sorted) {
      const rect = droppableRects.get(container.id);
      if (!rect) continue;
      const midpoint = isHorizontal
        ? rect.left + rect.width / 2
        : rect.top + rect.height / 2;
      if (pointer < midpoint) {
        return [{ id: container.id }];
      }
    }

    return [{ id: sorted[sorted.length - 1]!.id }];
  };
}

function sortStrategyForAxis(axis: DraggableSortAxis): SortingStrategy {
  switch (axis) {
    case "x":
      return horizontalListSortingStrategy;
    case "grid":
      return rectSortingStrategy;
    default:
      return verticalListSortingStrategy;
  }
}

function usePersistedBlockLayout(
  storageKey: string,
  defaultOrder: readonly string[],
  sections: Record<string, ReactNode | null | undefined>,
  layoutEpoch: number,
) {
  const activeIds = useMemo(
    () => defaultOrder.filter((id) => sections[id] != null),
    [defaultOrder, sections],
  );

  const activeSet = useMemo(() => new Set(activeIds), [activeIds]);
  const canonicalSet = useMemo(() => new Set(defaultOrder), [defaultOrder]);

  const loadOrder = useCallback(
    () => normalizeOrder(readJsonStringArray(storageKey), defaultOrder),
    [storageKey, defaultOrder],
  );

  const loadHidden = useCallback(
    () => normalizeHidden(readJsonStringArray(hiddenStorageKey(storageKey)), canonicalSet),
    [storageKey, canonicalSet],
  );

  const [order, setOrder] = useState<string[]>(loadOrder);
  const [hidden, setHidden] = useState<Set<string>>(loadHidden);

  useEffect(() => {
    setOrder(loadOrder());
    setHidden(loadHidden());
  }, [layoutEpoch, loadOrder, loadHidden]);

  const fullOrder = useMemo(
    () => mergeOrderWithActive(order, defaultOrder, activeIds),
    [order, defaultOrder, activeIds],
  );

  const displayOrder = useMemo(
    () => fullOrder.filter((id) => activeSet.has(id) && !hidden.has(id)),
    [fullOrder, activeSet, hidden],
  );

  const moveActiveIdOver = useCallback(
    (activeId: string, overId: string) => {
      if (activeId === overId) return;
      setOrder((prev) => {
        const prevFull = mergeOrderWithActive(prev, defaultOrder, activeIds);
        const visible = prevFull.filter(
          (id) => activeSet.has(id) && !hidden.has(id),
        );
        const oldIndex = visible.indexOf(activeId);
        const newIndex = visible.indexOf(overId);
        if (oldIndex < 0 || newIndex < 0) return prev;
        const newVisible = arrayMove(visible, oldIndex, newIndex);
        return applyVisibleReorder(prevFull, activeSet, newVisible);
      });
    },
    [activeSet, activeIds, defaultOrder, hidden],
  );

  const closeBlock = useCallback(
    (id: string) => {
      if (!activeSet.has(id)) return;
      setHidden((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
    },
    [activeSet],
  );

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(fullOrder));
    } catch {
      /* ignore quota */
    }
  }, [storageKey, fullOrder]);

  useEffect(() => {
    try {
      localStorage.setItem(
        hiddenStorageKey(storageKey),
        JSON.stringify([...hidden]),
      );
    } catch {
      /* ignore quota */
    }
  }, [storageKey, hidden]);

  return {
    displayOrder,
    moveActiveIdOver,
    sections,
    closeBlock,
    hiddenCount: hidden.size,
  };
}

function SortableBlock({
  id,
  label,
  children,
  closable,
  onClose,
  fullRow,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
  closable: boolean;
  onClose: () => void;
  fullRow?: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, transition: REPORT_REORDER_TRANSITION });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    position: "relative",
    // invisible placeholder while DragOverlay carries the block visually
    opacity: isDragging ? 0 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={[
        "report-reorder-item",
        fullRow ? "report-reorder-item--full-row" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="report-reorder-item-head">
        <button
          type="button"
          className="report-reorder-drag-head"
          title={`拖动排序：${label}`}
          aria-label={`拖动排序：${label}`}
          {...listeners}
          {...attributes}
        >
          <span className="report-reorder-grip" aria-hidden>
            ⋮⋮
          </span>
          <span className="report-reorder-drag-title">{label}</span>
        </button>
        {closable ? (
          <button
            type="button"
            className="report-reorder-close"
            title={`关闭：${label}`}
            aria-label={`关闭：${label}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onClose}
          >
            ✕
          </button>
        ) : null}
      </div>
      <div className="report-reorder-body">{children}</div>
    </div>
  );
}

function DraggableReportBlocksInner({
  storageKey,
  defaultOrder,
  sections,
  sortAxis,
  groupClassName,
  labels = {},
  layoutEpoch = 0,
  closable = true,
  fullRowIds = [],
}: DraggableReportBlocksProps & { sortAxis: DraggableSortAxis }) {
  const { displayOrder, moveActiveIdOver, sections: sec, closeBlock } =
    usePersistedBlockLayout(storageKey, defaultOrder, sections, layoutEpoch);

  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const fullRowSet = useMemo(() => new Set(fullRowIds), [fullRowIds]);

  const strategy = sortStrategyForAxis(sortAxis);
  const collisionDetection = useMemo(
    () => createPointerMidpointCollision(sortAxis),
    [sortAxis],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveId(null);
      const { active, over } = event;
      if (over && active.id !== over.id) {
        moveActiveIdOver(String(active.id), String(over.id));
      }
      requestAnimationFrame(() => {
        window.dispatchEvent(new Event("resize"));
      });
    },
    [moveActiveIdOver],
  );

  const groupCls = ["report-reorder-group", groupClassName].filter(Boolean).join(" ");

  if (displayOrder.length === 0) {
    return null;
  }

  const activeLabel = activeId != null ? (labels[String(activeId)] ?? String(activeId)) : null;

  return (
    <div className={groupCls}>
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={displayOrder} strategy={strategy}>
          {displayOrder.map((id) => (
            <SortableBlock
              key={id}
              id={id}
              label={labels[id] ?? id}
              closable={closable}
              fullRow={fullRowSet.has(id)}
              onClose={() => closeBlock(id)}
            >
              {sec[id]}
            </SortableBlock>
          ))}
        </SortableContext>
        <DragOverlay dropAnimation={null}>
          {activeId != null ? (
            <div className="report-reorder-item report-reorder-item--drag-overlay">
              <div className="report-reorder-item-head">
                <div className="report-reorder-drag-head report-reorder-drag-head--grabbing">
                  <span className="report-reorder-grip" aria-hidden>⋮⋮</span>
                  <span className="report-reorder-drag-title">{activeLabel}</span>
                </div>
              </div>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

export function DraggableReportBlocks(props: DraggableReportBlocksProps) {
  const sortAxis: DraggableSortAxis = props.axis ?? "y";
  return <DraggableReportBlocksInner {...props} sortAxis={sortAxis} />;
}

const TOP_SECTION_LABELS: Record<string, string> = {
  binDist: "坏 Bin 全局分布",
  kpi: "关键指标",
  funnel: "多级钻取漏斗",
  device: "Device 不良分析",
  pcType: "ProbeCard Type 不良对比",
  timeTrend: "每日触发量趋势",
  periodAlarm: "周期报警统计",
  underperformingDuts: "低良率 DUT",
  chartsGrid: "图表矩阵",
  tree: "分组汇总",
  detail: "明细表",
  infDut: "INF · DUT 分布（仅不良 bin）",
};

type TopSectionsProps = {
  storageKey: string;
  defaultOrder: readonly string[];
  sections: Record<string, ReactNode | null | undefined>;
  layoutEpoch?: number;
  closable?: boolean;
};

export function DraggableReportSections({
  storageKey,
  defaultOrder,
  sections,
  layoutEpoch = 0,
  closable = true,
}: TopSectionsProps) {
  return (
    <DraggableReportBlocks
      storageKey={storageKey}
      defaultOrder={defaultOrder}
      sections={sections}
      axis="y"
      labels={TOP_SECTION_LABELS}
      layoutEpoch={layoutEpoch}
      closable={closable}
    />
  );
}

type ReportLayoutResetBarProps = {
  onReset: () => void;
  className?: string;
};

/** Clears order + hidden state for all keys in a report; parent should bump `layoutEpoch` */
export function ReportLayoutResetButton({
  onReset,
  className,
}: ReportLayoutResetBarProps) {
  return (
    <button
      type="button"
      className={["btn ghost report-layout-reset-btn", className]
        .filter(Boolean)
        .join(" ")}
      title="恢复已关闭的模块与默认排序"
      onClick={onReset}
    >
      ↺ 还原布局
    </button>
  );
}

export function ReportLayoutResetBar({ onReset, className }: ReportLayoutResetBarProps) {
  return (
    <div className={["report-layout-reset-bar", className].filter(Boolean).join(" ")}>
      <ReportLayoutResetButton onReset={onReset} />
      <span className="report-layout-reset-hint muted small">
        恢复已关闭的模块与默认排序
      </span>
    </div>
  );
}
