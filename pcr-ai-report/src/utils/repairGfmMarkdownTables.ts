/** Count pipe-table columns (GFM: leading/trailing pipes). */
export function countGfmTableColumns(row: string): number {
  const trimmed = row.trim();
  if (!trimmed.startsWith("|")) return 0;
  return trimmed.split("|").filter((_, i, parts) => i > 0 && i < parts.length - 1).length;
}

function isSeparatorRow(line: string): boolean {
  return /^\s*\|[\s:|-]+\|\s*$/.test(line.trim());
}

/** Build |---|---| row with n columns (GFM table delimiter). */
export function buildGfmSeparatorRow(columnCount: number): string {
  if (columnCount < 1) return "";
  return `|${Array(columnCount).fill("---").join("|")}|`;
}

/**
 * Fix delimiter rows whose column count does not match the header row above.
 * remark-gfm ignores invalid tables and leaves raw pipes visible.
 */
export function repairGfmMarkdownTables(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const next = lines[i + 1];
    if (
      next != null &&
      /^\s*\|/.test(line) &&
      !isSeparatorRow(line) &&
      isSeparatorRow(next)
    ) {
      const headerCols = countGfmTableColumns(line);
      const sepCols = countGfmTableColumns(next);
      out.push(line);
      if (headerCols > 0 && sepCols !== headerCols) {
        out.push(buildGfmSeparatorRow(headerCols));
        i++;
        continue;
      }
    }
    out.push(line);
  }

  return out.join("\n");
}
