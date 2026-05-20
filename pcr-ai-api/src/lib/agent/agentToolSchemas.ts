// pcr-ai-api/src/lib/agent/agentToolSchemas.ts

export const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "query_yield_triggers",
      description:
        "查询 Yield Monitor 触发记录列表（delta_diff 类型）。返回最近触发的原始记录。",
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
      description: "对 Yield Monitor 触发记录按维度聚合统计触发次数。",
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
        "查询 JB STAR Layer Bins 数据列表（INFCONTROL ⋈ INFLAYERBINLIST，PASSTYPE=TEST）。返回 rows[].badBins/goodBins：每项 { bin: BIN编号, dieCount: die颗数 }，禁止把 dieCount 写成 BIN 号。结果中 distinctSlots 字段列出本次查询范围内所有出现过的 slot 编号（去重升序），可直接用于 wafer 列表枚举。",
      parameters: {
        type: "object",
        properties: {
          device: { type: "string", description: "产品代码" },
          lot: { type: "string", description: "批次 ID，原样传入完整字符串，含 '.' 后缀（如 'NF12551.1N'），不可截断" },
          slot: { type: "number", description: "晶圆槽位号" },
          cardId: { type: "string", description: "探针卡 ID（CARDID）" },
          probeCardType: { type: "string", description: "探针卡类型" },
          testerId: { type: "string", description: "测试机 ID" },
          passId: { type: "number", description: "Pass ID" },
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
      name: "aggregate_jb_bins",
      description:
        "对 JB STAR 数据按维度聚合统计 die 数量（UNPIVOT BIN0-BIN255，仅统计坏 bin）。bin 维度自动包含。",
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
          passId: { type: "number" },
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
        "根据数据生成 ECharts 图表配置。调用后图表会内嵌显示在对话中。",
      parameters: {
        type: "object",
        properties: {
          chartType: {
            type: "string",
            enum: ["bar", "line", "pie", "scatter"],
            description: "图表类型",
          },
          title: { type: "string", description: "图表标题" },
          data: {
            type: "object",
            description: "图表数据",
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
            required: ["labels", "series"],
          },
        },
        required: ["chartType", "title", "data"],
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
      name: "query_inf_site_bin_by_dut",
      description:
        "读取该片 wafer 的 INF 文件（服务端由 device+lot+slot 自动拼路径），按 pass 统计各 bin 由哪个 DUT(site) 测得及 dieCount。数据来自磁盘 INF，非 Oracle JB；与 query_jb_bins 数据源不同。调用前须已通过 query_jb_bins 获得 device+lot+slot+CARDID。",
      parameters: {
        type: "object",
        properties: {
          device:   { type: "string", description: "产品代码，必填" },
          lot:      { type: "string", description: "批次 ID，含 '.' 后缀，必填" },
          slot:     { type: "number", description: "wafer 槽位 SLOT，必填" },
          passId:   { type: "number", description: "PASS_ID；sort1/2/3→1/3/5" },
          passIds:  { type: "array", items: { type: "number" }, description: "多 pass 对比" },
          focusBin: { type: "number", description: "结论聚焦某一 BIN" },
          cardId:   { type: "string", description: "探针卡 ID（来自 query_jb_bins 的 CARDID），用于结论描述卡号" },
        },
        required: ["device", "lot", "slot"],
      },
    },
  },
] as const;
