/** Browser `datetime-local` value ↔ API ISO 8601 (UTC via Date.toISOString). */

export function isoLikeToDatetimeLocal(isoOrTimestamp: string): string {
  const d = new Date(isoOrTimestamp.trim());
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function datetimeLocalToIso(value: string): string | undefined {
  const t = value.trim();
  if (!t) return undefined;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}
