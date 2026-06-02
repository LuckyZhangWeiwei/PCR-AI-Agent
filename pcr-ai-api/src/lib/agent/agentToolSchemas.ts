// pcr-ai-api/src/lib/agent/agentToolSchemas.ts
import { INF_TOOL_SCHEMAS } from "../infTools/index.js";

export const TOOL_SCHEMAS = [
  ...INF_TOOL_SCHEMAS,
  {
    type: "function",
    function: {
      name: "query_yield_triggers",
      description:
        "查询 Yield Monitor 探针卡 DUT 不均衡报警记录（delta_diff），返回触发条数/时间，不是 die 良品率%。用户问良率/yield%/lot yield 时请用 query_jb_bins。",
      parameters: {
        type: "object",
        properties: {
          device: { type: "string", description: "产品代码，如 WA03P02G" },
          lotId: { type: "string", description: "批次 ID，原样传入完整字符串，含 '.' 后缀（如 'NF12551.1N'），不可截断" },
          wafer: { type: "string", description: "晶圆编号" },
          hostname: { type: "string", description: "测试机名称" },
          probeCard: { type: "string", description: "探针卡 ID" },
          probeCardType: {
            type: "string",
            description: "探针卡类型（PROBECARD 第一段，- 之前）",
          },
          pass: { type: "number", description: "Pass 编号" },
          timeFrom: { type: "string", description: "开始时间 ISO 8601" },
          timeTo: { type: "string", description: "结束时间 ISO 8601" },
          limit: {
            type: "number",
            description: "返回行数，默认 50，最大 200",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "aggregate_yield_triggers",
      description:
        "对 Yield Monitor 报警按维度聚合统计触发次数（count），不是 die 良品率%。用户问良率/yield%/各 lot 良率排名时请用 query_jb_bins 并读 lotYieldRankByTestEnd。",
      parameters: {
        type: "object",
        properties: {
          dimensions: {
            type: "string",
            description:
              "逗号分隔的聚合维度，可选: device, hostname, lotId, wafer, probeCard, probeCardType, pass, timeDay",
          },
          groupTop: {
            type: "number",
            description: "返回 top N 组，默认 10，最大 25",
          },
          device: { type: "string" },
          lotId: { type: "string", description: "批次 ID，原样传入完整字符串，含 '.' 后缀（如 'NF12551.1N'），不可截断" },
          wafer: { type: "string" },
          hostname: { type: "string" },
          probeCard: { type: "string" },
          probeCardType: { type: "string" },
          pass: { type: "number" },
          timeFrom: { type: "string", description: "开始时间 ISO 8601" },
          timeTo: { type: "string", description: "结束时间 ISO 8601" },
        },
        required: ["dimensions"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_jb_bins",
      description:
        "查询 JB STAR 实测数据（INFCONTROL ⋈ INFLAYERBINLIST）。单 lot 良率读 yieldByPassIdMarkdown（分 sort）与 slotYieldPivotMarkdown；passIdsPresent 列出实际 sort 层。指定 lot 时返回该 lot 全部匹配行（不限 limit）。另含 cardByPassId、slotYieldInterruptMarkdown 等。rows 可能省略。",
      parameters: {
        type: "object",
        properties: {
          device: { type: "string", description: "产品代码" },
          lot: { type: "string", description: "批次 ID，原样传入完整字符串，含 '.' 后缀（如 'NF12551.1N'），不可截断" },
          slot: { type: "number", description: "晶圆槽位号" },
          cardId: { type: "string", description: "探针卡 ID（CARDID）" },
          probeCardType: { type: "string", description: "探针卡类型" },
          testerId: { type: "string", description: "测试机 ID" },
          passId: {
            type: "number",
            description:
              "测试层 PASSID：pass1/sort1/常温→1，pass3/sort2/高温→3，pass5/sort3/低温→5（勿用2/4）；回复用 pass1/3/5",
          },
          meslot: { type: "string", description: "MES 槽位" },
          testEndFrom: {
            type: "string",
            description: "测试结束时间起 ISO 8601",
          },
          testEndTo: {
            type: "string",
            description: "测试结束时间止 ISO 8601",
          },
          limit: {
            type: "number",
            description: "返回行数，默认 50，最大 200；传 lot 时忽略（拉全量行以免漏 sort1）",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "aggregate_jb_bins",
      description:
        "对 JB STAR 按维度聚合坏 bin die 数。**必填** lot/device/cardId/slot 之一作范围过滤，禁止无过滤调用（否则为全库数据）。用户已指定 lot 时必传 lot。单 lot 概况/坏 bin Top 排名：用 query_jb_bins(lot) 读 topBadBins，勿用本工具。禁止：最近 N lot（用 recentLotsByTestEnd）、BIN10 vs BIN66（用 bin10Vs66ByLot）。",
      parameters: {
        type: "object",
        properties: {
          groupBy: {
            type: "string",
            description:
              "逗号分隔的分组维度，可选（bin 自动包含）: device, lot, slot, cardId, probeCardType, testerId, passId, layerName, passResume, passResult, meslot",
          },
          groupTop: {
            type: "number",
            description: "返回 top N 组，默认 10，最大 50",
          },
          device: { type: "string" },
          lot: { type: "string", description: "批次 ID，原样传入完整字符串，含 '.' 后缀（如 'NF12551.1N'），不可截断" },
          slot: { type: "number" },
          cardId: { type: "string" },
          probeCardType: { type: "string" },
          testerId: { type: "string" },
          passId: {
            type: "number",
            description:
              "测试层 PASSID：pass1/常温/sort1→1，pass3/高温/sort2→3，pass5/低温/sort3→5（勿用2/4）",
          },
          meslot: { type: "string" },
          testEndFrom: { type: "string" },
          testEndTo: { type: "string" },
        },
        required: ["groupBy"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_chart",
      description:
        "根据数据生成 ECharts 图表。占比 pie 可传顶层 labels+values；或 data:{labels,series}。刚执行 query_inf_site_bin_by_dut 后画 DUT 占比可只传 chartType=pie 与含 DUT 编号的 title。",
      parameters: {
        type: "object",
        properties: {
          chartType: {
            type: "string",
            enum: ["bar", "line", "pie", "scatter"],
            description: "图表类型，占比默认 pie",
          },
          title: { type: "string", description: "图表标题（含 DUT/BIN 编号便于自动取数）" },
          labels: {
            type: "array",
            items: { type: "string" },
            description: "分类标签（与 values 成对，可替代 data）",
          },
          values: {
            type: "array",
            items: { type: "number" },
            description: "各分类数值（与 labels 成对）",
          },
          seriesName: { type: "string", description: "单系列名称，默认「占比」" },
          data: {
            type: "object",
            description: "嵌套图表数据 labels + series",
            properties: {
              labels: {
                type: "array",
                items: { type: "string" },
                description: "X 轴标签或 pie 分类",
              },
              series: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    values: { type: "array", items: { type: "number" } },
                  },
                  required: ["name", "values"],
                },
              },
            },
          },
        },
        required: ["chartType", "title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_clarification",
      description:
        "当用户请求模糊或缺少关键信息时，调用此工具向用户提问。问题应简洁明确，每次只问一个问题。",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "向用户提出的澄清问题",
          },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_filter_values",
      description:
        "查询某个筛选维度的可用值列表（如探针卡、批次号、测试机等）。在需要精确筛选但不知道具体值时调用。不要用它查 device 或时间范围——那些已在系统提示词的数据快照中。",
      parameters: {
        type: "object",
        properties: {
          domain: {
            type: "string",
            enum: ["yield", "jb"],
            description: "数据域：yield = Yield Monitor；jb = JB STAR",
          },
          field: {
            type: "string",
            description:
              "yield 支持: probeCard, probeCardType, hostname, lotId；jb 支持: cardId, probeCardType, testerId, lot",
          },
          filterBy: {
            type: "object",
            description: "可选前置过滤，如 { device: 'WA03P02G' }",
            properties: {
              device: { type: "string" },
              probeCardType: { type: "string" },
            },
            additionalProperties: false,
          },
          limit: {
            type: "number",
            description: "返回条数，默认 20，最大 50",
          },
        },
        required: ["domain", "field"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_lot_dut_bin_agg",
      description:
        "读取某个 lot 全部 wafer INF（最多 25 片求和），按 pass 聚合各 bin 由哪个 DUT 贡献的 dieCount。" +
        "适用于「lot 整批 DUT 分布/坏 bin 集中在哪个 DUT」问题。数据来自磁盘 INF，非 Oracle。" +
        "调用前须已通过 query_jb_bins 获得 device+lot；建议传 probeCardType（来自 cardByPassId）提高精度，省略时扫 lot 目录全部 wafer。",
      parameters: {
        type: "object",
        properties: {
          device: { type: "string", description: "产品代码，必填" },
          lot: { type: "string", description: "批次 ID，含 '.' 后缀，必填" },
          passId: {
            type: "number",
            description: "PASS_ID：pass1/常温→1，pass3/高温→3，pass5/低温→5",
          },
          passIds: {
            type: "array",
            items: { type: "number" },
            description: "多 pass，如 [1,3,5]",
          },
          probeCardType: {
            type: "string",
            description:
              "探针卡类型（来自 query_jb_bins 的 cardByPassId 首段，如 '6045'）；省略时扫 lot 目录全部 wafer",
          },
          focusBin: { type: "number", description: "结论聚焦某一 BIN（可选）" },
        },
        required: ["device", "lot"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_inf_site_bin_by_dut",
      description:
        "读取该片 wafer 的 INF 文件（服务端由 device+lot+slot 自动拼路径），按 pass 统计各 bin 由哪个 DUT(site) 测得及 dieCount。数据来自磁盘 INF，非 Oracle JB；与 query_jb_bins 数据源不同。调用前须已通过 query_jb_bins 获得 device+lot+slot+CARDID。",
      parameters: {
        type: "object",
        properties: {
          device:   { type: "string", description: "产品代码，必填" },
          lot:      { type: "string", description: "批次 ID，含 '.' 后缀，必填" },
          slot:     { type: "number", description: "waferId（JB 字段名 slot / INFCONTROL.SLOT），必填" },
          passId: {
            type: "number",
            description:
              "PASS_ID：pass1/常温/sort1→1，pass3/高温/sort2→3，pass5/低温/sort3→5（禁止2/4）",
          },
          passIds: {
            type: "array",
            items: { type: "number" },
            description: "多 pass 对比，如 sort1+2+3 用 [1,3,5]",
          },
          focusBin: { type: "number", description: "结论聚焦某一 BIN" },
          cardId:   { type: "string", description: "探针卡 ID（来自 query_jb_bins 的 CARDID），用于结论描述卡号" },
        },
        required: ["device", "lot", "slot"],
      },
    },
  },
] as const;
