import { Router } from "express";

export const healthRouter = Router();

healthRouter.get("/health", (_req, res) => {
  const agentEnabled = process.env.AGENT_ENABLED?.trim().toLowerCase() !== "false";
  res.json({ status: "ok", service: "pcr-ai-api", agentEnabled });
});
