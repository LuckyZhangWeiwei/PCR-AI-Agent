/**
 * Oracle `OUT_FORMAT_OBJECT` 等返回的列名在不同驱动/配置下可能出现大小写差异；
 * Dummy/Excel 与内存聚合代码（如 **`BIN0`**、**`PASSBIN`**）按**大写**键读取。
 * 将单行键统一为 **UPPER**，使 v4 Oracle 内存聚合与 Dummy 行形状对齐。
 */
export function normalizeDbRowKeysUpper(
  row: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === "__proto__") continue;
    out[k.toUpperCase()] = v;
  }
  return out;
}
