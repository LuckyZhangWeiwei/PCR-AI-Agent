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
import { validateProbeCardType } from "../lib/siteBinByLotWaferResolve.js";

export const infAnalysisRouter = Router();

function firstQueryString(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0];
  return "";
}

function optionalProbeCardType(raw: string): string | undefined {
  const t = raw.trim();
  return t.length > 0 ? t : undefined;
}

function jsonAggregateResponse(
  req: Parameters<typeof reqId>[0],
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

/**
 * 按 wafer 测试 pass（可多个）汇总：各 bin 测试结果由 probe card 哪个 DUT 测得。
 *
 * 单片（不变）：`?infPath=...&passId=1`
 * Lot 目录扫描（兼容）：`?device=...&lot=...&passId=1`
 * Lot + 卡型：`?device=...&lot=...&probeCardType=...&passId=1`
 * Device + 卡型：`?device=...&probeCardType=...&passId=1`（无 lot）
 */
infAnalysisRouter.get("/inf-analysis/site-bin-bylot", async (req, res) => {
  const infRaw = req.query.infPath ?? req.query.inf_path;
  const deviceRaw = req.query.device;
  const lotRaw = req.query.lot;
  const probeCardTypeRaw =
    req.query.probeCardType ?? req.query.probe_card_type;
  const passRaw = req.query.passId ?? req.query.pass_id;

  const deviceStr = firstQueryString(deviceRaw);
  const lotStr = firstQueryString(lotRaw);
  const probeCardTypeOpt = optionalProbeCardType(
    firstQueryString(probeCardTypeRaw)
  );
  const lotTrimmed = lotStr.trim();
  const aggMode = deviceStr.length > 0;

  let passIds: number[];
  try {
    passIds = parsePassIdsFromQuery(passRaw);
    if (aggMode) {
      if (!deviceStr.trim()) {
        throw new OutputSiteBinByLotValidationError(
          "Aggregation requires query parameter: device"
        );
      }
      if (firstQueryString(infRaw)) {
        throw new OutputSiteBinByLotValidationError(
          "Use infPath (single wafer) or device (+ optional lot / probeCardType), not both"
        );
      }
      if (lotStr.length > 0 && !lotTrimmed) {
        throw new OutputSiteBinByLotValidationError(
          "Invalid empty query parameter: lot"
        );
      }
      if (lotTrimmed.length === 0 && !probeCardTypeOpt) {
        throw new OutputSiteBinByLotValidationError(
          "Device-level aggregation requires probeCardType; lot-level directory scan requires device and lot"
        );
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
        let probeCardType: string;
        try {
          probeCardType = validateProbeCardType(probeCardTypeOpt);
        } catch (e) {
          if (e instanceof OutputSiteBinByLotValidationError) {
            return sendAgentError(res, 400, e.code, e.message);
          }
          throw e;
        }

        try {
          const dummyLot = tryResolveSiteBinByLotDummyForLot(
            device,
            lot,
            probeCardType,
            passIds
          );
          if (dummyLot !== null) {
            const {
              lotDir,
              waferCount,
              waferSlots,
              skippedInfPaths,
              passes,
              probeCardType: pct,
            } = dummyLot;
            return res.json(
              jsonAggregateResponse(req, SITE_BIN_BY_LOT_LOT_AGG_SUMMARY, "lot", {
                device,
                lot,
                lotDir,
                probeCardType: pct,
                waferCount,
                waferSlots,
                passIds,
                passes,
                ...(skippedInfPaths.length > 0 ? { skippedInfPaths } : {}),
              })
            );
          }

          const result = await runOutputSiteBinByLotForLot(
            device,
            lot,
            probeCardType,
            passIds
          );
          return res.json(
            jsonAggregateResponse(req, SITE_BIN_BY_LOT_LOT_AGG_SUMMARY, "lot", {
              device,
              lot,
              lotDir: result.lotDir,
              probeCardType: result.probeCardType,
              waferCount: result.waferCount,
              waferSlots: result.waferSlots,
              passIds,
              passes: result.data.passes,
              ...(result.skippedInfPaths.length > 0
                ? { skippedInfPaths: result.skippedInfPaths }
                : {}),
              ...(result.stderrParts.length > 0
                ? { stderr: result.stderrParts.join("\n\n") }
                : {}),
            })
          );
        } catch (e) {
          return handleAggError(res, e, "lot");
        }
      }

      try {
        const dummyLot = tryResolveSiteBinByLotDummyForLotByDirectory(
          device,
          lot,
          passIds
        );
        if (dummyLot !== null) {
          const { lotDir, waferCount, waferSlots, passes } = dummyLot;
          return res.json(
            jsonAggregateResponse(
              req,
              SITE_BIN_BY_LOT_LOT_DIR_AGG_SUMMARY,
              "lot",
              {
                device,
                lot,
                lotDir,
                waferCount,
                waferSlots,
                passIds,
                passes,
              }
            )
          );
        }

        const result = await runOutputSiteBinByLotForLotByDirectory(
          device,
          lot,
          passIds
        );
        return res.json(
          jsonAggregateResponse(
            req,
            SITE_BIN_BY_LOT_LOT_DIR_AGG_SUMMARY,
            "lot",
            {
              device,
              lot,
              lotDir: result.lotDir,
              waferCount: result.waferCount,
              waferSlots: result.waferSlots,
              passIds,
              passes: result.data.passes,
              ...(result.stderrParts.length > 0
                ? { stderr: result.stderrParts.join("\n\n") }
                : {}),
            }
          )
        );
      } catch (e) {
        return handleAggError(res, e, "lot");
      }
    }

    let probeCardType: string;
    try {
      probeCardType = validateProbeCardType(probeCardTypeOpt ?? "");
    } catch (e) {
      if (e instanceof OutputSiteBinByLotValidationError) {
        return sendAgentError(res, 400, e.code, e.message);
      }
      throw e;
    }

    try {
      const dummyDev = tryResolveSiteBinByLotDummyForDevice(
        device,
        probeCardType,
        passIds
      );
      if (dummyDev !== null) {
        const {
          deviceDir,
          waferCount,
          waferSlots,
          waferLots,
          skippedInfPaths,
          passes,
          probeCardType: pct,
        } = dummyDev;
        return res.json(
          jsonAggregateResponse(
            req,
            SITE_BIN_BY_LOT_DEVICE_AGG_SUMMARY,
            "device",
            {
              device,
              deviceDir,
              probeCardType: pct,
              waferCount,
              waferSlots,
              waferLots,
              passIds,
              passes,
              ...(skippedInfPaths.length > 0 ? { skippedInfPaths } : {}),
            }
          )
        );
      }

      const result = await runOutputSiteBinByLotForDevice(
        device,
        probeCardType,
        passIds
      );
      return res.json(
        jsonAggregateResponse(
          req,
          SITE_BIN_BY_LOT_DEVICE_AGG_SUMMARY,
          "device",
          {
            device,
            deviceDir: result.deviceDir,
            probeCardType: result.probeCardType,
            waferCount: result.waferCount,
            waferSlots: result.waferSlots,
            waferLots: result.waferLots,
            passIds,
            passes: result.data.passes,
            ...(result.skippedInfPaths.length > 0
              ? { skippedInfPaths: result.skippedInfPaths }
              : {}),
            ...(result.stderrParts.length > 0
              ? { stderr: result.stderrParts.join("\n\n") }
              : {}),
          }
        )
      );
    } catch (e) {
      return handleAggError(res, e, "device");
    }
  }

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
        meta: {
          apiVersion: "1",
          requestId: reqId(req),
          summary: SITE_BIN_BY_LOT_SUMMARY,
        },
        infPath,
        passIds,
        ...dummyData,
      });
    }

    const result = await runOutputSiteBinByLot(infPath, passIds);
    if (result.exitCode !== 0) {
      const detail = [result.stderr.trim(), result.stdout.trim()]
        .filter(Boolean)
        .join("\n---\n");
      return sendAgentError(
        res,
        502,
        "PERL_SCRIPT_FAILED",
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
      meta: {
        apiVersion: "1",
        requestId: reqId(req),
        summary: SITE_BIN_BY_LOT_SUMMARY,
      },
      infPath,
      passIds,
      ...data,
      ...(result.stderr.trim() !== ""
        ? { stderr: result.stderr }
        : {}),
    });
  } catch (e) {
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
        : "Failed to execute Perl script";
    return sendAgentError(res, statusCode, code, error, detail);
  }
});

function handleAggError(
  res: import("express").Response,
  e: unknown,
  scope: "lot" | "device"
) {
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
