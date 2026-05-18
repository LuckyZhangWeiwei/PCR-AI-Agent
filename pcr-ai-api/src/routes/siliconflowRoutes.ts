import { Router } from "express";
import { sendAgentError } from "../lib/agentResponse.js";
import { callSiliconflowChat, getSiliconflowConfig } from "../lib/siliconflowChat.js";

export const siliconflowRouter = Router();

/** 硅基流动 OpenAI 兼容 Chat Completions：仅查询参数 `message`（UTF-8）；密钥见 `siliconflowChat.ts`。 */
siliconflowRouter.get("/siliconflow/chat", async (req, res) => {
  const raw = req.query.message;
  const message =
    typeof raw === "string"
      ? raw.trim()
      : Array.isArray(raw) && typeof raw[0] === "string"
        ? raw[0].trim()
        : "";
  if (!message) {
    return sendAgentError(
      res,
      400,
      "VALIDATION_ERROR",
      "Missing or empty query parameter: message"
    );
  }
  const maxLen = 100_000;
  if (message.length > maxLen) {
    return sendAgentError(
      res,
      400,
      "VALIDATION_ERROR",
      `message exceeds ${maxLen} characters`
    );
  }

  const cfg = getSiliconflowConfig();

  try {
    const out = await callSiliconflowChat(cfg, message);
    if (!out.ok) {
      const detail =
        typeof out.body === "string"
          ? out.body
          : JSON.stringify(out.body).slice(0, 4000);
      const status =
        out.status >= 400 && out.status < 600 ? out.status : 502;
      const isNetwork = out.kind === "network";
      return sendAgentError(
        res,
        status,
        isNetwork ? "SILICONFLOW_FETCH_FAILED" : "SILICONFLOW_ERROR",
        isNetwork
          ? "Failed to reach SiliconFlow"
          : "SiliconFlow API returned an error",
        detail
      );
    }
    const body: Record<string, unknown> = {
      message,
      reply: out.reply,
      model: out.model,
    };
    if (out.reasoningContent != null && out.reasoningContent !== "") {
      body.reasoningContent = out.reasoningContent;
    }
    res.json(body);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return sendAgentError(
      res,
      502,
      "SILICONFLOW_FETCH_FAILED",
      "Failed to reach SiliconFlow",
      detail
    );
  }
});
