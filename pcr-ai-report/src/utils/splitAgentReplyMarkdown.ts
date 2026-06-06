/**
 * Split deterministic JB replies: server data tables vs LLM prose (解读/建议).
 * Keeps data tables in a horizontally scrollable block so conclusion text does not stretch table width.
 */

const COMMENTARY_START =
  /(?:^|\n)(?:##\s*分析结论|###\s*数据解读)\s*(?:\n|$)/m;

const SUMMARY_FIRST_CELL =
  /^(总结|汇总|解读|结论|备注|说明|概况|分析|数据解读|专业建议)$/i;

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

/** True when a pipe row is a wafer yield data row (Slot = waferId number). */
function isDataSlotTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return false;
  const m = /^\|\s*([^|]+?)\s*\|/.exec(trimmed);
  if (!m) return false;
  const first = m[1]!.trim();
  if (SUMMARY_FIRST_CELL.test(first)) return false;
  if (/^\d+$/.test(first)) return true;
  return first === "—" || first === "-" || first === "–";
}

/**
 * Pull trailing "summary" table rows (| 总结 | … |) out of the data section.
 */
export function detachSummaryLikeTableRows(md: string): {
  body: string;
  detachedProse: string;
} {
  const lines = md.split("\n");
  const detached: string[] = [];

  while (lines.length > 0) {
    const last = lines[lines.length - 1] ?? "";
    if (!last.trim().startsWith("|")) break;
    if (isDataSlotTableRow(last)) break;
    const cells = last
      .split("|")
      .map((c) => c.trim())
      .filter((_, i, parts) => i > 0 && i < parts.length - 1);
    const firstCell = cells[0] ?? "";
    // Only strip rows whose first cell is a summary keyword; stop at data/header/separator rows
    if (!SUMMARY_FIRST_CELL.test(firstCell)) break;
    if (cells.length) detached.unshift(cells.join(" "));
    lines.pop();
  }

  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") {
    lines.pop();
  }

  return {
    body: lines.join("\n"),
    detachedProse: detached.join("\n\n").trim(),
  };
}

/**
 * Move non-table prose after the last pipe-table block into commentary tail.
 */
export function detachProseAfterMarkdownTables(md: string): {
  body: string;
  tailProse: string;
} {
  const lines = md.split("\n");
  let tableEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\|/.test(lines[i]!)) tableEnd = i;
  }
  if (tableEnd < 0) return { body: md, tailProse: "" };

  let end = tableEnd;
  while (end + 1 < lines.length && /^\s*\|/.test(lines[end + 1]!)) end++;

  const tailLines = lines.slice(end + 1);
  const tail = tailLines.join("\n").trim();
  if (!tail) return { body: md, tailProse: "" };
  if (tailLines.some((l) => /^\s*\|/.test(l))) return { body: md, tailProse: "" };

  return {
    body: lines.slice(0, end + 1).join("\n").trimEnd(),
    tailProse: tail,
  };
}

function mergeCommentaryParts(...parts: string[]): string {
  return stripPipeTablesFromMarkdown(
    parts.filter((p) => p.trim()).join("\n\n")
  );
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
  if (m?.index != null) {
    let commentary = trimmed.slice(m.index).trim();
    commentary = commentary.replace(/^##\s*分析结论\s*\n+/i, "");
    if (m.index === 0) {
      // Commentary heading at start — no data tables precede it
      return { dataMarkdown: "", commentaryMarkdown: mergeCommentaryParts(commentary) };
    }
    let dataPart = trimmed.slice(0, m.index).trim();
    const fromRows = detachSummaryLikeTableRows(dataPart);
    dataPart = fromRows.body;
    return {
      dataMarkdown: dataPart,
      commentaryMarkdown: mergeCommentaryParts(fromRows.detachedProse, commentary),
    };
  }

  const fromRows = detachSummaryLikeTableRows(trimmed);
  let dataPart = fromRows.body;
  const { body, tailProse } = detachProseAfterMarkdownTables(dataPart);
  dataPart = body;

  const commentary = mergeCommentaryParts(fromRows.detachedProse, tailProse);
  if (commentary) {
    return { dataMarkdown: dataPart, commentaryMarkdown: commentary };
  }

  return { dataMarkdown: dataPart, commentaryMarkdown: "" };
}
