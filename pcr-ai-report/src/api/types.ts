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

export type YieldMonitorResponse = {
  meta?: ApiMeta;
  limit: number;
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

/** GET /api/v1/infcontrol-layer-bins/v2 */
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

/** GET /api/v1/infcontrol-layer-bins/v2/top-bad-bins */
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

/** GET /api/v1/table-rows — dev helper per manifest */
export type TableRowsResponse = {
  meta?: ApiMeta;
  table: string;
  limit: number;
  rows: Record<string, unknown>[];
};
