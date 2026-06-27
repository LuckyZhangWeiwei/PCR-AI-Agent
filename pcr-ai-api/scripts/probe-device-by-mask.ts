// scripts/probe-device-by-mask.ts
// ─────────────────────────────────────────────────────────────────────────────
// 定位 P-A：get_filter_values device-by-mask 真库恒空，但同 mask 的 query_* 有数据。
// 本脚本直接对真库复跑那两条 SQL + 逐步二分的变体，**完全不经过 LLM**，当场看每段
// 返回几行——哪一段从 0 变成非 0，就是被哪个 WHERE 条件杀光了行。
//
// 必须在能连真库的环境运行（服务器，或本机 .env 配好 ORACLE_*）：
//   cd pcr-ai-api && PCR_AI_LOCAL_DUMMY=false npx tsx scripts/probe-device-by-mask.ts P11C
//
// 把整段输出贴回给 Claude / 写进结果文件即可定位根因。预期最可能：
//   - yield/full=0 但 yield/noType>0  → 真库 TYPE 裸值 ≠ 'DELTA_DIFF'（看 yield/distinctType）
//   - 某段抛 ❌ ERROR(ORA-xxxxx)        → 「空」其实是被吞掉的异常，按 ORA 码定位
// ─────────────────────────────────────────────────────────────────────────────
import "../src/loadEnv.js";
import oracledb from "oracledb";
import { withConnection, withProbeWebConnection } from "../src/oracle.js";
import { deviceMaskOracleWhere } from "../src/lib/deviceMask.js";

type ConnRunner = <T>(fn: (conn: oracledb.Connection) => Promise<T>) => Promise<T>;

const mask = (process.argv[2] ?? "P11C").toUpperCase();
const binds = { mask };

async function probe(label: string, pool: ConnRunner, sql: string): Promise<void> {
  try {
    const rows = await pool(async (conn) => {
      const r = await conn.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      return (r.rows ?? []) as Record<string, unknown>[];
    });
    console.log(`\n[${label}] rowCount=${rows.length}`);
    if (rows.length) console.log(JSON.stringify(rows.slice(0, 8)));
  } catch (e) {
    console.error(`\n[${label}] ❌ ERROR: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const where = deviceMaskOracleWhere("t.DEVICE", "mask");
const whereJb = deviceMaskOracleWhere("t1.DEVICE", "mask");

async function main(): Promise<void> {
  console.log(`=== device-by-mask probe, mask=${mask} ===`);

  // ── YIELD 侧（probeweb，YMWEB_YIELDMONITORTRIGGER）──
  // 1) 完整（= oracleYieldDeviceByMaskMap，应复现「空」）
  await probe("yield/full", withProbeWebConnection, `
    SELECT DISTINCT t.DEVICE FROM YMWEB_YIELDMONITORTRIGGER t
    WHERE UPPER(TRIM(t."TYPE")) = 'DELTA_DIFF'
      AND NOT REGEXP_LIKE(t.LOTID, '^(kk|gg|c)', 'i')
      AND ${where}
      AND t.DEVICE IS NOT NULL AND TRIM(t.DEVICE) != ''`);

  // 2) 去掉 TYPE='DELTA_DIFF'
  await probe("yield/noType", withProbeWebConnection, `
    SELECT DISTINCT t.DEVICE FROM YMWEB_YIELDMONITORTRIGGER t
    WHERE NOT REGEXP_LIKE(t.LOTID, '^(kk|gg|c)', 'i')
      AND ${where}`);

  // 3) 只留 mask
  await probe("yield/onlyMask", withProbeWebConnection,
    `SELECT DISTINCT t.DEVICE FROM YMWEB_YIELDMONITORTRIGGER t WHERE ${where}`);

  // 4) TYPE 裸值（看真库到底是不是 'delta_diff'：大小写 / 前后空格 / 其它枚举）
  await probe("yield/distinctType", withProbeWebConnection, `
    SELECT t."TYPE" AS TYPE_RAW, COUNT(*) AS CNT FROM YMWEB_YIELDMONITORTRIGGER t
    WHERE ${where} GROUP BY t."TYPE"`);

  // ── JB 侧（main，INFCONTROL ⋈ INFLAYERBINLIST）──
  // 5) 完整（= oracleJbDeviceByMaskMap，应复现「空」）
  await probe("jb/full", withConnection, `
    SELECT DISTINCT t1.DEVICE
    FROM INFCONTROL t1 JOIN INFLAYERBINLIST t2 ON t1.KEYNUMBER = t2.KEYNUMBER
    WHERE NOT REGEXP_LIKE(t1.LOT, '^(kk|gg|c)', 'i')
      AND ${whereJb}
      AND t1.DEVICE IS NOT NULL AND TRIM(t1.DEVICE) != ''`);

  // 6) JB 只留 mask（不 JOIN）——若有行而 jb/full 无行，说明 JOIN 或 LOT 前缀杀的
  await probe("jb/onlyMaskNoJoin", withConnection,
    `SELECT DISTINCT t1.DEVICE FROM INFCONTROL t1 WHERE ${whereJb}`);

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
