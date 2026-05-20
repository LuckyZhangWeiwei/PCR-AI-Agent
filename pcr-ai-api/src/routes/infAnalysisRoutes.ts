import { Router } from "express";
import { sendAgentError } from "../lib/agentResponse.js";
import {
  OutputSiteBinByLotValidationError,
  parsePassIdsFromQuery,
  parseSiteBinByLotJson,
  runOutputSiteBinByLot,
  SITE_BIN_BY_LOT_SUMMARY,
  validateInfPath,
} from "../lib/outputSiteBinByLot.js";
import { reqId } from "../lib/routeHelpers.js";

export const infAnalysisRouter = Router();

/**
 * 按 wafer 测试 pass（可多个）汇总：各 bin 测试结果由 probe card 哪个 DUT 测得。
 * INF：`iBinCodeLast` → bin 标签；`iTestSiteLast` → DUT#；`dieCount` 为 map 上颗数。
 * GET /api/v1/inf-analysis/site-bin-bylot?infPath=...&passId=1&passId=2
 */
infAnalysisRouter.get("/inf-analysis/site-bin-bylot", async (req, res) => {
  const infRaw = req.query.infPath ?? req.query.inf_path;
  const passRaw = req.query.passId ?? req.query.pass_id;

  let infPath: string;
  let passIds: number[];
  try {
    const infStr =
      typeof infRaw === "string"
        ? infRaw
        : Array.isArray(infRaw) && typeof infRaw[0] === "string"
          ? infRaw[0]
          : "";
    infPath = validateInfPath(infStr);
    passIds = parsePassIdsFromQuery(passRaw);
  } catch (e) {
    if (e instanceof OutputSiteBinByLotValidationError) {
      return sendAgentError(res, 400, e.code, e.message);
    }
    throw e;
  }

  try {
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
