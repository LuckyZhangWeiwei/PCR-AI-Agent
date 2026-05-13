import { fileURLToPath } from "node:url";

/**
 * 层控 / 产量监控列表与聚合是否 **禁止** 使用内存 Dummy、必须走 Oracle。
 *
 * - `npm run build` 后的 **`node dist/...`**：本模块路径在 **`dist/`** 下 → 恒为 **true**（与 `*_DUMMY` 无关）。
 * - **`NODE_ENV=production`**（如 PM2）：恒为 **true**。
 * - **`NODE_ENV=test`**：恒为 **false**（单元测试仍可用 Dummy / Excel）。
 */
export function listApisForceOracleNoDummy(): boolean {
  if (process.env.NODE_ENV === "test") return false;
  if (process.env.NODE_ENV === "production") return true;
  const f = fileURLToPath(import.meta.url).replace(/\\/g, "/");
  return f.includes("/dist/");
}
