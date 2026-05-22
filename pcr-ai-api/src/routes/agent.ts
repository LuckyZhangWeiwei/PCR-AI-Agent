// pcr-ai-api/src/routes/agent.ts
import { Router } from "express";
import { resolveAgentConfig, type AgentConfig } from "../lib/agent/agentConfig.js";
import { runAgentLoop, type AgentSseEvent } from "../lib/agent/agentLoop.js";

export const agentRouter = Router();

agentRouter.post("/chat", async (req, res) => {
  const body = req.body as {
    message?: unknown;
    sessionId?: unknown;
    agentConfig?: Partial<AgentConfig>;
    retry?: unknown;
  };

  const retry = body.retry === true;
  const message =
    typeof body.message === "string" ? body.message.trim() : "";
  const sessionId =
    typeof body.sessionId === "string" ? body.sessionId.trim() : "";

  if (!retry && !message) {
    return res
      .status(400)
      .json({ error: "VALIDATION_ERROR", message: "message is required" });
  }
  if (retry && !sessionId) {
    return res
      .status(400)
      .json({ error: "VALIDATION_ERROR", message: "sessionId is required" });
  }
  if (!sessionId) {
    return res
      .status(400)
      .json({ error: "VALIDATION_ERROR", message: "sessionId is required" });
  }

  const config = resolveAgentConfig(body.agentConfig);
  if (!config.apiKey) {
    return res.status(400).json({
      error: "CONFIG_ERROR",
      message:
        "API Key 未配置，请在 Settings 中设置 AI Agent API Key，或在服务器环境变量中配置 AGENT_API_KEY",
    });
  }

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering
  res.flushHeaders();

  const writeEvent = (event: AgentSseEvent) => {
    if (closed) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    const resWithFlush = res as typeof res & { flush?: () => void };
    if (typeof resWithFlush.flush === "function") resWithFlush.flush();
  };

  let closed = false;
  res.on("close", () => {
    closed = true;
  });

  writeEvent({
    type: "status",
    message: retry ? "正在从上次进度继续…" : "已连接，正在分析…",
  });

  const heartbeatMs = 15_000;
  const heartbeat = setInterval(() => {
    if (!closed) {
      writeEvent({ type: "status", message: "仍在处理中（查询或模型推理可能较慢）…" });
    }
  }, heartbeatMs);

  try {
    await runAgentLoop(message, sessionId, config, (event) => {
      writeEvent(event);
    }, { resume: retry });
  } catch (err) {
    if (!closed) {
      writeEvent({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    clearInterval(heartbeat);
    if (!closed) res.end();
  }
});
