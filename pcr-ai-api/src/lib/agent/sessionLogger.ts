import { mkdir, writeFile, appendFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSseEvent } from "./agentLoop.js";

function resolveLogDir(): string {
  const env = process.env["SESSION_LOG_DIR"];
  if (env) return env;
  // At runtime the file is dist/lib/agent/sessionLogger.js → 3 levels up = pcr-ai-api root
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../session-logs");
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

interface ToolEntry {
  name: string;
  args: Record<string, unknown>;
  result: string;
}

type Section =
  | { kind: "ai_text"; text: string }
  | { kind: "tool"; entry: ToolEntry };

export class SessionLogger {
  private readonly sessionId: string;
  private readonly startTime: Date;
  private readonly userMessage: string;
  private readonly model: string;
  private readonly isRetry: boolean;

  private sections: Section[] = [];
  private textBuffer = "";
  /** Queue of started-but-not-yet-completed tool calls. Parallel tool
   * execution (different resource groups) can emit tool_start events for
   * multiple tools before any tool_result fires, so a single-slot `pendingTool`
   * would drop or mis-pair results. The queue matches each tool_result to the
   * first queued entry with the same tool name. */
  private pendingToolQueue: { name: string; args: Record<string, unknown> }[] = [];
  private finalStatus = "done";

  constructor(opts: {
    sessionId: string;
    userMessage: string;
    model: string;
    isRetry: boolean;
  }) {
    this.sessionId = opts.sessionId;
    this.userMessage = opts.userMessage;
    this.model = opts.model;
    this.isRetry = opts.isRetry;
    this.startTime = new Date();
  }

  /** Feed every SSE event through this method. */
  feed(event: AgentSseEvent): void {
    switch (event.type) {
      case "text":
        this.textBuffer += event.delta;
        break;

      case "tool_start":
        if (this.textBuffer.trim()) {
          this.sections.push({ kind: "ai_text", text: this.textBuffer });
          this.textBuffer = "";
        }
        this.pendingToolQueue.push({ name: event.name, args: event.args });
        break;

      case "tool_result": {
        // Match by tool name so parallel tool calls (different resource groups)
        // pair correctly even when start/result events interleave.
        const idx = this.pendingToolQueue.findIndex((p) => p.name === event.name);
        if (idx !== -1) {
          const pending = this.pendingToolQueue.splice(idx, 1)[0]!;
          this.sections.push({
            kind: "tool",
            entry: { name: pending.name, args: pending.args, result: event.summary },
          });
        }
        break;
      }

      case "done":
        this.finalStatus = "done";
        void this.flush();
        break;

      case "error":
        this.finalStatus = `error: ${event.message}`;
        void this.flush();
        break;

      default:
        break;
    }
  }

  /** Session-level header — written only when the file is first created. */
  private buildSessionHeader(): string {
    return [
      `# AI Agent Session Log`,
      ``,
      `| Field | Value |`,
      `|---|---|`,
      `| **Session ID** | \`${this.sessionId}\` |`,
      `| **Model** | ${this.model} |`,
      `| **Started** | ${this.startTime.toISOString()} |`,
      ``,
    ].join("\n");
  }

  /** Content for this single turn (user + tools + AI response). */
  private buildTurnContent(): string {
    const endTime = new Date();
    const durationSec = ((endTime.getTime() - this.startTime.getTime()) / 1000).toFixed(1);

    const lines: string[] = [
      `## User`,
      ``,
      this.userMessage,
      ``,
      `---`,
      ``,
    ];

    // Flush any remaining text buffer
    const remainingText = this.textBuffer.trim();
    if (remainingText) {
      this.sections.push({ kind: "ai_text", text: remainingText });
      this.textBuffer = "";
    }

    let toolCount = 0;
    for (const sec of this.sections) {
      if (sec.kind === "ai_text") {
        lines.push(`## AI Response`);
        lines.push(``);
        lines.push(sec.text.trim());
        lines.push(``);
        lines.push(`---`);
        lines.push(``);
      } else {
        toolCount++;
        lines.push(`## Tool Call ${toolCount}: \`${sec.entry.name}\``);
        lines.push(``);
        lines.push(`**Input:**`);
        lines.push(``);
        lines.push("```json");
        lines.push(JSON.stringify(sec.entry.args, null, 2));
        lines.push("```");
        lines.push(``);
        lines.push(`**Output:**`);
        lines.push(``);
        lines.push(sec.entry.result);
        lines.push(``);
        lines.push(`---`);
        lines.push(``);
      }
    }

    lines.push(`*Status: ${this.finalStatus} | Duration: ${durationSec}s | Ended: ${endTime.toISOString()}*`);
    return lines.join("\n");
  }

  private async flush(): Promise<void> {
    try {
      const dir = resolveLogDir();
      await mkdir(dir, { recursive: true });
      const filepath = path.join(dir, `${this.sessionId}.md`);

      const turnContent = this.buildTurnContent();
      const isFirst = !(await fileExists(filepath));

      if (isFirst) {
        await writeFile(filepath, this.buildSessionHeader() + "\n" + turnContent, "utf8");
      } else {
        const retryTag = this.isRetry ? " *(retry)*" : "";
        const separator = `\n\n---\n\n**${this.startTime.toISOString()}**${retryTag}\n\n`;
        await appendFile(filepath, separator + turnContent, "utf8");
      }
    } catch (err) {
      console.error("[sessionLogger] Failed to write session log:", err);
    }
  }
}
