import "./loadEnv.js";

import { createApp } from "./app.js";
import { infcontrolLayerBinsUseDummy } from "./lib/infcontrolLayerBinDummy.js";
import { listApisForceOracleNoDummy } from "./lib/listDummyRuntime.js";
import { yieldMonitorTriggersUseDummy } from "./lib/yieldMonitorTriggerDummy.js";
import { closeOraclePool, closeProbeWebPool, isOracleThickRuntime } from "./oracle.js";

const port = Number(process.env.PORT) || 30008;
const app = createApp();

app.listen(port, () => {
  console.log(`pcr-ai-api listening on http://localhost:${port}`);
  console.log(`  v3 联调页: http://localhost:${port}/v3-api-tester.html`);
  const forcedOracle = listApisForceOracleNoDummy();
  console.log(
    `[dummy] yield-monitor-triggers=${yieldMonitorTriggersUseDummy()} (env YIELD_MONITOR_TRIGGERS_DUMMY=${JSON.stringify(process.env.YIELD_MONITOR_TRIGGERS_DUMMY)}; forcedOracle=${forcedOracle})`
  );
  console.log(
    `[dummy] infcontrol-layer-bins=${infcontrolLayerBinsUseDummy()} (env INFCONTROL_LAYER_BINS_DUMMY=${JSON.stringify(process.env.INFCONTROL_LAYER_BINS_DUMMY)}; forcedOracle=${forcedOracle})`
  );
  if (forcedOracle && !isOracleThickRuntime()) {
    console.warn(
      "[oracledb] Thick mode is NOT active — Oracle routes (e.g. db/ping) may fail with NJS-116. Install Oracle Instant Client 19+, set ORACLE_INSTANT_CLIENT_LIB_DIR to the directory containing libclntsh.so (Linux) or oci.dll (Windows), unset ORACLE_HOME if it points only to 11g, restart PM2."
    );
  }
});

const shutdown = async () => {
  try {
    await Promise.all([closeOraclePool(), closeProbeWebPool()]);
  } finally {
    process.exit(0);
  }
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
