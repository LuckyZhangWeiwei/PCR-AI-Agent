// pcr-ai-api/src/lib/agent/core/agentToolSchemas.ts
export { INF_DRAW_AGENT_SCHEMAS as INF_TOOL_SCHEMAS } from "../../infTools/index.js";

export const TOOL_SCHEMAS = [
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
          mask: {
            type: "string",
            description: "device 末 4 位 mask（如 P02G），与 device 二选一；用于按产品系列后缀查询",
          },
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
          mask: {
            type: "string",
            description: "device 末 4 位 mask（如 P02G），与 device 二选一",
          },
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
        "查询 JB STAR 实测数据（INFCONTROL ⋈ INFLAYERBINLIST）。单 lot 良率读 yieldByPassIdMarkdown（分 sort）与 slotYieldPivotMarkdown；passIdsPresent 列出实际 sort 层。指定 lot 时返回该 lot 全部匹配行（不限 limit）。mask/device 未指定 lot 时另含 recentLotsByTestEnd + totalDistinctLots（库级 lot 枚举，不受 limit 行截断影响）。rows 可能省略。",
      parameters: {
        type: "object",
        properties: {
          device: { type: "string", description: "产品代码" },
          mask: {
            type: "string",
            description: "device 末 4 位 mask（如 P02G），与 device 二选一",
          },
          lot: { type: "string", description: "批次 ID，原样传入完整字符串，含 '.' 后缀（如 'NF12551.1N'），不可截断" },
          slot: { type: "number", description: "晶圆槽位号" },
          cardId: { type: "string", description: "探针卡 ID（CARDID）" },
          probeCardType: { type: "string", description: "探针卡类型" },
          testerId: { type: "string", description: "测试机 ID" },
          tstype: {
            type: "string",
            description:
              "测试平台类型（TSTYPE）：PS16 / J750 / UFLEX / FLEX / MST / 93K。别名自动规范化：ps/ps16/ps1600→PS16，750/j750→J750，flex→FLEX，uflex→UFLEX",
          },
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
        "对 JB STAR 按维度聚合坏 bin die 数。**必填** lot/device/cardId/slot 之一作范围过滤，禁止无过滤调用（否则为全库数据）。若用户未给出任何范围条件，**必须先 ask_clarification 询问**再调用，禁止无过滤调用（服务端将直接报错）。用户已指定 lot 时必传 lot。单 lot 概况/坏 bin Top 排名：用 query_jb_bins(lot) 读 topBadBins，勿用本工具。禁止：最近 N lot（用 recentLotsByTestEnd）、任意两个 bin 的 by-lot 对比（用 binTotalsByLot）。",
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
          mask: {
            type: "string",
            description: "device 末 4 位 mask（如 P02G），与 device 二选一；可作为范围过滤",
          },
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
          tstype: {
            type: "string",
            description:
              "测试平台类型（TSTYPE）：PS16 / J750 / UFLEX / FLEX / MST / 93K。别名自动规范化：ps/ps16/ps1600→PS16，750/j750→J750，flex→FLEX，uflex→UFLEX",
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
      name: "aggregate_probe_card_tester_performance",
      description:
        "按 device 计算 JB STAR 探针卡/测试机组合良率排名与探针卡表现排名（含月度趋势、坏 bin 频率、置信度档位）。用于回答：哪个探针卡+测试机组合良率最好/最差、探针卡表现排名、这张卡良率是不是在变差、这张卡常见坏 bin 是什么。**必填 device**；未传 passId 时按 passId∈{1,3,5} 分别输出三张组合表+三张探针卡表（pass1/pass3/pass5，不跨 sort 合并）。结果含月度良率趋势表（仅≥2个月数据的卡）与坏 bin Top3 频率表（仅频率统计，非坐标级分布）。数字均由服务端计算直出，禁止在回复里自行改写。",
      parameters: {
        type: "object",
        properties: {
          device: { type: "string", description: "device 代码，必填" },
          passId: {
            type: "number",
            description:
              "测试层 PASSID：pass1/常温/sort1→1，pass3/高温/sort2→3，pass5/低温/sort3→5（勿用2/4）；不传则分 1/3/5 三组分别输出",
          },
          testEndFrom: { type: "string", description: "TESTEND 起始时间（ISO），不传默认最近一年" },
          testEndTo: { type: "string", description: "TESTEND 结束时间（ISO）" },
        },
        required: ["device"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_chart",
      description:
        "根据数据生成 ECharts 图表。占比 pie 可传顶层 labels+values；或 data:{labels,series}。刚执行 query_inf_site_bin_by_dut 后画 DUT 占比可只传 chartType=pie 与含 DUT 编号的 title。**调用前必须已有真实数值**；禁止传空数组或占位符——若数据未获取，先调相关查询工具。",
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
          options: {
            type: "array",
            items: { type: "string" },
            description:
              "候选 device 列表（mask 查到多个完整 device 时使用）；前端渲染为可点选按钮，每项为用户选择后发送的文本；其他场景不传",
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
        "查询某个筛选维度的可用值列表。field=\"device\"+mask 时优先 domain=\"both\"（一次合并 Yield+JB，避免漏掉只出现在单域的 device，如 N84R→WC06N84R+WC07N84R）。mask 可写在 filterBy.mask 或顶层 mask。",
      parameters: {
        type: "object",
        properties: {
          domain: {
            type: "string",
            enum: ["yield", "jb", "both"],
            description:
              "数据域：yield = Yield Monitor；jb = JB STAR；both = 合并两域（field=device+mask 时推荐，防止单域漏 device）",
          },
          field: {
            type: "string",
            description:
              "yield 支持: probeCard, probeCardType, hostname, lotId, device；jb 支持: cardId, probeCardType, testerId, lot, device。field=\"device\" 须传 mask",
          },
          mask: {
            type: "string",
            description: "device 末 4 位（如 P02G）；field=\"device\" 时可放顶层，等价于 filterBy.mask",
          },
          filterBy: {
            type: "object",
            description: "可选过滤：search（对返回值做模糊匹配，如 hostname/testerId 用于机台名搜索）、mask（配合 field=\"device\"）、device、probeCardType",
            properties: {
              search: { type: "string", description: "对目标字段值做大小写不敏感的包含匹配，如 \"1600\" 可筛出所有含 1600 的 hostname/testerId" },
              mask: { type: "string", description: "device 末 4 位（基础段），如 \"N06Z\"，配合 field=\"device\" 使用" },
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
      name: "query_lot_underperforming_duts",
      description:
        "按 lot 筛选 probe DUT 良率偏低的 site：DUT良率 < lot 整体良率 × thresholdRatio（默认 0.75）。" +
        "仅需 lot；device / probeCardType 由 JB 反查。按 pass 分开输出。数据来自 INF 聚合，非 Oracle。",
      parameters: {
        type: "object",
        properties: {
          lot: { type: "string", description: "批次 ID，含 '.' 后缀，必填" },
          device: {
            type: "string",
            description: "可选；省略时由 JB STAR 按 lot 反查",
          },
          passId: {
            type: "number",
            description: "PASS_ID：pass1→1，pass3→3，pass5→5",
          },
          passIds: {
            type: "array",
            items: { type: "number" },
            description: "多 pass，默认 [1,3,5]",
          },
          thresholdRatio: {
            type: "number",
            description: "相对 lot 整体良率的比例阈值，默认 0.75",
          },
        },
        required: ["lot"],
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
