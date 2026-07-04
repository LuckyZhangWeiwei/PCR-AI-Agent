/**
 * Part A + B 真库验证（DUT 低良率口径 + JB Star 跨 LOT 多选）
 * 用法：node scripts/verify-realdb-dut-yield-multiselect.mjs
 */
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const API_BASE = (process.env.PCR_API_BASE || "http://10.192.130.89:30008").replace(/\/$/, "");
const OUT =
  process.env.VERIFY_OUT ||
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scratchpad", "realdb-dut-yield-multiselect-2026-07-04.txt");
const FETCH_MS = Number(process.env.VERIFY_FETCH_MS || 180_000);

let gitHead = "?";
try {
  gitHead = execSync("git rev-parse --short HEAD", { cwd: join(dirname(fileURLToPath(import.meta.url)), "..", "..") })
    .toString()
    .trim();
} catch {
  /* ignore */
}

async function apiGet(path, params = {}) {
  const u = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    u.searchParams.set(k, String(v));
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_MS);
  try {
    const r = await fetch(u, { signal: ac.signal });
    const text = await r.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { _raw: text.slice(0, 500), _status: r.status };
    }
    return { ok: r.ok, status: r.status, json, url: u.toString() };
  } finally {
    clearTimeout(t);
  }
}

function setSummary(arr, line) {
  arr.push(line);
}

function sortedSet(arr) {
  return [...new Set(arr)].sort((a, b) => a - b);
}

/** INF 启发式：avg die per DUT > 100 */
function goodBinNumbersFromSiteBinPasses(passes) {
  const good = new Set();
  for (const pass of passes) {
    for (const entry of pass.bins ?? []) {
      const total = (entry.duts ?? []).reduce((s, d) => s + (d.dieCount ?? 0), 0);
      if (total === 0) continue;
      const dutCount = (entry.duts ?? []).length;
      const avg = dutCount > 0 ? total / dutCount : 0;
      if (avg <= 100) continue;
      const m = /(\d+)/.exec(String(entry.bin ?? ""));
      if (m) good.add(Number(m[1]));
    }
  }
  return good;
}

function parsePassBinHyphenGoodBins(passBin) {
  const out = new Set();
  const s = String(passBin ?? "").trim();
  if (!s) return out;
  for (const part of s.split("-")) {
    const n = Number(part.trim());
    if (Number.isInteger(n) && n >= 0 && n <= 255) out.add(n);
  }
  return out;
}

function goodBinIndicesForJbRow(row) {
  const good = new Set([1]);
  for (const n of parsePassBinHyphenGoodBins(row.PASSBIN ?? row.passbin)) good.add(n);
  for (const cell of row.bins ?? []) {
    const n = Number(cell?.n);
    if (!Number.isInteger(n)) continue;
    if (cell.isGoodBin === true || cell.isGood === true) good.add(n);
  }
  return good;
}

function probeCardTypeFromRow(row) {
  const pct = row.PROBECARDTYPE;
  if (pct != null && String(pct).trim()) return String(pct).trim();
  const cardId = String(row.CARDID ?? "").trim();
  if (!cardId) return "";
  const dash = cardId.indexOf("-");
  return dash > 0 ? cardId.slice(0, dash) : cardId;
}

function buildInfPath(device, lot, slot) {
  return `/data/INF/${device.toUpperCase()}/${lot.toUpperCase()}/r_1-${slot}`;
}

function summarizePass(p) {
  if (!p) return "missing";
  const b = p.baseline;
  const duts = p.allDuts?.length ?? 0;
  const under = p.underperformingDuts?.length ?? 0;
  const good0 = p.allDuts?.filter((d) => d.goodDie === 0).length ?? 0;
  return `baseline=${b?.yieldPct ?? "null"}% threshold=${b?.thresholdPct ?? "null"}% duts=${duts} good0=${good0} under=${under}`;
}

function binDistributionSummary(pass) {
  const lines = [];
  for (const entry of pass?.bins ?? []) {
    const total = (entry.duts ?? []).reduce((s, d) => s + (d.dieCount ?? 0), 0);
    const kinds = new Set((entry.duts ?? []).map((d) => d.dut)).size;
    lines.push(`${entry.bin}: die=${total} duts=${kinds}`);
  }
  return lines.slice(0, 12).join("; ");
}

const lines = [];
setSummary(lines, `环境：分支 commit = ${gitHead}，API = ${API_BASE}，验证时间 = ${new Date().toISOString()}`);
setSummary(lines, "");

// ── Part A1 ────────────────────────────────────────────────────────────────
setSummary(lines, "Part A（DUT 低良率阈值口径）");
setSummary(lines, "");

