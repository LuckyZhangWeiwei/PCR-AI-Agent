import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { buildInfDeviceDir, buildInfLotDir } from "./buildInfPath.js";
import {
  resolveSiteBinWafersWithSkips,
  type SiteBinWaferRef,
} from "./siteBinByLotWaferResolve.js";

const execFileAsync = promisify(execFile);

const SCRIPT_NAME = "output_site_bin_bylot.pl";

/** 写入响应 meta，说明本接口业务含义（交接 / 前端展示用）。 */
export const SITE_BIN_BY_LOT_SUMMARY =
  "Per wafer test pass (one or more PASS_ID in INF, PASS_TYPE=TEST only): for each bin result on the map, which probe-card DUT (test site) produced that bin and how many die at that bin×DUT. Data from INF layers iBinCodeLast + iTestSiteLast via output_site_bin_bylot.pl.";

/** 兼容：device+lot、无 probeCardType 时扫描 lot 目录下全部 r_1-{slot}。 */
export const SITE_BIN_BY_LOT_LOT_DIR_AGG_SUMMARY =
  "Lot-level aggregation: sum dieCount across all wafer INF files under {INF_STORAGE_ROOT}/{DEVICE}/{LOT}/ (r_1-{slot}), per passId×bin×dut. Same Perl PASS_TYPE=TEST filter as single-wafer mode.";

export const SITE_BIN_BY_LOT_LOT_AGG_SUMMARY =
  "Lot-level aggregation (probeCardType filter): sum dieCount across JB-matched wafer INFs under {INF_STORAGE_ROOT}/{DEVICE}/{LOT}/ for one probeCardType and requested passId(s), per passId×bin×dut.";

export const SITE_BIN_BY_LOT_DEVICE_AGG_SUMMARY =
  "Device-level aggregation: sum dieCount across all lots/slots under {INF_STORAGE_ROOT}/{DEVICE}/ for one probeCardType and requested passId(s), per passId×bin×dut.";

export class OutputSiteBinByLotValidationError extends Error {
  readonly statusCode = 400;
  readonly code = "VALIDATION_ERROR";
}

export class OutputSiteBinByLotNotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = "LOT_INF_NOT_FOUND";
}

function resolvePerlScriptPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "..", "perlscripts", SCRIPT_NAME),
    path.join(here, "..", "..", "src", "perlscripts", SCRIPT_NAME),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    `Perl script not found (${SCRIPT_NAME}); run npm run build to copy src/perlscripts into dist/`
  );
}

export function getPerlBin(): string {
  const fromEnv = process.env.PERL_BIN?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : "perl";
}

export function getPerlScriptTimeoutMs(): number {
  const raw = process.env.PERL_SCRIPT_TIMEOUT_MS?.trim();
  if (!raw) return 120_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1_000 || n > 3_600_000) {
    return 120_000;
  }
  return Math.floor(n);
}

/** 与 Perl `untaint` 一致：整条路径须匹配 /^(.+)$/（无换行等控制字符）。 */
export function validateInfPath(raw: string): string {
  const infPath = raw.trim();
  if (!infPath) {
    throw new OutputSiteBinByLotValidationError("Missing or empty query parameter: infPath");
  }
  if (/[\0\r\n]/.test(infPath)) {
    throw new OutputSiteBinByLotValidationError("infPath contains invalid characters");
  }
  if (!/^(.+)$/.test(infPath)) {
    throw new OutputSiteBinByLotValidationError("infPath failed path validation");
  }
  const allowedRoot = process.env.INF_PATH_ALLOWED_ROOT?.trim();
  if (allowedRoot) {
    const resolvedRoot = path.resolve(allowedRoot);
    const resolvedInf = path.resolve(infPath);
    const prefix = resolvedRoot.endsWith(path.sep)
      ? resolvedRoot
      : resolvedRoot + path.sep;
    if (resolvedInf !== resolvedRoot && !resolvedInf.startsWith(prefix)) {
      throw new OutputSiteBinByLotValidationError(
        `infPath must be under INF_PATH_ALLOWED_ROOT (${resolvedRoot})`
      );
    }
  }
  return infPath;
}

const WAFER_INF_BASENAME_RE = /^r_1-(\d+)$/;

function readMaxWafersEnv(
  envKey: string,
  defaultVal: number,
  maxCap: number
): number {
  const raw = process.env[envKey]?.trim();
  if (!raw) return defaultVal;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > maxCap) return defaultVal;
  return Math.floor(n);
}

export function getSiteBinByLotMaxWafers(): number {
  return readMaxWafersEnv("SITE_BIN_BY_LOT_MAX_WAFERS", 25, 100);
}

export function getSiteBinByLotMaxWafersDevice(): number {
  return readMaxWafersEnv("SITE_BIN_BY_LOT_MAX_WAFERS_DEVICE", 100, 500);
}

