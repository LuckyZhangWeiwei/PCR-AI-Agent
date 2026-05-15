#!/usr/bin/env node
/**
 * Fail build if compiled output still imports npm `undici` (stale deploy guard).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "dist", "lib", "siliconflowChat.js");

if (!fs.existsSync(target)) {
  console.warn("[verify-dist-no-undici] skip: dist/lib/siliconflowChat.js not found");
  process.exit(0);
}

const src = fs.readFileSync(target, "utf8");
const bad =
  /from\s+["']undici["']/.test(src) ||
  /import\s*\(\s*["']undici["']\s*\)/.test(src) ||
  /require\s*\(\s*["']undici["']\s*\)/.test(src);

if (bad) {
  console.error(
    "[verify-dist-no-undici] dist/lib/siliconflowChat.js still imports undici. Run a clean build from current src (no undici in package.json).",
  );
  process.exit(1);
}

console.log("[verify-dist-no-undici] ok: no undici import in siliconflowChat.js");
