/**
 * Pack pcr-ai-report/dist for nginx deploy.
 * Extract at web root so index.html and assets/ sit side by side.
 *
 *   cd pcr-ai-report && npm run pack:dist
 *   scp dist.tar server:/var/www/html/ && ssh server 'cd /var/www/html && tar xf dist.tar'
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(pkgRoot, "dist");
const indexHtml = path.join(distDir, "index.html");
const assetsDir = path.join(distDir, "assets");

if (!fs.existsSync(indexHtml)) {
  console.error("dist/index.html missing — run npm run build first");
  process.exit(1);
}
if (!fs.existsSync(assetsDir)) {
  console.error("dist/assets/ missing — run npm run build first");
  process.exit(1);
}

const assetCount = fs.readdirSync(assetsDir).length;
const outTar = path.join(pkgRoot, "dist.tar");

const entries = fs
  .readdirSync(distDir, { withFileTypes: true })
  .map((d) => d.name)
  .filter((name) => name !== ".gitkeep");

execSync(`tar -cf "${outTar}" ${entries.map((e) => JSON.stringify(e)).join(" ")}`, {
  cwd: distDir,
  stdio: "inherit",
});

console.log(
  `Wrote ${outTar} (${assetCount} files under assets/ + ${entries.length - 1} top-level items)`
);
console.log(
  "Deploy: extract to nginx document root (index.html and assets/ must be siblings)."
);
