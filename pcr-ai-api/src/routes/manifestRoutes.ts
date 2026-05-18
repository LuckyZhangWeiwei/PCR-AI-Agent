import { Router, type Request } from "express";
import oracledb from "oracledb";
import { buildManifestResponseJson } from "../lib/rebaseApiManifest.js";
import { sendAgentError } from "../lib/agentResponse.js";
import { enrichOracleDriverDetail } from "../lib/agentResponse.js";
import { reqId } from "../lib/routeHelpers.js";
import { clampLimit, parseQualifiedTable } from "../lib/sqlIdent.js";
import { withConnection } from "../oracle.js";

export const manifestRouter = Router();

/** AI agent 工具发现：参数说明、示例与错误格式约定（**`/api/v1/manifest`** 全量；**`/api/v3/manifest`**、**`/api/v4/manifest`** 为各自前缀的精简目录）。 */
manifestRouter.get("/manifest", (req, res) => {
  res.json(buildManifestResponseJson(req.baseUrl || "/api/v1"));
});

/** 从 dual 探测数据库连通性 */
manifestRouter.get("/db/ping", async (req, res) => {
  try {
    const row = await withConnection(async (conn) => {
      const r = await conn.execute(
        "SELECT 1 AS ok FROM DUAL",
        {},
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      return r.rows?.[0] ?? null;
    });
    return res.json({
      meta: { apiVersion: "1", requestId: reqId(req) },
      ok: true,
      dual: row,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return sendAgentError(
      res,
      500,
      "ORACLE_PING_FAILED",
      "Oracle ping failed",
      enrichOracleDriverDetail(message)
    );
  }
});

/**
 * 只读查询表前 N 行（ROWNUM，兼容旧版 Oracle）
 * GET /api/v1/table-rows?table=MY_TABLE&limit=50
 * 或 ?table=OWNER.MY_TABLE
 * 未传 table 时使用环境变量 ORACLE_DEFAULT_TABLE
 */
manifestRouter.get("/table-rows", async (req, res) => {
  const fromEnv = process.env.ORACLE_DEFAULT_TABLE;
  const tableRaw = req.query.table ?? fromEnv;
  const parsed = parseQualifiedTable(tableRaw);
  if ("error" in parsed) {
    return sendAgentError(
      res,
      400,
      "VALIDATION_ERROR",
      parsed.error,
      "Set ?table=SCHEMA.MY_TABLE or ORACLE_DEFAULT_TABLE in .env"
    );
  }

  const limit = clampLimit(req.query.limit, 50, 500);
  const fromClause =
    parsed.schema == null
      ? parsed.table
      : `${parsed.schema}.${parsed.table}`;

  const sql = `
    SELECT * FROM (
      SELECT inner_q.*, ROWNUM AS rnum
      FROM (SELECT * FROM ${fromClause}) inner_q
      WHERE ROWNUM <= :lim
    )
    WHERE rnum >= 1
  `;

  try {
    const rows = await withConnection(async (conn) => {
      const result = await conn.execute(
        sql,
        { lim: limit },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );
      return result.rows || [];
    });
    return res.json({
      meta: { apiVersion: "1", requestId: reqId(req) },
      table: parsed.schema ? `${parsed.schema}.${parsed.table}` : parsed.table,
      limit,
      rows,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return sendAgentError(
      res,
      500,
      "ORACLE_QUERY_FAILED",
      "Oracle query failed",
      enrichOracleDriverDetail(message)
    );
  }
});
