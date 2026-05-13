import "./loadEnv.js";

import { createApp } from "./app.js";
import { infcontrolLayerBinsUseDummy } from "./lib/infcontrolLayerBinDummy.js";
import { yieldMonitorTriggersUseDummy } from "./lib/yieldMonitorTriggerDummy.js";
import { closeOraclePool, closeProbeWebPool } from "./oracle.js";

const port = Number(process.env.PORT) || 30008;
const app = createApp();

app.listen(port, () => {
  console.log(`pcr-ai-api listening on http://localhost:${port}`);
  console.log(
    `[dummy] yield-monitor-triggers=${yieldMonitorTriggersUseDummy()} (env YIELD_MONITOR_TRIGGERS_DUMMY=${JSON.stringify(process.env.YIELD_MONITOR_TRIGGERS_DUMMY)})`
  );
  console.log(
    `[dummy] infcontrol-layer-bins=${infcontrolLayerBinsUseDummy()} (env INFCONTROL_LAYER_BINS_DUMMY=${JSON.stringify(process.env.INFCONTROL_LAYER_BINS_DUMMY)})`
  );
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
