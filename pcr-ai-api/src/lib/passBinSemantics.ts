/**
 * `PASSBIN` 形如 `1-55`（减号分隔两个整数）时可解析为两端下标。
 * 列表 **`bins`**：键为 BIN **列下标**（字符串 `"0"`…`"255"`），与 Oracle `BINn` 一致；**`value`** 为该列计数；
 * **`isGood`**：**BIN1（硬良品）**或 **PASSBIN 为 N-M 时两端列下标** 为 `true`，其余为 `false`。
 */

/** `PASSBIN` 解析出的两个整数，顺序与字符串 **`N-M`** 一致，例如 **`[1, 55]`** */
export type PassBinPair = readonly [number, number];

/** `PASSBIN` 无法解析为 `N-M` 两段数字时返回 null */
export function parsePassBinPair(passBin: unknown): PassBinPair | null {
  if (passBin == null || passBin === "") return null;
  const s = String(passBin).trim();
  const m = s.match(/^(\d+)\s*-\s*(\d+)$/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
  if (a < 0 || b > 255 || a > b) return null;
  return [a, b];
}

/** 列下标 **`binIndex`** 是否为 PASSBIN 指定的「两端」（仅 **`binIndex === N`** 或 **`binIndex === M`**）— 纯函数，与列表 `isGood` 输出无关 */
export function binColumnIndexIsGood(
  passBinRaw: unknown,
  binIndex: number
): boolean {
  const pair = parsePassBinPair(passBinRaw);
  if (!pair) return false;
  return binIndex === pair[0] || binIndex === pair[1];
}

/** 长度 256：仅 **`a`**、**`b`** 两处为 true（`a === b` 时仅一处） */
function binIsGoodFlagsForPairEndpoints(a: number, b: number): boolean[] {
  return Array.from(
    { length: 256 },
    (_, k) => k === a || k === b
  );
}

/**
 * 由已解析的 **`pair`** 生成 good 标记向量（库内其它用途）；列表 **`bins[k].isGood`** 由
 * **`extractBins`** 单独计算（与向量语义一致）。
 */
export function computeBinIsGoodFlagVectorFromPair(
  pair: PassBinPair | null
): boolean[] {
  if (!pair) return Array.from({ length: 256 }, () => false);
  return binIsGoodFlagsForPairEndpoints(pair[0], pair[1]);
}

/** 由原始 **`PASSBIN`** 字段值生成 good 标记向量 */
export function computeBinIsGoodFlagVector(passBinRaw: unknown): boolean[] {
  return computeBinIsGoodFlagVectorFromPair(parsePassBinPair(passBinRaw));
}

/** 单行内 **`bins[n]`**：`value` 为计数；`isGood` 表示是否为良品列（BIN1 或 PASSBIN 两端） */
export type InfcontrolLayerBinCell = {
  value: number;
  isGood: boolean;
};

function isBinColumnKey(key: string): boolean {
  const m = key.match(/^BIN(\d+)$/i);
  if (!m) return false;
  const n = Number(m[1]);
  return n >= 0 && n <= 255;
}

/** 值为 null / undefined / 数值 0 时不纳入 `bins` */
function isNullOrZeroBinValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "number" && Object.is(v, 0)) return true;
  if (typeof v === "bigint" && v === 0n) return true;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return false;
    const n = Number(t);
    return !Number.isNaN(n) && n === 0;
  }
  return false;
}

function coerceBinNumericValue(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const n = Number(v.trim());
    if (!Number.isNaN(n)) return n;
  }
  return Number(v);
}

/**
 * 从行内剥离 **`BIN0`…`BIN255`**，写入 **`bins`**：`{ [binIndex]: { value, isGood } }`，
 * 仅包含值非 null 且非 0 的 BIN。
 */
function extractBins(
  row: Record<string, unknown>,
  passBinRaw: unknown
): Record<string, InfcontrolLayerBinCell> {
  const bins: Record<string, InfcontrolLayerBinCell> = {};
  for (const key of Object.keys(row)) {
    if (!isBinColumnKey(key)) continue;
    const m = key.match(/^BIN(\d+)$/i)!;
    const idx = Number(m[1]);
    const raw = row[key];
    if (isNullOrZeroBinValue(raw)) {
      delete row[key];
      continue;
    }
    const isGood =
      idx === 1 || binColumnIndexIsGood(passBinRaw, idx);
    bins[String(idx)] = {
      value: coerceBinNumericValue(raw),
      isGood,
    };
    delete row[key];
  }
  return bins;
}

/**
 * 列表行附加：**`passBinPair`**（`PASSBIN` 两侧的两个整数，仅供解析参考）、**`bins`**。
 * 不再输出顶层 **`BINn`** 列与 **`binIsGood`** 数组。
 */
export function enrichInfcontrolLayerBinRow(
  row: Record<string, unknown>
): Record<string, unknown> {
  const passBin = row.PASSBIN ?? row.passbin;
  const pair = parsePassBinPair(passBin);

  const rest = { ...row };
  const bins = extractBins(rest, passBin);

  return {
    ...rest,
    passBinPair: pair,
    bins,
  };
}

/**
 * PASSBIN 形如 **`1-2-3-55-250`**（`-` 分隔）时，每一段的非负整数 **BIN 下标** 视为 **good bin**；
 * 非法段跳过；下标限制在 0…255。
 */
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

/** v2 列表：每个非空 BIN 列对应一项 */
export type InfcontrolLayerBinV2BinEntry = {
  value: number;
  /** BIN 列下标，与 Oracle `BINn` 的 **n** 一致 */
  n: number;
  isGoodBin: boolean;
};

/**
 * 剥离 **`BIN0`…`BIN255`**，生成 **`bins`** 数组（仅值非 null 且非 0 的列）；
 * **good bin** 由 PASSBIN 的 `-` 分隔整数列表决定。
 */
export function enrichInfcontrolLayerBinRowV2(
  row: Record<string, unknown>
): Record<string, unknown> {
  const rest = { ...row };
  const hasBinColumns = Object.keys(rest).some((k) => isBinColumnKey(k));
  // v4 列表已带 bins[]、已剥离 BINn；勿再 enrich 成空数组（会导致良率误为 100%）。
  if (
    !hasBinColumns &&
    Array.isArray(rest.bins) &&
    (rest.bins as unknown[]).length > 0
  ) {
    return rest;
  }

  const passBin = row.PASSBIN ?? row.passbin;
  const good = parsePassBinHyphenGoodBins(passBin);
  const bins: InfcontrolLayerBinV2BinEntry[] = [];

  for (const key of Object.keys(rest)) {
    if (!isBinColumnKey(key)) continue;
    const m = key.match(/^BIN(\d+)$/i)!;
    const idx = Number(m[1]);
    const raw = rest[key];
    if (isNullOrZeroBinValue(raw)) {
      delete rest[key];
      continue;
    }
    bins.push({
      value: coerceBinNumericValue(raw),
      n: idx,
      isGoodBin: good.has(idx),
    });
    delete rest[key];
  }

  bins.sort((a, b) => a.n - b.n);

  return {
    ...rest,
    bins,
  };
}
