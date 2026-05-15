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

/** timeDay aggregate keys (e.g. `2024-05-01 00:00:00`) → `YYYY-MM-DD` for chart axes */
export function formatChartDayLabel(raw: string): string {
  const t = raw.trim();
  if (!t) return t;
  const datePrefix = t.match(/^(\d{4}-\d{2}-\d{2})/);
  if (datePrefix) return datePrefix[1];
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return t;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Chart axis label for a single aggregate dimension value */
export function formatAggregateDimLabel(dim: string, raw: string): string {
  if (dim === "timeDay") return formatChartDayLabel(raw);
  return raw;
}
