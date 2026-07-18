import { Router } from "express";
import { buildOpenApiDocument } from "../lib/manifest/openapiConverter.js";

export const openapiRouter = Router();

/** Full real-path OpenAPI 3.0 document for every route in the app; consumed by GET /api-docs (swagger-ui-dist). */
openapiRouter.get("/openapi.json", (_req, res) => {
  res.json(buildOpenApiDocument());
});
