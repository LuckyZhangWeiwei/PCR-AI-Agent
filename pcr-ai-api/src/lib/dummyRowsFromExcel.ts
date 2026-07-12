import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import type { InfcontrolLayerBinDummyRow } from "./infcontrol/infcontrolLayerBinDummy.js";
import type { YieldMonitorTriggerDummyRow } from "./yieldMonitor/yieldMonitorTriggerDummy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function docsPath(filename: string): string {
  return join(__dirname, "..", "..", "docs", filename);
}

function readXlsxSheet1Rows(path: string): unknown[][] {
  const buf = readFileSync(path);
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  const name = wb.SheetNames[0];
  if (!name) throw new Error(`No sheets in workbook: ${path}`);
  const sheet = wb.Sheets[name];
  if (!sheet) throw new Error(`Missing sheet ${name} in ${path}`);
  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: null,
    raw: true,
  }) as unknown[][];
  if (rows.length < 2) throw new Error(`Expected header + data rows in ${path}`);
  return rows;
}

/** 列名重复时保留第一次出现（JBStart 表尾重复 PASSRESUME / PASSTYPE / PASSBIN） */
function firstWinHeaderColumnMap(headerRow: unknown[]): Map<string, number> {
  const m = new Map<string, number>();
  for (let c = 0; c < headerRow.length; c++) {
    const cell = headerRow[c];
    if (cell == null || cell === "") continue;
    const name = String(cell).trim();
    if (!name) continue;
    if (!m.has(name)) m.set(name, c);
  }
  return m;
}

function pickRaw(row: unknown[], map: Map<string, number>, col: string): unknown {
  const i = map.get(col);
  if (i === undefined) return undefined;
  return row[i];
}

function pickStr(row: unknown[], map: Map<string, number>, col: string): string {
  const v = pickRaw(row, map, col);
  if (v == null) return "";
  return String(v).trim();
}

function pickNum(row: unknown[], map: Map<string, number>, col: string): number {
  const v = pickRaw(row, map, col);
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function cellToIso(v: unknown): string {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
  const s = String(v ?? "").trim();
  if (!s) return "";
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  return s;
}

function pickIso(row: unknown[], map: Map<string, number>, col: string): string {
  const v = pickRaw(row, map, col);
  return cellToIso(v);
}

function zeroBins(): Record<string, number> {
  const o: Record<string, number> = {};
  for (let i = 0; i < 256; i++) o[`BIN${i}`] = 0;
  return o;
}

/** 来自 `docs/JBStart.xlsx` Sheet1，列名与导出表一致（含 BIN1…BIN255）。 */
export function loadInfcontrolLayerBinRowsFromJbStartXlsx(): InfcontrolLayerBinDummyRow[] {
  const path = docsPath("JBStart.xlsx");
  const rows = readXlsxSheet1Rows(path);
  const headerRow = rows[0] ?? [];
  const col = firstWinHeaderColumnMap(headerRow);
  const out: InfcontrolLayerBinDummyRow[] = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0) continue;
    const keyRaw = row[0];
    const keynumber =
      typeof keyRaw === "number" && Number.isFinite(keyRaw)
        ? keyRaw
        : Number(String(keyRaw ?? "").replace(/,/g, ""));
    if (!Number.isFinite(keynumber)) continue;

    const bins = zeroBins();
    for (let b = 1; b <= 255; b++) {
      const name = `BIN${b}`;
      if (!col.has(name)) continue;
      bins[name] = pickNum(row, col, name);
    }

    const device = pickStr(row, col, "DEVICE");
    const lot = pickStr(row, col, "LOT");
    if (!device || !lot) continue;

    const o: InfcontrolLayerBinDummyRow = {
      ...bins,
      KEYNUMBER: keynumber,
      DEVICE: device,
      LOT: lot,
      CASSETTE: pickStr(row, col, "CASSETTE"),
      SLOT: pickNum(row, col, "SLOT"),
      NOTCH: pickStr(row, col, "NOTCH"),
      MAPROWS: pickNum(row, col, "MAPROWS"),
      MAPCOLS: pickNum(row, col, "MAPCOLS"),
      SAMPLETESTNUMBER: pickNum(row, col, "SAMPLETESTNUMBER"),
      PDPW: pickNum(row, col, "PDPW"),
      MESLOT: pickStr(row, col, "MESLOT"),
      TESTERID: pickStr(row, col, "TESTERID"),
      TSTYPE: pickStr(row, col, "TSTYPE"),
      CARDID: pickStr(row, col, "CARDID"),
      PIBID: pickStr(row, col, "PIBID"),
      PROBE: pickStr(row, col, "PROBE"),
      GROSSDIE: pickNum(row, col, "GROSSDIE"),
      PASSID: pickNum(row, col, "PASSID"),
      SESSIONNUMBER: pickNum(row, col, "SESSIONNUMBER"),
      PASSNUM: pickNum(row, col, "PASSNUM"),
      TESTSTART: pickIso(row, col, "TESTSTART"),
      TESTEND: pickIso(row, col, "TESTEND"),
      LAYERNAME: pickStr(row, col, "LAYERNAME"),
      PASSRESUME: pickStr(row, col, "PASSRESUME"),
      PASSRESULT: pickStr(row, col, "PASSRESULT"),
      PASSTYPE: pickStr(row, col, "PASSTYPE"),
      PASSBIN: pickStr(row, col, "PASSBIN"),
    };
    out.push(o);
  }

  if (out.length === 0) {
    throw new Error(`No usable rows parsed from ${path}`);
  }
  return out;
}

/** 来自 `docs/delta-diff.xlsx` Sheet1，列名与 YMWEB_YIELDMONITORTRIGGER 导出一致。 */
export function loadYieldMonitorTriggerRowsFromDeltaDiffXlsx(): YieldMonitorTriggerDummyRow[] {
  const path = docsPath("delta-diff.xlsx");
  const rows = readXlsxSheet1Rows(path);
  const headerRow = rows[0] ?? [];
  const col = firstWinHeaderColumnMap(headerRow);
  const out: YieldMonitorTriggerDummyRow[] = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0) continue;

    const id = pickNum(row, col, "ID");
    const device = pickStr(row, col, "DEVICE");
    if (!device || !id) continue;

    out.push({
      HOSTNAME: pickStr(row, col, "HOSTNAME"),
      DEVICE: device,
      LOTID: pickStr(row, col, "LOTID"),
      PASS: pickNum(row, col, "PASS"),
      WAFER: pickStr(row, col, "WAFER"),
      TYPE: pickStr(row, col, "TYPE"),
      TRIGGER_LABEL: pickStr(row, col, "TRIGGER_LABEL"),
      TIME_STAMP: pickIso(row, col, "TIME_STAMP"),
      ID: id,
      PROBECARD: pickStr(row, col, "PROBECARD"),
    });
  }

  if (out.length === 0) {
    throw new Error(`No usable rows parsed from ${path}`);
  }
  return out;
}
