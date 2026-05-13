import fs from "node:fs";
import path from "node:path";
import oracledb, { type Connection, type Pool } from "oracledb";

/**
 * Thick 模式（Instant Client）全局只需初始化一次。
 * 部署若出现 NJS-116，说明仍在 Thin 模式：请设置 ORACLE_INSTANT_CLIENT_LIB_DIR
 * 指向含 libclntsh.so（Linux）或 oci.dll（Windows）的目录。
 */
function tryInitThick(
  libDir: string | undefined,
  configDir: string | undefined,
  label: string
): boolean {
  if (!libDir && !configDir) return false;
  try {
    oracledb.initOracleClient({
      ...(libDir ? { libDir } : {}),
      ...(configDir ? { configDir } : {}),
    });
    const verStr =
      typeof oracledb.oracleClientVersionString === "string"
        ? oracledb.oracleClientVersionString
        : "";
    console.log(
      `[oracledb] Thick mode OK (${label})${verStr ? ` client=${verStr}` : ""}`
    );
    return true;
  } catch (e) {
    console.warn(`[oracledb] Thick init failed (${label}):`, e);
    return false;
  }
}

function bootstrapOracleThick(): void {
  const configDir =
    process.env.ORACLE_CLIENT_CONFIG_DIR?.trim() ||
    process.env.TNS_ADMIN?.trim();

  const instant = process.env.ORACLE_INSTANT_CLIENT_LIB_DIR?.trim();
  if (instant && tryInitThick(instant, configDir, "ORACLE_INSTANT_CLIENT_LIB_DIR")) {
    return;
  }

  const home = process.env.ORACLE_HOME?.trim();
  if (home) {
    const lib = path.join(home, "lib");
    if (tryInitThick(lib, configDir, "ORACLE_HOME/lib")) {
      if (!process.env.PATH?.includes(path.join(home, "bin"))) {
        process.env.PATH = `${path.join(home, "bin")}:${process.env.PATH || ""}`;
      }
      return;
    }
  }

  // 旧版内网默认路径：仅在目录存在时尝试（避免发布环境静默失败退回 Thin）
  if (process.platform !== "win32") {
    const legacyHome = "/u01/app/oracle/product/client_11.2";
    const legacyLib = path.join(legacyHome, "lib");
    const legacyTns = "/exec/apps/tools/oracle";
    if (fs.existsSync(legacyLib)) {
      const cd = configDir || legacyTns;
      if (tryInitThick(legacyLib, cd, "legacy /u01 client")) {
        if (!process.env.ORACLE_HOME) process.env.ORACLE_HOME = legacyHome;
        if (!process.env.TNS_ADMIN) process.env.TNS_ADMIN = legacyTns;
        process.env.PATH = `${path.join(legacyHome, "bin")}:${process.env.PATH || ""}`;
        return;
      }
    }
  }

  if (process.platform === "win32" && configDir) {
    if (tryInitThick(undefined, configDir, "ORACLE_CLIENT_CONFIG_DIR only")) {
      return;
    }
  }

  console.warn(
    "[oracledb] Thin mode: some Oracle passwords fail with NJS-116. Set ORACLE_INSTANT_CLIENT_LIB_DIR to your Instant Client directory (contains libclntsh.so or oci.dll), then restart."
  );
  console.warn(
    "[oracledb] Frontend-only: skip this Node process and point pcr-ai-report「服务器地址」at the deployed API (Thick mode there avoids NJS-116 on your laptop)."
  );
}

bootstrapOracleThick();
let pool: Pool | undefined;
let poolInitPromise: Promise<Pool> | undefined;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** 主池（如 /api/v1/infcontrol-layer-bins）：暂时硬编码，上线前改为环境变量 */
const MAIN_ORACLE_USER = "jbstar_loader";
const MAIN_ORACLE_PASSWORD = "jbstarloader";

/** probeweb 池（如 /api/v1/yield-monitor-triggers）：暂时硬编码 */
const PROBEWEB_ORACLE_USER = "probeweb";
const PROBEWEB_ORACLE_PASSWORD = "probeweb";

export async function initOraclePool(): Promise<Pool> {
  if (pool) return pool;
  if (poolInitPromise) return poolInitPromise;

  const user = MAIN_ORACLE_USER;
  const password = MAIN_ORACLE_PASSWORD;
  const connectString =
    process.env.ORACLE_CONNECT_STRING ||
    "m17pmis1.cn-tnj03.nxp.com:1539/m17pmis1";

  poolInitPromise = (async () => {
    pool = await oracledb.createPool({
      user,
      password,
      connectString,
      poolMin: envInt("ORACLE_POOL_MIN", 0),
      poolMax: envInt("ORACLE_POOL_MAX", 4),
      poolIncrement: envInt("ORACLE_POOL_INCREMENT", 1),
    });
    return pool;
  })();

  try {
    return await poolInitPromise;
  } finally {
    poolInitPromise = undefined;
  }
}

export async function closeOraclePool(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = undefined;
  await p.close(10);
}

export async function withConnection<T>(
  fn: (connection: Connection) => Promise<T>
): Promise<T> {
  const p = await initOraclePool();
  const connection = await p.getConnection();
  try {
    return await fn(connection);
  } finally {
    try {
      await connection.close();
    } catch {
      // ignore
    }
  }
}

let probeWebPool: Pool | undefined;
let probeWebPoolInitPromise: Promise<Pool> | undefined;

/** probeweb 账号池（YMWEB_YIELDMONITORTRIGGER 等），连接串可环境变量覆盖 */
export async function initProbeWebPool(): Promise<Pool> {
  if (probeWebPool) return probeWebPool;
  if (probeWebPoolInitPromise) return probeWebPoolInitPromise;

  const user = PROBEWEB_ORACLE_USER;
  const password = PROBEWEB_ORACLE_PASSWORD;
  const connectString =
    process.env.ORACLE_PROBEWEB_CONNECT_STRING ||
    process.env.ORACLE_CONNECT_STRING ||
    "m17pmis1.cn-tnj03.nxp.com:1539/m17pmis1";

  probeWebPoolInitPromise = (async () => {
    probeWebPool = await oracledb.createPool({
      user,
      password,
      connectString,
      poolMin: envInt("ORACLE_POOL_MIN", 0),
      poolMax: envInt("ORACLE_POOL_MAX", 4),
      poolIncrement: envInt("ORACLE_POOL_INCREMENT", 1),
    });
    return probeWebPool;
  })();

  try {
    return await probeWebPoolInitPromise;
  } finally {
    probeWebPoolInitPromise = undefined;
  }
}

export async function closeProbeWebPool(): Promise<void> {
  if (!probeWebPool) return;
  const p = probeWebPool;
  probeWebPool = undefined;
  await p.close(10);
}

export async function withProbeWebConnection<T>(
  fn: (connection: Connection) => Promise<T>
): Promise<T> {
  const p = await initProbeWebPool();
  const connection = await p.getConnection();
  try {
    return await fn(connection);
  } finally {
    try {
      await connection.close();
    } catch {
      // ignore
    }
  }
}
