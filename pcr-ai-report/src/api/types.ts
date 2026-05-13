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

/** `GET /api/v3/manifest` 等返回的 v3 目录 */
export type ManifestV3Response = {
  apiVersion?: string;
  title?: string;
  description?: string;
  catalogScope?: string;
  endpoints?: ManifestEndpoint[];
};

export type YieldMonitorResponse = {
  meta?: ApiMeta;
  limit: number;
  /** v3 列表 `…/yield-monitor-triggers/v3` */
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

/** `GET …/yield-monitor-triggers/v3/aggregate` */
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

/** `GET …/infcontrol-layer-bins/v3`（行形状与 v2 列表一致） */
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

/** GET …/table-rows（开发辅助，与 manifest 一致挂载在 v3） */
export type TableRowsResponse = {
  meta?: ApiMeta;
  table: string;
  limit: number;
  rows: Record<string, unknown>[];
};
