/**
 * One-off: reads JSON from stdin, writes docs/site-bin-bylot-dummy-r_1-1.passes.json
 * Usage: node scripts/write-site-bin-dummy-fixture.mjs < payload.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "..", "docs", "site-bin-bylot-dummy-r_1-1.passes.json");

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const parsed = JSON.parse(raw);
const passes = parsed.passes ?? parsed;
if (!Array.isArray(passes)) {
  console.error("Expected { passes: [...] } or a passes array");
  process.exit(1);
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ passes }, null, 2) + "\n", "utf8");
console.log("Wrote", out, "passes:", passes.length);
