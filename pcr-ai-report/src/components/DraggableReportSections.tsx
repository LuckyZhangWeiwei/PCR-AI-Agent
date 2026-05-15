import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
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
  /**
   * Sorting topology: KPI row `"x"`, stacked panels `"y"`,
   * 2×2 (or irregular) grids use `"grid"` with `rectSortingStrategy`.
   */
  axis?: DraggableSortAxis;
  /** Appended after `report-reorder-group` */
  groupClassName?: string;
  labels?: Record<string, string>;
};

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

/** Append any newly-visible section ids without dropping user order */
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

function usePersistedBlockOrder(
  storageKey: string,
  defaultOrder: readonly string[],
  sections: Record<string, ReactNode | null | undefined>,
) {
  const activeIds = useMemo(
    () => defaultOrder.filter((id) => sections[id] != null),
    [defaultOrder, sections],
  );

  const activeSet = useMemo(() => new Set(activeIds), [activeIds]);

  const [order, setOrder] = useState<string[]>(() =>
    normalizeOrder(
      (() => {
        try {
          const raw = localStorage.getItem(storageKey);
          if (!raw) return [];
          const parsed = JSON.parse(raw) as unknown;
          return Array.isArray(parsed) ? (parsed as string[]) : [];
        } catch {
          return [];
        }
      })(),
      defaultOrder,
    ),
  );

  const fullOrder = useMemo(
    () => mergeOrderWithActive(order, defaultOrder, activeIds),
    [order, defaultOrder, activeIds],
  );

  const displayOrder = useMemo(
    () => fullOrder.filter((id) => activeSet.has(id)),
    [fullOrder, activeSet],
  );

  /** Used by @dnd-kit drop */
  const moveActiveIdOver = useCallback(
    (activeId: string, overId: string) => {
      if (activeId === overId) return;
      setOrder((prev) => {
        const prevFull = mergeOrderWithActive(prev, defaultOrder, activeIds);
        const visible = prevFull.filter((id) => activeSet.has(id));
        const oldIndex = visible.indexOf(activeId);
        const newIndex = visible.indexOf(overId);
        if (oldIndex < 0 || newIndex < 0) return prev;
        const newVisible = arrayMove(visible, oldIndex, newIndex);
        return applyVisibleReorder(prevFull, activeSet, newVisible);
      });
    },
    [activeSet, activeIds, defaultOrder],
  );

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(fullOrder));
    } catch {
      /* ignore quota */
    }
  }, [storageKey, fullOrder]);

  return {
    displayOrder,
    moveActiveIdOver,
    sections,
  };
}

function SortableBlock({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    position: "relative",
    zIndex: isDragging ? 10_000 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`report-reorder-item${isDragging ? " report-reorder-item--dragging" : ""}`}
    >
      <div className="report-reorder-handlebar">
        <button
          type="button"
          className="report-reorder-handle"
          title={`拖动排序：${label}`}
          aria-label={`拖动排序：${label}`}
          {...listeners}
          {...attributes}
        >
          <span className="report-reorder-grip" aria-hidden>
            ⋮⋮
          </span>
        </button>
        <span className="report-reorder-label">{label}</span>
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
}: DraggableReportBlocksProps & { sortAxis: DraggableSortAxis }) {
  const { displayOrder, moveActiveIdOver, sections: sec } = usePersistedBlockOrder(
    storageKey,
    defaultOrder,
    sections,
  );

  const strategy = sortStrategyForAxis(sortAxis);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    moveActiveIdOver(String(active.id), String(over.id));
  };

  const groupCls = ["report-reorder-group", groupClassName].filter(Boolean).join(" ");

  return (
    <div className={groupCls}>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={displayOrder} strategy={strategy}>
          {displayOrder.map((id) => (
            <SortableBlock key={id} id={id} label={labels[id] ?? id}>
              {sec[id]}
            </SortableBlock>
          ))}
        </SortableContext>
      </DndContext>
    </div>
  );
}

export function DraggableReportBlocks(props: DraggableReportBlocksProps) {
  const sortAxis: DraggableSortAxis = props.axis ?? "y";
  return <DraggableReportBlocksInner {...props} sortAxis={sortAxis} />;
}

const TOP_SECTION_LABELS: Record<string, string> = {
  kpi: "关键指标",
  timeTrend: "趋势图",
  lotYield: "LOT Yield",
  chartsGrid: "图表矩阵",
  tree: "分组汇总",
  detail: "明细表",
};

type TopSectionsProps = {
  storageKey: string;
  defaultOrder: readonly string[];
  sections: Record<string, ReactNode | null | undefined>;
};

/** Top-level report panels (Yield / JB) */
export function DraggableReportSections({ storageKey, defaultOrder, sections }: TopSectionsProps) {
  return (
    <DraggableReportBlocks
      storageKey={storageKey}
      defaultOrder={defaultOrder}
      sections={sections}
      axis="y"
      labels={TOP_SECTION_LABELS}
    />
  );
}
