import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src", "perlscripts");
const destDir = path.join(root, "dist", "perlscripts");

if (!fs.existsSync(srcDir)) {
  console.error("copy-perlscripts: missing", srcDir);
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });
for (const name of fs.readdirSync(srcDir)) {
  if (!name.endsWith(".pl")) continue;
  fs.copyFileSync(path.join(srcDir, name), path.join(destDir, name));
}
console.log("copy-perlscripts: copied .pl files to dist/perlscripts/");
