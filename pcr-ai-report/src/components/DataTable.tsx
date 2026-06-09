import { useState, useMemo, useCallback } from "react";
import "./DataTable.css";

type Props = {
  rows: Record<string, unknown>[];
  /** Optional preferred column order */
  columnOrder?: string[];
  /** Keys to hide (e.g. heavy nested blobs) */
  omitKeys?: string[];
  maxHeight?: number;
  /** Called when user clicks a row. Receives the full row object. */
  onRowClick?: (row: Record<string, unknown>, rowIndex: number) => void;
  /** Highlight row at this index (0-based, matches `rows` order). */
  selectedRowIndex?: number | null;
  /** Checkbox multi-select: stable row keys (e.g. list row index). */
  multiSelect?: boolean;
  selectedRowKeys?: ReadonlySet<string | number>;
  getRowKey?: (row: Record<string, unknown>, rowIndex: number) => string | number;
  onToggleRowKey?: (key: string | number, row: Record<string, unknown>) => void;
  onToggleAllVisible?: (keys: (string | number)[], select: boolean) => void;
  /** Show per-column text filter inputs in the header */
  filterRow?: boolean;
  /** Per-column display formatters. Only affects rendered text, not the underlying row data. */
  columnFormatters?: Record<string, (v: unknown) => string>;
};

/** omitKeys 与行内键名大小写均可匹配 */
function keyIsOmitted(key: string, omitLower: Set<string>): boolean {
  return omitLower.has(key.toLowerCase());
}

function collectKeys(
  rows: Record<string, unknown>[],
  omitLower: Set<string>
): string[] {
  const set = new Set<string>();
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!keyIsOmitted(k, omitLower)) set.add(k);
    }
  }
  return [...set];
}

/**
 * columnOrder 与数据键名忽略大小写对齐。
 * 若优先列在数据中尚无键（如 Oracle 省略全 null 列），仍保留该列表头（单元格为空）。
 */
function resolveColumns(
  keysRaw: string[],
  columnOrder: string[] | undefined
): string[] {
  const lowerToKey = new Map<string, string>();
  for (const k of keysRaw) {
    const low = k.toLowerCase();
    if (!lowerToKey.has(low)) lowerToKey.set(low, k);
  }
  const ordered: string[] = [];
  const seenLower = new Set<string>();
  if (columnOrder) {
    for (const pref of columnOrder) {
      const prefLow = pref.toLowerCase();
      const actual = lowerToKey.get(prefLow);
      if (actual !== undefined && !seenLower.has(actual.toLowerCase())) {
        ordered.push(actual);
        seenLower.add(actual.toLowerCase());
      } else if (actual === undefined && !seenLower.has(prefLow)) {
        ordered.push(pref);
        seenLower.add(prefLow);
      }
    }
  }
  const rest = keysRaw
    .filter((k) => !seenLower.has(k.toLowerCase()))
    .sort();
  return [...ordered, ...rest];
}

/** 表头用 PASSTYPE、行内键为 passtype 时仍能取值 */
function cellValueForColumn(
  row: Record<string, unknown>,
  columnKey: string
): unknown {
  if (Object.prototype.hasOwnProperty.call(row, columnKey)) {
    return row[columnKey];
  }
  const low = columnKey.toLowerCase();
  for (const k of Object.keys(row)) {
    if (k.toLowerCase() === low) return row[k];
  }
  return undefined;
}

const MAX_CELL = 320;

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s: string;
  if (typeof v === "object") s = JSON.stringify(v);
  else s = String(v);
  if (s.length > MAX_CELL) return `${s.slice(0, MAX_CELL)}…`;
  return s;
}

type SortState = { col: string; dir: "asc" | "desc" } | null;