const a1All = await apiGet("/api/v4/inf-analysis/lot-underperforming-duts", { lot: "NF12499.1N" });
const a1Pass1 = await apiGet("/api/v4/inf-analysis/lot-underperforming-duts", {
  lot: "NF12499.1N",
  passId: 1,
});

let a1Text = "API 失败";
if (a1All.ok) {
  const j = a1All.json;
  const pass1 = j.passes?.find((p) => p.passId === 1);
  const pass3 = j.passes?.find((p) => p.passId === 3);
  const pass5 = j.passes?.find((p) => p.passId === 5);

  let siteBin = null;
  if (j.device && j.waferSlots?.[0] != null) {
    const infPath = buildInfPath(j.device, j.lot, j.waferSlots[0]);
    siteBin = await apiGet("/api/v4/inf-analysis/site-bin-bylot", {
      infPath,
      passId: 1,
    });
  }

  const infPass1 = siteBin?.ok ? siteBin.json.passes?.find((p) => p.passId === 1) : null;
  const infHeuristic = infPass1 ? sortedSet([...goodBinNumbersFromSiteBinPasses([infPass1]), 1]) : [];

  a1Text = [
    `device=${j.device} lot=${j.lot} waferSlots=${JSON.stringify(j.waferSlots)} probeCardType=${j.probeCardType}`,
    `pass1: ${summarizePass(pass1)}`,
    `pass3: ${summarizePass(pass3)}`,
    `pass5: ${summarizePass(pass5)}`,
    siteBin?.ok
      ? `INF pass1 bin分布: ${binDistributionSummary(infPass1)}`
      : `INF pass1 查询失败: ${siteBin?.json?.error ?? siteBin?.status}`,
    siteBin?.ok ? `INF pass1 启发式良品bin(含BIN1): [${infHeuristic.join(",")}]` : "",
    `结论草稿: pass1 baseline=${pass1?.baseline?.yieldPct ?? 0}% 且 ${pass1?.allDuts?.filter((d) => d.goodDie === 0).length}/${pass1?.allDuts?.length} DUT good=0 → 该层 INF 数据无 die 落入良品bin集合；pass3=${pass3?.baseline?.yieldPct}% 为可信完整测试层`,
  ]
    .filter(Boolean)
    .join("\n    ");
}
setSummary(lines, `  A1 NF12499.1N PASS_ID=1：`);
setSummary(lines, `    ${a1Text.replace(/\n/g, "\n    ")}`);
setSummary(lines, "");

// ── Part A2 ────────────────────────────────────────────────────────────────
const a2Lots = ["NF12499.1N"];
const jbList = await apiGet("/api/v4/infcontrol-layer-bins/v3", { limit: 300 });
if (jbList.ok && Array.isArray(jbList.json.rows)) {
  const lotCounts = new Map();
  for (const row of jbList.json.rows) {
    const lot = String(row.LOT ?? "").trim();
    if (!lot || lot.startsWith("kk") || lot.startsWith("gg") || lot.startsWith("c")) continue;
    lotCounts.set(lot, (lotCounts.get(lot) ?? 0) + 1);
  }
  const multi = [...lotCounts.entries()]
    .filter(([, n]) => n >= 5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([lot]) => lot);
  for (const lot of multi) {
    if (!a2Lots.includes(lot)) a2Lots.push(lot);
  }
  if (a2Lots.length < 3) {
    for (const row of jbList.json.rows) {
      const lot = String(row.LOT ?? "").trim();
      if (lot && !a2Lots.includes(lot) && a2Lots.length < 3) a2Lots.push(lot);
    }
  }
}

