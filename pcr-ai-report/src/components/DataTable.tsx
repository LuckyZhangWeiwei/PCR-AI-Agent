import "./DataTable.css";

type Props = {
  rows: Record<string, unknown>[];
  /** Optional preferred column order */
  columnOrder?: string[];
  /** Keys to hide (e.g. heavy nested blobs) */
  omitKeys?: string[];
  maxHeight?: number;
  /** Called when user clicks a row. Receives the full row object. */
  onRowClick?: (row: Record<string, unknown>) => void;
  /** Highlight row at this index (0-based, matches `rows` order). */
  selectedRowIndex?: number | null;
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

export function DataTable({
  rows,
  columnOrder,
  omitKeys,
  maxHeight = 420,
  onRowClick,
  selectedRowIndex = null,
}: Props) {
  if (rows.length === 0) {
    return <p className="data-table-empty">No rows.</p>;
  }

  const omitLower = new Set((omitKeys ?? []).map((k) => k.toLowerCase()));
  const keysRaw = collectKeys(rows, omitLower);
  const columns = resolveColumns(keysRaw, columnOrder);

  return (
    <div className="data-table-wrap" style={{ maxHeight }}>
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const selected = selectedRowIndex != null && selectedRowIndex === i;
            const rowClass = [
              onRowClick ? "clickable" : "",
              selected ? "selected" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
            <tr
              key={i}
              className={rowClass || undefined}
              aria-selected={selected || undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {columns.map((c) => (
                <td
                  key={c}
                  title={formatCell(cellValueForColumn(row, c))}
                >
                  {formatCell(cellValueForColumn(row, c))}
                </td>
              ))}
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
