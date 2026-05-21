/**
 * node-oracledb 5.5 Connection._isDate() calls util.isDate (removed in Node.js 23+).
 * Patch before any `import "oracledb"` so Date bind parameters work on newer Node runtimes.
 */
import nodeUtil from "node:util";

const util = nodeUtil as typeof nodeUtil & {
  isDate?: (value: unknown) => boolean;
};

if (typeof util.isDate !== "function") {
  util.isDate = (value: unknown): boolean => value instanceof Date;
}
