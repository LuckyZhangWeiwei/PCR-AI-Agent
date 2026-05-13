/**
 * `TRIGGER_LABEL` in delta-diff / `YMWEB_YIELDMONITORTRIGGER` often contains
 * a substring like `on dut# 21` (spacing around `#` may vary). See `docs/delta-diff.xlsx`.
 */
const DUT_NUMBER_FROM_TRIGGER_LABEL = /\bon\s+dut#\s*(\d+)\b/i;

export function parseDutNumberFromTriggerLabel(
  label: string | null | undefined
): number | null {
  if (label == null || label === "") return null;
  const m = String(label).match(DUT_NUMBER_FROM_TRIGGER_LABEL);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Adds **`dutNumber`** (camelCase JSON) from **`TRIGGER_LABEL`** / common driver key casings. */
export function addDutNumberToYieldMonitorV3Row(
  row: Record<string, unknown>
): Record<string, unknown> {
  const out = { ...row };
  const label =
    out.TRIGGER_LABEL ?? out.trigger_label ?? out.Trigger_Label ?? out.TRIGGER_label;
  out.dutNumber = parseDutNumberFromTriggerLabel(
    label != null ? String(label) : null
  );
  return out;
}
