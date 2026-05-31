import { Router } from "express";
import { AGENT_JB_CACHE_VERSION } from "../lib/agent/agentJbSessionCache.js";
import { getAgentEnabled } from "../lib/runtimeConfig.js";

export const healthRouter = Router();

healthRouter.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "pcr-ai-api",
    agentEnabled: getAgentEnabled(),
    agentJbDeterministicSummary: true,
    agentJbCacheVersion: AGENT_JB_CACHE_VERSION,
  });
});
