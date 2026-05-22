import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SCRIPT_NAME = "output_site_bin_bylot.pl";

/** 写入响应 meta，说明本接口业务含义（交接 / 前端展示用）。 */
export const SITE_BIN_BY_LOT_SUMMARY =
  "Per wafer test pass (one or more PASS_ID in INF, PASS_TYPE=TEST only): for each bin result on the map, which probe-card DUT (test site) produced that bin and how many die at that bin×DUT. Data from INF layers iBinCodeLast + iTestSiteLast via output_site_bin_bylot.pl.";

export class OutputSiteBinByLotValidationError extends Error {
  readonly statusCode = 400;
  readonly code = "VALIDATION_ERROR";
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
