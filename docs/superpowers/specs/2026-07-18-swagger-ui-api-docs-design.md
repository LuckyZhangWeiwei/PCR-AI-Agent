# Swagger UI for all RESTful APIs — Design

**Date:** 2026-07-18
**Status:** Approved, ready for implementation plan
**Package:** `pcr-ai-api` only (no `pcr-ai-report` changes)

## Problem

`pcr-ai-api` exposes many REST endpoints (`infcontrol-layer-bins`, `yield-monitor-triggers`, `inf-analysis/*`, `agent/*`, `admin/*`, `siliconflow/chat`, misc). There is already a machine-readable catalog (`GET .../manifest`, built from `pcr-ai-api/src/lib/manifest/index.ts`) and a simple card-list UI (`OverviewReport.tsx`), but neither offers interactive, standards-based API documentation (params table, response shape, "try it out" execution). The user wants a Swagger-UI-style browsing/testing page covering *every real route*, including newer ones not yet registered in the manifest (`agent/chat`, `agent/feedback`, `admin/config`, `admin/agent-enabled`, `inf-analysis/*`, `siliconflow/chat`).

## Decisions (from brainstorming)

1. **Coverage**: all real routes, including the ones currently missing from the manifest. The manifest must be extended first.
2. **Format**: a genuine OpenAPI 3.0 document generated from the (extended) manifest, rendered with `swagger-ui-dist` — not a hand-rolled swagger-styled React component.
3. **Location**: backend-only static page served by `pcr-ai-api` at `GET /api-docs`, pointing at `GET /openapi.json`. No `pcr-ai-report` changes, no new frontend bundle weight.
4. **Try it out**: enabled for every operation, including the 5 non-GET endpoints (`POST /api/v4/agent/chat`, `POST /api/v4/agent/feedback`, `POST /api/v1|v3|v4/inf-analysis/site-bin-bylot/layers`, `GET+PATCH /api/v4/admin/config`, `POST /api/v4/admin/agent-enabled`). This is an internal ops tool with no auth boundary today; documenting accurately (including that `admin/config` round-trips `agentApiKey` in plaintext, per `pcr-ai-api/CLAUDE.md` §11-22) does not change that existing security posture.
5. **Deprecated endpoints**: shown, marked `deprecated: true` (both the pre-existing `deprecatedManifestEndpoints` list and the newly-documented `POST /admin/agent-enabled`, which the code already comments as "Backward compat").
6. **Document structure**: a single OpenAPI document with real, absolute paths — not three separate per-mount specs mirroring the existing v1/v3/v4 manifest-catalog split. Investigation confirmed `apiRouter` (infcontrol/yield-monitor/misc/inf-analysis/siliconflow) is mounted identically at `/api/v1`, `/api/v3`, and `/api/v4` (`app.ts`), so its canonical manifest entries expand into three real path entries per prefix. `agentRouter` and `adminRouter` are mounted *only* at `/api/v4/agent` and `/api/v4/admin` — they appear once, at their real path. `/health` appears once, unprefixed.

## Architecture

### 1. Manifest extension

New files under `pcr-ai-api/src/lib/manifest/`:

- `agentManifestEndpoints.ts` — `POST /api/v4/agent/chat`, `POST /api/v4/agent/feedback`.
- `adminManifestEndpoints.ts` — `GET /api/v4/admin/config`, `PATCH /api/v4/admin/config`, `POST /api/v4/admin/agent-enabled` (marked deprecated inline, same shape as `deprecatedManifestEndpoints` entries).
- `infAnalysisManifestEndpoints.ts` — `GET /api/v1/inf-analysis/lot-underperforming-duts`, `GET /api/v1/inf-analysis/site-bin-bylot`, `POST /api/v1/inf-analysis/site-bin-bylot/layers`.

`siliconflow/chat` is added as one more entry in the existing `miscManifestEndpoints.ts` (`GET /api/v1/siliconflow/chat`).

Each entry follows the existing shape (`path`, `method`, `purpose`, optional `queryParameters`/`requestBody` description, optional `responseShape`, optional `example`). For `POST`/`PATCH` endpoints, add a `requestBody` field (new, small addition to the shared entry shape) describing the JSON body loosely the same way `responseShape` already describes response bodies.

`manifest/index.ts` aggregates the three new arrays into `apiManifest.endpoints`, same as today.

This extension is additive only — it does not change `rebaseApiManifest.ts`'s existing `V3_CATALOG_CANONICAL_PATHS` / `V4_CATALOG_CANONICAL_PATHS` allowlists, so the existing agent-facing `GET .../manifest` tool-discovery catalogs keep their current, deliberately narrow scope. The new endpoints become visible in Swagger UI without widening what AI agents discover via `.../manifest`.

### 2. OpenAPI converter

New file `pcr-ai-api/src/lib/manifest/openapiConverter.ts`, exporting `buildOpenApiDocument(): OpenApiDocument`:

