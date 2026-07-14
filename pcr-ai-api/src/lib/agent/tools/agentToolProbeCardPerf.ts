// pcr-ai-api/src/lib/agent/tools/agentToolProbeCardPerf.ts
import { withConnection } from "../../../oracle.js";
import oracledb from "oracledb";
import { logAgentSql } from "../agentSqlDebugLog.js";
import {
  parseInfcontrolLayerBinsV3Query,
} from "../../infcontrol/infcontrolLayerBinFilters.js";
import {
  adaptInfcontrolV3WhereAndSqlToAggregateAliases,
} from "../../infcontrol/infcontrolLayerBinV3Aggregate.js";
import {
  buildInfcontrolLayerBinMatchingCountSql,
} from "../../infcontrol/infcontrolLayerBinAggregate.js";
import {
  infcontrolLayerBinsUseDummy,
} from "../../infcontrol/infcontrolLayerBinDummy.js";
import {
  filterInfcontrolLayerBinV3DummyRowsMatching,
} from "../../infcontrol/infcontrolLayerBinDummyV3.js";
import {
  buildInfcontrolLayerBinsV3SqlFullMatching,
} from "../../apiV3ListSql.js";
import { infcontrolLayerBinV3BaseWhereBlock } from "../../infcontrolLayerBinPasstypeScope.js";
import { readMemoryAggregateOracleMaxRows } from "../../memoryAggregateOracleLimits.js";
import { computeProbeCardTesterPerformance } from "../../probeCard/probeCardTesterPerformance.js";
import { truncateResult, enrichJbRow } from "./agentToolHandlers.js";

export function probeCardPerfRowLimitExceededMessage(count: number, maxRows: number): string {
  return `aggregate_probe_card_tester_performance 错误：匹配行数 (${count}) 超过上限 (${maxRows})，请缩小 passId 或 testEndFrom/testEndTo 时间范围。`;
}

export async function toolAggregateProbeCardTesterPerformance(
  args: Record<string, unknown>,
  maxChars: number
): Promise<string> {
  const device = typeof args["device"] === "string" ? args["device"].trim() : "";
  const mask = typeof args["mask"] === "string" ? args["mask"].trim() : "";
  if (!device && !mask) {
    return "aggregate_probe_card_tester_performance 参数错误: device 或 mask 至少填一个。";
  }

  const params: Record<string, unknown> = {};
  if (device) params["device"] = device;
  if (mask) params["mask"] = mask;
  if (typeof args["passId"] === "number") params["passId"] = args["passId"];
  if (args["testEndFrom"]) params["testEndFrom"] = args["testEndFrom"];
  if (args["testEndTo"]) params["testEndTo"] = args["testEndTo"];

  const parsed = parseInfcontrolLayerBinsV3Query(params);
  if (!parsed.ok) return `查询参数错误: ${parsed.error}`;

  const maxRows = readMemoryAggregateOracleMaxRows();
  let rawRows: Record<string, unknown>[];

  if (infcontrolLayerBinsUseDummy()) {
    rawRows = filterInfcontrolLayerBinV3DummyRowsMatching(
      parsed.applied
    ) as Record<string, unknown>[];
    if (rawRows.length > maxRows) {
      return probeCardPerfRowLimitExceededMessage(rawRows.length, maxRows);
    }
  } else {
    const adapted = adaptInfcontrolV3WhereAndSqlToAggregateAliases(parsed.whereAndSql);
    const countWhereSql = infcontrolLayerBinV3BaseWhereBlock("lb", adapted);
    const countSql = buildInfcontrolLayerBinMatchingCountSql(countWhereSql);
    const matchingCount = await withConnection(async (conn) => {
      const result = await conn.execute(countSql, parsed.binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });
      const rows = (result.rows ?? []) as Record<string, unknown>[];
      return typeof rows[0]?.["TOTAL_MATCHING"] === "number"
        ? (rows[0]["TOTAL_MATCHING"] as number)
        : 0;
    });
    if (matchingCount > maxRows) {
      return probeCardPerfRowLimitExceededMessage(matchingCount, maxRows);
    }
    const sql = buildInfcontrolLayerBinsV3SqlFullMatching(parsed.whereAndSql);
    logAgentSql("aggregate_probe_card_tester_performance", sql, parsed.binds, {
      device: device || undefined,
      mask: mask || undefined,
      passId: typeof args["passId"] === "number" ? args["passId"] : undefined,
    });
    rawRows = await withConnection(async (conn) => {
      const result = await conn.execute(sql, parsed.binds, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });
      return (result.rows ?? []) as Record<string, unknown>[];
    });
  }

  const enriched = rawRows.map(enrichJbRow);
  const groups = computeProbeCardTesterPerformance(enriched);

  if (groups.length === 0) {
    const scope = device ? `device=${device}` : `mask=${mask}`;
    return `aggregate_probe_card_tester_performance: ${scope} 在指定范围内未查到有效良率数据（GROSSDIE 缺失，或 PASSID 不在 1/3/5 范围内）。可尝试放宽 testEndFrom/testEndTo。`;
  }

  return truncateResult(
    {
      ...(device ? { device } : {}),
      ...(mask ? { mask } : {}),
      passIdFilter: typeof args["passId"] === "number" ? args["passId"] : null,
      totalRowsMatching: rawRows.length,
      groups,
    },
    maxChars
  );
}