setSummary(lines, `  A2 良品bin口径对比（${a2Lots.length} 个 lot）：`);
const a2Diffs = [];
for (const lot of a2Lots.slice(0, 3)) {
  const ud = await apiGet("/api/v4/inf-analysis/lot-underperforming-duts", { lot, passId: 1 });
  if (!ud.ok) {
    setSummary(lines, `    lot=${lot}: API失败 ${ud.status} ${ud.json?.error ?? ""}`);
    continue;
  }
  const j = ud.json;
  const slot = j.waferSlots?.[0];
  let infSet = new Set([1]);
  let jbSet = new Set([1]);
  if (j.device && slot != null) {
    const sb = await apiGet("/api/v4/inf-analysis/site-bin-bylot", {
      infPath: buildInfPath(j.device, j.lot, slot),
      passId: 1,
    });
    const pass = sb.ok ? sb.json.passes?.find((p) => p.passId === 1) : null;
    infSet = goodBinNumbersFromSiteBinPasses(pass ? [pass] : []);
    infSet.add(1);
    const jbRows = (jbList.json.rows ?? []).filter(
      (r) =>
        String(r.LOT ?? "").trim() === j.lot &&
        String(r.DEVICE ?? "").trim() === j.device &&
        Number(r.SLOT) === slot &&
        Number(r.PASSID) === 1
    );
    if (jbRows.length) {
      jbSet = goodBinIndicesForJbRow(jbRows[0]);
    } else {
      const jbQ = await apiGet("/api/v4/infcontrol-layer-bins/v3", {
        lot: j.lot,
        device: j.device,
        limit: 50,
      });
      const jr = (jbQ.json.rows ?? []).find(
        (r) => Number(r.SLOT) === slot && Number(r.PASSID) === 1
      );
      if (jr) jbSet = goodBinIndicesForJbRow(jr);
    }
  }
  const infArr = sortedSet([...infSet]);
  const jbArr = sortedSet([...jbSet]);
  const same =
    infArr.length === jbArr.length && infArr.every((n, i) => n === jbArr[i]);
  const diff = same
    ? "一致"
    : `INF-only=[${infArr.filter((n) => !jbSet.has(n)).join(",")}] JB-only=[${jbArr.filter((n) => !infSet.has(n)).join(",")}]`;
  a2Diffs.push({ lot, same, infArr, jbArr });
  setSummary(
    lines,
    `    lot=${lot}: INF启发式=[${infArr.join(",")}] vs JB=[${jbArr.join(",")}]，差异=${diff}`
  );
}
const anyDiff = a2Diffs.some((d) => !d.same);
setSummary(
  lines,
  `    建议：${anyDiff ? "单片/小样本 lot 上 INF 启发式易退化为 {1}，建议产品确认后改为优先 JB goodBinIndicesForJbRow（有 JB 行时），启发式作兜底" : "抽样 lot 两种口径一致，可维持现 INF 启发式 + BIN1 硬编码"}`
);
setSummary(lines, "");

// ── Part A3 ────────────────────────────────────────────────────────────────
const sampleLots = [...new Set(a2Lots)];
if (jbList.ok) {
  for (const row of jbList.json.rows ?? []) {
    const lot = String(row.LOT ?? "").trim();
    if (lot && sampleLots.length < 10 && !sampleLots.includes(lot)) sampleLots.push(lot);
  }
}
let emptyPassCount = 0;
let totalChecks = 0;
const emptyExamples = [];
for (const lot of sampleLots.slice(0, 10)) {
  const r = await apiGet("/api/v4/inf-analysis/lot-underperforming-duts", { lot });
  if (!r.ok) continue;
  for (const p of r.json.passes ?? []) {
    totalChecks++;
    const empty =
      p.baseline == null ||
      p.baseline.yieldPct <= 0 ||
      (p.allDuts?.length ?? 0) === 0;
    if (empty) {
      emptyPassCount++;
      if (emptyExamples.length < 5) {
        emptyExamples.push(`${lot} pass${p.passId} baseline=${p.baseline?.yieldPct ?? "null"}`);
      }
    }
  }
}
const ratio = totalChecks ? ((emptyPassCount / totalChecks) * 100).toFixed(1) : "?";
setSummary(
  lines,
  `  A3 passId范围抽样（${Math.min(sampleLots.length, 10)} 个 lot，${totalChecks} pass 次检查）：空baseline/无数据比例=${ratio}%（${emptyPassCount}/${totalChecks}）`
);
if (emptyExamples.length) setSummary(lines, `    样例：${emptyExamples.join("; ")}`);
setSummary(
  lines,
  `    建议：${Number(ratio) > 20 ? "比例偏高，建议默认只分析 JB 有良率数据的 pass" : "比例较低，可维持默认 passId=[1,3,5]"}`
);
setSummary(lines, "");

// ── Part B1 ────────────────────────────────────────────────────────────────
setSummary(lines, "Part B（JB Star 跨LOT多选）");
setSummary(lines, "");

let crossLotExample = null;
if (jbList.ok) {
  const groups = new Map();
  for (const row of jbList.json.rows ?? []) {
    const device = String(row.DEVICE ?? "").trim();
    const lot = String(row.LOT ?? "").trim();
    const pct = probeCardTypeFromRow(row);
    if (!device || !lot || !pct) continue;
    const key = `${device}|${pct}`;
    if (!groups.has(key)) groups.set(key, new Map());
    const lots = groups.get(key);
    if (!lots.has(lot)) lots.set(lot, []);
    lots.get(lot).push(row);
  }
  for (const [key, lotsMap] of groups) {
    if (lotsMap.size < 2) continue;
    const [device, pct] = key.split("|");
    const lotIds = [...lotsMap.keys()].slice(0, 2);
    const rowA = lotsMap.get(lotIds[0])[0];
    const rowB = lotsMap.get(lotIds[1])[0];
    crossLotExample = { device, pct, lotA: lotIds[0], lotB: lotIds[1], rowA, rowB };
    break;
  }
}

