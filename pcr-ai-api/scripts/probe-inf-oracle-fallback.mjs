/**
 * 探索 INFLAYERBINLIST / INFCONTROL 是否含 wafer map 回退字段（TESTSITELAST 等）。
 * 通过已部署 API 的 Oracle 连接执行只读 SQL（不依赖本机 .env）。
 *
 * 用法：
 *   node scripts/probe-inf-oracle-fallback.mjs
 *   PCR_API_BASE=http://127.0.0.1:30008 node scripts/probe-inf-oracle-fallback.mjs
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API_BASE = (process.env.PCR_API_BASE || "http://10.192.130.89:30008").replace(/\/$/, "");
const OUT =
  process.env.PROBE_OUT ||
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scratchpad", "probe-inf-oracle-fallback.txt");

const lines = [];
function log(s = "") {
  lines.push(s);
  console.log(s);
}

async function apiGet(path, params = {}) {
  const u = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) u.searchParams.set(k, String(v));
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 120_000);
  try {
    const r = await fetch(u, { signal: ac.signal });
    const text = await r.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { _raw: text.slice(0, 2000), _status: r.status };
    }
    return { ok: r.ok, status: r.status, json, url: u.toString() };
  } finally {
    clearTimeout(t);
  }
}

/** 通过 table-rows 拉样本；CLOB 可能很大，只保留列名 + 截断值 */
function summarizeRows(rows, maxValLen = 120) {
  if (!Array.isArray(rows) || rows.length === 0) return { columns: [], sample: null };
  const row = rows[0];
  const columns = Object.keys(row).sort();
  const sample = {};
  for (const k of columns) {
    let v = row[k];
    if (v == null) {
      sample[k] = null;
      continue;
    }
    if (typeof v === "object" && v !== null) {
      // oracledb LOB / Date serialized oddly
      v = String(v);
    }
    const s = String(v);
    sample[k] = s.length > maxValLen ? s.slice(0, maxValLen) + `…(${s.length} chars)` : s;
  }
  return { columns, sample };
}

function colsMatching(columns, re) {
  return columns.filter((c) => re.test(c));
}

