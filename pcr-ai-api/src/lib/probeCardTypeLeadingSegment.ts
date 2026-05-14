/**
 * v3 列表 **`PROBECARDTYPE`**：取 **`CARDID` / `PROBECARD`** 在**首个 `-` 之前**的一段
 *（与 PASSBIN 的 token 规则无关）。无 `-` 时为整段 trim 后字符串；空或仅空白为 **`null`**。
 */
export function probeCardTypeLeadingSegment(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === "") return null;
  const i = s.indexOf("-");
  const head = i === -1 ? s : s.slice(0, i).trim();
  return head === "" ? null : head;
}