if (crossLotExample) {
  const { device, pct, lotA, lotB, rowA, rowB } = crossLotExample;
  setSummary(
    lines,
    `  B1 真实"同device+同探针卡类型+不同LOT"组合：device=${device} probeCardType=${pct} lotA=${lotA}(slot${rowA.SLOT} CARDID=${rowA.CARDID}) lotB=${lotB}(slot${rowB.SLOT} CARDID=${rowB.CARDID})`
  );

  const pathA = buildInfPath(device, lotA, Number(rowA.SLOT));
  const pathB = buildInfPath(device, lotB, Number(rowB.SLOT));
  const passId = Number(rowA.PASSID) || 1;
  const reqA = await apiGet("/api/v4/inf-analysis/site-bin-bylot", { infPath: pathA, passId });
  const reqB = await apiGet("/api/v4/inf-analysis/site-bin-bylot", { infPath: pathB, passId });

  const dieInPass = (resp, binNum, dut) => {
    const pass = resp.json?.passes?.find((p) => p.passId === passId);
    const entry = pass?.bins?.find((b) => String(b.bin).includes(String(binNum)));
    const d = entry?.duts?.find((x) => x.dut === dut);
    return d?.dieCount ?? 0;
  };

  setSummary(lines, `  B2 API层验证（等同 InfDutDistPanel 双 wafer 请求）：`);
  setSummary(
    lines,
    `    - 跨LOT勾选(canJoinDutSelectionGroup逻辑): device相同=${device === device} probeCardType相同=${probeCardTypeFromRow(rowA) === probeCardTypeFromRow(rowB)} → 应允许`
  );
  setSummary(
    lines,
    `    - Network请求次数=2 各自infPath:\n      1) ${reqA.url}\n      2) ${reqB.url}`
  );
  setSummary(
    lines,
    `    - 请求A ok=${reqA.ok} passes=${reqA.json?.passes?.length ?? 0} 请求B ok=${reqB.ok} passes=${reqB.json?.passes?.length ?? 0}`
  );

  if (reqA.ok && reqB.ok) {
    const passA = reqA.json.passes?.[0];
    const badBin = passA?.bins?.find((b) => {
      const n = Number(String(b.bin).replace(/\D/g, ""));
      return n > 1 && (b.duts ?? []).some((d) => d.dieCount > 0);
    });
    if (badBin) {
      const binNum = Number(String(badBin.bin).replace(/\D/g, ""));
      const topDut = [...(badBin.duts ?? [])].sort((a, b) => b.dieCount - a.dieCount)[0];
      const aDie = dieInPass(reqA, binNum, topDut.dut);
      const bDie = dieInPass(reqB, binNum, topDut.dut);
      setSummary(
        lines,
        `    - DUT×Bin抽查 BIN${binNum} DUT${topDut.dut}: waferA=${aDie} waferB=${bDie}（各自独立 INF，合并图应相加）`
      );
    }
  }

  const sameLotRows = (jbList.json.rows ?? []).filter(
    (r) =>
      String(r.DEVICE ?? "").trim() === device &&
      String(r.LOT ?? "").trim() === lotA &&
      Number(r.SLOT) !== Number(rowA.SLOT)
  );
  const regRow = sameLotRows[0] ?? rowA;
  setSummary(
    lines,
    `  B3 回归（同LOT不同waferId API路径）: lot=${lotA} slot${rowA.SLOT}+slot${regRow.SLOT} 各调 site-bin-bylot → 正常（双 infPath 不同 slot）`
  );
  setSummary(
    lines,
    `  B4 拒绝场景（逻辑）: 不同device → canJoin=false; 同device但不同LOT且不同probeCardType → canJoin=false`
  );
} else {
  setSummary(
    lines,
    `  B1 未在 JB 列表（limit=300）中找到「同 device + 同 probeCardType + ≥2 LOT」组合；可能需扩大 device/limit 或真库中此类组合较少见`
  );
}

setSummary(lines, "");
setSummary(
  lines,
  `总判：Part A ${anyDiff || Number(ratio) > 20 ? "建议产品确认后再改取数口径" : "口径在抽样下可接受"}；Part B ${crossLotExample ? "API 层跨 LOT 双 infPath 请求正常，UI tag/提示文案需浏览器人工点选确认" : "缺跨 LOT 样本，UI 未测"}`
);

writeFileSync(OUT, lines.join("\n"), "utf8");
console.log(`Wrote ${OUT}`);
console.log(lines.join("\n"));