export function DataTable({
  rows,
  columnOrder,
  omitKeys,
  maxHeight = 420,
  onRowClick,
  selectedRowIndex = null,
  multiSelect = false,
  selectedRowKeys,
  getRowKey,
  onToggleRowKey,
  onToggleAllVisible,
  filterRow = false,
  columnFormatters,
}: Props) {
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<SortState>(null);

  const handleHeaderClick = useCallback((col: string) => {
    setSort((prev) => {
      if (!prev || prev.col !== col) return { col, dir: "asc" };
      if (prev.dir === "asc") return { col, dir: "desc" };
      return null;
    });
  }, []);

  const omitLower = new Set((omitKeys ?? []).map((k) => k.toLowerCase()));
  const keysRaw = collectKeys(rows, omitLower);
  const columns = resolveColumns(keysRaw, columnOrder);

  const formatCellWithOverride = (col: string, v: unknown): string => {
    const fn = columnFormatters?.[col];
    return fn ? fn(v) : formatCell(v);
  };

  const filteredRows = useMemo(() => {
    if (!filterRow) return rows;
    const active = Object.entries(columnFilters).filter(([, v]) => v !== "");
    if (!active.length) return rows;
    return rows.filter((row) =>
      active.every(([col, val]) =>
        formatCellWithOverride(col, cellValueForColumn(row, col))
          .toLowerCase()
          .includes(val.toLowerCase())
      )
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, columnFilters, filterRow, columnFormatters]);

  const sortedRows = useMemo(() => {
    if (!sort) return filteredRows;
    const { col, dir } = sort;
    const sign = dir === "asc" ? 1 : -1;
    return [...filteredRows].sort((a, b) => {
      const av = formatCellWithOverride(col, cellValueForColumn(a, col));
      const bv = formatCellWithOverride(col, cellValueForColumn(b, col));
      const an = Number(av), bn = Number(bv);
      if (!isNaN(an) && !isNaN(bn)) return sign * (an - bn);
      return sign * av.localeCompare(bv, undefined, { numeric: true, sensitivity: "base" });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredRows, sort, columnFormatters]);

  if (rows.length === 0) {
    return <p className="data-table-empty">No rows.</p>;
  }

  const visibleKeys = sortedRows.map((row, i) =>
    getRowKey ? getRowKey(row, i) : i
  );
  const allVisibleSelected =
    multiSelect &&
    visibleKeys.length > 0 &&
    visibleKeys.every((k) => selectedRowKeys?.has(k));

  return (
    <div className="data-table-wrap" style={{ maxHeight }}>
      <table className="data-table">
        <thead>
          <tr>
            {multiSelect ? (
              <th className="data-table-check-col">
                <input
                  type="checkbox"
                  aria-label="全选当前表"
                  checked={allVisibleSelected}
                  onChange={() => {
                    onToggleAllVisible?.(visibleKeys, !allVisibleSelected);
                  }}
                />
              </th>
            ) : null}
            {columns.map((c) => {
              const isSorted = sort?.col === c;
              return (
                <th
                  key={c}
                  className="data-table-sortable"
                  onClick={() => handleHeaderClick(c)}
                  title={`按 ${c} 排序`}
                >
                  {c}
                  <span className="data-table-sort-icon">
                    {isSorted ? (sort!.dir === "asc" ? " ▲" : " ▼") : " ⇅"}
                  </span>
                </th>
              );
            })}
          </tr>
          {filterRow && (
            <tr className="data-table-filter-row">
              {multiSelect && <th className="data-table-check-col" aria-label="筛选行选择" />}
              {columns.map((c) => (
                <th key={c} className="data-table-filter-th">
                  <input
                    type="text"
                    className="data-table-filter-input"
                    placeholder="筛选…"
                    value={columnFilters[c] ?? ""}
                    onChange={(e) =>
                      setColumnFilters((prev) => ({ ...prev, [c]: e.target.value }))
                    }
                  />
                </th>
              ))}
            </tr>
          )}
        </thead>
        <tbody>
          {filteredRows.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length + (multiSelect ? 1 : 0)}
                className="data-table-filter-empty"
              >
                无匹配行
              </td>
            </tr>
          ) : (
            sortedRows.map((row, i) => {
              const rowKey = visibleKeys[i]!;
              const selected = multiSelect
                ? selectedRowKeys?.has(rowKey) === true
                : selectedRowIndex != null && selectedRowIndex === i;
              const rowClass = [
                onRowClick || multiSelect ? "clickable" : "",
                selected ? "selected" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <tr
                  key={String(rowKey)}
                  className={rowClass || undefined}
                  aria-selected={selected}
                  onClick={
                    multiSelect
                      ? () => onToggleRowKey?.(rowKey, row)
                      : onRowClick
                      ? () => onRowClick(row, i)
                      : undefined
                  }
                >
                  {multiSelect ? (
                    <td
                      className="data-table-check-col"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        aria-label="选择行"
                        checked={selected}
                        onChange={() => onToggleRowKey?.(rowKey, row)}
                      />
                    </td>
                  ) : null}
                  {columns.map((c) => (
                    <td
                      key={c}
                      title={formatCellWithOverride(c, cellValueForColumn(row, c))}
                    >
                      {formatCellWithOverride(c, cellValueForColumn(row, c))}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
