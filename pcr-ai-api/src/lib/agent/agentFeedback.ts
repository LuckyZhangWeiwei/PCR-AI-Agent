import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

export interface FeedbackRecord {
  id: string;
  kind: "good" | "bad";
  question: string;
  answer: string;
  category?: string;
  comment?: string;
  timestamp: string;
  sessionId: string;
}

// Using a function (not a constant) so PCR_FEEDBACK_DIR can be set in tests
// before the first call without worrying about module-load-time evaluation.
function defaultFeedbackFile(): string {
  const dir = process.env["PCR_FEEDBACK_DIR"] ?? join(process.cwd(), "data");
  return join(dir, "feedback.json");
}

async function readAll(filePath: string): Promise<FeedbackRecord[]> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as FeedbackRecord[];
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    console.error("[feedback] readAll: could not parse feedback file:", err);
    throw err;
  }
}

/**
 * Appends a feedback record to the JSON file at filePath.
 * Not safe for concurrent writes — adequate for low-frequency user feedback.
 */
export async function saveFeedback(
  record: FeedbackRecord,
  filePath = defaultFeedbackFile()
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const existing = await readAll(filePath);
  existing.push(record);
  await writeFile(filePath, JSON.stringify(existing, null, 2), "utf-8");
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[\s，。？！、：；,.?!:;\-_/\\()\[\]{}]+/)
      .filter((t) => t.length >= 2)
  );
}

// Uses max(|A|,|B|) as denominator (not union) so short queries match longer stored questions.
function jaccard(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const maxSize = Math.max(a.size, b.size);
  return maxSize === 0 ? 0 : intersection / maxSize;
}

export async function buildFeedbackInjection(
  question: string,
  filePath = defaultFeedbackFile()
): Promise<string> {
  const all = await readAll(filePath);
  if (all.length === 0) return "";

  const qTokens = tokenize(question);
  const rank = (kind: "good" | "bad") =>
    all
      .filter((r) => r.kind === kind)
      .map((r) => ({ r, score: jaccard(qTokens, tokenize(r.question)) }))
      .filter(({ score }) => score >= 0.15)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .map(({ r }) => r);

  const good = rank("good");
  const bad = rank("bad");
  if (good.length === 0 && bad.length === 0) return "";

  const parts: string[] = ["\n\n【历史反馈参考】"];

  if (good.length > 0) {
    parts.push("以下是用户对类似问题满意的回答示例，请参考其风格和深度：");
    for (const r of good) {
      parts.push(`Q: ${r.question}\nA: ${r.answer.slice(0, 500)}`);
    }
  }
  if (bad.length > 0) {
    parts.push("以下类型的回答曾被标记为不好，请注意避免：");
    for (const r of bad) {
      const comment = r.comment ? `，反馈：${r.comment}` : "";
      parts.push(
        `- [${r.category ?? "其他"}] 曾问：${r.question.slice(0, 60)}${comment}`
      );
    }
  }

  return parts.join("\n");
}
