/**
 * 在 **NODE_ENV=test** 下 **`listApisForceOracleNoDummy()`** 为 false，可配合
 * **`INFCONTROL_LAYER_BINS_DUMMY`** / **`YIELD_MONITOR_TRIGGERS_DUMMY`** 走 **Excel** 内存数据。
 *
 * 覆盖 **`/api/v3`** 挂载的**全部** GET 业务路由；**`/health`** 单独挂在 app 根。
 * **`/api/v3/db/ping`** 与 **`/api/v3/table-rows`** 需真实 Oracle：仅当环境变量
 * **`PCR_AI_RUN_ORACLE_TESTS=1`** 时执行（否则 **skip**）。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

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
      }
      assert.ok(withDut > 0, "样本中应至少有一行含 on dut# 且 dutNumber 非 null");
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

    test("未知路径 → 404 NOT_FOUND", async () => {
      const { status, body } = await getJson(`${API}/no-such-route`);
      assert.equal(status, 404);
      assert.ok(body && typeof body === "object");
      assert.equal((body as { code?: string }).code, "NOT_FOUND");
    });
  }
);
