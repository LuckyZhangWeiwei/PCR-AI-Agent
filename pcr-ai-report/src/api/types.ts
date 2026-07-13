export type ApiMeta = {
  apiVersion: string;
  requestId?: string;
};

export type ApiErrorBody = {
  error: string;
  code: string;
  detail?: string;
};

export type Manifest = {
  apiVersion: string;
  title: string;
  description?: string;
  endpoints: unknown[];
};

export type ManifestEndpoint = {
  path?: string;
  purpose?: string;
  methods?: string[];
};

/** `GET /api/v3/manifest` 或 **`GET /api/v4/manifest`** 返回的精简目录 */
export type ManifestCatalogResponse = {
  apiVersion?: string;
  title?: string;
  description?: string;
  catalogScope?: string;
  endpoints?: ManifestEndpoint[];
};

/** @deprecated 使用 **`ManifestCatalogResponse`** */
export type ManifestV3Response = ManifestCatalogResponse;

export type YieldMonitorResponse = {
  meta?: ApiMeta;
  limit: number;
  /** 产量列表（v3/v4 路径不同，响应形状一致） */
  limitMax?: number;
  orderBy: string;
  filters: Record<string, unknown>;
  count: number;
  rows: Record<string, unknown>[];
  probeCardSummary?: { probeCard: string; count: number }[];
  probeCardSummaryOrderBy?: string;
  /** 与 probeCardSummary 同一套筛选下的全量 HOSTNAME 计数（默认随 includeProbeCardSummary） */
  hostnameSummary?: { hostname: string; count: number }[];
  hostnameSummaryOrderBy?: string;
};

/** `GET …/yield-monitor-triggers/v3/aggregate` 或 **`…/v4/aggregate`** */
export type YieldMonitorV3AggregateResponse = {
  meta?: ApiMeta;
  dimensions: string[];
  groupTop: number;
  orderBy: string;
  filters: Record<string, unknown>;
  totalRowsMatching: number;
  groups: AggregateGroup[];
  documentation?: string;
};

/** `GET …/yield-monitor-triggers/v3/period-alarm-trend` */
export type PeriodAlarmTopTester = {
  hostname: string;
  count: number;
};

export type PeriodAlarmTopDevice = {
  device: string;
  count: number;
};

export type PeriodAlarmTopProbeCard = {
  probeCard: string;
  count: number;
};

export type PeriodAlarmTrendBucket = {
  label: string;
  timeStampFrom: string;
  timeStampTo: string;
  total: number;
  testerCount: number;
  cardCount: number;
  binCount: number;
  dutCount: number;
  testerAlarmNumerator: number;
  /** 同期同筛选、该桶内 JB Start distinct (LOT,SLOT) 片数（分母；同片多断片计 1） */
  testerActivityTotal: number;
  testerAlarmRate: number | null;
  topTesters: PeriodAlarmTopTester[];
  topDevices: PeriodAlarmTopDevice[];
  topProbeCards: PeriodAlarmTopProbeCard[];
};

export type YieldMonitorPeriodAlarmTrendResponse = {
  meta?: ApiMeta;
  period: "week" | "month";
  filters: Record<string, unknown>;
  buckets: PeriodAlarmTrendBucket[];
  documentation?: string;
};

export type InfcontrolLayerBinsResponse = {
  meta?: ApiMeta;
  limit: number;
  orderBy: string;
  filters: Record<string, unknown>;
  count: number;
  rows: Record<string, unknown>[];
};

export type AggregateGroup = {
  key: string;
  count: number;
  parts: Record<string, string>;
};

export type InfcontrolAggregateResponse = {
  meta?: ApiMeta;
  groupBy: string[];
  groupTop: number;
  orderBy: string;
  filters: Record<string, unknown>;
  totalRowsMatching: number;
  groups: AggregateGroup[];
};

/** Single aggregate block from **`GET …/v4/combined`** response `aggregates` map. */
export interface InfcontrolAggregateBlock {
  groupBy: string;
  groupTop: number;
  totalRowsMatching: number;
  groups: AggregateGroup[];
}

/** **`GET …/v4/combined`** response — list rows + all aggregates in one call. */
export interface InfcontrolCombinedResponse extends InfcontrolLayerBinsV3Response {
  aggregates: Record<string, InfcontrolAggregateBlock>;
}

/** GET …/infcontrol-layer-bins/v2（v2 列表；报表层控已改用 v3，类型仍可用于对照） */
export type InfcontrolLayerBinV2BinCell = {
  value: number;
  n: number;
  isGoodBin: boolean;
};

export type InfcontrolLayerBinsV2Response = {
  meta?: ApiMeta;
  limit: number;
  limitMax: number;
  orderBy: string;
  filters: Record<string, unknown>;
  count: number;
  rows: Record<string, unknown>[];
};

