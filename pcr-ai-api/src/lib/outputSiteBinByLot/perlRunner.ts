import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { getPerlBin, getPerlScriptTimeoutMs } from "./params.js";
import {
  OutputSiteBinByLotValidationError,
  type RunOutputSiteBinByLotResult,
  type SiteBinByLotData,
  type SiteBinDutEntry,
  type SiteBinEntry,
  type SiteBinPass,
} from "./types.js";

const execFileAsync = promisify(execFile);

const SCRIPT_NAME = "output_site_bin_bylot.pl";

function resolvePerlScriptPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "..", "..", "perlscripts", SCRIPT_NAME),
    path.join(here, "..", "..", "..", "src", "perlscripts", SCRIPT_NAME),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    `Perl script not found (${SCRIPT_NAME}); run npm run build to copy src/perlscripts into dist/`
  );
}

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
