/**
 * Prepare LLM markdown for display in AiAgentReport (remark-gfm).
 * Models often wrap asides in ~~…~~; GFM renders that as strikethrough.
 */
export function sanitizeAgentMarkdownForDisplay(md: string): string {
  return md.replace(/~~([\s\S]*?)~~/g, "$1");
}
