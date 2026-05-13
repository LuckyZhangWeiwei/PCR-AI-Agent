import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";

const HDR = "x-request-id";

export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const incoming = req.get(HDR)?.trim();
  const id = incoming && incoming.length > 0 ? incoming : randomUUID();
  res.setHeader("X-Request-Id", id);
  (req as Request & { requestId?: string }).requestId = id;
  next();
}
