/**
 * 在 **NODE_ENV=test** 下 **`listApisForceOracleNoDummy()`** 为 false，可配合
 * **`INFCONTROL_LAYER_BINS_DUMMY`** / **`YIELD_MONITOR_TRIGGERS_DUMMY`** 走 **Excel** 内存数据。
 *
 * 覆盖 **`/api/v3`** 挂载的**全部** GET 业务路由；**`/api/v4`** 的 v4 列表与聚合（dummy 下与 v3 聚合结果对齐）；
 * **`/health`** 单独挂在 app 根。
 * **`/api/v3/db/ping`** 与 **`/api/v3/table-rows`** 需真实 Oracle：仅当环境变量
 * **`PCR_AI_RUN_ORACLE_TESTS=1`** 时执行（否则 **skip**）。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

import { probeCardTypeLeadingSegment } from "../src/lib/probeCardTypeLeadingSegment.js";
import { parseDutNumberFromTriggerLabel } from "../src/lib/yieldTriggerLabelDut.js";

const API = "/api/v3";

describe(
  "REST API（/api/v3 + dummy Excel + /health）",
  { concurrency: false },
  () => {
    let baseUrl = "";
    let server: ReturnType<typeof createServer> | undefined;
    let icExampleQs = "";
    let yExampleQs = "";

    before(async () => {
      process.env.NODE_ENV = "test";
      process.env.INFCONTROL_LAYER_BINS_DUMMY = "true";
      process.env.YIELD_MONITOR_TRIGGERS_DUMMY = "true";

      const [{ createApp }, icDummy, yDummy] = await Promise.all([
        import("../src/app.js"),
        import("../src/lib/infcontrolLayerBinDummy.js"),
        import("../src/lib/yieldMonitorTriggerDummy.js"),
      ]);

      icExampleQs = icDummy.getInfcontrolDummyExampleQuery();
      yExampleQs = yDummy.getYieldMonitorDummyExampleQuery();

      const app = createApp();

      await new Promise<void>((resolve, reject) => {
        const s = createServer(app);
        server = s;
        s.listen(0, "127.0.0.1", () => resolve());
        s.on("error", reject);
      });
      const addr = server!.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
    });

    after(async () => {
      await new Promise<void>((resolve) => {
        if (server) server.close(() => resolve());
        else resolve();
      });
      const { closeOraclePool, closeProbeWebPool } = await import(
        "../src/oracle.js"
      );
      await Promise.all([closeOraclePool(), closeProbeWebPool()]).catch(
        () => undefined
      );
    });

    async function getJson(path: string): Promise<{
      status: number;
      body: unknown;
    }> {
      const r = await fetch(`${baseUrl}${path}`);
      const text = await r.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        /* keep raw */
      }
      return { status: r.status, body };
    }

    function assertOkJson(status: number, body: unknown): asserts body is Record<
      string,
      unknown
    > {
      assert.equal(status, 200);
      assert.ok(body && typeof body === "object" && !Array.isArray(body));
    }

    test("GET /health", async () => {
      const { status, body } = await getJson("/health");
      assertOkJson(status, body);
      assert.equal((body as { status?: string }).status, "ok");
    });

    test("GET /api/v4/manifest（v4 目录）", async () => {
      const { status, body } = await getJson("/api/v4/manifest");
      assertOkJson(status, body);
      assert.equal((body as { catalogScope?: string }).catalogScope, "v4-surfaces-only");
      const eps = (body as { endpoints?: { path?: string }[] }).endpoints;
      assert.ok(Array.isArray(eps) && eps.length > 0);
      const paths = eps!.map((e) => e.path).filter(Boolean) as string[];
      assert.ok(paths.some((p) => p.includes("/api/v4/infcontrol-layer-bins/v4")));
      assert.ok(paths.some((p) => p.includes("/api/v4/yield-monitor-triggers/v4")));
      assert.ok(paths.every((p) => !p.startsWith("/api/v1")));
    });

    test("GET /api/v3/manifest（v3 目录）", async () => {
      const { status, body } = await getJson(`${API}/manifest`);
      assertOkJson(status, body);
      assert.equal((body as { catalogScope?: string }).catalogScope, "v3-surfaces-only");
      const eps = (body as { endpoints?: { path?: string }[] }).endpoints;
      assert.ok(Array.isArray(eps) && eps.length > 0);
      const paths = eps!.map((e) => e.path).filter(Boolean) as string[];
      assert.ok(paths.some((p) => p.includes("/api/v3/yield-monitor-triggers/v3")));
      assert.ok(paths.some((p) => p.includes("/api/v3/infcontrol-layer-bins/v3")));
      assert.ok(paths.every((p) => !p.startsWith("/api/v1")));
    });

    test("GET /api/v3/infcontrol-layer-bins（v1 列表 · dummy）", async () => {
      const { status, body } = await getJson(
        `${API}/infcontrol-layer-bins?${icExampleQs}&limit=50`
      );
      assertOkJson(status, body);
      assert.ok(Array.isArray((body as { rows?: unknown }).rows));
    });

    test("GET /api/v3/infcontrol-layer-bins/v2（dummy）", async () => {
      const { status, body } = await getJson(
        `${API}/infcontrol-layer-bins/v2?${icExampleQs}&limit=50`
      );
      assertOkJson(status, body);
      assert.ok(Array.isArray((body as { rows?: unknown }).rows));
    });

    test("GET /api/v3/infcontrol-layer-bins/v3（v3 列表 · dummy）", async () => {
      const { status, body } = await getJson(
        `${API}/infcontrol-layer-bins/v3?${icExampleQs}&limit=50`
      );
      assertOkJson(status, body);
      const b = body as {
        meta?: { apiVersion?: string };
        rows?: unknown[];
        count?: number;
      };
      assert.equal(b.meta?.apiVersion, "3");
      assert.ok(Array.isArray(b.rows));
      assert.equal(b.count, b.rows!.length);
      assert.ok(b.rows!.length > 0, "JBStart dummy 应至少返回一行");
      for (const row of b.rows!) {
        assert.ok("PROBECARDTYPE" in row);
        assert.equal(
          row.PROBECARDTYPE,
          probeCardTypeLeadingSegment(row.CARDID ?? row.cardid)
        );
      }
    });

    test("GET /api/v3/infcontrol-layer-bins/v3 bins=8 filters BIN8 column", async () => {
      const qs = new URLSearchParams();
      qs.set("bins", "8");
      const { status, body } = await getJson(
        `${API}/infcontrol-layer-bins/v3?${qs.toString()}&limit=200`
      );
      assertOkJson(status, body);
      const rows = (body as { rows?: Record<string, unknown>[] }).rows ?? [];
      assert.ok(rows.length > 0);
      for (const row of rows) {
        const bins = row.bins;
        assert.ok(Array.isArray(bins));
        assert.ok(
          bins.some(
            (c) =>
              c &&
              typeof c === "object" &&
              Number((c as { n?: number }).n) === 8 &&
              Number((c as { value?: number }).value) > 0
          ),
          "enriched row should include bins[].n=8 with value>0"
        );
      }
      assert.deepEqual(
        (body as { filters?: { bins?: number[] } }).filters?.bins,
        [8]
      );
    });

    test("GET /api/v3/infcontrol-layer-bins/v3 无 testStart/testEnd* 时 filters 含默认一年 TESTEND", async () => {
      const qs = new URLSearchParams(icExampleQs);
      for (const k of [
        "testStartBegin",
        "testStartFrom",
        "testStartEnd",
        "testStartTo",
        "testEndBegin",
        "testEndFrom",
        "testEndEnd",
        "testEndTo",
      ]) {
        qs.delete(k);
      }
      const { status, body } = await getJson(
        `${API}/infcontrol-layer-bins/v3?${qs.toString()}&limit=50`
      );
      assertOkJson(status, body);
      const f = (body as { filters?: Record<string, unknown> }).filters;
      assert.equal(typeof f?.testEndBegin, "string");
      assert.equal(typeof f?.testEndEnd, "string");
      assert.ok(
        new Date(String(f!.testEndBegin)).getTime() <=
          new Date(String(f!.testEndEnd)).getTime()
      );
    });

    test("GET /api/v3/infcontrol-layer-bins/v3/aggregate（v3 聚合 · dummy）", async () => {
      const qs = new URLSearchParams(icExampleQs);
      qs.set("groupBy", "device,bin");
      qs.set("groupTop", "5");
      const { status, body } = await getJson(
        `${API}/infcontrol-layer-bins/v3/aggregate?${qs.toString()}`
      );
      assertOkJson(status, body);
      const b = body as {
        meta?: { apiVersion?: string };
        groups?: unknown[];
        totalRowsMatching?: number;
      };
      assert.equal(b.meta?.apiVersion, "3");
      assert.ok(typeof b.totalRowsMatching === "number");
      assert.ok(Array.isArray(b.groups));
    });

    test("GET /api/v3/infcontrol-layer-bins/v3/aggregate groupBy=probeCard,bin（dummy）", async () => {
      const qs = new URLSearchParams(icExampleQs);
      qs.set("groupBy", "probeCard,bin");
      qs.set("groupTop", "5");
      const { status, body } = await getJson(
        `${API}/infcontrol-layer-bins/v3/aggregate?${qs.toString()}`
      );
      assertOkJson(status, body);
      const b = body as { groups?: unknown[] };
      assert.ok(Array.isArray(b.groups));
    });

    test("GET /api/v3/infcontrol-layer-bins/v3/aggregate groupBy=probeCardType,bin（dummy）", async () => {
      const qs = new URLSearchParams(icExampleQs);
      qs.set("groupBy", "probeCardType,bin");
      qs.set("groupTop", "12");
      const { status, body } = await getJson(
        `${API}/infcontrol-layer-bins/v3/aggregate?${qs.toString()}`
      );
      assertOkJson(status, body);
      const b = body as { groups?: { parts?: Record<string, string> }[] };
      assert.ok(Array.isArray(b.groups));
      if (b.groups!.length > 0) {
        assert.ok("probeCardType" in (b.groups![0].parts ?? {}));
      }
    });

    test("GET /api/v3/infcontrol-layer-bins/v3/aggregate groupBy 同时含 probe 与 probeCard → 400", async () => {
      const qs = new URLSearchParams(icExampleQs);
      qs.set("groupBy", "probe,probeCard,bin");
      qs.set("groupTop", "5");
      const { status, body } = await getJson(
        `${API}/infcontrol-layer-bins/v3/aggregate?${qs.toString()}`
      );
      assert.equal(status, 400);
      assert.ok(body && typeof body === "object");
      assert.equal((body as { code?: string }).code, "VALIDATION_ERROR");
    });

    test("GET /api/v3/infcontrol-layer-bins/v2/top-bad-bins（dummy）", async () => {
      const { status, body } = await getJson(
        `${API}/infcontrol-layer-bins/v2/top-bad-bins?${icExampleQs}&rankTop=10`
      );
      assertOkJson(status, body);
      assert.ok(Array.isArray((body as { bins?: unknown }).bins));
    });

    test("GET /api/v3/infcontrol-layer-bins/aggregate（v1 聚合 · dummy）", async () => {
      const qs = new URLSearchParams(icExampleQs);
      qs.set("groupBy", "device,bin");
      qs.set("groupTop", "5");
      const { status, body } = await getJson(
        `${API}/infcontrol-layer-bins/aggregate?${qs.toString()}`
      );
      assertOkJson(status, body);
      assert.ok(Array.isArray((body as { groups?: unknown }).groups));
    });

    test("GET /api/v3/yield-monitor-triggers（v1 列表 · dummy）", async () => {
      const { status, body } = await getJson(
        `${API}/yield-monitor-triggers?${yExampleQs}`
      );
      assertOkJson(status, body);
      assert.ok(Array.isArray((body as { rows?: unknown }).rows));
    });

    test("GET /api/v3/yield-monitor-triggers/v3（v3 列表 · dummy）", async () => {
      const { status, body } = await getJson(
        `${API}/yield-monitor-triggers/v3?${yExampleQs}&limit=100`
      );
      assertOkJson(status, body);
      const b = body as {
        meta?: { apiVersion?: string };
        rows?: Record<string, unknown>[];
        count?: number;
        filters?: Record<string, unknown>;
      };
      assert.equal(b.meta?.apiVersion, "3");
      assert.equal(b.filters?.typeScope, "delta_diff");
      assert.ok(Array.isArray(b.rows));
      assert.equal(b.count, b.rows!.length);
      assert.ok(b.rows!.length > 0, "delta-diff dummy 应至少返回一行");
      let withDut = 0;
      for (const row of b.rows!) {
        assert.ok("dutNumber" in row);
        assert.equal(
          String(row.TYPE ?? "").trim().toLowerCase(),
          "delta_diff",
          "v3 列表仅应返回 TYPE=delta_diff 行"
        );
        const label = row.TRIGGER_LABEL != null ? String(row.TRIGGER_LABEL) : "";
        assert.equal(
          row.dutNumber,
          parseDutNumberFromTriggerLabel(label),
          "dutNumber 须与 TRIGGER_LABEL 中 on dut# 解析一致"
        );
        if (row.dutNumber != null) withDut++;
        assert.ok("PROBECARDTYPE" in row);
        assert.equal(
          row.PROBECARDTYPE,
          probeCardTypeLeadingSegment(row.PROBECARD ?? row.probecard)
        );
      }
      assert.ok(withDut > 0, "样本中应至少有一行含 on dut# 且 dutNumber 非 null");
    });

    test("GET /api/v3/yield-monitor-triggers/v3 platform=UFLEX filters HOSTNAME", async () => {
      const qs = new URLSearchParams(yExampleQs);
      qs.set("platform", "UFLEX");
      qs.delete("hostname");
      const { status, body } = await getJson(
        `${API}/yield-monitor-triggers/v3?${qs.toString()}&limit=200`
      );
      assertOkJson(status, body);
      const rows = (body as { rows?: { HOSTNAME?: string }[] }).rows ?? [];
      assert.ok(rows.length > 0);
      for (const row of rows) {
        assert.match(String(row.HOSTNAME).toLowerCase(), /uflex/);
      }
      assert.equal(
        (body as { filters?: { platform?: string } }).filters?.platform,
        "UFLEX"
      );
    });

    test("GET /api/v3/yield-monitor-triggers/v3 无 timeStamp* 时 filters 含默认一年 TIME_STAMP", async () => {
      const qs = new URLSearchParams(yExampleQs);
      for (const k of [
        "timeStampBegin",
        "timeStampFrom",
        "timeStampEnd",
        "timeStampTo",
      ]) {
        qs.delete(k);
      }
      const { status, body } = await getJson(
        `${API}/yield-monitor-triggers/v3?${qs.toString()}&limit=50`
      );
      assertOkJson(status, body);
      const f = (body as { filters?: Record<string, unknown> }).filters;
      assert.equal(typeof f?.timeStampBegin, "string");
      assert.equal(typeof f?.timeStampEnd, "string");
      assert.ok(
        new Date(String(f!.timeStampBegin)).getTime() <=
          new Date(String(f!.timeStampEnd)).getTime()
      );
    });

    test("probeCardTypeLeadingSegment（首个 - 前段）", () => {
      assert.equal(probeCardTypeLeadingSegment("9400-01"), "9400");
      assert.equal(probeCardTypeLeadingSegment("  X-Y  "), "X");
      assert.equal(probeCardTypeLeadingSegment("nohyphen"), "nohyphen");
      assert.equal(probeCardTypeLeadingSegment(null), null);
      assert.equal(probeCardTypeLeadingSegment(""), null);
      assert.equal(probeCardTypeLeadingSegment("  "), null);
      assert.equal(probeCardTypeLeadingSegment("-only"), null);
    });

    test("parseDutNumberFromTriggerLabel（TRIGGER_LABEL 片段）", () => {
      assert.equal(
        parseDutNumberFromTriggerLabel(
          "Min Yield(Dut#6): 0.0% on dut# 6 is less than 0.0%"
        ),
        6
      );
      assert.equal(parseDutNumberFromTriggerLabel("on dut# 21 "), 21);
      assert.equal(parseDutNumberFromTriggerLabel("ON DUT#2"), 2);
      assert.equal(parseDutNumberFromTriggerLabel("Bin# 8 Count: 1"), null);
      assert.equal(parseDutNumberFromTriggerLabel(undefined), null);
    });

    test("GET /api/v3/yield-monitor-triggers/v3 带 type 查询参数 → 400", async () => {
      const qs = new URLSearchParams(yExampleQs);
      qs.set("type", "delta_diff");
      const { status, body } = await getJson(
        `${API}/yield-monitor-triggers/v3?${qs.toString()}`
      );
      assert.equal(status, 400);
      assert.ok(body && typeof body === "object");
      assert.equal((body as { code?: string }).code, "VALIDATION_ERROR");
    });

    test("GET /api/v3/yield-monitor-triggers/v3/aggregate（v3 聚合 · dummy）", async () => {
      const qs = new URLSearchParams(yExampleQs);
      qs.set("dimensions", "device,hostname");
      qs.set("groupTop", "10");
      const { status, body } = await getJson(
        `${API}/yield-monitor-triggers/v3/aggregate?${qs.toString()}`
      );
      assertOkJson(status, body);
      const b = body as {
        meta?: { apiVersion?: string };
        groups?: unknown[];
        totalRowsMatching?: number;
        filters?: Record<string, unknown>;
      };
      assert.equal(b.meta?.apiVersion, "3");
      assert.equal(b.filters?.typeScope, "delta_diff");
      assert.ok(typeof b.totalRowsMatching === "number");
      assert.ok(Array.isArray(b.groups));
    });

    test("GET /api/v3/yield-monitor-triggers/v3/combined（列表 + 多聚合 · dummy）", async () => {
      const qs = new URLSearchParams(yExampleQs);
      qs.set("limit", "50");
      qs.set(
        "aggs",
        "timeDay:10|probeCardType:10|device,lotId,probeCardType,probeCard:20"
      );
      const { status, body } = await getJson(
        `${API}/yield-monitor-triggers/v3/combined?${qs.toString()}`
      );
      assertOkJson(status, body);
      const b = body as {
        meta?: { combinedPath?: string };
        count?: number;
        rows?: unknown[];
        aggregates?: Record<
          string,
          { totalRowsMatching?: number; groups?: unknown[] }
        >;
      };
      assert.equal(b.meta?.combinedPath, "yield-monitor-triggers/v3/combined");
      assert.ok(Array.isArray(b.rows));
      assert.ok(typeof b.count === "number");
      assert.ok(b.aggregates?.timeDay);
      assert.ok(typeof b.aggregates?.timeDay?.totalRowsMatching === "number");
      assert.ok(Array.isArray(b.aggregates?.timeDay?.groups));
      assert.ok(b.aggregates?.["device,lotId,probeCardType,probeCard"]);
    });

    test("GET /api/v3/yield-monitor-triggers/v3/aggregate dimensions 含 probeCardType（dummy）", async () => {
      const qs = new URLSearchParams(yExampleQs);
      qs.set("dimensions", "device,probeCardType");
      qs.set("groupTop", "20");
      const { status, body } = await getJson(
        `${API}/yield-monitor-triggers/v3/aggregate?${qs.toString()}`
      );
      assertOkJson(status, body);
      const b = body as { groups?: { parts?: Record<string, string> }[] };
      assert.ok(Array.isArray(b.groups));
      if (b.groups!.length > 0) {
        assert.ok("probeCardType" in (b.groups![0].parts ?? {}));
      }
    });

    test("GET /api/v3/yield-monitor-triggers/v3/aggregate dimensions=bin（dummy，从 TRIGGER_LABEL 解析）", async () => {
      const qs = new URLSearchParams(yExampleQs);
      qs.set("dimensions", "bin");
      qs.set("groupTop", "50");
      const { status, body } = await getJson(
        `${API}/yield-monitor-triggers/v3/aggregate?${qs.toString()}`
      );
      assertOkJson(status, body);
      const b = body as {
        totalRowsMatching?: number;
        groups?: { count: number; parts?: Record<string, string> }[];
      };
      assert.ok(Array.isArray(b.groups));
      assert.ok(b.groups!.length > 0, "delta_diff 样本行应能解析出 bin");
      const sum = b.groups!.reduce((acc, g) => acc + g.count, 0);
      assert.equal(sum, b.totalRowsMatching);
      for (const g of b.groups!) {
        assert.ok("bin" in (g.parts ?? {}));
        assert.notEqual(g.parts!.bin, "");
      }
    });

    test("GET /api/v3/yield-monitor-triggers/v3/aggregate dimensions=dutNumber（dummy）", async () => {
      const qs = new URLSearchParams(yExampleQs);
      qs.set("dimensions", "dutNumber");
      qs.set("groupTop", "50");
      const { status, body } = await getJson(
        `${API}/yield-monitor-triggers/v3/aggregate?${qs.toString()}`
      );
      assertOkJson(status, body);
      const b = body as {
        totalRowsMatching?: number;
        groups?: { count: number; parts?: Record<string, string> }[];
      };
      assert.ok(Array.isArray(b.groups));
      if (b.groups!.length > 0) {
        assert.ok("dutNumber" in (b.groups![0].parts ?? {}));
      }
    });

    test("GET /api/v3/db/ping（Oracle，可选）", async () => {
      if (process.env.PCR_AI_RUN_ORACLE_TESTS !== "1") {
        test.skip("设置 PCR_AI_RUN_ORACLE_TESTS=1 且配置可达 Oracle 时再跑");
        return;
      }
      const { status, body } = await getJson(`${API}/db/ping`);
      assertOkJson(status, body);
      assert.equal((body as { ok?: boolean }).ok, true);
    });

    test("GET /api/v3/table-rows（Oracle，可选）", async () => {
      if (process.env.PCR_AI_RUN_ORACLE_TESTS !== "1") {
        test.skip("设置 PCR_AI_RUN_ORACLE_TESTS=1 且配置 ORACLE_DEFAULT_TABLE 或 ?table= 时再跑");
        return;
      }
      const table = process.env.ORACLE_DEFAULT_TABLE?.trim();
      if (!table) {
        test.skip("未设置 ORACLE_DEFAULT_TABLE");
        return;
      }
      const { status, body } = await getJson(
        `${API}/table-rows?${new URLSearchParams({ table, limit: "5" }).toString()}`
      );
      assertOkJson(status, body);
      assert.ok(Array.isArray((body as { rows?: unknown }).rows));
    });

    test("GET /api/v4/infcontrol-layer-bins/v4/combined testEndFrom/To 收窄结果（dummy）", async () => {
      const qsWide = new URLSearchParams(icExampleQs);
      qsWide.set("limit", "50");
      qsWide.set("aggs", "bin:10");
      const wide = await getJson(
        `/api/v4/infcontrol-layer-bins/v4/combined?${qsWide.toString()}`
      );
      assertOkJson(wide.status, wide.body);
      const wideCount = (wide.body as { count?: number }).count ?? 0;
      assert.ok(wideCount > 0, "wide window should return rows");

      const qsNarrow = new URLSearchParams(qsWide.toString());
      qsNarrow.set("testEndFrom", "2099-01-01T00:00:00.000Z");
      qsNarrow.set("testEndTo", "2099-01-02T00:00:00.000Z");
      const narrow = await getJson(
        `/api/v4/infcontrol-layer-bins/v4/combined?${qsNarrow.toString()}`
      );
      assertOkJson(narrow.status, narrow.body);
      const narrowCount = (narrow.body as { count?: number }).count ?? 0;
      assert.equal(narrowCount, 0, "future-only window should return zero rows");
      const nf = (narrow.body as { filters?: Record<string, unknown> }).filters;
      assert.equal(typeof nf?.testEndFrom, "string");
      assert.equal(typeof nf?.testEndTo, "string");
    });

    test("GET /api/v4/infcontrol-layer-bins/v4（dummy）与 v4 聚合对齐 v3 dummy 聚合", async () => {
      const { status, body } = await getJson(
        `/api/v4/infcontrol-layer-bins/v4?${icExampleQs}&limit=30`
      );
      assertOkJson(status, body);
      assert.equal((body as { meta?: { apiVersion?: string } }).meta?.apiVersion, "4");

      const qs = new URLSearchParams(icExampleQs);
      qs.set("groupBy", "device,bin");
      qs.set("groupTop", "8");
      const [v3r, v4r] = await Promise.all([
        getJson(`${API}/infcontrol-layer-bins/v3/aggregate?${qs.toString()}`),
        getJson(`/api/v4/infcontrol-layer-bins/v4/aggregate?${qs.toString()}`),
      ]);
      assertOkJson(v3r.status, v3r.body);
      assertOkJson(v4r.status, v4r.body);
      assert.equal(
        (v4r.body as { meta?: { apiVersion?: string } }).meta?.apiVersion,
        "4"
      );
      const v3b = v3r.body as {
        totalRowsMatching?: number;
        groups?: unknown[];
      };
      const v4b = v4r.body as {
        totalRowsMatching?: number;
        groups?: unknown[];
      };
      assert.equal(v3b.totalRowsMatching, v4b.totalRowsMatching);
      assert.deepEqual(v3b.groups, v4b.groups);
    });

    test("GET /api/v4/yield-monitor-triggers/v4/aggregate（dummy）与 v3 聚合一致", async () => {
      const qs = new URLSearchParams(yExampleQs);
      qs.set("dimensions", "device,hostname");
      qs.set("groupTop", "15");
      const [v3r, v4r] = await Promise.all([
        getJson(`${API}/yield-monitor-triggers/v3/aggregate?${qs.toString()}`),
        getJson(`/api/v4/yield-monitor-triggers/v4/aggregate?${qs.toString()}`),
      ]);
      assertOkJson(v3r.status, v3r.body);
      assertOkJson(v4r.status, v4r.body);
      const v3b = v3r.body as { totalRowsMatching?: number; groups?: unknown[] };
      const v4b = v4r.body as { totalRowsMatching?: number; groups?: unknown[] };
      assert.equal(v3b.totalRowsMatching, v4b.totalRowsMatching);
      assert.deepEqual(v3b.groups, v4b.groups);
    });

    test("GET /api/v4/yield-monitor-triggers/v4/aggregate dimensions=bin,dutNumber 与 v3 聚合一致", async () => {
      const qs = new URLSearchParams(yExampleQs);
      qs.set("dimensions", "bin,dutNumber");
      qs.set("groupTop", "50");
      const [v3r, v4r] = await Promise.all([
        getJson(`${API}/yield-monitor-triggers/v3/aggregate?${qs.toString()}`),
        getJson(`/api/v4/yield-monitor-triggers/v4/aggregate?${qs.toString()}`),
      ]);
      assertOkJson(v3r.status, v3r.body);
      assertOkJson(v4r.status, v4r.body);
      const v3b = v3r.body as { totalRowsMatching?: number; groups?: unknown[] };
      const v4b = v4r.body as { totalRowsMatching?: number; groups?: unknown[] };
      assert.equal(v3b.totalRowsMatching, v4b.totalRowsMatching);
      assert.deepEqual(v3b.groups, v4b.groups);
    });

    test("未知路径 → 404 NOT_FOUND", async () => {
      const { status, body } = await getJson(`${API}/no-such-route`);
      assert.equal(status, 404);
      assert.ok(body && typeof body === "object");
      assert.equal((body as { code?: string }).code, "NOT_FOUND");
    });
  }
);
