import https from "node:https";
import { URL } from "node:url";

const DEFAULT_BASE = "https://api.siliconflow.cn/v1";
const DEFAULT_MODEL = "Pro/MiniMaxAI/MiniMax-M2.5";

const SILICONFLOW_API_KEY =
  "sk-omidncsxeyqgdqlexvpksyptpsguggdxlfmiukohejekmxte";

export type SiliconflowConfig = {
  apiKey: string;
  model: string;
  baseUrl: string;
};

export function getSiliconflowConfig(): SiliconflowConfig {
  const model = process.env.SILICONFLOW_MODEL?.trim() || DEFAULT_MODEL;
  const rawBase = process.env.SILICONFLOW_API_BASE?.trim() || DEFAULT_BASE;
  const baseUrl = rawBase.replace(/\/+$/, "");
  return { apiKey: SILICONFLOW_API_KEY, model, baseUrl };
}

export type SiliconflowChatOk = {
  ok: true;
  reply: string | null;
  reasoningContent: string | null;
  model: string;
};

export type SiliconflowChatErr = {
  ok: false;
  status: number;
  body: unknown;
  kind?: "network" | "upstream";
};

function readFetchTimeoutMs(): number {
  const raw = process.env.SILICONFLOW_FETCH_TIMEOUT_MS?.trim();
  if (!raw) return 60_000;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 60_000;
  return Math.min(120_000, Math.max(5_000, Math.floor(n)));
}

const HARDCODED_SILICONFLOW_TLS_INSECURE_DEFAULT = true;

function tlsInsecureForSiliconflow(): boolean {
  if (/^true$/i.test(process.env.SILICONFLOW_TLS_STRICT?.trim() ?? "")) {
    return false;
  }
  const env = process.env.SILICONFLOW_TLS_INSECURE?.trim();
  if (/^true$/i.test(env ?? "")) return true;
  if (/^false$/i.test(env ?? "")) return false;
  return HARDCODED_SILICONFLOW_TLS_INSECURE_DEFAULT;
}

let relaxedTlsWarned = false;

function warnTlsInsecureOnce(): void {
  if (relaxedTlsWarned) return;
  relaxedTlsWarned = true;
  const viaEnv = /^true$/i.test(
    process.env.SILICONFLOW_TLS_INSECURE?.trim() ?? ""
  );
  console.warn(
    `[siliconflow] TLS verification disabled for SiliconFlow only (${viaEnv ? "SILICONFLOW_TLS_INSECURE" : "built-in default"}). Prefer NODE_EXTRA_CA_CERTS with your corporate root CA, or set SILICONFLOW_TLS_STRICT=true to enforce TLS.`
  );
}

/** 企业解密场景：不依赖外部 `undici` 包，仅用 Node 内置 `https` + `rejectUnauthorized: false`。 */
function postJsonHttpsInsecure(
  urlStr: string,
  headerMap: Record<string, string>,
  jsonBody: string,
  timeoutMs: number
): Promise<{ statusCode: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    if (u.protocol !== "https:") {
      reject(new Error("TLS relax path only supports https URLs"));
      return;
    }
    const port = u.port === "" ? 443 : Number(u.port);
    warnTlsInsecureOnce();
    const req = https.request(
      {
        hostname: u.hostname,
        port,
        path: `${u.pathname}${u.search}`,
        method: "POST",
        headers: {
          ...headerMap,
          "Content-Length": Buffer.byteLength(jsonBody, "utf8"),
        },
        rejectUnauthorized: false,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (c) => chunks.push(c));
        incoming.on("end", () => {
          resolve({
            statusCode: incoming.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.write(jsonBody);
    req.end();
  });
}

function formatOutboundFetchError(err: unknown): string {
  if (err instanceof AggregateError) {
    const parts = err.errors.map((e) =>
      e instanceof Error ? e.message : String(e)
    );
    return `AggregateError: ${parts.join("; ")}`;
  }
  const msgs: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 8 && cur; i++) {
    if (cur instanceof Error) {
      msgs.push(cur.message);
      const code = (cur as NodeJS.ErrnoException).code;
      if (code && !msgs[msgs.length - 1]?.includes(code)) {
        msgs.push(`(${code})`);
      }
      cur = cur.cause;
    } else {
      msgs.push(String(cur));
      break;
    }
  }
  return msgs.filter(Boolean).join(" → ");
}

export async function callSiliconflowChat(
  cfg: SiliconflowConfig,
  userMessage: string
): Promise<SiliconflowChatOk | SiliconflowChatErr> {
  const url = `${cfg.baseUrl}/chat/completions`;
  const timeoutMs = readFetchTimeoutMs();
  const payload = JSON.stringify({
    model: cfg.model,
    messages: [{ role: "user", content: userMessage }],
    stream: false,
  });
  const authHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
  };

  let status = 0;
  let textBody = "";

  try {
    if (tlsInsecureForSiliconflow()) {
      const out = await postJsonHttpsInsecure(url, authHeaders, payload, timeoutMs);
      status = out.statusCode;
      textBody = out.text;
    } else {
      const res = await fetch(url, {
        method: "POST",
        headers: authHeaders,
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = res.status;
      textBody = await res.text();
    }
  } catch (err) {
    const detail = formatOutboundFetchError(err);
    console.warn("[siliconflow] outbound fetch failed:", detail, "url=", url);
    const certHint =
      /CERT|TLS|SSL|self-signed/i.test(detail) && !tlsInsecureForSiliconflow()
        ? " If this is corporate TLS inspection, set SILICONFLOW_TLS_INSECURE=true on the API host (see .env.example), use built-in default in siliconflowChat.ts, or add the inspection root to NODE_EXTRA_CA_CERTS."
        : "";
    return {
      ok: false,
      status: 502,
      kind: "network",
      body: {
        message: detail,
        hint:
          "API host cannot reach SiliconFlow (firewall/DNS/TLS). Node fetch does not use HTTP_PROXY unless you add a proxy agent. Try: curl -v https://api.siliconflow.cn/v1/models from the same machine." +
          certHint,
      },
    };
  }

  let data: unknown = {};
  try {
    data = textBody ? JSON.parse(textBody) : {};
  } catch {
    data = { raw: textBody };
  }

  if (status < 200 || status >= 300) {
    return { ok: false, status, kind: "upstream", body: data };
  }

  const obj = data as Record<string, unknown>;
  const choices = obj.choices;
  const first =
    Array.isArray(choices) && choices.length > 0 ? choices[0] : undefined;
  const msg =
    first &&
    typeof first === "object" &&
    first !== null &&
    "message" in first &&
    typeof (first as { message: unknown }).message === "object" &&
    (first as { message: object }).message !== null
      ? (first as { message: Record<string, unknown> }).message
      : undefined;

  const content = msg?.content;
  const reasoning = msg?.reasoning_content;
  const reply = typeof content === "string" ? content : null;
  const reasoningContent =
    typeof reasoning === "string" ? reasoning : null;
  const model = typeof obj.model === "string" ? obj.model : cfg.model;

  return {
    ok: true,
    reply,
    reasoningContent,
    model,
  };
}
