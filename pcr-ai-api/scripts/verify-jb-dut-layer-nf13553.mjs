/**
 * 真库复验：NF13553.1H slot 14 passId 3 两层 DUT×BIN 不应合并。
 * 用法（API 已部署 testEnd 参数后）：
 *   node scripts/verify-jb-dut-layer-nf13553.mjs
 *   API_BASE=http://10.192.130.89:30008 node scripts/verify-jb-dut-layer-nf13553.mjs
 */
const base = (process.env.API_BASE ?? "http://10.192.130.89:30008").replace(/\/$/, "");
const lot = "NF13553.1H";
const slot = 14;
const passId = 3;
const infPath = `/data/INF/WA20N65N/${lot}/r_1-${slot}`;

function sumPassDie(passes, pid) {
  const p = passes.find((x) => x.passId === pid);
  if (!p) return 0;
  return p.bins.reduce(
    (s, b) => s + b.duts.reduce((t, d) => t + (d.dieCount ?? 0), 0),
    0
  );
}

function yieldFromRow(row) {
  let good = 0;
  let total = 0;
  for (const b of row.bins ?? []) {
    const v = Number(b.value) || 0;
    if (v <= 0) continue;
    total += v;
    if (b.isGoodBin) good += v;
  }
  return total > 0 ? Math.round((1000 * good) / total) / 10 : null;
}

async function main() {
  const jbUrl = `${base}/api/v4/infcontrol-layer-bins/v3?lot=${encodeURIComponent(lot)}&slot=${slot}&passId=${passId}&limit=20`;
  const jb = await fetch(jbUrl).then((r) => r.json());
  if (!jb.rows?.length) {
    console.error("No JB rows", jb);
    process.exit(1);
  }
  console.log(`JB rows: ${jb.rows.length}`);
  for (const row of jb.rows) {
    console.log(
      `  KEYNUMBER=${row.KEYNUMBER} PASSNUM=${row.PASSNUM} TESTEND=${row.TESTEND} GROSS=${row.GROSSDIE} yield=${yieldFromRow(row)}%`
    );
  }

  const mergedUrl = `${base}/api/v4/inf-analysis/site-bin-bylot?infPath=${encodeURIComponent(infPath)}&passId=${passId}`;
  const merged = await fetch(mergedUrl).then((r) => r.json());
  if (merged.error) {
    console.error("merged fetch error", merged);
    process.exit(1);
  }
  const mergedDie = sumPassDie(merged.passes ?? [], passId);
  console.log(`\nMerged (no layer keys) mapSource=${merged.mapSource} pass3 totalDie=${mergedDie}`);

  const layerResults = [];
  for (const row of jb.rows) {
    const q = new URLSearchParams({
      infPath,
      passId: String(passId),
      testEnd: String(row.TESTEND),
    });
    if (row.KEYNUMBER != null) q.set("keynumber", String(row.KEYNUMBER));
    if (row.PASSNUM != null) q.set("passNum", String(row.PASSNUM));
    const url = `${base}/api/v4/inf-analysis/site-bin-bylot?${q}`;
    const data = await fetch(url).then((r) => r.json());
    if (data.error) {
      console.error("layer fetch error", row.TESTEND, data);
      process.exit(1);
    }
    const die = sumPassDie(data.passes ?? [], passId);
    layerResults.push({ testEnd: row.TESTEND, gross: row.GROSSDIE, yield: yieldFromRow(row), die, mapSource: data.mapSource });
    console.log(
      `Layer TESTEND=${row.TESTEND} yield=${yieldFromRow(row)}% siteBinDie=${die} mapSource=${data.mapSource}`
    );
  }

  const dies = layerResults.map((x) => x.die);
  const unique = new Set(dies);
  const sumLayers = dies.reduce((a, b) => a + b, 0);
  console.log("\n--- summary ---");
  console.log(`unique layer die counts: ${[...unique].join(", ")}`);
  console.log(`sum(layers)=${sumLayers} merged=${mergedDie}`);
  const okDistinct = unique.size === jb.rows.length && unique.size > 1;
  const okNotMerged = layerResults.every((l) => l.die < mergedDie || mergedDie === 0);
  console.log(okDistinct ? "PASS distinct layers" : "FAIL layers not distinct");
  console.log(okNotMerged ? "PASS each layer < merged" : "WARN layer die equals merged (still merged?)");
  process.exit(okDistinct ? 0 : 2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
