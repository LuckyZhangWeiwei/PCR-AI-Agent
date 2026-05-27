import "./polyfillUtilIsDate.js";
import express, { type ErrorRequestHandler } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendAgentError } from "./lib/agentResponse.js";
import { wideOpenCorsMiddleware } from "./lib/corsConfig.js";
import { requestIdMiddleware } from "./middleware/requestId.js";
import { adminRouter } from "./routes/admin.js";
import { agentRouter } from "./routes/agent.js";
import { apiRouter } from "./routes/api.js";
import { healthRouter } from "./routes/health.js";

function getStatusCode(err: unknown): number {
  if (
    err &&
    typeof err === "object" &&
    "statusCode" in err &&
    typeof (err as { statusCode: unknown }).statusCode === "number"
  ) {
    return (err as { statusCode: number }).statusCode;
  }
  return 500;
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.use(requestIdMiddleware);
  app.use(wideOpenCorsMiddleware);
  app.use(express.json());

  app.use(healthRouter);
  app.use("/api/v1", apiRouter);
  /** Same router as **`/api/v1`**; **`/api/v3/manifest`** returns v3-focused paths (no `/api/v1` in catalog URLs). */
  app.use("/api/v3", apiRouter);
  /** v4：列表与 v3 相同；聚合在 Node 内对全量列表行集计算（见 **`GET /api/v4/manifest`**）。 */
  app.use("/api/v4", apiRouter);
  app.use("/api/v4/agent", agentRouter);
  app.use("/api/v4/admin", adminRouter);

  const publicDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "public"
  );
  /** 本地 v3 联调页：`public/v3-api-tester.html` → `GET /v3-api-tester.html` */
  app.use(express.static(publicDir));

  app.use((req, res) => {
    sendAgentError(res, 404, "NOT_FOUND", "Not Found", req.path);
  });

  const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    console.error(err);
    const status = getStatusCode(err);
    const msg =
      status === 500 ? "Internal Server Error" : getErrorMessage(err);
    if (status === 500) {
      sendAgentError(res, status, "INTERNAL_ERROR", msg);
    } else {
      sendAgentError(res, status, "REQUEST_ERROR", msg, req.path);
    }
  };
  app.use(errorHandler);

  return app;
}
