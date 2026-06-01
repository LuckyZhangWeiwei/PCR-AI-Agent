/**
 * Split deterministic JB replies: server data tables vs LLM prose (解读/建议).
 * Keeps data tables in a horizontally scrollable block so conclusion text does not stretch table width.
 */

const COMMENTARY_START =
  /(?:^|\n)(?:##\s*分析结论|###\s*数据解读)\s*(?:\n|$)/m;

/** Remove GFM pipe tables from commentary (model must not restate data as tables). */
export function stripPipeTablesFromMarkdown(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let skippingTable = false;
  for (const line of lines) {
    const isTableRow = /^\s*\|/.test(line);
    const isSepRow = /^\s*\|[\s:|-]+\|\s*$/.test(line);
    if (isTableRow || isSepRow) {
      skippingTable = true;
      continue;
    }
    if (skippingTable && line.trim() === "") {
      skippingTable = false;
      continue;
    }
    skippingTable = false;
    out.push(line);
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function splitAgentReplyMarkdown(text: string): {
  dataMarkdown: string;
  commentaryMarkdown: string;
} {
  const trimmed = text.trim();
  if (!trimmed) {
    return { dataMarkdown: "", commentaryMarkdown: "" };
  }

  const m = COMMENTARY_START.exec(trimmed);
  if (m?.index != null && m.index > 0) {
    let commentary = trimmed.slice(m.index).trim();
    commentary = commentary.replace(/^##\s*分析结论\s*\n+/i, "");
    return {
      dataMarkdown: trimmed.slice(0, m.index).trim(),
      commentaryMarkdown: stripPipeTablesFromMarkdown(commentary),
    };
  }

  return { dataMarkdown: trimmed, commentaryMarkdown: "" };
}
