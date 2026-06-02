import fs from "node:fs";

// ── InfBlock ───────────────────────────────────────────────────────────────

type InfEntry =
  | { type: "kv"; key: string; value: string }
  | { type: "block"; block: InfBlock };

export class InfBlock {
  readonly name: string;
  private readonly _data: InfEntry[] = [];

  constructor(name: string) {
    this.name = name;
  }

  addBlock(block: InfBlock): void {
    this._data.push({ type: "block", block });
  }

  addKey(key: string, value: string): void {
    this._data.push({ type: "kv", key, value });
  }

  /** First direct child block matching name. */
  block(name: string): InfBlock | undefined {
    for (const e of this._data) {
      if (e.type === "block" && e.block.name === name) return e.block;
    }
    return undefined;
  }

  /** All direct child blocks; pass "" to get every block. */
  blocks(name = ""): InfBlock[] {
    return this._data
      .filter((e): e is { type: "block"; block: InfBlock } => e.type === "block")
      .filter((e) => name === "" || e.block.name === name)
      .map((e) => e.block);
  }

  /** First value for a key. */
  key(name: string): string | undefined {
    for (const e of this._data) {
      if (e.type === "kv" && e.key === name) return e.value;
    }
    return undefined;
  }

  /** All values for a key (RowData / ListData multi-line). */
  keys(name: string): string[] {
    return this._data
      .filter(
        (e): e is { type: "kv"; key: string; value: string } =>
          e.type === "kv" && e.key === name
      )
      .map((e) => e.value);
  }
}

// ── Parser internals ───────────────────────────────────────────────────────

function isInlineBlockOpen(line: string): string | null {
  if (!line.endsWith("{") || line.includes(":")) return null;
  const name = line.slice(0, -1).trim();
  if (name.length === 0 || name.includes("{") || name.includes("}")) return null;
  return name;
}

interface KvResult {
  key: string;
  value: string;
  closesBlock: boolean;
}

function tryParseKeyValue(line: string): KvResult | null {
  if (line.startsWith(":")) return null;
  const colon = line.indexOf(":");
  if (colon <= 0) return null;
  const key = line.slice(0, colon).trim();
  if (/[{}\s]/.test(key)) return null;

  let rest = line.slice(colon + 1);
  let closesBlock = false;
  const trimmed = rest.trimEnd();
  if (trimmed.endsWith("}")) {
    closesBlock = true;
    rest = trimmed.slice(0, -1);
  }
  if (rest.includes("{") || rest.includes("}")) return null;
  return { key, value: rest.trim(), closesBlock };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Parse an INF file (Latin-1 encoded text, hierarchical block structure)
 * and return the root InfBlock tree.
 *
 * Block syntax mirrors the .NET InfParser:
 *   "BlockName {"  or  bare "BlockName" + standalone "{"  → push block
 *   "}"                                                   → pop block
 *   "KEY:value"                                           → key-value
 *   ":continuation"                                       → copy-down (inherits prev key)
 *   Lines starting with "#"                               → comments (skipped)
 */
export async function parseInf(filePath: string): Promise<InfBlock> {
  const content = await fs.promises.readFile(filePath, "latin1");
  return parseInfString(content);
}

export function parseInfString(content: string): InfBlock {
  const lines = content.split(/\r?\n/);
  const root = new InfBlock("Root");
  const stack: InfBlock[] = [root];
  let lastLine: string | null = null;
  let lastKey: string | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const current = stack[stack.length - 1]!;

    if (line === "{") {
      lastKey = null;
      const block = new InfBlock(lastLine ?? "");
      current.addBlock(block);
      stack.push(block);
    } else if (line === "}") {
      lastKey = null;
      if (stack.length > 1) stack.pop();
    } else {
      const inlineName = isInlineBlockOpen(line);
      if (inlineName !== null) {
        lastKey = null;
        const block = new InfBlock(inlineName);
        current.addBlock(block);
        stack.push(block);
      } else if (line.startsWith(":") && lastKey !== null) {
        // copy-down continuation (RowData / ListData)
        current.addKey(lastKey, line.slice(1));
      } else {
        const kv = tryParseKeyValue(line);
        if (kv !== null) {
          current.addKey(kv.key, kv.value);
          lastKey = kv.key;
          if (kv.closesBlock && stack.length > 1) stack.pop();
        } else {
          lastKey = null;
        }
      }
    }

    lastLine = line;
  }

  return root;
}
