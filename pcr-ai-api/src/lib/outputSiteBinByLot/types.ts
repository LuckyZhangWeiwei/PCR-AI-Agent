import type { SiteBinTestEndWindow } from "../siteBinByLotTestEndWindow.js";
import type { SiteBinWaferSource } from "../infOracleMapFallback.js";

/** 写入响应 meta，说明本接口业务含义（交接 / 前端展示用）。 */
export const SITE_BIN_BY_LOT_SUMMARY =
  "Per wafer test pass (one or more PASS_ID in INF, PASS_TYPE=TEST only): for each bin result on the map, which probe-card DUT (test site) produced that bin and how many die at that bin×DUT. Data from INF layers iBinCodeLast + iTestSiteLast via output_site_bin_bylot.pl.";

export const SITE_BIN_LAYERS_BATCH_SUMMARY =
  "Batch layer-scoped DUT×BIN: merge passId×bin×dut dieCount across multiple JB detail rows (each with optional testEnd/keynumber/passNum) in one request.";

/** 兼容：device+lot、无 probeCardType 时扫描 lot 目录下全部 r_1-{slot}。 */
export const SITE_BIN_BY_LOT_LOT_DIR_AGG_SUMMARY =
  "Lot-level aggregation: sum dieCount across all wafer INF files under {INF_STORAGE_ROOT}/{DEVICE}/{LOT}/ (r_1-{slot}), per passId×bin×dut. Same Perl PASS_TYPE=TEST filter as single-wafer mode.";

export const SITE_BIN_BY_LOT_LOT_AGG_SUMMARY =
  "Lot-level aggregation (probeCardType filter): sum dieCount across JB-matched wafer INFs under {INF_STORAGE_ROOT}/{DEVICE}/{LOT}/ for one probeCardType and requested passId(s), per passId×bin×dut.";

export const SITE_BIN_BY_LOT_DEVICE_AGG_SUMMARY =
  "Device-level aggregation: pick the N most recent lots by MAX(TESTEND) (default topN=10, max 50), then sum dieCount across readable wafer INFs under those lots for one probeCardType and passId(s), per passId×bin×dut.";

export class OutputSiteBinByLotValidationError extends Error {
  readonly statusCode = 400;
  readonly code = "VALIDATION_ERROR";
}

export class OutputSiteBinByLotNotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = "LOT_INF_NOT_FOUND";
}

export type RunSiteBinForWaferOpts = {
  /** JB 明细行 KEYNUMBER（可选，与 testEnd 联用）。 */
  keynumber?: number;
  /** JB 明细行 PASSNUM。 */
  passNum?: number;
  /** JB 明细行 TESTEND（ISO）；有值时按该层 map 取数，不合并同 slot 其它层。 */
  testEnd?: string;
};

export type RunOutputSiteBinByLotAggregateResult = {
  aggregateScope: "lot" | "device";
  deviceDir?: string;
  lotDir?: string;
  /** 仅 JB/卡类型过滤路径返回 */
  probeCardType?: string;
  testEndWindow?: SiteBinTestEndWindow;
  waferCount: number;
  waferSlots: number[];
  waferLots?: string[];
  /** device：按 TESTEND 选中的 lot（新→旧） */
  selectedLots?: string[];
  topN?: number;
  skippedInfPaths: string[];
  /** INF 不可读但 Oracle map 回退成功的路径 */
  oracleFallbackPaths?: string[];
  data: SiteBinByLotData;
  stderrParts: string[];
};

export class InfSiteBinUnavailableError extends Error {
  readonly infPath: string;
  constructor(infPath: string, message: string) {
    super(message);
    this.name = "InfSiteBinUnavailableError";
    this.infPath = infPath;
  }
}

/** 明细多选 DUT×BIN：一次 HTTP 拉多层，服务端串行 Oracle 后合并。 */
export const SITE_BIN_LAYERS_BATCH_MAX = 50;

export type SiteBinLayerRequest = {
  infPath: string;
  device: string;
  passIds: number[];
  keynumber?: number;
  passNum?: number;
  testEnd?: string;
};

export type SiteBinLayerResult = {
  infPath: string;
  passIds: number[];
  mapSource: SiteBinWaferSource;
  keynumber?: number;
  passNum?: number;
  testEnd?: string;
  passes: SiteBinPass[];
  notices: string[];
};

export type RunSiteBinLayersBatchResult = {
  layerCount: number;
  layers: SiteBinLayerResult[];
  data: SiteBinByLotData;
  notices: string[];
};

/** Probe card 上的测试 DUT（site）编号；无 site 层时为 `single`。 */
export type SiteBinDutEntry = {
  dut: number | "single";
  /** 该 pass 的 wafer map 上，此 bin 且此 DUT 的测试 die 颗数 */
  dieCount: number;
};

export type SiteBinEntry = {
  /** 测试结果 bin 编号，标签形如 `bin30`（来自 iBinCodeLast 解码） */
  bin: string;
  /** 测出该 bin 的各 probe card DUT 及颗数 */
  duts: SiteBinDutEntry[];
};

/** 一片 wafer 的一次测试 pass（INF SmWaferPass / PASS_ID） */
export type SiteBinPass = {
  passId: number;
  bins: SiteBinEntry[];
};

export type SiteBinByLotData = {
  passes: SiteBinPass[];
};

export type RunOutputSiteBinByLotResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};
