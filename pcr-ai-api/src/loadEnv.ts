/**
 * 必须在其它模块（尤其 oracle）之前加载；路径相对本文件，避免 cwd 不是项目根时读不到 .env。
 */
import "./polyfillUtilIsDate.js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { listApisForceOracleNoDummy } from "./lib/listDummyRuntime.js";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, "../.env") });

/**
 * `npm run dev`（tsx + src）：默认走 Excel Dummy，不连 Oracle。
 * dist / NODE_ENV=production：不改动（恒走库）。显式 `*_DUMMY=false` 或 `PCR_AI_LOCAL_DUMMY=false` 可关闭。
 */
function applyLocalDevDummyDefaults(): void {
  if (listApisForceOracleNoDummy()) return;
  if (process.env.NODE_ENV === "test") return;
  const optOut =
    process.env.PCR_AI_LOCAL_DUMMY?.trim().toLowerCase() === "false";
  if (optOut) return;

  const setIfUnset = (key: string) => {
    const cur = process.env[key]?.trim();
    if (cur === undefined || cur === "") process.env[key] = "true";
  };
  setIfUnset("YIELD_MONITOR_TRIGGERS_DUMMY");
  setIfUnset("INFCONTROL_LAYER_BINS_DUMMY");
}

applyLocalDevDummyDefaults();