- Iterates `apiManifest.endpoints`. For entries whose canonical path starts with `/api/v1` **and** is served by `apiRouter` (i.e. not agent/admin), emits three path entries via the existing `rebaseApiPath()` helper: `/api/v1/...`, `/api/v3/...`, `/api/v4/...`.
- For agent/admin entries (canonical path already `/api/v4/agent/...` or `/api/v4/admin/...`), emits exactly one path entry, unchanged.
- For `/health`, emits exactly one path entry.
- Iterates `apiManifest.deprecatedEndpoints`, emitting them the same way but with `deprecated: true` and description built from their `note`/`status` fields.
- Query parameter conversion: `type: "string"|"number"|"datetime"|"boolean"` → OpenAPI schema (`datetime` → `{ type: "string", format: "date-time" }`); `note` → `description`; `optional: false` (or absent) → `required: true`.
- Request body conversion (new `requestBody` field on manifest entries): becomes `requestBody.content["application/json"].schema`, built with the same best-effort object/array/string inference as response shapes (see below).
- Response shape conversion: best-effort, not full JSON Schema fidelity. Recursively walks `responseShape`:
  - string value starting with `"array"` → `{ type: "array", items: { type: "object" }, description: <value> }`
  - other string value → `{ type: "string", description: <value> }` (the field is documented via description text, not decomposed into a precise type — the manifest's free-text shapes like `"number (fixed 200)"` aren't structured enough to do better without a larger rewrite of the manifest data model, which is out of scope)
  - nested plain-object value → `{ type: "object", properties: { ...recursed } }`
  - top-level wraps in `{ type: "object", properties: {...} }`
- `errorShape` (existing, shared) becomes `components.schemas.Error`; every operation gets a generic `default` response referencing it in addition to a `200`/`204` (or `200` with the converted `responseShape` when present).
- `example` (existing per-entry example URL string) becomes the query example on the first matching query parameter, or an `examples` block at the operation level when it's a full URL.
- Streaming caveat: `POST /api/v4/agent/chat`'s manifest `purpose` text explicitly notes the response is SSE and that Swagger UI's "try it out" will show the buffered raw body, not a live event stream.

### 3. New route: `GET /openapi.json`

Thin handler (e.g. `pcr-ai-api/src/routes/openapiRoutes.ts`) calling `buildOpenApiDocument()` and returning it as JSON. Mounted in `app.ts` at the app root (`app.use(openapiRouter)`), alongside `healthRouter`, since it describes the whole app rather than one version mount.

### 4. Static docs page: `GET /api-docs`

- Add `swagger-ui-dist` to `pcr-ai-api/dependencies` (static assets only, no server code — safe to keep pinned loosely since it doesn't touch the Oracle driver constraints in §8 of `pcr-ai-api/CLAUDE.md`).
- `app.ts` serves `node_modules/swagger-ui-dist` (CSS/JS bundles) under `/api-docs/vendor` via `express.static`.
- A small hand-written `pcr-ai-api/public/api-docs/index.html` loads those bundles and initializes `SwaggerUIBundle({ url: "/openapi.json", tryItOutEnabled: true, ... })`. Served via `express.static(publicDir)` (already mounted in `app.ts`), reachable at `GET /api-docs/index.html`; add an explicit `GET /api-docs` redirect/alias to that file for a clean URL.
- No CORS work needed — `wideOpenCorsMiddleware` already applies to the whole app, and the docs page calls same-origin `/openapi.json` and same-origin API paths when executing "try it out".

## Testing

- New `pcr-ai-api/test/openapiManifest.test.ts`:
  - `buildOpenApiDocument()` returns an object with `openapi` starting `"3."`, non-empty `paths`, and `components.schemas.Error` defined.
  - Every apiRouter-sourced canonical path appears three times (once per `/api/v1`, `/api/v3`, `/api/v4` prefix); every agent/admin path appears exactly once at its real prefix; `/health` appears exactly once.
  - Every deprecated endpoint's path entries have `deprecated: true` on all their operations.
  - At least one `POST` operation (`/api/v4/agent/chat`) and one `PATCH` operation (`/api/v4/admin/config`) are present with a `requestBody`.
- `npm run typecheck` and `npm test` must pass.
- No changes to any existing WHERE/filter/aggregation/response-shape logic, so the dummy-parity rule (`pcr-ai-api/.cursor/rules/dummy-parity.mdc`) does not apply to this work.

## Out of scope

- No changes to `pcr-ai-report` (per decision #3).
- No auth/masking changes to `admin/config` (documenting existing behavior, not changing it).
- No attempt to make manifest `responseShape` fully JSON-Schema-precise (best-effort conversion only, per decision in §2).
- No CI/build-time regeneration step — `/openapi.json` is computed live on each request from the manifest, consistent with how `.../manifest` already works today.