export function validateDeviceLot(deviceRaw: string, lotRaw: string): { device: string; lot: string } {
  const device = deviceRaw.trim();
  const lot = lotRaw.trim();
  if (!device) {
    throw new OutputSiteBinByLotValidationError("Missing or empty query parameter: device");
  }
  if (!lot) {
    throw new OutputSiteBinByLotValidationError("Missing or empty query parameter: lot");
  }
  return { device, lot };
}

/** 列出 lot 目录下所有 wafer INF（文件名 `r_1-{slot}`，无扩展名）。 */
export async function listWaferInfPathsInLotDir(
  lotDir: string
): Promise<{ slot: number; infPath: string }[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(lotDir, { withFileTypes: true });
  } catch (e: unknown) {
    const code =
      e && typeof e === "object" && "code" in e
        ? (e as { code?: string }).code
        : undefined;
    if (code === "ENOENT") {
      throw new OutputSiteBinByLotNotFoundError(
        `Lot INF directory not found: ${lotDir}`
      );
    }
    throw e;
  }

  const wafers: { slot: number; infPath: string }[] = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const m = WAFER_INF_BASENAME_RE.exec(ent.name);
    if (!m) continue;
    const slot = Number(m[1]);
    if (!Number.isInteger(slot) || slot < 1) continue;
    wafers.push({ slot, infPath: path.join(lotDir, ent.name) });
  }
  wafers.sort((a, b) => a.slot - b.slot);
  return wafers;
}

function dutSortKey(dut: number | "single"): string {
  if (dut === "single") return "z:single";
  return `n:${String(dut).padStart(12, "0")}`;
}

/** 将多片 wafer 的 passes 按 passId×bin×dut 累加 dieCount。 */
export function mergeSiteBinByLotData(chunks: SiteBinByLotData[]): SiteBinByLotData {
  const passMap = new Map<
    number,
    Map<string, Map<number | "single", number>>
  >();

  for (const chunk of chunks) {
    for (const pass of chunk.passes) {
      let binMap = passMap.get(pass.passId);
      if (!binMap) {
        binMap = new Map();
        passMap.set(pass.passId, binMap);
      }
      for (const binEntry of pass.bins) {
        let dutMap = binMap.get(binEntry.bin);
        if (!dutMap) {
          dutMap = new Map();
          binMap.set(binEntry.bin, dutMap);
        }
        for (const { dut, dieCount } of binEntry.duts) {
          dutMap.set(dut, (dutMap.get(dut) ?? 0) + dieCount);
        }
      }
    }
  }

  const passes: SiteBinPass[] = [];
  for (const passId of [...passMap.keys()].sort((a, b) => a - b)) {
    const binMap = passMap.get(passId)!;
    const bins: SiteBinEntry[] = [];
    for (const bin of [...binMap.keys()].sort((a, b) => {
      const na = Number(a.replace(/^bin/i, ""));
      const nb = Number(b.replace(/^bin/i, ""));
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return a.localeCompare(b);
    })) {
      const dutMap = binMap.get(bin)!;
      const duts: SiteBinDutEntry[] = [];
      for (const dut of [...dutMap.keys()].sort((a, b) =>
        dutSortKey(a).localeCompare(dutSortKey(b))
      )) {
        duts.push({ dut, dieCount: dutMap.get(dut)! });
      }
      bins.push({ bin, duts });
    }
    passes.push({ passId, bins });
  }
  return { passes };
}

export type RunOutputSiteBinByLotAggregateResult = {
  aggregateScope: "lot" | "device";
  deviceDir?: string;
  lotDir?: string;
  /** 仅 JB/卡类型过滤路径返回 */
  probeCardType?: string;
  waferCount: number;
  waferSlots: number[];
  waferLots?: string[];
  skippedInfPaths: string[];
  data: SiteBinByLotData;
  stderrParts: string[];
};

function assertWaferCountWithinLimit(
  count: number,
  max: number,
  envName: string,
  scopeLabel: string
): void {
  if (count > max) {
    throw new OutputSiteBinByLotValidationError(
      `${scopeLabel} has ${count} wafer(s); maximum allowed is ${max} (${envName})`
    );
  }
}

async function runPerlForWafers(
  wafers: SiteBinWaferRef[],
  passIds: number[]
): Promise<{ data: SiteBinByLotData; stderrParts: string[] }> {
  const chunks: SiteBinByLotData[] = [];
  const stderrParts: string[] = [];

  for (const { infPath } of wafers) {
    const result = await runOutputSiteBinByLot(infPath, passIds);
    if (result.exitCode !== 0) {
      const detail = [result.stderr.trim(), result.stdout.trim()]
        .filter(Boolean)
        .join("\n---\n");
      const err = new Error(
        `Perl script failed for ${infPath} (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`
      );
      (err as { statusCode?: number }).statusCode = 502;
      throw err;
    }
    chunks.push(parseSiteBinByLotJson(result.stdout));
    if (result.stderr.trim()) stderrParts.push(`${infPath}:\n${result.stderr.trim()}`);
  }

  return { data: mergeSiteBinByLotData(chunks), stderrParts };
}

