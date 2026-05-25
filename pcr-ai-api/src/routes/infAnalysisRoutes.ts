import type { Request, Response } from "express";
import { Router } from "express";
import { sendAgentError } from "../lib/agentResponse.js";
import {
  OutputSiteBinByLotNotFoundError,
  OutputSiteBinByLotValidationError,
  parsePassIdsFromQuery,
  parseSiteBinByLotJson,
  runOutputSiteBinByLot,
  runOutputSiteBinByLotForDevice,
  runOutputSiteBinByLotForLot,
  runOutputSiteBinByLotForLotByDirectory,
  SITE_BIN_BY_LOT_DEVICE_AGG_SUMMARY,
  SITE_BIN_BY_LOT_LOT_AGG_SUMMARY,
  SITE_BIN_BY_LOT_LOT_DIR_AGG_SUMMARY,
  SITE_BIN_BY_LOT_SUMMARY,
  validateDeviceLot,
  validateInfPath,
} from "../lib/outputSiteBinByLot.js";
import {
  tryResolveSiteBinByLotDummy,
  tryResolveSiteBinByLotDummyForDevice,
  tryResolveSiteBinByLotDummyForLot,
  tryResolveSiteBinByLotDummyForLotByDirectory,
} from "../lib/outputSiteBinByLotDummy.js";
import { reqId } from "../lib/routeHelpers.js";
import { parseSiteBinDeviceTopN } from "../lib/siteBinByLotDeviceTopN.js";
import { parseSiteBinByLotTestEndWindow } from "../lib/siteBinByLotTestEndWindow.js";
import { validateProbeCardType } from "../lib/siteBinByLotWaferResolve.js";

export const infAnalysisRouter = Router();

// ── helpers ──────────────────────────────────────────────────────────────────

function firstQueryString(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0];
  return "";
}

function optionalProbeCardType(raw: string): string | undefined {
  const t = raw.trim();
  return t.length > 0 ? t : undefined;
}

function testEndWindowBody(
  window: ReturnType<typeof parseSiteBinByLotTestEndWindow>
): Record<string, unknown> {
  return {
    testEndWindow: window.applied,
    ...(window.defaultOneYear ? { testEndWindowDefaultOneYear: true } : {}),
  };
}

function jsonAggregateResponse(
  req: Request,
  summary: string,
  aggregateScope: "lot" | "device",
  body: Record<string, unknown>
) {
  return {
    meta: {
      apiVersion: "1",
      requestId: reqId(req),
      summary,
      aggregateScope,
    },
    ...body,
  };
}

function handleAggError(res: Response, e: unknown, scope: "lot" | "device") {
  if (e instanceof OutputSiteBinByLotValidationError) {
    return sendAgentError(res, 400, e.code, e.message);
  }
  if (e instanceof OutputSiteBinByLotNotFoundError) {
    return sendAgentError(res, 404, e.code, e.message);
  }
  const statusCode =
    e &&
    typeof e === "object" &&
    "statusCode" in e &&
    typeof (e as { statusCode: unknown }).statusCode === "number"
      ? (e as { statusCode: number }).statusCode
      : 502;
  const detail = e instanceof Error ? e.message : String(e);
  const code = statusCode === 504 ? "PERL_SCRIPT_TIMEOUT" : "PERL_EXEC_FAILED";
  const error =
    statusCode === 504
      ? "Perl script execution timed out"
      : `Failed to execute Perl script for ${scope} aggregation`;
  return sendAgentError(res, statusCode, code, error, detail);
}

// ── sub-handlers ─────────────────────────────────────────────────────────────

/** device + lot + probeCardType：JB 同卡型过滤后聚合 */
async function handleLotWithCardType(
  req: Request,
  res: Response,
  device: string,
  lot: string,
  passIds: number[],
  probeCardTypeRaw: string
): Promise<void> {
  let probeCardType: string;
  let testEndWindow: ReturnType<typeof parseSiteBinByLotTestEndWindow>;
  try {
    probeCardType = validateProbeCardType(probeCardTypeRaw);
    testEndWindow = parseSiteBinByLotTestEndWindow(req.query as Record<string, unknown>);
  } catch (e) {
    if (e instanceof OutputSiteBinByLotValidationError) {
      sendAgentError(res, 400, e.code, e.message);
      return;
    }
    throw e;
  }

  try {
    const dummy = tryResolveSiteBinByLotDummyForLot(device, lot, probeCardType, passIds, testEndWindow);
    if (dummy !== null) {
      const { lotDir, waferCount, waferSlots, skippedInfPaths, passes, probeCardType: pct } = dummy;
      res.json(
        jsonAggregateResponse(req, SITE_BIN_BY_LOT_LOT_AGG_SUMMARY, "lot", {
          device, lot, lotDir, probeCardType: pct, waferCount, waferSlots, passIds, passes,
          ...testEndWindowBody(testEndWindow),
          ...(skippedInfPaths.length > 0 ? { skippedInfPaths } : {}),
        })
      );
      return;
    }

    const result = await runOutputSiteBinByLotForLot(device, lot, probeCardType, passIds, testEndWindow);
    res.json(
      jsonAggregateResponse(req, SITE_BIN_BY_LOT_LOT_AGG_SUMMARY, "lot", {
        device, lot,
        lotDir: result.lotDir,
        probeCardType: result.probeCardType,
        waferCount: result.waferCount,
        waferSlots: result.waferSlots,
        passIds,
        passes: result.data.passes,
        ...(result.testEndWindow ? testEndWindowBody(result.testEndWindow) : {}),
        ...(result.skippedInfPaths.length > 0 ? { skippedInfPaths: result.skippedInfPaths } : {}),
        ...(result.stderrParts.length > 0 ? { stderr: result.stderrParts.join("\n\n") } : {}),
      })
    );
  } catch (e) {
    handleAggError(res, e, "lot");
  }
}