async function main() {
  log(`=== probe-inf-oracle-fallback ===`);
  log(`API_BASE=${API_BASE}`);
  log(`time=${new Date().toISOString()}`);
  log("");

  const health = await apiGet("/health");
  log(`[health] ok=${health.ok} status=${health.status}`);
  if (!health.ok) {
    log(JSON.stringify(health.json, null, 2));
    writeFileSync(OUT, lines.join("\n"), "utf8");
    process.exit(1);
  }

  const ping = await apiGet("/api/v1/db/ping");
  log(`[db/ping] ok=${ping.ok} status=${ping.status}`);
  if (!ping.ok) {
    log(JSON.stringify(ping.json, null, 2));
    writeFileSync(OUT, lines.join("\n"), "utf8");
    process.exit(1);
  }

  // 1) 从 JB v4 取一条最近 TEST 行作为探针 lot/slot
  const jb = await apiGet("/api/v4/infcontrol-layer-bins/v4", {
    device: "WA03P02G",
    limit: 3,
  });
  log(`\n[jb/v4 sample] ok=${jb.ok}`);
  const jbRows = jb.json?.rows ?? [];
  log(`count=${jbRows.length}`);
  for (const r of jbRows.slice(0, 3)) {
    log(
      `  lot=${r.LOT} slot=${r.SLOT} passId=${r.PASSID} passNum=${r.PASSNUM} card=${r.CARDID} testEnd=${r.TESTEND}`
    );
  }
  const probe = jbRows[0];
  if (!probe) {
    log("No JB rows — abort");
    writeFileSync(OUT, lines.join("\n"), "utf8");
    process.exit(1);
  }

  // 2) table-rows：INFLAYERBINLIST / INFCONTROL 列结构（limit=1，可能含大 CLOB）
  for (const table of ["INFLAYERBINLIST", "INFCONTROL"]) {
    log(`\n[table-rows ${table}]`);
    const tr = await apiGet("/api/v1/table-rows", { table, limit: 1 });
    log(`ok=${tr.ok} status=${tr.status}`);
    if (!tr.ok) {
      log(JSON.stringify(tr.json, null, 2));
      continue;
    }
    const { columns, sample } = summarizeRows(tr.json?.rows);
    log(`columnCount=${columns.length}`);
    const mapCols = colsMatching(columns, /MAP|NOTCH|SITE|BIN.*LAST|KEY|PASS|LOT|SLOT|DEVICE/i);
    log(`mapRelatedColumns=${JSON.stringify(mapCols)}`);
    if (sample) {
      for (const k of mapCols) {
        log(`  ${k}=${JSON.stringify(sample[k])}`);
      }
    }
  }

  // 3) site-bin-bylot：该片 INF 是否在 API 主机可读
  const infPath = `/data/INF/${String(probe.DEVICE).toUpperCase()}/${String(probe.LOT).toUpperCase()}/r_1-${probe.SLOT}`;
  log(`\n[site-bin-bylot single] infPath=${infPath} passId=${probe.PASSID}`);
  const sb = await apiGet("/api/v4/inf-analysis/site-bin-bylot", {
    infPath,
    passId: probe.PASSID,
  });
  log(`ok=${sb.ok} status=${sb.status}`);
  if (sb.ok) {
    const passes = sb.json?.passes ?? [];
    log(`passes=${passes.length} bins[0]=${JSON.stringify(passes[0]?.bins?.slice(0, 2))}`);
  } else {
    log(`error=${JSON.stringify(sb.json?.error ?? sb.json?.code ?? sb.json)}`);
    log(`detail=${(sb.json?.detail ?? "").slice(0, 500)}`);
  }

  // 4) 用 device+lot+passId 聚合模式（JB 锁定 wafer 列表）
  log(`\n[site-bin-bylot lot agg] device=${probe.DEVICE} lot=${probe.LOT} passId=${probe.PASSID}`);
  const sbLot = await apiGet("/api/v4/inf-analysis/site-bin-bylot", {
    device: probe.DEVICE,
    lot: probe.LOT,
    passId: probe.PASSID,
    probeCardType: probe.PROBECARDTYPE ?? "8041",
  });
  log(`ok=${sbLot.ok} status=${sbLot.status}`);
  if (sbLot.ok) {
    log(
      `waferCount=${sbLot.json?.waferCount} waferSlots=${JSON.stringify(sbLot.json?.waferSlots?.slice(0, 8))} skipped=${(sbLot.json?.skippedInfPaths ?? []).length}`
    );
  } else {
    log(`error=${JSON.stringify(sbLot.json?.error ?? sbLot.json?.code ?? sbLot.json)}`);
  }

  // 5) 尝试用 table-rows 拉同 lot 的 INFLAYERBINLIST 多行（limit=5）看列名是否含 TESTSITELAST
  log(`\n[table-rows INFLAYERBINLIST limit=5 — column scan only]`);
  const tr5 = await apiGet("/api/v1/table-rows", { table: "INFLAYERBINLIST", limit: 5 });
  if (tr5.ok && tr5.json?.rows?.length) {
    const cols = Object.keys(tr5.json.rows[0]).sort();
    const siteBinLast = cols.filter((c) => /SITE|BIN|MAP|LAST|ROW|COL|NOTCH/i.test(c));
    log(`allColumns(${cols.length}): ${cols.join(", ")}`);
    log(`filtered: ${siteBinLast.join(", ")}`);
    // 找非空 TESTSITELAST 样例行
    for (const row of tr5.json.rows) {
      for (const key of cols) {
        if (!/SITE|BIN.*LAST|MAP/i.test(key)) continue;
        const v = row[key];
        if (v != null && String(v).trim().length > 0) {
          const s = String(v);
          log(`\n  non-null ${key} on KEYNUMBER=${row.KEYNUMBER ?? "?"} PASSID=${row.PASSID ?? "?"}:`);
          log(`    ${s.slice(0, 200)}${s.length > 200 ? `…(${s.length} chars)` : ""}`);
          break;
        }
      }
    }
  } else {
    log(`failed: ${JSON.stringify(tr5.json)?.slice(0, 500)}`);
  }

  log("\n=== done ===");
  writeFileSync(OUT, lines.join("\n"), "utf8");
  log(`\nWrote ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
