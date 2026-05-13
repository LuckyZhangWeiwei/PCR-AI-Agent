import { apiManifest } from "./apiManifest.js";

const API_V1_PREFIX = "/api/v1";

/** Paths kept when serving manifest from **`/api/v3`** (v3 data + Oracle ping + process health). */
const V3_CATALOG_CANONICAL_PATHS = new Set([
  "/api/v1/manifest",
  "/api/v1/infcontrol-layer-bins/v3",
  "/api/v1/infcontrol-layer-bins/v3/aggregate",
  "/api/v1/yield-monitor-triggers/v3",
  "/api/v1/yield-monitor-triggers/v3/aggregate",
  "/api/v1/db/ping",
  "/health",
]);

export function rebaseApiPath(path: string, mountPrefix: string): string {
  const base = mountPrefix.replace(/\/$/, "") || API_V1_PREFIX;
  if (path.startsWith(API_V1_PREFIX)) return base + path.slice(API_V1_PREFIX.length);
  return path;
}

type ManifestEndpoint = (typeof apiManifest.endpoints)[number];

function mapEndpoint(
  e: ManifestEndpoint,
  mountPrefix: string
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ...e,
    path: rebaseApiPath(e.path, mountPrefix),
  };
  if ("example" in e && typeof e.example === "string") {
    out.example = rebaseApiPath(e.example, mountPrefix);
  }
  return out;
}

/**
 * JSON body for **`GET …/manifest`**: paths and examples match the mount
 * (**`/api/v1`** full catalog, **`/api/v3`** v3-only catalog + **`/api/v3`** prefix).
 */
export function buildManifestResponseJson(mountPrefix: string): Record<string, unknown> {
  const mount = mountPrefix && mountPrefix !== "" ? mountPrefix : API_V1_PREFIX;
  const v3Only = mount === "/api/v3";

  const endpoints = v3Only
    ? apiManifest.endpoints.filter((e) => V3_CATALOG_CANONICAL_PATHS.has(e.path))
    : apiManifest.endpoints;

  const deprecated = v3Only
    ? apiManifest.deprecatedEndpoints.filter((d) =>
        d.path.startsWith(API_V1_PREFIX)
      )
    : apiManifest.deprecatedEndpoints;

  const description = v3Only
    ? `${apiManifest.description} This response is from ${mount}: catalog lists v3 list/aggregate endpoints for layer bins and yield triggers, GET ${mount}/db/ping, and GET /health only; every path and example field uses the ${mount} prefix (no /api/v1 in URLs). The same routes are also mounted under /api/v1 for backward compatibility.`
    : `${apiManifest.description} The same router is mounted at /api/v3; GET /api/v3/manifest returns a v3-focused catalog with /api/v3-prefixed paths.`;

  return {
    ...apiManifest,
    description,
    catalogScope: v3Only ? "v3-surfaces-only" : "full",
    endpoints: endpoints.map((e) => mapEndpoint(e, mount)),
    deprecatedEndpoints: deprecated.map((d) => ({
      ...d,
      path: rebaseApiPath(d.path, mount),
    })),
  };
}
