import { mkdir, writeFile } from "node:fs/promises";
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

/** Build a Windows-safe timestamp string from a Date (replaces : with -). */
function tsToFilename(d: Date): string {
  return d.toISOString().replace(/:/g, "-").replace(/\./g, "-");
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
  private pendingTool: { name: string; args: Record<string, unknown> } | null = null;
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
        this.pendingTool = { name: event.name, args: event.args };
        break;

      case "tool_result":
        if (this.pendingTool) {
          this.sections.push({
            kind: "tool",
            entry: { name: this.pendingTool.name, args: this.pendingTool.args, result: event.summary },
          });
          this.pendingTool = null;
        }
        break;

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

  private buildMarkdown(): string {
    const endTime = new Date();
    const durationSec = ((endTime.getTime() - this.startTime.getTime()) / 1000).toFixed(1);

    const lines: string[] = [
      `# AI Agent Session Log`,
      ``,
      `| Field | Value |`,
      `|---|---|`,
      `| **Time** | ${this.startTime.toISOString()} |`,
      `| **Session ID** | \`${this.sessionId}\` |`,
      `| **Model** | ${this.model} |`,
      `| **Retry** | ${this.isRetry ? "yes" : "no"} |`,
      ``,
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
      const filename = `${tsToFilename(this.startTime)}.md`;
      const filepath = path.join(dir, filename);
      await writeFile(filepath, this.buildMarkdown(), "utf8");
    } catch (err) {
      console.error("[sessionLogger] Failed to write session log:", err);
    }
  }
}
