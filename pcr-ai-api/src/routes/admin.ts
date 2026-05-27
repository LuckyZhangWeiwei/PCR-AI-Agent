import { Router } from "express";
import { getConfig, patchConfig, type RuntimeConfig } from "../lib/runtimeConfig.js";

export const adminRouter = Router();

adminRouter.get("/config", (_req, res) => {
  res.json(getConfig());
});

adminRouter.patch("/config", (req, res) => {
  const patch = req.body as Partial<RuntimeConfig>;
  const updated = patchConfig(patch);
  res.json(updated);
});

// Backward compat
adminRouter.post("/agent-enabled", (req, res) => {
  const { agentEnabled } = req.body as { agentEnabled?: unknown };
  if (typeof agentEnabled !== "boolean") {
    res.status(400).json({ error: "agentEnabled must be a boolean" });
    return;
  }
  const updated = patchConfig({ agentEnabled });
  res.json({ ok: true, agentEnabled: updated.agentEnabled });
});