/** device + lot（无 probeCardType）：扫 lot 目录下全部 wafer */
async function handleLotByDirectory(
  req: Request,
  res: Response,
  device: string,
  lot: string,
  passIds: number[]
): Promise<void> {
  try {
    const dummy = tryResolveSiteBinByLotDummyForLotByDirectory(device, lot, passIds);
    if (dummy !== null) {
      const { lotDir, waferCount, waferSlots, passes } = dummy;
      res.json(
        jsonAggregateResponse(req, SITE_BIN_BY_LOT_LOT_DIR_AGG_SUMMARY, "lot", {
          device, lot, lotDir, waferCount, waferSlots, passIds, passes,
        })
      );
      return;
    }

    const result = await runOutputSiteBinByLotForLotByDirectory(device, lot, passIds);
    res.json(
      jsonAggregateResponse(req, SITE_BIN_BY_LOT_LOT_DIR_AGG_SUMMARY, "lot", {
        device, lot,
        lotDir: result.lotDir,
        waferCount: result.waferCount,
        waferSlots: result.waferSlots,
        passIds,
        passes: result.data.passes,
        ...(result.stderrParts.length > 0 ? { stderr: result.stderrParts.join("\n\n") } : {}),
      })
    );
  } catch (e) {
    handleAggError(res, e, "lot");
  }
}

/** device（无 lot）：topN 最新 lot 聚合 */
async function handleDeviceAgg(
  req: Request,
  res: Response,
  device: string,
  passIds: number[],
  probeCardTypeOpt: string | undefined
): Promise<void> {
  let testEndWindow: ReturnType<typeof parseSiteBinByLotTestEndWindow>;
  let topN: number;
  try {
    testEndWindow = parseSiteBinByLotTestEndWindow(req.query as Record<string, unknown>);
    topN = parseSiteBinDeviceTopN(req.query.topN ?? req.query.topn);
  } catch (e) {
    if (e instanceof OutputSiteBinByLotValidationError) {
      sendAgentError(res, 400, e.code, e.message);
      return;
    }
    throw e;
  }

  try {
    const dummy = tryResolveSiteBinByLotDummyForDevice(device, passIds, testEndWindow, topN, probeCardTypeOpt);
    if (dummy !== null) {
      const { deviceDir, waferCount, waferSlots, waferLots, selectedLots, skippedInfPaths, passes, probeCardType: pct } = dummy;
      res.json(
        jsonAggregateResponse(req, SITE_BIN_BY_LOT_DEVICE_AGG_SUMMARY, "device", {
          device, deviceDir, probeCardType: pct, topN, selectedLots,
          waferCount, waferSlots, waferLots, passIds, passes,
          ...testEndWindowBody(testEndWindow),
          ...(skippedInfPaths.length > 0 ? { skippedInfPaths } : {}),
        })
      );
      return;
    }

    const result = await runOutputSiteBinByLotForDevice(device, passIds, testEndWindow, topN, probeCardTypeOpt);
    res.json(
      jsonAggregateResponse(req, SITE_BIN_BY_LOT_DEVICE_AGG_SUMMARY, "device", {
        device,
        deviceDir: result.deviceDir,
        probeCardType: result.probeCardType,
        topN: result.topN,
        selectedLots: result.selectedLots,
        waferCount: result.waferCount,
        waferSlots: result.waferSlots,
        waferLots: result.waferLots,
        passIds,
        passes: result.data.passes,
        ...(result.testEndWindow ? testEndWindowBody(result.testEndWindow) : {}),
        ...(result.skippedInfPaths.length > 0 ? { skippedInfPaths: result.skippedInfPaths } : {}),
        ...(result.stderrParts.length > 0 ? { stderr: result.stderrParts.join("\n\n") } : {}),
      })
    );
  } catch (e) {
    handleAggError(res, e, "device");
  }
}

