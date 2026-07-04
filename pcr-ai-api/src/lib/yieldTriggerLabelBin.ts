/**
 * `TRIGGER_LABEL` in delta-diff / `YMWEB_YIELDMONITORTRIGGER` always contains a
 * substring like `Bin# 1 on dut# 2 ...` or `Bin# goodbin on dut# 21 ...`.
 * See `docs/delta-diff.xlsx`; verified 152/152 TYPE=delta_diff sample rows parse.
 */
const BIN_FROM_TRIGGER_LABEL = /\bBin#\s*([0-9]+|goodbin)\b/i;

export function parseBinFromTriggerLabel(
  label: string | null | undefined
): string | null {
  if (label == null || label === "") return null;
  const m = String(label).match(BIN_FROM_TRIGGER_LABEL);
  if (!m) return null;
  return m[1].toLowerCase();
}
