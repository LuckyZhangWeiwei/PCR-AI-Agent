/** Client-side rollups on API list payloads（JB START v2 列表行数由 limit 决定）. */

/**
 * yield monitor：`TYPE` 列偶见历史值 `bin`，并非合法触发类型代码；图表与按 TYPE 汇总时跳过。
 */
export function isYieldMonitorTypeExcludedFromCharts(raw: unknown): boolean {
  const s =
    raw === null || raw === undefined ? "" : String(raw).trim().toLowerCase();
  return s === "bin";
}

/** CP 常见约定：硬 BIN1 为良品；列表 bins[].isGood 优先 */
const EXCLUDE_HARD_GOOD_BIN_INDEX = 1;

/** PASSBIN 形如 `N-M` 时两端 BIN 不计入合计（与后端聚合排除规则一致） */
function binColumnExcludedAsPassBinEndpoint(
  row: Record<string, unknown>,
  binKey: string
): boolean {
  const binIndex = Number(binKey);
  if (!Number.isFinite(binIndex)) return false;
  const pair = row.passBinPair;
  if (!Array.isArray(pair) || pair.length !== 2) return false;
  const n = Number(pair[0]);
  const m = Number(pair[1]);
  if (!Number.isFinite(n) || !Number.isFinite(m)) return false;
  return binIndex === n || binIndex === m;
}

type BinCell = { value?: number; isGood?: boolean };
type BinCellV2 = { value?: number; n?: number; isGoodBin?: boolean };

/** 不计入「不良 BIN」条形图：良品（bins[].isGood===true），否则回退列下标/PASSBIN 规则 */
function binExcludedFromInfcontrolChart(
  row: Record<string, unknown>,
  binKey: string,
  cell?: BinCell
): boolean {
  if (cell?.isGood === true) return true;
  if (cell?.isGood === false) return false;
  const binIndex = Number(binKey);
  if (binIndex === EXCLUDE_HARD_GOOD_BIN_INDEX) return true;
  return binColumnExcludedAsPassBinEndpoint(row, binKey);
}

export function tallyColumn(
  rows: Record<string, unknown>[],
  column: string,
  top = 30
): [string, number][] {
  const m = new Map<string, number>();
  const upper = column.toUpperCase();
  const lower = column.toLowerCase();
  for (const r of rows) {
    const raw = r[column] ?? r[upper] ?? r[lower];
    const key =
      raw === null || raw === undefined || raw === ""
        ? "（空）"
        : String(raw);
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
}

export function sumBinsOnPage(
  rows: Record<string, unknown>[],
  top = 25
): { bin: string; sum: number }[] {
  const sums = new Map<string, number>();
  for (const r of rows) {
    const bins = r.bins;
    if (!bins || typeof bins !== "object") continue;

    if (Array.isArray(bins)) {
      for (const cell of bins as BinCellV2[]) {
        if (cell?.isGoodBin === true) continue;
        const v = cell?.value;
        const n = cell?.n;
        if (typeof v !== "number" || !Number.isFinite(v)) continue;
        const k = String(n ?? "");
        sums.set(k, (sums.get(k) ?? 0) + v);
      }
      continue;
    }

    for (const [k, cell] of Object.entries(
      bins as Record<string, BinCell>
    )) {
      if (binExcludedFromInfcontrolChart(r, k, cell)) continue;
      const v = cell?.value;
      if (typeof v === "number" && Number.isFinite(v)) {
        sums.set(k, (sums.get(k) ?? 0) + v);
      }
    }
  }
  return [...sums.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([bin, sum]) => ({ bin, sum }));
}