// ── route ─────────────────────────────────────────────────────────────────────

/**
 * 按 wafer 测试 pass（可多个）汇总：各 bin 测试结果由 probe card 哪个 DUT 测得。
 *
 * 单片（不变）：`?infPath=...&passId=1`
 * Lot 目录扫描（兼容）：`?device=...&lot=...&passId=1`
 * Lot + 卡型：`?device=...&lot=...&probeCardType=...&passId=1`
 * Device：`?device=...&passId=1`（无 lot；默认 TESTEND 最新 `topN=10` 个 lot，最大 50）
 */
infAnalysisRouter.get("/inf-analysis/site-bin-bylot", async (req, res) => {
  const infRaw = req.query.infPath ?? req.query.inf_path;
  const deviceStr = firstQueryString(req.query.device);
  const lotStr = firstQueryString(req.query.lot);
  const probeCardTypeOpt = optionalProbeCardType(
    firstQueryString(req.query.probeCardType ?? req.query.probe_card_type)
  );
  const lotTrimmed = lotStr.trim();
  const aggMode = deviceStr.length > 0;

  let passIds: number[];
  try {
    passIds = parsePassIdsFromQuery(req.query.passId ?? req.query.pass_id);
    if (aggMode) {
      if (firstQueryString(infRaw)) {
        throw new OutputSiteBinByLotValidationError(
          "Use infPath (single wafer) or device (+ optional lot / probeCardType), not both"
        );
      }
      if (lotStr.length > 0 && !lotTrimmed) {
        throw new OutputSiteBinByLotValidationError("Invalid empty query parameter: lot");
      }
    }
  } catch (e) {
    if (e instanceof OutputSiteBinByLotValidationError) {
      return sendAgentError(res, 400, e.code, e.message);
    }
    throw e;
  }

  if (aggMode) {
    const device = deviceStr.trim();

    if (lotTrimmed.length > 0) {
      let lot: string;
      try {
        ({ lot } = validateDeviceLot(device, lotTrimmed));
      } catch (e) {
        if (e instanceof OutputSiteBinByLotValidationError) {
          return sendAgentError(res, 400, e.code, e.message);
        }
        throw e;
      }

      if (probeCardTypeOpt) {
        await handleLotWithCardType(req, res, device, lot, passIds, probeCardTypeOpt);
      } else {
        await handleLotByDirectory(req, res, device, lot, passIds);
      }
      return;
    }

    await handleDeviceAgg(req, res, device, passIds, probeCardTypeOpt);
    return;
  }

  // ── single wafer ──────────────────────────────────────────────────────────
  let infPath: string;
  try {
    infPath = validateInfPath(firstQueryString(infRaw));
  } catch (e) {
    if (e instanceof OutputSiteBinByLotValidationError) {
      return sendAgentError(res, 400, e.code, e.message);
    }
    throw e;
  }

  try {
    const dummyData = tryResolveSiteBinByLotDummy(infPath, passIds);
    if (dummyData !== null) {
      return res.json({
        meta: { apiVersion: "1", requestId: reqId(req), summary: SITE_BIN_BY_LOT_SUMMARY },
        infPath,
        passIds,
        ...dummyData,
      });
    }

    const result = await runOutputSiteBinByLot(infPath, passIds);
    if (result.exitCode !== 0) {
      const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n---\n");
      return sendAgentError(
        res, 502, "PERL_SCRIPT_FAILED",
        `Perl script exited with code ${result.exitCode}`,
        detail || undefined
      );
    }

    let data;
    try {
      data = parseSiteBinByLotJson(result.stdout);
    } catch (e) {
      if (e instanceof OutputSiteBinByLotValidationError) {
        return sendAgentError(res, 502, "PERL_OUTPUT_PARSE_FAILED", e.message);
      }
      throw e;
    }

    return res.json({
      meta: { apiVersion: "1", requestId: reqId(req), summary: SITE_BIN_BY_LOT_SUMMARY },
      infPath,
      passIds,
      ...data,
      ...(result.stderr.trim() !== "" ? { stderr: result.stderr } : {}),
    });
  } catch (e) {
    const statusCode =
      e && typeof e === "object" && "statusCode" in e &&
      typeof (e as { statusCode: unknown }).statusCode === "number"
        ? (e as { statusCode: number }).statusCode
        : 502;
    const detail = e instanceof Error ? e.message : String(e);
    const code = statusCode === 504 ? "PERL_SCRIPT_TIMEOUT" : "PERL_EXEC_FAILED";
    const error = statusCode === 504 ? "Perl script execution timed out" : "Failed to execute Perl script";
    return sendAgentError(res, statusCode, code, error, detail);
  }
});
