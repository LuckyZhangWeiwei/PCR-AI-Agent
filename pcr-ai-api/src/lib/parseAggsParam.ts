export type AggSpec = { groupBy: string; groupTop: number };

export function parseAggsParam(
  raw: unknown,
  maxSpecs = 10
): { ok: true; specs: AggSpec[] } | { ok: false; error: string } {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: true, specs: [] };
  }
  const items = raw.split("|").filter((s) => s.trim() !== "");
  if (items.length > maxSpecs) {
    return {
      ok: false,
      error: `aggs has at most ${maxSpecs} specs; got ${items.length}`,
    };
  }
  const specs: AggSpec[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    const lastColon = trimmed.lastIndexOf(":");
    let groupBy: string;
    let groupTop: number;
    if (lastColon === -1) {
      groupBy = trimmed;
      groupTop = 30;
    } else {
      const suffix = trimmed.slice(lastColon + 1).trim();
      if (suffix === "") {
        groupBy = trimmed.slice(0, lastColon).trim();
        groupTop = 30;
      } else {
        const n = Number(suffix);
        if (!Number.isInteger(n) || n <= 0) {
          return {
            ok: false,
            error: `groupTop must be a positive integer; got "${suffix}" in "${trimmed}"`,
          };
        }
        groupBy = trimmed.slice(0, lastColon).trim();
        groupTop = n;
      }
    }
    if (groupBy === "") {
      return { ok: false, error: `groupBy is empty in aggs spec "${trimmed}"` };
    }
    specs.push({ groupBy, groupTop });
  }
  return { ok: true, specs };
}