/** `GET …/infcontrol-layer-bins/v3` 或 **`…/v4`**（行形状与 v2 列表一致） */
export type InfcontrolLayerBinsV3Response = InfcontrolLayerBinsV2Response;

/** GET …/infcontrol-layer-bins/v2/top-bad-bins */
export type InfcontrolTopBadBinsEntry = {
  n: number;
  badTotal: number;
};

export type InfcontrolTopBadBinsResponse = {
  meta?: ApiMeta;
  rankTop: number;
  rankTopMin: number;
  rankTopMax: number;
  orderBy: string;
  filters: Record<string, unknown>;
  bins: InfcontrolTopBadBinsEntry[];
};

/** GET …/table-rows（开发辅助；与 **`API_PREFIX`** 同挂载） */
export type TableRowsResponse = {
  meta?: ApiMeta;
  table: string;
  limit: number;
  rows: Record<string, unknown>[];
};

/** Single bin cell from 层控列表行 **`bins[]`** */
export type InfcontrolBinCell = {
  n: number;
  value: number;
  isGoodBin: boolean;
};

/** Typed 层控列表行（JB STAR，`…/v3` 或 **`…/v4`**） */
export type InfcontrolLayerBinV3Row = {
  KEYNUMBER?: number;
  DEVICE?: string;
  /** DEVICE 末 4 位，由 API enrichInfcontrolLayerBinV3ListRow 注入 */
  MASK?: string | null;
  LOT?: string;
  SLOT?: number;
  MESLOT?: string;
  TESTERID?: string;
  TSTYPE?: string;
  CARDID?: string;
  /** CARDID 首个 `-` 前段，由 API enrichInfcontrolLayerBinV3ListRow 注入 */
  PROBECARDTYPE?: string | null;
  PIBID?: string;
  PROBE?: string;
  GROSSDIE?: number;
  PASSID?: number;
  PASSNUM?: number;
  SESSIONNUMBER?: string;
  TESTSTART?: string;
  TESTEND?: string;
  LAYERNAME?: string;
  PASSTYPE?: string;
  PASSBIN?: string;
  passBinPair?: [number, number] | null;
  bins: InfcontrolBinCell[];
};

/** Typed 产量列表行（**`…/v3`** 或 **`…/v4`**） */
export type YieldMonitorV3Row = {
  ID?: string | number;
  HOSTNAME?: string;
  DEVICE?: string;
  /** DEVICE 末 4 位，由 API enrichYieldMonitorTriggerV3ListRow 注入 */
  MASK?: string | null;
  LOTID?: string;
  WAFER?: string;
  PASS?: number;
  TYPE?: string;
  TRIGGER_LABEL?: string;
  TIME_STAMP?: string;
  PROBECARD?: string;
  /** PROBECARD 首个 `-` 前段，由 API enrichYieldMonitorTriggerV3ListRow 注入 */
  PROBECARDTYPE?: string | null;
  dutNumber?: number | null;
};

/** GET …/yield-monitor-triggers/v3 或 v4 (typed rows) */
export type YieldMonitorV3Response = {
  meta?: ApiMeta;
  limit: number;
  limitMax?: number;
  orderBy: string;
  filters: Record<string, unknown>;
  count: number;
  rows: YieldMonitorV3Row[];
};

/** Single aggregate block from **`GET …/v3/combined`** response `aggregates` map. */
export interface YieldMonitorAggregateBlock {
  dimensions: string[];
  groupTop: number;
  totalRowsMatching: number;
  groups: AggregateGroup[];
}

/** **`GET …/v3/combined`** — list rows + all v3 aggregates in one call. */
export interface YieldMonitorCombinedResponse extends YieldMonitorV3Response {
  aggregates: Record<string, YieldMonitorAggregateBlock>;
}

export type SiteBinDutEntry = {
  dut: number | "single";
  dieCount: number;
};

export type SiteBinEntry = {
  bin: string;
  duts: SiteBinDutEntry[];
};

export type SiteBinPass = {
  passId: number;
  bins: SiteBinEntry[];
};

export type SiteBinByLotResponse = {
  meta: { apiVersion: string; requestId: string; summary: string };
  infPath: string;
  passIds: number[];
  passes: SiteBinPass[];
  /** inf = Perl/INF 整片；oracle = 分层或 fallback 库表 map */
  mapSource?: "inf" | "oracle";
  keynumber?: number;
  passNum?: number;
  testEnd?: string;
  notices?: string[];
};

/** POST site-bin-bylot/layers 批量分层响应 */
export type SiteBinLayersBatchResponse = {
  meta: { apiVersion: string; requestId: string; summary: string };
  layerCount: number;
  mapSources?: Array<"inf" | "oracle">;
  layers: Array<{
    infPath: string;
    passIds: number[];
    mapSource?: "inf" | "oracle";
    keynumber?: number;
    passNum?: number;
    testEnd?: string;
    passes: SiteBinPass[];
  }>;
  passes: SiteBinPass[];
  notices?: string[];
};
