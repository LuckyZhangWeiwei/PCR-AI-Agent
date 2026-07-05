// pcr-ai-api/src/lib/agent/agentDataMasking.ts
import { createHash } from "node:crypto";
import oracledb from "oracledb";
import { withConnection, withProbeWebConnection } from "../../oracle.js";
import { oracleNonEmptyTrimmedColumn } from "../oracleStringSql.js";
import {
  yieldMonitorTriggersUseDummy,
  getYieldMonitorTriggerDummyRows,
} from "../yieldMonitorTriggerDummy.js";
import {
  infcontrolLayerBinsUseDummy,
  getInfcontrolLayerBinDummyRows,
} from "../infcontrolLayerBinDummy.js";

const NXP_TOKEN = "COMPANY_X";
const NXP_RE = /nxp/gi;
const DEVICE_TOKEN_PREFIX = "DEV_";
const DICTIONARY_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_HASH_HEX_LEN = 64; // full SHA-256 hex length — collision-safe upper bound
const INITIAL_HASH_HEX_LEN = 10;

export interface MaskingDictionary {
  /** Replace real device values / NXP with tokens in outbound text. */
  mask(text: string): string;
  /** Replace tokens back to real device values / NXP in inbound text (whole string, no streaming). */
  unmask(text: string): string;
}

interface DictionaryState {
  builtAt: number;
  /** false when the underlying build failed (e.g. Oracle error) — such a
   * result must never be cached, so the next call retries instead of
   * silently serving an empty dictionary for a full TTL window. */
  ok: boolean;
  realToToken: Map<string, string>;
  tokenToReal: Map<string, string>;
  matchRegex: RegExp | null; // matches any known real device value (longest-first)
  tokenRegex: RegExp | null; // matches any known device token (longest-first)
}

let cached: DictionaryState | undefined;
let buildingPromise: Promise<DictionaryState> | undefined;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hashToken(real: string, hexLen: number): string {
  const hex = createHash("sha256")
    .update(real)
    .digest("hex")
    .slice(0, Math.min(hexLen, MAX_HASH_HEX_LEN));
  return `${DEVICE_TOKEN_PREFIX}${hex}`;
}

/** Assign a stable token per real value; on hash collision, lengthen the hex
 * suffix for the colliding value until unique (capped at the full SHA-256 hex
 * length — a collision at that length is cryptographically infeasible). */
function assignTokens(realValues: string[]): {
  realToToken: Map<string, string>;
  tokenToReal: Map<string, string>;
} {
  const realToToken = new Map<string, string>();
  const tokenToReal = new Map<string, string>();
  for (const real of realValues) {
    let len = INITIAL_HASH_HEX_LEN;
    let token = hashToken(real, len);
    while (tokenToReal.has(token) && tokenToReal.get(token) !== real) {
      if (len >= MAX_HASH_HEX_LEN) break;
      len += 2;
      token = hashToken(real, len);
    }
    realToToken.set(real, token);
    tokenToReal.set(token, real);
  }
  return { realToToken, tokenToReal };
}

function buildAlternationRegex(values: string[]): RegExp | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => b.length - a.length);
  return new RegExp(sorted.map(escapeRegExp).join("|"), "g");
}

