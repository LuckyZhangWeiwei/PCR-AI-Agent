import type { InfcontrolLayerBinV3Row } from "../api/types";

const HARD_GOOD_BIN = 1;

/** 明细表行内嵌索引，用于点击时取 `list.rows` 同一行（勿展示为列） */
export const JB_DETAIL_LIST_INDEX = "__jbListIndex";

/** 明细表行预计算的良品 bin 下标列表（点击时优先使用） */
export const JB_DETAIL_GOOD_BINS = "__jbGoodBins";

function passBinFromJbRow(row: InfcontrolLayerBinV3Row): unknown {
  const rec = row as Record<string, unknown>;
  return row.PASSBIN ?? rec.passbin ?? rec.PassBin ?? rec.PASS_BIN;
}

function addGoodBinIndex(good: Set<number>, raw: unknown): void {
  const v = typeof raw === "number" ? raw : Number(raw);
  if (Number.isInteger(v) && v >= 0 && v <= 255) good.add(v);
}

/** 与 API `parsePassBinHyphenGoodBins` 一致：`1-55-250` → {1,55,250}。 */
export function parsePassBinHyphenGoodBins(passBinRaw: unknown): Set<number> {
  const out = new Set<number>();
  if (passBinRaw == null || passBinRaw === "") return out;
  const s = String(passBinRaw).trim();
  if (s === "") return out;
  for (const part of s.split("-")) {
    const t = part.trim();
    if (t === "") continue;
    const n = Number(t);
    if (!Number.isInteger(n) || n < 0 || n > 255) continue;
    out.add(n);
  }
  return out;
}

/** 单行 JB 列表行的良品 bin（BIN1 + bins[].isGoodBin + PASSBIN 段）。 */
export function collectGoodBinNumbersFromJbRow(
  row: InfcontrolLayerBinV3Row
): Set<number> {
  const good = new Set<number>();
  addGoodBinIndex(good, HARD_GOOD_BIN);

  const bins = row.bins;
  if (Array.isArray(bins)) {
    for (const c of bins) {
      const cell = c as {
        n?: unknown;
        isGoodBin?: boolean;
        isGood?: boolean;
      };
      if (cell.isGoodBin === true || cell.isGood === true) {
        addGoodBinIndex(good, cell.n);
      }
    }
  }

  for (const n of parsePassBinHyphenGoodBins(passBinFromJbRow(row))) {
    addGoodBinIndex(good, n);
  }

  const pair = row.passBinPair;
  if (Array.isArray(pair) && pair.length === 2) {
    addGoodBinIndex(good, pair[0]);
    addGoodBinIndex(good, pair[1]);
  }

  return good;
}

export function goodBinNumbersFromDetailRow(
  row: Record<string, unknown>
): Set<number> | undefined {
  const raw = row[JB_DETAIL_GOOD_BINS];
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const good = new Set<number>();
  for (const v of raw) addGoodBinIndex(good, v);
  return good.size > 0 ? good : undefined;
}

export function goodBinNumbersKey(good: ReadonlySet<number> | undefined): string {
  if (!good?.size) return "";
  return [...good].sort((a, b) => a - b).join(",");
}

/** 明细表点击行 → `list.rows` 中对应完整行（优先 CARDID、TESTEND 精确匹配）。 */
export function findJbListRowForDetailClick(
  rows: InfcontrolLayerBinV3Row[] | undefined,
  keys: {
    device: string;
    lot: string;
    slot: number;
    passId?: number;
    cardId?: string;
    testEnd?: string;
  }
): InfcontrolLayerBinV3Row | undefined {
  if (!rows?.length) return undefined;

  let pool = rows.filter(
    (r) =>
      String(r.DEVICE ?? "").trim() === keys.device &&
      String(r.LOT ?? "").trim() === keys.lot &&
      Number(r.SLOT) === keys.slot
  );
  if (!pool.length) return undefined;

  if (keys.passId != null && Number.isFinite(keys.passId)) {
    const byPass = pool.filter((r) => Number(r.PASSID) === keys.passId);
    if (byPass.length) pool = byPass;
  }
  if (keys.cardId) {
    const byCard = pool.filter(
      (r) => String(r.CARDID ?? "").trim() === keys.cardId
    );
    if (byCard.length) pool = byCard;
  }
  if (keys.testEnd) {
    const te = keys.testEnd.trim();
    const byTe = pool.filter((r) => String(r.TESTEND ?? "").trim() === te);
    if (byTe.length) pool = byTe;
  }
  return pool[0];
}

/** 多行合并良品 bin（钻取、明细行 DUT 分布等）；合并同 lot+slot+pass 行，并补充同 lot 的 PASSBIN token。 */
export function collectGoodBinNumbersFromJbRows(
  rows: InfcontrolLayerBinV3Row[] | undefined,
  device: string,
  lot: string,
  slot: number,
  passIds: number[]
): Set<number> {
  const good = new Set<number>([HARD_GOOD_BIN]);
  if (!rows?.length) return good;

  const passSet = passIds.length > 0 ? new Set(passIds) : null;

  for (const r of rows) {
    if (String(r.DEVICE ?? "").trim() !== device) continue;
    if (String(r.LOT ?? "").trim() !== lot) continue;
    if (Number(r.SLOT) !== slot) continue;
    if (passSet != null && r.PASSID != null && !passSet.has(Number(r.PASSID))) {
      continue;
    }
    for (const n of collectGoodBinNumbersFromJbRow(r)) good.add(n);
  }

  // PASSBIN 按 lot/device 通常一致；当前 slot 行若缺 PASSBIN，从同 lot 其它行补齐（如 bin55）
  for (const r of rows) {
    if (String(r.DEVICE ?? "").trim() !== device) continue;
    if (String(r.LOT ?? "").trim() !== lot) continue;
    for (const n of parsePassBinHyphenGoodBins(passBinFromJbRow(r))) {
      good.add(n);
    }
  }

  return good;
}

export function parseBinLabelNumber(bin: string): number | null {
  const t = bin.trim();
  let m = /^bin(\d+)$/i.exec(t);
  if (!m) m = /^(\d+)$/.exec(t);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n >= 0 && n <= 255 ? n : null;
}

export function isGoodBinLabel(
  bin: string,
  goodBinNumbers: ReadonlySet<number>
): boolean {
  const n = parseBinLabelNumber(bin);
  if (n === null) return false;
  return goodBinNumbers.has(n);
}
