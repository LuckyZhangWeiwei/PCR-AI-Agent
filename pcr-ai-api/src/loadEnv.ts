/**
 * 必须在其它模块（尤其 oracle）之前加载；路径相对本文件，避免 cwd 不是项目根时读不到 .env。
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, "../.env") });
