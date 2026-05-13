import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import { sendAgentError } from "./lib/agentResponse.js";
import { requestIdMiddleware } from "./middleware/requestId.js";
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
  app.use(cors());
  app.use(express.json());

  app.use(healthRouter);
  app.use("/api/v1", apiRouter);

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
