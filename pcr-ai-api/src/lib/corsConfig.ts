import type { RequestHandler } from "express";

/**
 * 手写 CORS（不再依赖 `cors` 包对 `origin:*` / 动态 origin 的边角），行为固定为：
 * - 带 **`Origin`** 时：**原样回写** `Access-Control-Allow-Origin`（与 `credentials:false` 的 fetch 兼容）。
 * - 无 Origin（curl 等）：`**`。
 * - **OPTIONS**：回显 `Access-Control-Request-Headers`；Chrome PNA 时回 **`Access-Control-Allow-Private-Network`**。
 */
export const wideOpenCorsMiddleware: RequestHandler = (req, res, next) => {
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.length > 0) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Expose-Headers", "X-Request-Id");

  if (req.method !== "OPTIONS") {
    next();
    return;
  }

  const pna = String(req.headers["access-control-request-private-network"] ?? "")
    .toLowerCase();
  if (pna === "true") {
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS"
  );
  const reqHdr = req.headers["access-control-request-headers"];
  res.setHeader(
    "Access-Control-Allow-Headers",
    typeof reqHdr === "string" && reqHdr.length > 0
      ? reqHdr
      : "Content-Type, Authorization, Accept, X-Requested-With, Origin, X-Request-Id"
  );
  res.setHeader("Access-Control-Max-Age", "86400");
  res.status(204).end();
};

export function describeCorsModeForLog(): string {
  return "[cors] wide-open: echo Origin when present; preflight echoes Request-Headers + PNA";
}
