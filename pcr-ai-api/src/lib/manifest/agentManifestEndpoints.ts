export const agentManifestEndpoints = [
  {
    path: "/api/v4/agent/chat",
    method: "POST",
    purpose:
      "AI Agent ReAct chat loop over the Yield Monitor and JB STAR domains (see src/lib/agent/core/agentLoop.ts). Response is Server-Sent Events (Content-Type: text/event-stream): a sequence of `data: {...}\\n\\n` frames, each a JSON object with a `type` field (status | text | tool_call | tool_result | error | done). Swagger UI 'Try it out' shows the buffered raw SSE body, not a live incremental stream — for real-time viewing use the pcr-ai-report chat UI or `curl -N`.",
    requestBody: {
      message: "string; required unless retry=true",
      sessionId:
        "string, required — client-generated id used to resume/continue a session",
      retry:
        "optional boolean; true resumes the last session without appending a new user message (sessionId must already exist)",
      agentConfig:
        "optional partial AgentConfig override: { apiKey?, apiBase?, model?, subAgentModel?, maxRounds?, streamTimeoutSec?, toolResultMaxChars?, ... } — see resolveAgentConfig() in src/lib/agent/agentConfig.ts",
    },
    responseShape: {
      contentType: "text/event-stream",
      frames:
        "newline-delimited `data: <json>\\n\\n`; each JSON object has a `type` field: status (progress message), text (assistant token chunk), tool_call, tool_result, error, done",
    },
  },
  {
    path: "/api/v4/agent/feedback",
    method: "POST",
    purpose: "Persist a thumbs-up/down feedback record for one agent answer.",
    requestBody: {
      sessionId: "string, required, max 64 chars",
      question: "string, required, max 500 chars",
      answer: "string, required, max 1500 chars",
      kind: "'good' | 'bad', required",
      category:
        "string, required when kind='bad'; one of 回答不准确 | 数据有误 | 回答不完整 | 其他",
      comment: "optional string, max 1000 chars",
    },
    responseShape: {
      ok: "boolean true on success",
    },
  },
];