/**
 * Lot 聚合（原有逻辑）：扫描 lot 目录下全部 `r_1-{slot}`，不按卡类型过滤。
 */
export async function runOutputSiteBinByLotForLotByDirectory(
  device: string,
  lot: string,
  passIds: number[]
): Promise<RunOutputSiteBinByLotAggregateResult> {
  const lotDir = validateInfPath(buildInfLotDir(device, lot));
  const listed = await listWaferInfPathsInLotDir(lotDir);
  if (listed.length === 0) {
    throw new OutputSiteBinByLotNotFoundError(
      `No wafer INF files (r_1-{slot}) under ${lotDir}`
    );
  }
  assertWaferCountWithinLimit(
    listed.length,
    getSiteBinByLotMaxWafers(),
    "SITE_BIN_BY_LOT_MAX_WAFERS",
    "Lot"
  );

  const wafers: SiteBinWaferRef[] = listed.map(({ slot, infPath }) => ({
    lot,
    slot,
    infPath,
  }));
  const { data, stderrParts } = await runPerlForWafers(wafers, passIds);

  return {
    aggregateScope: "lot",
    lotDir,
    waferCount: wafers.length,
    waferSlots: wafers.map((w) => w.slot),
    skippedInfPaths: [],
    data,
    stderrParts,
  };
}

/**
 * Lot 聚合（可选）：JB 锁定 probeCardType + passId，仅聚合磁盘可读的 wafer INF。
 */
export async function runOutputSiteBinByLotForLot(
  device: string,
  lot: string,
  probeCardType: string,
  passIds: number[]
): Promise<RunOutputSiteBinByLotAggregateResult> {
  const { wafers, skippedInfPaths } = await resolveSiteBinWafersWithSkips({
    device,
    lot,
    probeCardType,
    passIds,
  });
  assertWaferCountWithinLimit(
    wafers.length,
    getSiteBinByLotMaxWafers(),
    "SITE_BIN_BY_LOT_MAX_WAFERS",
    "Lot"
  );

  const { data, stderrParts } = await runPerlForWafers(wafers, passIds);
  if (skippedInfPaths.length > 0) {
    stderrParts.push(
      `Skipped ${skippedInfPaths.length} INF path(s) (JB match but not readable):\n${skippedInfPaths.join("\n")}`
    );
  }

  return {
    aggregateScope: "lot",
    lotDir: validateInfPath(buildInfLotDir(device, lot)),
    probeCardType,
    waferCount: wafers.length,
    waferSlots: wafers.map((w) => w.slot),
    skippedInfPaths,
    data,
    stderrParts,
  };
}

/**
 * Device 聚合：同 probeCardType + passId，跨 lot 累加。
 */
export async function runOutputSiteBinByLotForDevice(
  device: string,
  probeCardType: string,
  passIds: number[]
): Promise<RunOutputSiteBinByLotAggregateResult> {
  const { wafers, skippedInfPaths } = await resolveSiteBinWafersWithSkips({
    device,
    probeCardType,
    passIds,
  });
  assertWaferCountWithinLimit(
    wafers.length,
    getSiteBinByLotMaxWafersDevice(),
    "SITE_BIN_BY_LOT_MAX_WAFERS_DEVICE",
    "Device"
  );

  const { data, stderrParts } = await runPerlForWafers(wafers, passIds);
  if (skippedInfPaths.length > 0) {
    stderrParts.push(
      `Skipped ${skippedInfPaths.length} INF path(s) (JB match but not readable):\n${skippedInfPaths.join("\n")}`
    );
  }

  const lotSet = new Set(wafers.map((w) => w.lot));
  return {
    aggregateScope: "device",
    deviceDir: validateInfPath(buildInfDeviceDir(device)),
    probeCardType,
    waferCount: wafers.length,
    waferSlots: wafers.map((w) => w.slot),
    waferLots: [...lotSet].sort((a, b) => a.localeCompare(b)),
    skippedInfPaths,
    data,
    stderrParts,
  };
}

