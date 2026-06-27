/**
 * Non-empty trimmed string check for Oracle WHERE clauses.
 * Do not use `TRIM(col) != ''` — Oracle treats '' as NULL, so `x != ''` becomes `x != NULL`
 * (always unknown) and filters out every row, including non-empty values.
 */
export function oracleNonEmptyTrimmedColumn(column: string): string {
  return `${column} IS NOT NULL AND LENGTH(TRIM(${column})) > 0`;
}
