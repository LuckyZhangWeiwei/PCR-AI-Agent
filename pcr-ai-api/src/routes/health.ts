import { Router } from "express";
import { getAgentEnabled } from "../lib/runtimeConfig.js";

export const healthRouter = Router();

healthRouter.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "pcr-ai-api", agentEnabled: getAgentEnabled() });
});