export function parsePassIdsFromQuery(raw: unknown): number[] {
  const parts: string[] = [];
  if (typeof raw === "string") parts.push(raw);
  else if (Array.isArray(raw)) {
    for (const x of raw) {
      if (typeof x === "string") parts.push(x);
    }
  }
  if (parts.length === 0) {
    throw new OutputSiteBinByLotValidationError(
      "Missing query parameter: passId (one or more, comma-separated allowed)"
    );
  }

  const ids: number[] = [];
  for (const s of parts) {
    for (const seg of s.split(",")) {
      const t = seg.trim();
      if (t === "") continue;
      const n = Number(t);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        throw new OutputSiteBinByLotValidationError(`Invalid passId: ${t}`);
      }
      ids.push(n);
    }
  }
  if (ids.length === 0) {
    throw new OutputSiteBinByLotValidationError(
      "passId must contain at least one integer"
    );
  }
  return ids;
}

/** Probe card 上的测试 DUT（site）编号；无 site 层时为 `single`。 */
export type SiteBinDutEntry = {
  dut: number | "single";
  /** 该 pass 的 wafer map 上，此 bin 且此 DUT 的测试 die 颗数 */
  dieCount: number;
};

export type SiteBinEntry = {
  /** 测试结果 bin 编号，标签形如 `bin30`（来自 iBinCodeLast 解码） */
  bin: string;
  /** 测出该 bin 的各 probe card DUT 及颗数 */
  duts: SiteBinDutEntry[];
};

/** 一片 wafer 的一次测试 pass（INF SmWaferPass / PASS_ID） */
export type SiteBinPass = {
  passId: number;
  bins: SiteBinEntry[];
};

export type SiteBinByLotData = {
  passes: SiteBinPass[];
};

export type RunOutputSiteBinByLotResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export function parseSiteBinByLotJson(stdout: string): SiteBinByLotData {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new OutputSiteBinByLotValidationError("Perl returned empty JSON output");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed) as unknown;
  } catch {
    throw new OutputSiteBinByLotValidationError(
      "Perl stdout is not valid JSON (ensure script supports --json)"
    );
  }
  if (!raw || typeof raw !== "object" || !("passes" in raw)) {
    throw new OutputSiteBinByLotValidationError(
      "Perl JSON must contain a passes array"
    );
  }
  const passesRaw = (raw as { passes: unknown }).passes;
  if (!Array.isArray(passesRaw)) {
    throw new OutputSiteBinByLotValidationError("passes must be an array");
  }

  const passes: SiteBinPass[] = [];
  for (const p of passesRaw) {
    if (!p || typeof p !== "object") continue;
    const passId = (p as { passId?: unknown }).passId;
    const binsRaw = (p as { bins?: unknown }).bins;
    if (typeof passId !== "number" || !Number.isInteger(passId)) continue;
    if (!Array.isArray(binsRaw)) {
      passes.push({ passId, bins: [] });
      continue;
    }
    const bins: SiteBinEntry[] = [];
    for (const b of binsRaw) {
      if (!b || typeof b !== "object") continue;
      const bin = (b as { bin?: unknown }).bin;
      const dutsRaw = (b as { duts?: unknown }).duts;
      if (typeof bin !== "string" || !/^bin\d+$/i.test(bin)) continue;
      const duts: SiteBinDutEntry[] = [];
      if (Array.isArray(dutsRaw)) {
        for (const d of dutsRaw) {
          if (!d || typeof d !== "object") continue;
          const dut = (d as { dut?: unknown }).dut;
          const dieCount = (d as { dieCount?: unknown }).dieCount;
          if (
            (typeof dut === "number" && Number.isInteger(dut)) ||
            dut === "single"
          ) {
            if (typeof dieCount === "number" && dieCount >= 0) {
              duts.push({ dut: dut as number | "single", dieCount });
            }
          }
        }
      }
      bins.push({ bin, duts });
    }
    passes.push({ passId, bins });
  }
  return { passes };
}

/**
 * 调用 `output_site_bin_bylot.pl --json`，stdout 为 JSON。
 * 对 INF 只读（LoadINF）；本模块不写入、删除或修改 INF 文件。
 */
export async function runOutputSiteBinByLot(
  infPath: string,
  passIds: number[]
): Promise<RunOutputSiteBinByLotResult> {
  const scriptPath = resolvePerlScriptPath();
  const perlBin = getPerlBin();
  const timeoutMs = getPerlScriptTimeoutMs();
  const args = [scriptPath, "--json", infPath, ...passIds.map(String)];

  try {
    const { stdout, stderr } = await execFileAsync(perlBin, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return {
      stdout: stdout ?? "",
      stderr: stderr ?? "",
      exitCode: 0,
    };
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err) {
      const e = err as {
        code?: string;
        status?: number | null;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      if (e.code === "ETIMEDOUT") {
        const te = new Error(`Perl script timed out after ${timeoutMs}ms`);
        (te as { statusCode?: number }).statusCode = 504;
        throw te;
      }
      const exitCode =
        typeof e.status === "number" && e.status != null ? e.status : 1;
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? (e.message ?? ""),
        exitCode,
      };
    }
    throw err;
  }
}
