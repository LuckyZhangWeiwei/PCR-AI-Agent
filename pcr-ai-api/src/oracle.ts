import fs from "node:fs";
import path from "node:path";
import oracledb, { type Connection, type Pool } from "oracledb";

/**
 * Thick 模式（Instant Client）全局只需初始化一次。
 * 部署若出现 NJS-116，说明仍在 Thin 模式：请设置 ORACLE_INSTANT_CLIENT_LIB_DIR
 * 指向含 libclntsh.so（Linux）或 oci.dll（Windows）的目录。
 *
 * 说明：**node-oracledb 6+** 在 Thick 下若仅用 **11g** 客户端可能在执行阶段报 **DPI-1050**（需 Client ≥ 18.1）。
 * 本包锁定 **oracledb 5.5.x**，以便在**不升级**服务器 Oracle 客户端、不改环境变量的前提下，尽量兼容既有 11g 部署。
 * 内网 legacy 路径默认仍尝试加载；若需禁用可设 **ORACLE_SKIP_LEGACY_CLIENT_11=true**。
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

  // 旧版内网默认路径：仅在目录存在时尝试（可用 ORACLE_SKIP_LEGACY_CLIENT_11=true 关闭）
  if (process.platform !== "win32") {
    const legacyHome = "/u01/app/oracle/product/client_11.2";
    const legacyLib = path.join(legacyHome, "lib");
    const legacyTns = "/exec/apps/tools/oracle";
    const skipLegacy =
      process.env.ORACLE_SKIP_LEGACY_CLIENT_11?.trim().toLowerCase() === "true";
    if (fs.existsSync(legacyLib) && !skipLegacy) {
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

/** 与早期版本一致；可通过 ORACLE_POOL_MAX 等在 .env 中覆盖（无需改库配置） */
const DEFAULT_ORACLE_POOL_MAX = 4;
const DEFAULT_ORACLE_POOL_INCREMENT = 1;

type PoolCreateAttrs = {
  poolMin: number;
  poolMax: number;
  poolIncrement: number;
  queueTimeout: number;
};

function queueTimeoutMs(): number {
  return envInt("ORACLE_QUEUE_TIMEOUT", 60000);
}

function mainPoolCreateAttrs(): PoolCreateAttrs {
  const poolMax = envInt("ORACLE_POOL_MAX", DEFAULT_ORACLE_POOL_MAX);
  return {
    poolMin: envInt("ORACLE_POOL_MIN", 0),
    poolMax,
    poolIncrement: envInt("ORACLE_POOL_INCREMENT", DEFAULT_ORACLE_POOL_INCREMENT),
    queueTimeout: queueTimeoutMs(),
  };
}

function probeWebPoolCreateAttrs(): PoolCreateAttrs {
  const sharedMax = envInt("ORACLE_POOL_MAX", DEFAULT_ORACLE_POOL_MAX);
  const poolMax = envInt("ORACLE_PROBEWEB_POOL_MAX", sharedMax);
  return {
    poolMin: envInt("ORACLE_PROBEWEB_POOL_MIN", envInt("ORACLE_POOL_MIN", 0)),
    poolMax,
    poolIncrement: envInt(
      "ORACLE_PROBEWEB_POOL_INCREMENT",
      envInt("ORACLE_POOL_INCREMENT", DEFAULT_ORACLE_POOL_INCREMENT)
    ),
    queueTimeout: queueTimeoutMs(),
  };
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
    const attrs = mainPoolCreateAttrs();
    pool = await oracledb.createPool({
      user,
      password,
      connectString,
      ...attrs,
    });
    logPoolReady("main", attrs);
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

/** 断连类错误：还回池易导致后续 borrow 卡住，应 drop 掉该 session */
function shouldDropOracleConnection(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (!msg) return false;
  return /(ORA-03113|ORA-03114|ORA-12535|ORA-12537|ORA-12547|ORA-12570|ORA-12571|NJS-500|NJS-503|DPI-1080|TNS:)/i.test(
    msg
  );
}

/** 未设置 ORACLE_CALL_TIMEOUT_MS 时不限制（与早期行为一致） */
function defaultCallTimeoutMs(): number {
  return envInt("ORACLE_CALL_TIMEOUT_MS", 0);
}

function applyConnectionRuntimeSettings(connection: Connection): void {
  const ms = defaultCallTimeoutMs();
  if (ms > 0) {
    connection.callTimeout = ms;
  }
}

function logPoolReady(label: string, attrs: PoolCreateAttrs): void {
  const slowLog = envInt("ORACLE_SLOW_QUERY_LOG_MS", 0);
  console.log(
    `[oracle] ${label} poolMax=${attrs.poolMax} poolMin=${attrs.poolMin} poolIncrement=${attrs.poolIncrement} queueTimeout=${attrs.queueTimeout}ms callTimeoutMs=${defaultCallTimeoutMs() || "off"} slowLogMs=${slowLog > 0 ? slowLog : "off"}`
  );
}

async function withPooledConnection<T>(
  getPool: () => Promise<Pool>,
  fn: (connection: Connection) => Promise<T>
): Promise<T> {
  const p = await getPool();
  const connection = await p.getConnection();
  applyConnectionRuntimeSettings(connection);
  let drop = false;
  const t0 = Date.now();
  try {
    return await fn(connection);
  } catch (err) {
    drop = shouldDropOracleConnection(err);
    throw err;
  } finally {
    const slowMs = envInt("ORACLE_SLOW_QUERY_LOG_MS", 0);
    const elapsed = Date.now() - t0;
    if (slowMs > 0 && elapsed >= slowMs) {
      console.warn(
        `[oracle] slow pooled op ${elapsed}ms (threshold ${slowMs}ms; set ORACLE_SLOW_QUERY_LOG_MS=0 to disable)`
      );
    }
    try {
      if (drop) {
        await connection.close({ drop: true });
      } else {
        await connection.close();
      }
    } catch {
      // ignore
    }
  }
}

export async function withConnection<T>(
  fn: (connection: Connection) => Promise<T>
): Promise<T> {
  return withPooledConnection(initOraclePool, fn);
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
    const attrs = probeWebPoolCreateAttrs();
    probeWebPool = await oracledb.createPool({
      user,
      password,
      connectString,
      ...attrs,
    });
    logPoolReady("probeweb", attrs);
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
  return withPooledConnection(initProbeWebPool, fn);
}

/** Thick 已成功加载（有客户端版本字符串）；否则多为 Thin，连真实库时易出现 NJS-116 */
export function isOracleThickRuntime(): boolean {
  const v = oracledb.oracleClientVersionString;
  return typeof v === "string" && v.trim().length > 0;
}
