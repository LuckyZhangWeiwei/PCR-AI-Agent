import type { ApiErrorBody } from "./types";

/** 正式 API（可被 VITE_API_BASE_URL 或页面输入框覆盖） */
export const DEFAULT_API_BASE = "http://10.192.130.89:30008";

const DEFAULT_BASE = DEFAULT_API_BASE;

function devUsesViteProxy(): boolean {
  return (
    import.meta.env.DEV &&
    String(import.meta.env.VITE_DEV_API_VIA_PROXY ?? "").toLowerCase() ===
      "true"
  );
}

/**
 * 规范化地址栏输入；空串、非法或暂不完整的 URL 回退默认，避免 `new URL` 抛错导致整页崩溃。
 *
 * 开发且 **`VITE_DEV_API_VIA_PROXY=true`** 时，空串表示**同页相对路径**（由 Vite 代理到网关），避免
 * `localhost` 页面直连内网 IP 被 Chrome **Private Network Access** 拦截。
 */
export function normalizeApiBase(raw: string): string {
  const t = raw.trim().replace(/\/$/, "");
  if (!t) {
    if (devUsesViteProxy()) return "";
    return DEFAULT_BASE;
  }

  try {
    const withScheme = /^https?:\/\//i.test(t) ? t : `http://${t}`;
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return DEFAULT_BASE;
    const path =
      u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return DEFAULT_BASE;
  }
}

export function defaultApiBase(): string {
  const fromEnv = import.meta.env.VITE_API_BASE_URL as string | undefined;
  const trimmed = fromEnv?.trim() ?? "";
  if (trimmed === "" && devUsesViteProxy()) return "";
  if (trimmed === "") return DEFAULT_BASE;
  return normalizeApiBase(trimmed);
}

/**
 * 浏览器里展示「实际请求的 origin」（开发 + 代理时空 base 为当前页）。
 */
export function displayApiOrigin(base: string): string {
  const n = normalizeApiBase(base);
  if (n !== "") return n;
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }
  return "http://localhost";
}

export function buildUrl(
  base: string,
  path: string,
  params?: Record<string, string | number | boolean | undefined | null>
): string {
  const root = normalizeApiBase(base);
  const p = path.startsWith("/") ? path : `/${path}`;
  let url: URL;
  try {
    if (root === "") {
      const origin =
        typeof window !== "undefined" && window.location?.origin
          ? window.location.origin
          : "http://localhost";
      url = new URL(p, origin);
    } else {
      url = new URL(`${root}${p}`);
    }
  } catch {
    url = new URL(`${normalizeApiBase(DEFAULT_BASE)}${p}`);
  }
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === "") continue;
      if (typeof v === "boolean") {
        url.searchParams.set(k, v ? "true" : "false");
      } else {
        url.searchParams.set(k, String(v));
      }
    }
  }
  return url.toString();
}

export async function apiGetJson<T>(
  base: string,
  path: string,
  params?: Record<string, string | number | boolean | undefined | null>,
  init?: RequestInit
): Promise<T> {
  const url = buildUrl(base, path, params);
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  const body: unknown = (() => {
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return text;
    }
  })();
  if (!res.ok) {
    const err = body as Partial<ApiErrorBody> | null;
    const msg =
      err?.error ??
      (typeof body === "string" ? body : `HTTP ${res.status}`);
    const detail = err?.detail ? ` (${err.detail})` : "";
    throw new Error(`${msg}${detail}`);
  }
  return body as T;
}
