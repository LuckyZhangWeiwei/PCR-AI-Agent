import type { ApiErrorBody } from "./types";

/** 正式 API（可被 VITE_API_BASE_URL 或页面输入框覆盖） */
const DEFAULT_BASE = "http://10.192.130.89:30008";

/**
 * 规范化地址栏输入；空串、非法或暂不完整的 URL 回退默认，避免 `new URL` 抛错导致整页崩溃。
 */
export function normalizeApiBase(raw: string): string {
  const t = raw.trim().replace(/\/$/, "");
  if (!t) return DEFAULT_BASE;

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
  return normalizeApiBase(fromEnv ?? DEFAULT_BASE);
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
    url = new URL(`${root}${p}`);
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
