import {
  getInfcontrolDummyExampleQuery,
} from "./infcontrolLayerBinDummy.js";
import { getYieldMonitorDummyExampleQuery } from "./yieldMonitorTriggerDummy.js";

/**
 * 供 AI agent / OpenAPI 生成器使用的机器可读 API 说明（只读 GET）。
 */
export const apiManifest = {
  apiVersion: "1",
  title: "pcr-ai-api",
  description:
    "Read-only Oracle-backed HTTP API for PCR workflows. All query keys are case-insensitive. The same Express router is mounted at /api/v1 (full catalog in GET /api/v1/manifest), /api/v3 (GET /api/v3/manifest returns v3-only paths), and /api/v4 (GET /api/v4/manifest returns v4-only paths). v4 duplicates v3 list surfaces for layer bins and yield triggers; v4 aggregates load the full matching row set (same WHERE as the v4 list without FETCH FIRST) and compute groups in Node—no separate v3-style aggregate SQL. v3 routes use fixed SQL; when dummy env flags are set and the process is not dist/production (see listDummyRuntime.ts), v3/v4 list and aggregates use in-memory Excel samples like v1/v2; otherwise they hit Oracle. deprecatedEndpoints lists routes removed from the router (yield-monitor-triggers/aggregate only).",
  mediaType: "application/json",
  endpoints: [
    {
      path: "/api/v1/manifest",
      method: "GET",
      purpose:
        "Return this catalog for tool discovery (endpoints, deprecatedEndpoints, error/tracing shapes).",
    },
    {
      path: "/api/v1/infcontrol-layer-bins",
      method: "GET",
      purpose:
        "Join INFCONTROL and INFLAYERBINLIST on KEYNUMBER; max 200 rows; ORDER BY TESTEND DESC NULLS LAST, KEYNUMBER DESC NULLS LAST.",
      queryParameters: [
        { name: "keynumber", type: "number", optional: true },
        { name: "device", type: "string", optional: true },
        { name: "lot", type: "string", optional: true },
        { name: "slot", type: "number", optional: true },
        { name: "pdpw", type: "number", optional: true },
        { name: "meslot", type: "string", optional: true },
        { name: "testerId", type: "string", optional: true },
        { name: "tstype", type: "string", optional: true },
        { name: "cardId", type: "string", optional: true },
        { name: "pibId", type: "string", optional: true },
        { name: "probe", type: "string", optional: true },
        { name: "grossDie", type: "number", optional: true },
        { name: "passId", type: "number", optional: true },
        { name: "sessionNumber", type: "number", optional: true },
        { name: "passNum", type: "number", optional: true },
        { name: "layerName", type: "string", optional: true },
        { name: "passResume", type: "string", optional: true },
        { name: "passResult", type: "string", optional: true },
        { name: "passType", type: "string", optional: true },
        { name: "passBin", type: "string", optional: true },
        {
          name: "testStartFrom",
          type: "datetime",
          optional: true,
          note: "ISO 8601; filters lb.TESTSTART >= value",
        },
        {
          name: "testStartTo",
          type: "datetime",
          optional: true,
          note: "ISO 8601; filters lb.TESTSTART <= value",
        },
        {
          name: "testEndFrom",
          type: "datetime",
          optional: true,
          note: "ISO 8601; filters lb.TESTEND >= value",
        },
        {
          name: "testEndTo",
          type: "datetime",
          optional: true,
          note: "ISO 8601; filters lb.TESTEND <= value",
        },
        {
          name: "bin0 … bin255",
          type: "string",
          optional: true,
          note: 'Comma-separated integers → IN list, e.g. bin5=1,3,5',
        },
      ],
      responseShape: {
        limit: "number (fixed 200)",
        orderBy: "string",
        filters: "object (echo of applied query params)",
        count: "number",
        rows:
          "array of row objects (Oracle columns uppercased except BINs packaged below); each row adds passBinPair [N,M]|null (from PASSBIN like 1-55) and bins { [binIndex: string]: { value: number, isGood: boolean } } (only BIN cells with non-null non-zero value); isGood true for bin index 1 (hard good) or PASSBIN N-M endpoints",
      },
      example: `/api/v1/infcontrol-layer-bins?${getInfcontrolDummyExampleQuery()}`,
    },
    {
      path: "/api/v1/infcontrol-layer-bins/v2",
      method: "GET",
      purpose:
        "Same join as infcontrol-layer-bins (v2 row shape): INFCONTROL device/lot/slot/notch/meslot plus INFLAYERBINLIST testerId, tstype, cardId, pibId, probe, passId, TESTSTART, TESTEND; BIN0–BIN255 only appear inside bins[] (non-empty cells). PASSBIN is hyphen-separated good bin indices (e.g. 1-2-55-250); not filterable. Server always AND-filters INFLAYERBINLIST rows to PASSTYPE=TEST (trim); echoed as filters.passtypeScope. Composite AND filters; testStartFrom/To and testEndFrom/To for windows; no bin* query keys; ORDER BY TESTEND DESC NULLS LAST, KEYNUMBER DESC NULLS LAST; limit default 200, max 500.",
      queryParameters: [
        {
          name: "limit",
          type: "number",
          optional: true,
          note: "Top-N rows after sort; default 200, max 500",
        },
        { name: "keynumber", type: "number", optional: true },
        { name: "device", type: "string", optional: true },
        { name: "lot", type: "string", optional: true },
        { name: "slot", type: "number", optional: true },
        { name: "notch", type: "string", optional: true },
        { name: "meslot", type: "string", optional: true },
        { name: "testerId", type: "string", optional: true },
        { name: "tstype", type: "string", optional: true },
        { name: "cardId", type: "string", optional: true },
        { name: "pibId", type: "string", optional: true },
        { name: "probe", type: "string", optional: true },
        { name: "passId", type: "number", optional: true },
        {
          name: "testStartFrom",
          type: "datetime",
          optional: true,
          note: "ISO 8601; lb.TESTSTART >= value",
        },
        {
          name: "testStartTo",
          type: "datetime",
          optional: true,
          note: "ISO 8601; lb.TESTSTART <= value",
        },
        {
          name: "testEndFrom",
          type: "datetime",
          optional: true,
          note: "ISO 8601; lb.TESTEND >= value",
        },
        {
          name: "testEndTo",
          type: "datetime",
          optional: true,
          note: "ISO 8601; lb.TESTEND <= value",
        },
      ],
      responseShape: {
        limit: "number (requested top-N, capped)",
        limitMax: "number (500)",
        orderBy: "string",
        filters: "object (echo of applied query params including limit)",
        count: "number",
        rows:
          "array: Oracle columns for listed fields plus PASSBIN; bins array of { value: number, n: number (BIN index), isGoodBin: boolean } for each non-null non-zero BIN column",
      },
      example: `/api/v1/infcontrol-layer-bins/v2?${getInfcontrolDummyExampleQuery()}&limit=200`,
    },
    {
      path: "/api/v1/infcontrol-layer-bins/v2/top-bad-bins",
      method: "GET",
      purpose:
        "Same WHERE as infcontrol-layer-bins/v2 including fixed PASSTYPE=TEST on INFLAYERBINLIST (no row limit): over all matching rows, sum BIN column values that are bad per row (PASSBIN hyphen-separated good indices use REGEXP_LIKE token match in Oracle). Return the top rankTop BIN indices by total bad die count (rankTop clamped 5–10, default 10). Sort bins by badTotal DESC then n ASC.",
      queryParameters: [
        {
          name: "rankTop",
          type: "number",
          optional: true,
          note: "How many BIN indices to return after ranking; default 10; clamped between 5 and 10",
        },
        {
          name: "badBinTop",
          type: "number",
          optional: true,
          note: "Alias for rankTop",
        },
        { name: "keynumber", type: "number", optional: true },
        { name: "device", type: "string", optional: true },
        { name: "lot", type: "string", optional: true },
        { name: "slot", type: "number", optional: true },
        { name: "notch", type: "string", optional: true },
        { name: "meslot", type: "string", optional: true },
        { name: "testerId", type: "string", optional: true },
        { name: "tstype", type: "string", optional: true },
        { name: "cardId", type: "string", optional: true },
        { name: "pibId", type: "string", optional: true },
        { name: "probe", type: "string", optional: true },
        { name: "passId", type: "number", optional: true },
        {
          name: "testStartFrom",
          type: "datetime",
          optional: true,
          note: "ISO 8601; lb.TESTSTART >= value",
        },
        {
          name: "testStartTo",
          type: "datetime",
          optional: true,
          note: "ISO 8601; lb.TESTSTART <= value",
        },
        {
          name: "testEndFrom",
          type: "datetime",
          optional: true,
          note: "ISO 8601; lb.TESTEND >= value",
        },
        {
          name: "testEndTo",
          type: "datetime",
          optional: true,
          note: "ISO 8601; lb.TESTEND <= value",
        },
      ],
      responseShape: {
        rankTop: "number (requested, after clamp)",
        rankTopMin: "number (5)",
        rankTopMax: "number (10)",
        orderBy: "string",
        filters: "object",
        bins: "array of { n: number, badTotal: number }",
      },
      example: `/api/v1/infcontrol-layer-bins/v2/top-bad-bins?${getInfcontrolDummyExampleQuery()}&rankTop=10`,
    },
    {
      path: "/api/v1/infcontrol-layer-bins/aggregate",
      method: "GET",
      purpose:
        "Same list filters as infcontrol-layer-bins (AND). After WHERE, UNPIVOT BIN0…BIN255 and SUM per group; BIN1 (hard good) contributes 0; when PASSBIN matches N-M, BIN N and BIN M contribute 0; return top groupTop groups by SUM (default 10, max 50). Omit groupBy to default to bin-only ranking; or include bin once with optional device, lot, slot, tstype, cardId, …",
      queryParameters: [
        {
          name: "groupBy",
          type: "string",
          optional: true,
          note:
            'Default bin if omitted. Otherwise comma-separated; must include "bin" once (max 8 dims). probeCard maps to INFLAYERBINLIST.PROBE (same as probe; do not combine both). Example: bin | device,bin | testerId,cardId,lot,bin',
        },
        {
          name: "groupTop",
          type: "number",
          optional: true,
          note: "default 10, max 50",
        },
        { name: "keynumber", type: "number", optional: true },
        { name: "device", type: "string", optional: true },
        { name: "lot", type: "string", optional: true },
        { name: "slot", type: "number", optional: true },
        { name: "pdpw", type: "number", optional: true },
        { name: "meslot", type: "string", optional: true },
        { name: "testerId", type: "string", optional: true },
        { name: "tstype", type: "string", optional: true },
        { name: "cardId", type: "string", optional: true },
        { name: "pibId", type: "string", optional: true },
        { name: "probe", type: "string", optional: true },
        { name: "grossDie", type: "number", optional: true },
        { name: "passId", type: "number", optional: true },
        { name: "sessionNumber", type: "number", optional: true },
        { name: "passNum", type: "number", optional: true },
        { name: "layerName", type: "string", optional: true },
        { name: "passResume", type: "string", optional: true },
        { name: "passResult", type: "string", optional: true },
        { name: "passType", type: "string", optional: true },
        { name: "passBin", type: "string", optional: true },
        {
          name: "testStartFrom",
          type: "datetime",
          optional: true,
          note: "ISO 8601; filters lb.TESTSTART >= value",
        },
        {
          name: "testStartTo",
          type: "datetime",
          optional: true,
          note: "ISO 8601; filters lb.TESTSTART <= value",
        },
        {
          name: "testEndFrom",
          type: "datetime",
          optional: true,
          note: "ISO 8601; filters lb.TESTEND >= value (test end time window)",
        },
        {
          name: "testEndTo",
          type: "datetime",
          optional: true,
          note: "ISO 8601; filters lb.TESTEND <= value",
        },
        {
          name: "bin0 … bin255",
          type: "string",
          optional: true,
          note: 'Comma-separated integers → IN list, e.g. bin5=1,3,5',
        },
      ],
      responseShape: {
        groupBy:
          "string[] (normalized dimensions; parts.bin is BIN index 0…255 when grouping by bin)",
        groupTop: "number",
        orderBy:
          "string (SUM of unpivoted BIN cells DESC NULLS LAST within grouped dims)",
        filters:
          "object (includes groupBy as string[], groupTop, and list filters)",
        totalRowsMatching: "number (detail rows matching WHERE before agg cap)",
        groups:
          "array of { key: string, count: number (SUM of BIN cells), parts: Record<string,string> }",
      },
      example: `/api/v1/infcontrol-layer-bins/aggregate?${getInfcontrolDummyExampleQuery()}&groupTop=10`,
    },
    {
      path: "/api/v1/yield-monitor-triggers",
      method: "GET",
      purpose:
        "Query YMWEB_YIELDMONITORTRIGGER; max 200 rows; ORDER BY TIME_STAMP DESC NULLS LAST; optional PROBECARD and HOSTNAME counts over all matching rows (see probeCardSummary, hostnameSummary).",
      queryParameters: [
        { name: "hostname", type: "string", optional: true },
        { name: "device", type: "string", optional: true },
        { name: "lotId", type: "string", optional: true },
        { name: "wafer", type: "string", optional: true },
        { name: "type", type: "string", optional: true },
        { name: "triggerLabel", type: "string", optional: true },
        { name: "probeCard", type: "string", optional: true },
        { name: "pass", type: "number", optional: true },
        { name: "id", type: "number", optional: true },
        {
          name: "timeStampFrom",
          type: "datetime",
          optional: true,
          note: "ISO 8601; TIME_STAMP >= value",
        },
        {
          name: "timeStampTo",
          type: "datetime",
          optional: true,
          note: "ISO 8601; TIME_STAMP <= value",
        },
        {
          name: "includeProbeCardSummary",
          type: "boolean",
          optional: true,
          note:
            "default true; false skips extra GROUP BY PROBECARD and GROUP BY HOSTNAME queries",
        },
      ],
      responseShape: {
        limit: "number (fixed 200)",
        orderBy: "string",
        filters: "object",
        count: "number",
        rows: "array",
        probeCardSummary:
          "optional array of { probeCard: string, count: number }; all rows matching filters, ORDER BY COUNT(*) DESC NULLS LAST",
        probeCardSummaryOrderBy: "optional string when probeCardSummary present",
        hostnameSummary:
          "optional array of { hostname: string, count: number }; same WHERE as rows; ORDER BY COUNT(*) DESC NULLS LAST",
        hostnameSummaryOrderBy: "optional string when hostnameSummary present",
      },
      example: `/api/v1/yield-monitor-triggers?${getYieldMonitorDummyExampleQuery()}`,
    },
    {
      path: "/api/v1/infcontrol-layer-bins/v3",
      method: "GET",
      purpose:
        "INFCONTROL t1 INNER JOIN INFLAYERBINLIST t2 ON KEYNUMBER, WHERE PASSTYPE='TEST' plus optional AND filters (case-insensitive TRIM equality on device, lot, meslot, testerId, tstype, cardId via UPPER(TRIM(col))=UPPER(:bind); exact match on slot, passId; TESTSTART/TESTEND windows). If the client sends none of the eight testStart*/testEnd* query keys, the server AND-filters t2.TESTEND to [UTC now minus one calendar year, UTC now] (same default as v3 aggregate). Then ORDER BY TESTEND DESC NULLS LAST, SLOT, PASSID, PASSNUM, FETCH FIRST :lim ROWS ONLY. When INFCONTROL_LAYER_BINS_DUMMY is true and the process is not dist/production, serves rows from docs/JBStart.xlsx in memory (listDummyRuntime); otherwise main Oracle pool. Row shape matches infcontrol-layer-bins/v2 plus PROBECARDTYPE (leading segment of CARDID before first hyphen). Query keys are case-insensitive (including limit).",
      queryParameters: [
        {
          name: "limit",
          type: "number",
          optional: true,
          note: "Top-N rows; default 200; max 500",
        },
        { name: "device", type: "string", optional: true },
        { name: "lot", type: "string", optional: true },
        { name: "slot", type: "number", optional: true },
        { name: "meslot", type: "string", optional: true },
        { name: "testerId", type: "string", optional: true },
        { name: "tstype", type: "string", optional: true },
        { name: "cardId", type: "string", optional: true },
        { name: "passId", type: "number", optional: true },
        {
          name: "testStartBegin",
          type: "datetime",
          optional: true,
          note: "ISO 8601; t2.TESTSTART >= value (alias: testStartFrom)",
        },
        {
          name: "testStartEnd",
          type: "datetime",
          optional: true,
          note: "ISO 8601; t2.TESTSTART <= value (alias: testStartTo)",
        },
        {
          name: "testStartFrom",
          type: "datetime",
          optional: true,
          note: "Alias for testStartBegin when begin not set",
        },
        {
          name: "testStartTo",
          type: "datetime",
          optional: true,
          note: "Alias for testStartEnd when end not set",
        },
        {
          name: "testEndBegin",
          type: "datetime",
          optional: true,
          note: "ISO 8601; t2.TESTEND >= value (alias: testEndFrom)",
        },
        {
          name: "testEndEnd",
          type: "datetime",
          optional: true,
          note: "ISO 8601; t2.TESTEND <= value (alias: testEndTo)",
        },
        {
          name: "testEndFrom",
          type: "datetime",
          optional: true,
          note: "Alias for testEndBegin when begin not set",
        },
        {
          name: "testEndTo",
          type: "datetime",
          optional: true,
          note: "Alias for testEndEnd when end not set",
        },
      ],
      responseShape: {
        meta: "{ apiVersion: '3', requestId }",
        limit: "number",
        limitMax: "number (500)",
        orderBy: "string",
        filters: "object (echo of applied filters plus limit)",
        count: "number",
        rows: "same enrichment as infcontrol-layer-bins/v2 plus PROBECARDTYPE (string | null from CARDID)",
      },
      example:
        "/api/v1/infcontrol-layer-bins/v3?device=WB10N57U&lot=NF12615.1X&testEndBegin=2026-05-13T00:00:00.000Z&testEndEnd=2026-05-13T23:59:59.999Z&limit=200",
    },
    {
      path: "/api/v1/infcontrol-layer-bins/v3/aggregate",
      method: "GET",
      purpose:
        "v3 infcontrol BIN aggregate: same filter semantics as GET /infcontrol-layer-bins/v3 (PASSTYPE=TEST on INFLAYERBINLIST plus v3 AND filters; UPPER(TRIM) string equality; default one-calendar-year TESTEND window when no testStart*/testEnd* keys). Over ALL matching joined rows (not capped by list limit), UNPIVOT BIN0…BIN255 and SUM per groupBy dimensions; SUM counts bad-bin die only—PASSBIN hyphen-separated whole tokens (0–255) are good bins (same token rule as /infcontrol-layer-bins/v2/top-bad-bins and v3 list bins[].isGoodBin), excluded from SUM (not v1 aggregate BIN1 + N-M pair rules). Returns top groupTop groups by SUM (default 10, max 50). When INFCONTROL_LAYER_BINS_DUMMY is true and not dist/production, uses JBStart.xlsx in-memory rows with Node aggregation; else main Oracle UNPIVOT aggregate SQL. Response includes documentation (Chinese). Requires groupBy with exactly one bin (same rules as v1 aggregate).",
      queryParameters: [
        {
          name: "groupBy",
          type: "string",
          optional: true,
          note:
            'Default bin if omitted. Comma-separated; must include "bin" once (max 8 dims). Tokens include probeCard (INFLAYERBINLIST.PROBE, alias for yield-style naming; mutually exclusive with probe in the same request), probeCardType (leading segment of CARDID before first hyphen, same as v3 list PROBECARDTYPE). Same rules as /infcontrol-layer-bins/aggregate.',
        },
        {
          name: "groupTop",
          type: "number",
          optional: true,
          note: "default 10, max 50",
        },
        { name: "device", type: "string", optional: true },
        { name: "lot", type: "string", optional: true },
        { name: "slot", type: "number", optional: true },
        { name: "meslot", type: "string", optional: true },
        { name: "testerId", type: "string", optional: true },
        { name: "tstype", type: "string", optional: true },
        { name: "cardId", type: "string", optional: true },
        { name: "passId", type: "number", optional: true },
        {
          name: "testStartBegin",
          type: "datetime",
          optional: true,
          note: "ISO 8601; t2.TESTSTART >= (alias testStartFrom)",
        },
        {
          name: "testStartEnd",
          type: "datetime",
          optional: true,
          note: "ISO 8601; t2.TESTSTART <= (alias testStartTo)",
        },
        {
          name: "testStartFrom",
          type: "datetime",
          optional: true,
          note: "Alias for testStartBegin",
        },
        {
          name: "testStartTo",
          type: "datetime",
          optional: true,
          note: "Alias for testStartEnd",
        },
        {
          name: "testEndBegin",
          type: "datetime",
          optional: true,
          note: "ISO 8601; t2.TESTEND >= (alias testEndFrom)",
        },
        {
          name: "testEndEnd",
          type: "datetime",
          optional: true,
          note: "ISO 8601; t2.TESTEND <= (alias testEndTo)",
        },
        {
          name: "testEndFrom",
          type: "datetime",
          optional: true,
          note: "Alias for testEndBegin",
        },
        {
          name: "testEndTo",
          type: "datetime",
          optional: true,
          note: "Alias for testEndEnd",
        },
      ],
      responseShape: {
        meta: "{ apiVersion: '3', requestId, aggregatePath }",
        documentation: "string (fixed Chinese explanation: full population vs v3 list limit)",
        groupBy: "string[]",
        groupTop: "number",
        orderBy: "string",
        filters: "object",
        totalRowsMatching: "number",
        groups: "array of { key, count (SUM), parts }",
      },
      example:
        "/api/v1/infcontrol-layer-bins/v3/aggregate?device=WB10N57U&testEndBegin=2026-05-13T00:00:00.000Z&testEndEnd=2026-05-13T23:59:59.999Z&groupBy=bin&groupTop=10",
    },
    {
      path: "/api/v1/yield-monitor-triggers/v3",
      method: "GET",
      purpose:
        "SELECT * FROM YMWEB_YIELDMONITORTRIGGER with fixed WHERE UPPER(TRIM(TYPE)) = 'DELTA_DIFF' (bind :v3_type_scope; echoed as filters.typeScope) AND optional AND filters (case-insensitive TRIM on string columns: HOSTNAME, DEVICE, LOTID, WAFER, PROBECARD; exact PASS; TIME_STAMP window). If the client sends none of timeStampBegin/timeStampEnd/timeStampFrom/timeStampTo, the server AND-filters TIME_STAMP to [UTC now minus one calendar year, UTC now] (same default as v3 aggregate). Then ORDER BY TIME_STAMP DESC NULLS LAST FETCH FIRST :lim ROWS ONLY. Query parameter type is not supported on v3 (cannot override TYPE scope; rows still include TYPE in each object). Each row also includes dutNumber (from TRIGGER_LABEL) and PROBECARDTYPE (leading segment of PROBECARD before first hyphen). When YIELD_MONITOR_TRIGGERS_DUMMY is true and not dist/production, serves matching rows from docs/delta-diff.xlsx in memory; else probeweb Oracle. Query keys are case-insensitive (including limit).",
      queryParameters: [
        {
          name: "limit",
          type: "number",
          optional: true,
          note: "Top-N rows; default 200; max 500",
        },
        { name: "hostname", type: "string", optional: true },
        { name: "device", type: "string", optional: true },
        { name: "lotId", type: "string", optional: true },
        { name: "pass", type: "number", optional: true },
        { name: "wafer", type: "string", optional: true },
        { name: "probeCard", type: "string", optional: true },
        {
          name: "timeStampBegin",
          type: "datetime",
          optional: true,
          note: "ISO 8601; TIME_STAMP >= value (alias: timeStampFrom)",
        },
        {
          name: "timeStampEnd",
          type: "datetime",
          optional: true,
          note: "ISO 8601; TIME_STAMP <= value (alias: timeStampTo)",
        },
        {
          name: "timeStampFrom",
          type: "datetime",
          optional: true,
          note: "Alias for timeStampBegin when begin not set",
        },
        {
          name: "timeStampTo",
          type: "datetime",
          optional: true,
          note: "Alias for timeStampEnd when end not set",
        },
      ],
      responseShape: {
        meta: "{ apiVersion: '3', requestId }",
        limit: "number",
        limitMax: "number (500)",
        orderBy: "string",
        filters:
          "object (echo of applied filters plus limit; always includes typeScope: 'delta_diff' — server-fixed TYPE filter)",
        count: "number",
        rows:
          "array of row objects (all DB columns plus dutNumber: number | null — DUT id parsed from TRIGGER_LABEL when it contains “on dut# …”, else null; plus PROBECARDTYPE: string | null — leading segment of PROBECARD before first hyphen)",
      },
      example:
        "/api/v1/yield-monitor-triggers/v3?device=WA03P02G&timeStampBegin=2026-05-13T00:00:00.000Z&timeStampEnd=2026-05-13T23:59:59.999Z&limit=200",
    },
    {
      path: "/api/v1/yield-monitor-triggers/v3/aggregate",
      method: "GET",
      purpose:
        "v3 yield aggregate: same WHERE as GET /yield-monitor-triggers/v3 (fixed TYPE=delta_diff via UPPER(TRIM(TYPE)); UPPER(TRIM) on other string columns; TIME_STAMP window including default one-calendar-year bounds when no timeStamp* keys; etc.). Over ALL matching rows (not limited to FETCH FIRST list cap), COUNT(*) GROUP BY requested dimensions in Oracle, order by count DESC, return top groupTop groups (default 25, max 100). Required query parameter dimensions: comma-separated from device, hostname, lotId, wafer, probeCard, probeCardType, pass, triggerLabel, timeDay, timeHour (max 5 dims; timeDay and timeHour mutually exclusive; probeCardType is leading segment of PROBECARD before first hyphen, same as v3 list PROBECARDTYPE). Query parameter type is not supported on v3 yield endpoints. When YIELD_MONITOR_TRIGGERS_DUMMY is true and not dist/production, uses delta-diff.xlsx in-memory rows with Node aggregation; else probeweb Oracle GROUP BY SQL. JSON documentation field explains difference vs v3 list.",
      queryParameters: [
        {
          name: "dimensions",
          type: "string",
          optional: false,
          note:
            "Required. Comma-separated: device, hostname, lotId, wafer, probeCard, probeCardType, pass, triggerLabel, timeDay, timeHour (max 5). probeCardType = leading segment of PROBECARD before first hyphen (same as v3 list PROBECARDTYPE). Cannot combine timeDay+timeHour. Parameter type is not supported on v3.",
        },
        {
          name: "groupTop",
          type: "number",
          optional: true,
          note: "max groups returned; default 25, max 100",
        },
        { name: "hostname", type: "string", optional: true },
        { name: "device", type: "string", optional: true },
        { name: "lotId", type: "string", optional: true },
        { name: "pass", type: "number", optional: true },
        { name: "wafer", type: "string", optional: true },
        { name: "probeCard", type: "string", optional: true },
        {
          name: "timeStampBegin",
          type: "datetime",
          optional: true,
          note: "ISO 8601; TIME_STAMP >= (alias timeStampFrom)",
        },
        {
          name: "timeStampEnd",
          type: "datetime",
          optional: true,
          note: "ISO 8601; TIME_STAMP <= (alias timeStampTo)",
        },
        {
          name: "timeStampFrom",
          type: "datetime",
          optional: true,
          note: "Alias for timeStampBegin",
        },
        {
          name: "timeStampTo",
          type: "datetime",
          optional: true,
          note: "Alias for timeStampEnd",
        },
      ],
      responseShape: {
        meta: "{ apiVersion: '3', requestId, aggregatePath }",
        documentation: "string (fixed Chinese explanation)",
        dimensions: "string[] (normalized)",
        groupTop: "number",
        orderBy: "string",
        filters:
          "object (includes typeScope: 'delta_diff' plus dimensions, groupTop, and list filters)",
        totalRowsMatching: "number",
        groups: "array of { key, count (row count per group), parts }",
      },
      example:
        "/api/v1/yield-monitor-triggers/v3/aggregate?dimensions=device,hostname&timeStampBegin=2026-05-13T00:00:00.000Z&timeStampEnd=2026-05-13T23:59:59.999Z&groupTop=20",
    },
    {
      path: "/api/v1/infcontrol-layer-bins/v4",
      method: "GET",
      purpose:
        "Same filter semantics, ORDER BY, FETCH FIRST limit, row shape, and dummy/Oracle data sources as GET /api/v1/infcontrol-layer-bins/v3; meta.apiVersion is 4. Use GET /api/v4/manifest for v4-prefixed catalog URLs.",
      queryParameters: [
        {
          name: "limit",
          type: "number",
          optional: true,
          note: "Top-N rows; default 200; max 500 (same as v3 list)",
        },
        {
          name: "device, lot, slot, meslot, testerId, tstype, cardId, passId, testStart*, testEnd*",
          type: "mixed",
          optional: true,
          note: "Identical to infcontrol-layer-bins/v3 (see that entry)",
        },
      ],
      responseShape: {
        meta: "{ apiVersion: '4', requestId }",
        limit: "number",
        limitMax: "number (500)",
        orderBy: "string",
        filters: "object",
        count: "number",
        rows: "same as infcontrol-layer-bins/v3 list",
      },
      example:
        "/api/v1/infcontrol-layer-bins/v4?device=WB10N57U&lot=NF12615.1X&testEndBegin=2026-05-13T00:00:00.000Z&testEndEnd=2026-05-13T23:59:59.999Z&limit=200",
    },
    {
      path: "/api/v1/infcontrol-layer-bins/v4/aggregate",
      method: "GET",
      purpose:
        "v4 infcontrol BIN aggregate: same groupBy/groupTop validation and list filters as GET /infcontrol-layer-bins/v3/aggregate. Oracle/Dummy: loads all matching rows (no FETCH FIRST) and sums bad-bin die in Node (same hyphen-token PASSBIN rule as v3 dummy); v3 Oracle instead runs UNPIVOT aggregate SQL. Oracle path: COUNT first; if count exceeds MEMORY_AGG_ORACLE_MAX_ROWS, returns 422 QUERY_TOO_LARGE; else in-memory SUM. Dummy uses JBStart in-memory rows.",
      queryParameters: [
        {
          name: "groupBy, groupTop, device, lot, slot, …",
          type: "mixed",
          optional: true,
          note: "Same as infcontrol-layer-bins/v3/aggregate",
        },
      ],
      responseShape: {
        meta: "{ apiVersion: '4', requestId, aggregatePath }",
        documentation: "string (v4 Chinese note: in-memory aggregation from full list row set)",
        groupBy: "string[]",
        groupTop: "number",
        orderBy: "string",
        filters: "object",
        totalRowsMatching: "number",
        groups: "array of { key, count, parts }",
      },
      example:
        "/api/v1/infcontrol-layer-bins/v4/aggregate?device=WB10N57U&testEndBegin=2026-05-13T00:00:00.000Z&testEndEnd=2026-05-13T23:59:59.999Z&groupBy=bin&groupTop=10",
    },
    {
      path: "/api/v1/yield-monitor-triggers/v4",
      method: "GET",
      purpose:
        "Same as GET /api/v1/yield-monitor-triggers/v3 except meta.apiVersion is 4 and path is v4.",
      queryParameters: [
        {
          name: "limit, hostname, device, lotId, pass, wafer, probeCard, timeStamp*",
          type: "mixed",
          optional: true,
          note: "Identical to yield-monitor-triggers/v3",
        },
      ],
      responseShape: {
        meta: "{ apiVersion: '4', requestId }",
        limit: "number",
        limitMax: "number (500)",
        orderBy: "string",
        filters: "object",
        count: "number",
        rows: "same as yield-monitor-triggers/v3 list",
      },
      example:
        "/api/v1/yield-monitor-triggers/v4?device=WA03P02G&timeStampBegin=2026-05-13T00:00:00.000Z&timeStampEnd=2026-05-13T23:59:59.999Z&limit=200",
    },
    {
      path: "/api/v1/yield-monitor-triggers/v4/aggregate",
      method: "GET",
      purpose:
        "v4 yield aggregate: same dimensions/groupTop and WHERE as GET /yield-monitor-triggers/v3/aggregate. Oracle/Dummy: loads all matching rows, attaches PROBECARDTYPE, COUNT per group in Node (same as v3 dummy); v3 Oracle uses GROUP BY SQL. Oracle path: COUNT first, 422 if over MEMORY_AGG_ORACLE_MAX_ROWS; else in-memory COUNT.",
      queryParameters: [
        {
          name: "dimensions, groupTop, hostname, device, …",
          type: "mixed",
          optional: true,
          note: "Same as yield-monitor-triggers/v3/aggregate",
        },
      ],
      responseShape: {
        meta: "{ apiVersion: '4', requestId, aggregatePath }",
        documentation: "string (v4 Chinese note)",
        dimensions: "string[]",
        groupTop: "number",
        orderBy: "string",
        filters: "object",
        totalRowsMatching: "number",
        groups: "array of { key, count, parts }",
      },
      example:
        "/api/v1/yield-monitor-triggers/v4/aggregate?dimensions=device,hostname&timeStampBegin=2026-05-13T00:00:00.000Z&timeStampEnd=2026-05-13T23:59:59.999Z&groupTop=20",
    },
    {
      path: "/api/v1/inf-analysis/site-bin-bylot",
      method: "GET",
      purpose:
        "Per wafer test pass (one or more PASS_ID): from on-disk INF wafer map(s), list which probe-card DUT produced each bin and die counts (PASS_TYPE=TEST). Single wafer: infPath. Lot: device+lot+passId (optional probeCardType: JB filter or scan all r_1-{slot} under lot dir). Device: device+passId without lot (optional probeCardType; auto-infer single card type from JB). Sums dieCount per pass×bin×dut. Not Oracle JB—Perl output_site_bin_bylot.pl --json.",
      queryParameters: [
        {
          name: "infPath",
          type: "string",
          optional: true,
          note: "Single wafer INF path (alias: inf_path). Mutually exclusive with device+lot.",
        },
        {
          name: "device",
          type: "string",
          optional: true,
          note: "Aggregation: with lot → lot scope; without lot → device scope. Mutually exclusive with infPath.",
        },
        {
          name: "lot",
          type: "string",
          optional: true,
          note: "With device: lot scope; omit for device scope (all lots under device)",
        },
        {
          name: "probeCardType",
          type: "string",
          optional: true,
          note: "Lot: omit → scan all r_1-{slot} under lot dir; with value → JB-filtered wafers. Device (no lot): omit → infer single card type from JB or 400 if multiple; with value → explicit filter.",
        },
        {
          name: "passId",
          type: "number",
          optional: false,
          note: "Wafer test pass(es) to include—repeat or comma-separated, e.g. passId=1&passId=2 (alias: pass_id)",
        },
      ],
      responseShape: {
        meta: "{ apiVersion, requestId, summary, aggregateScope: 'wafer' | 'lot' | 'device' }",
        infPath: "string (wafer mode only)",
        device: "string (aggregation)",
        lot: "string (lot scope)",
        probeCardType: "string (aggregation; inferred on device scope when omitted)",
        lotDir: "string (lot scope)",
        deviceDir: "string (device scope)",
        waferCount: "number (aggregation)",
        waferSlots: "number[] (aggregation)",
        waferLots: "string[] (device scope)",
        skippedInfPaths: "string[] (JB matched but INF not readable)",
        passIds: "number[] (requested passes)",
        passes:
          "per pass: { passId (wafer pass), bins: [{ bin: 'bin30' (test bin label), duts: [{ dut (probe card DUT#), dieCount (die on map for bin×DUT) }] }] }",
        stderr: "optional string",
      },
      example:
        "/api/v1/inf-analysis/site-bin-bylot?infPath=/data/probe_logs/ps16_SMTPID/teststuffs/infanylist/r_1-1&passId=1; lot: ?device=WA03P02G&lot=NF12551.1N&passId=1; device: ?device=WA03P02G&passId=1",
    },
    {
      path: "/api/v1/db/ping",
      method: "GET",
      purpose: "Health check against Oracle via SELECT 1 FROM DUAL (main pool).",
    },
    {
      path: "/api/v1/table-rows",
      method: "GET",
      purpose: "Development helper: first N rows from a table (ROWNUM).",
      queryParameters: [
        { name: "table", type: "string", optional: true },
        { name: "limit", type: "number", optional: true, note: "default 50, max 500" },
      ],
    },
    {
      path: "/health",
      method: "GET",
      purpose: "Process liveness (no database).",
    },
  ],
  /** yield-monitor 聚合已从路由移除；infcontrol 聚合已恢复 */
  deprecatedEndpoints: [
    {
      path: "/api/v1/yield-monitor-triggers/aggregate",
      method: "GET",
      status: "removed",
      note: "Disabled in src/routes/api.ts; libraries yieldMonitorTriggerAggregate.ts, dummy aggregate kept for future redesign.",
    },
  ],
  errorShape: {
    error: "human-readable message",
    code: "machine-stable code (e.g. VALIDATION_ERROR, ORACLE_QUERY_FAILED)",
    detail: "optional extra context",
  },
  tracing: {
    requestHeader: "X-Request-Id",
    responseHeader: "X-Request-Id",
    note: "Echo client id or server-generated UUID for log correlation.",
  },
} as const;