async function fetchDistinctDevicesOracle(): Promise<string[]> {
  const yieldSql = `SELECT DISTINCT DEVICE AS DEV FROM YMWEB_YIELDMONITORTRIGGER WHERE ${oracleNonEmptyTrimmedColumn("DEVICE")}`;
  const jbSql = `SELECT DISTINCT DEVICE AS DEV FROM INFCONTROL WHERE ${oracleNonEmptyTrimmedColumn("DEVICE")}`;
  const [yieldRows, jbRows] = await Promise.all([
    withProbeWebConnection(async (conn) => {
      const r = await conn.execute(yieldSql, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      return (r.rows ?? []) as Record<string, unknown>[];
    }),
    withConnection(async (conn) => {
      const r = await conn.execute(jbSql, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      return (r.rows ?? []) as Record<string, unknown>[];
    }),
  ]);
  const set = new Set<string>();
  for (const row of [...yieldRows, ...jbRows]) {
    const v = String(row["DEV"] ?? "").trim();
    if (v) set.add(v);
  }
  return [...set];
}

function fetchDistinctDevicesDummy(): string[] {
  const set = new Set<string>();
  for (const row of getYieldMonitorTriggerDummyRows()) {
    const v = String(row.DEVICE ?? "").trim();
    if (v) set.add(v);
  }
  for (const row of getInfcontrolLayerBinDummyRows()) {
    const v = String(row.DEVICE ?? "").trim();
    if (v) set.add(v);
  }
  return [...set];
}

async function buildDictionary(): Promise<DictionaryState> {
  let realValues: string[];
  let ok = true;
  try {
    realValues =
      yieldMonitorTriggersUseDummy() || infcontrolLayerBinsUseDummy()
        ? fetchDistinctDevicesDummy()
        : await fetchDistinctDevicesOracle();
  } catch (err) {
    console.error("[agentDataMasking] failed to build device dictionary:", err);
    realValues = [];
    ok = false;
  }
  const { realToToken, tokenToReal } = assignTokens(realValues);
  return {
    builtAt: Date.now(),
    ok,
    realToToken,
    tokenToReal,
    matchRegex: buildAlternationRegex(realValues),
    tokenRegex: buildAlternationRegex([...tokenToReal.keys()]),
  };
}

async function getDictionaryState(): Promise<DictionaryState> {
  if (cached && Date.now() - cached.builtAt < DICTIONARY_TTL_MS) return cached;
  if (buildingPromise) return buildingPromise;
  buildingPromise = buildDictionary().then((d) => {
    if (d.ok) {
      cached = d;
    }
    buildingPromise = undefined;
    return d;
  });
  return buildingPromise;
}

/** Test-only: force the next loadMaskingDictionary() call to rebuild. */
export function resetMaskingDictionaryCacheForTest(): void {
  cached = undefined;
  buildingPromise = undefined;
}

function maskWithState(text: string, dict: DictionaryState): string {
  let out = text;
  if (dict.matchRegex) {
    out = out.replace(dict.matchRegex, (m) => dict.realToToken.get(m) ?? m);
  }
  out = out.replace(NXP_RE, NXP_TOKEN);
  return out;
}

function unmaskWithState(text: string, dict: DictionaryState): string {
  let out = text;
  if (dict.tokenRegex) {
    out = out.replace(dict.tokenRegex, (m) => dict.tokenToReal.get(m) ?? m);
  }
  return out.split(NXP_TOKEN).join("NXP");
}

export async function loadMaskingDictionary(): Promise<MaskingDictionary> {
  const dict = await getDictionaryState();
  return {
    mask: (text: string) => maskWithState(text, dict),
    unmask: (text: string) => unmaskWithState(text, dict),
  };
}

export interface StreamUnmasker {
  /** Feed a raw text delta; returns the portion that is now safe to emit (already unmasked). */
  push(delta: string): string;
  /** Call once after the stream ends — flushes any buffered remainder (unmasked). */
  finalize(): string;
}

/**
 * Length of a trailing suffix of `text` that might still be a growing,
 * not-yet-complete token: either a `DEV_` + hex run that hasn't hit the
 * maximum possible length yet, or a strict prefix of the fixed NXP
 * placeholder. That suffix must not be flushed/unmasked yet — more incoming
 * text could still complete it into (or rule it out as) a real token.
 * Returns 0 when nothing at the tail looks like a still-growing token.
 *
 * Must also treat a *partial* `DEV_` prefix (e.g. trailing "D", "DE", "DEV")
 * as unsafe, not just an already-complete "DEV_" followed by hex digits:
 * with streaming deltas smaller than `DEVICE_TOKEN_PREFIX.length` (4 chars),
 * a chunk boundary can split "DEV_" itself. If only the already-complete
 * "DEV_<hex>" shape were checked, the leading "D"/"DE"/"DEV" fragment would
 * get flushed (and unmasked as plain text, i.e. leaked) in one push() call
 * before the rest of the token ever arrives in a later call — this was
 * caught by a chunkSize=3 regression test against a real generated token.
 */
function trailingUnsafeLength(text: string): number {
  const devMatch = /DEV_[0-9a-f]{0,64}$/.exec(text);
  if (devMatch && devMatch[0].length < DEVICE_TOKEN_PREFIX.length + MAX_HASH_HEX_LEN) {
    return devMatch[0].length;
  }
  for (let len = Math.min(DEVICE_TOKEN_PREFIX.length - 1, text.length); len >= 1; len--) {
    if (DEVICE_TOKEN_PREFIX.startsWith(text.slice(text.length - len))) return len;
  }
  for (let len = Math.min(NXP_TOKEN.length - 1, text.length); len >= 1; len--) {
    if (NXP_TOKEN.startsWith(text.slice(text.length - len))) return len;
  }
  return 0;
}

export function createStreamUnmasker(dict: MaskingDictionary): StreamUnmasker {
  let pending = "";
  return {
    push(delta: string): string {
      pending += delta;
      const unsafeLen = trailingUnsafeLength(pending);
      const safeLen = pending.length - unsafeLen;
      if (safeLen <= 0) return "";
      const safe = pending.slice(0, safeLen);
      pending = pending.slice(safeLen);
      return dict.unmask(safe);
    },
    finalize(): string {
      const rest = pending;
      pending = "";
      return dict.unmask(rest);
    },
  };
}
