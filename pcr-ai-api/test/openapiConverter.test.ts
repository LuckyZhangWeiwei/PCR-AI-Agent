import assert from "node:assert/strict";
import test from "node:test";

process.env["YIELD_MONITOR_TRIGGERS_DUMMY"] = "true";
process.env["INFCONTROL_LAYER_BINS_DUMMY"] = "true";

import { buildOpenApiDocument } from "../src/lib/manifest/openapiConverter.js";

test("buildOpenApiDocument returns a well-formed OpenAPI 3.0 document", () => {
  const doc = buildOpenApiDocument() as any;
  assert.ok(doc.openapi.startsWith("3."), `expected openapi 3.x, got ${doc.openapi}`);
  assert.ok(Object.keys(doc.paths).length > 0, "expected non-empty paths");
  assert.ok(doc.components.schemas.Error, "expected components.schemas.Error");
});

test("apiRouter-sourced paths appear under v1, v3, and v4", () => {
  const doc = buildOpenApiDocument() as any;
  assert.ok(doc.paths["/api/v1/infcontrol-layer-bins"], "missing v1 path");
  assert.ok(doc.paths["/api/v3/infcontrol-layer-bins"], "missing v3 path");
  assert.ok(doc.paths["/api/v4/infcontrol-layer-bins"], "missing v4 path");
  assert.ok(doc.paths["/api/v1/infcontrol-layer-bins"].get, "expected GET operation");
});

test("agent and admin paths appear exactly once, at their real v4 prefix", () => {
  const doc = buildOpenApiDocument() as any;
  assert.ok(doc.paths["/api/v4/agent/chat"], "missing /api/v4/agent/chat");
  assert.ok(doc.paths["/api/v4/agent/chat"].post, "expected POST operation");
  assert.equal(doc.paths["/api/v1/agent/chat"], undefined, "must not exist under v1");
  assert.equal(doc.paths["/api/v3/agent/chat"], undefined, "must not exist under v3");

  assert.ok(doc.paths["/api/v4/admin/config"], "missing /api/v4/admin/config");
  assert.ok(doc.paths["/api/v4/admin/config"].get, "expected GET operation");
  assert.ok(doc.paths["/api/v4/admin/config"].patch, "expected PATCH operation");
});

test("/health appears exactly once, unprefixed", () => {
  const doc = buildOpenApiDocument() as any;
  assert.ok(doc.paths["/health"], "missing /health");
  assert.ok(doc.paths["/health"].get);
});

test("deprecated endpoints are marked deprecated:true on every expanded mount", () => {
  const doc = buildOpenApiDocument() as any;
  for (const prefix of ["/api/v1", "/api/v3", "/api/v4"]) {
    const op = doc.paths[`${prefix}/yield-monitor-triggers/aggregate`]?.get;
    assert.ok(op, `expected ${prefix}/yield-monitor-triggers/aggregate to exist`);
    assert.equal(op.deprecated, true);
  }
  assert.equal(doc.paths["/api/v4/admin/agent-enabled"].post.deprecated, true);
});

test("POST /api/v4/agent/chat and PATCH /api/v4/admin/config declare a requestBody", () => {
  const doc = buildOpenApiDocument() as any;
  assert.ok(doc.paths["/api/v4/agent/chat"].post.requestBody);
  assert.ok(doc.paths["/api/v4/admin/config"].patch.requestBody);
  assert.ok(
    doc.paths["/api/v4/agent/chat"].post.requestBody.content["application/json"].schema
  );
});

test("query parameters convert type + required correctly", () => {
  const doc = buildOpenApiDocument() as any;
  const op = doc.paths["/api/v1/inf-analysis/lot-underperforming-duts"].get;
  const lotParam = op.parameters.find((p: any) => p.name === "lot");
  assert.ok(lotParam);
  assert.equal(lotParam.required, true);
  assert.equal(lotParam.schema.type, "string");

  const deviceParam = op.parameters.find((p: any) => p.name === "device");
  assert.equal(deviceParam.required, false);

  const passIdParam = op.parameters.find((p: any) => p.name === "passId");
  assert.equal(passIdParam.schema.type, "number");
});

test("responseShape converts to an object schema with description text preserved", () => {
  const doc = buildOpenApiDocument() as any;
  const schema =
    doc.paths["/api/v1/infcontrol-layer-bins"].get.responses["200"].content[
      "application/json"
    ].schema;
  assert.equal(schema.type, "object");
  assert.ok(schema.properties.rows);
  assert.equal(schema.properties.rows.type, "array");
  assert.match(schema.properties.rows.description, /Oracle columns uppercased/);
});
