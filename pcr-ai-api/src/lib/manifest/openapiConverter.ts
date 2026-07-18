import { apiManifest } from "./index.js";
import { rebaseApiPath } from "../rebaseApiManifest.js";

interface ManifestQueryParam {
  name: string;
  type: string;
  optional?: boolean;
  note?: string;
}

interface OperationSource {
  purpose: string;
  queryParameters?: ManifestQueryParam[];
  requestBody?: unknown;
  responseShape?: unknown;
  example?: string;
  deprecated?: boolean;
}

interface ManifestEndpointDef extends OperationSource {
  path: string;
  method: string;
}

interface DeprecatedManifestEndpointDef {
  path: string;
  method: string;
  status: string;
  note: string;
}

function typeToSchema(type: string): Record<string, unknown> {
  switch (type) {
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "datetime":
      return { type: "string", format: "date-time" };
    default:
      return { type: "string" };
  }
}

function shapeToSchema(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    if (/array/i.test(value)) {
      return { type: "array", items: {}, description: value };
    }
    return { type: "string", description: value };
  }
  if (Array.isArray(value)) {
    return {
      type: "array",
      items: value.length > 0 ? shapeToSchema(value[0]) : {},
    };
  }
  if (value !== null && typeof value === "object") {
    const properties: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      properties[key] = shapeToSchema(v);
    }
    return { type: "object", properties };
  }
  return {};
}

function convertQueryParam(p: ManifestQueryParam): Record<string, unknown> {
  return {
    name: p.name,
    in: "query",
    required: p.optional !== true,
    ...(p.note ? { description: p.note } : {}),
    schema: typeToSchema(p.type),
  };
}

function buildOperation(
  e: OperationSource,
  deprecated: boolean,
  deprecatedNote: string | undefined
): Record<string, unknown> {
  const responses: Record<string, unknown> = {
    "200": {
      description: "Success",
      ...(e.responseShape !== undefined
        ? {
            content: {
              "application/json": { schema: shapeToSchema(e.responseShape) },
            },
          }
        : {}),
    },
    default: {
      description: "Error",
      content: {
        "application/json": { schema: { $ref: "#/components/schemas/Error" } },
      },
    },
  };

  const descriptionParts: string[] = [];
  if (deprecatedNote) descriptionParts.push(deprecatedNote);
  if (e.example) descriptionParts.push(`Example: ${e.example}`);

  const operation: Record<string, unknown> = {
    summary: e.purpose,
    responses,
  };
  if (descriptionParts.length > 0) {
    operation.description = descriptionParts.join("\n\n");
  }
  if (e.queryParameters && e.queryParameters.length > 0) {
    operation.parameters = e.queryParameters.map(convertQueryParam);
  }
  if (e.requestBody !== undefined) {
    operation.requestBody = {
      required: true,
      content: { "application/json": { schema: shapeToSchema(e.requestBody) } },
    };
  }
  if (deprecated) operation.deprecated = true;
  return operation;
}

function expandPaths(canonicalPath: string): string[] {
  if (canonicalPath.startsWith("/api/v1/")) {
    return ["/api/v1", "/api/v3", "/api/v4"].map((prefix) =>
      rebaseApiPath(canonicalPath, prefix)
    );
  }
  return [canonicalPath];
}

export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  function addOperation(path: string, method: string, operation: Record<string, unknown>) {
    const existing = paths[path] ?? {};
    existing[method.toLowerCase()] = operation;
    paths[path] = existing;
  }

  const endpoints = apiManifest.endpoints as unknown as ManifestEndpointDef[];
  for (const e of endpoints) {
    const operation = buildOperation(e, e.deprecated === true, undefined);
    for (const path of expandPaths(e.path)) {
      addOperation(path, e.method, operation);
    }
  }

  const deprecatedEndpoints =
    apiManifest.deprecatedEndpoints as unknown as DeprecatedManifestEndpointDef[];
  for (const d of deprecatedEndpoints) {
    const operation = buildOperation({ purpose: `[${d.status}] ${d.note}` }, true, d.note);
    for (const path of expandPaths(d.path)) {
      addOperation(path, d.method, operation);
    }
  }

  return {
    openapi: "3.0.3",
    info: {
      title: apiManifest.title,
      version: apiManifest.apiVersion,
      description: apiManifest.description,
    },
    paths,
    components: {
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: { type: "string", description: apiManifest.errorShape.error },
            code: { type: "string", description: apiManifest.errorShape.code },
            detail: { type: "string", description: apiManifest.errorShape.detail },
          },
        },
      },
    },
  };
}
