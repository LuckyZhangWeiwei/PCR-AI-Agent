import { Router } from "express";
import { getAgentEnabled, setAgentEnabled } from "../lib/runtimeConfig.js";

export const adminRouter = Router();

adminRouter.post("/agent-enabled", (req, res) => {
  const { agentEnabled } = req.body as { agentEnabled?: unknown };
  if (typeof agentEnabled !== "boolean") {
    res.status(400).json({ error: "agentEnabled must be a boolean" });
    return;
  }
  setAgentEnabled(agentEnabled);
  res.json({ ok: true, agentEnabled: getAgentEnabled() });
});
