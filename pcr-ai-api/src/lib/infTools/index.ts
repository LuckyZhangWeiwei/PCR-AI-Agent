/**
 * INF tools index: schemas + dispatch function.
 * All 23 inf_* tools for wafer map analysis.
 */

import {
  runParseWafer, runGetDieMap, runSiteStats, runAnalyzeWafer,
  runListPasses, runComparePasses, runBinMigration, runUnstableDies,
  runEdgeAnalysis, runBinSpatial, runTemperatureCompare,
  runClusterDetect, runTouchAnalysis, runYieldLossBreakdown,
  runPartialProbe, runDrawWaferMap, runClusterShape, runDrawDutBinMap,
} from "./infToolsSingleWafer.js";
import {
  runParseDir, runCompareWafers, runLotDieCompare,
  runLotHeatmap, runLotClusterOverlap, runSlotTrend,
} from "./infToolsLot.js";
import { argStr, argInt } from "./infToolCore.js";

// ── Common parameter sets ────────────────────────────────────────────────

const DEVICE_LOT_SLOT = {
  device: { type: "string", description: "产品代码，如 WA03P02G，必填" },
  lot:    { type: "string", description: "批次 ID，含 '.' 后缀，如 NF12551.1N，必填" },
  slot:   { type: "number", description: "晶圆槽位号（waferId），必填" },
};

const DEVICE_LOT = {
  device: { type: "string", description: "产品代码，必填" },
  lot:    { type: "string", description: "批次 ID，含 '.' 后缀，必填" },
};

const PASS_ID = {
  pass_id: {
    type: "string",
    description: "pass 标识：'final'（最终复合图，默认）| PASS_ID 数字 | 'N@pre'/'N@post'（中断前/后）| 'RETESTBIN:N'",
  },
};

// ── Schemas ────────────────────────────────────────────────────────────────

export const INF_TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "inf_parse_wafer",
      description: "解析单片晶圆 INF 文件，返回良率、bin 分布、各 pass 统计、良品 bin 列表、时间信息。",
      parameters: { type: "object", properties: DEVICE_LOT_SLOT, required: ["device", "lot", "slot"] },
    },
  },
  {
    type: "function",
    function: {
      name: "inf_get_die_map",
      description: "获取指定 pass 的 die 坐标数据（X/Y/Bin/Site）。可生成 ASCII 图，可过滤只返回坏 die。",
      parameters: {
        type: "object",
        properties: {
          ...DEVICE_LOT_SLOT, ...PASS_ID,
          include_dies: { type: "boolean", description: "是否返回 die 坐标列表，默认 false" },
          ascii_map:    { type: "boolean", description: "是否生成 ASCII 文字图（.=良品 X=坏 空格=晶圆外）" },
          bad_only:     { type: "boolean", description: "include_dies=true 时仅返回坏 die" },
        },
        required: ["device", "lot", "slot"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inf_site_stats",
      description: "统计各 DUT（探针台头/site）的良率。返回 site 数量、良率范围、各 site 明细。",
      parameters: { type: "object", properties: DEVICE_LOT_SLOT, required: ["device", "lot", "slot"] },
    },
  },
  {
    type: "function",
    function: {
      name: "inf_analyze_wafer",
      description: "一键综合分析：良率、pass 概况、DUT 差异、自动诊断（是否异常）。适合快速体检一片晶圆。",
      parameters: { type: "object", properties: DEVICE_LOT_SLOT, required: ["device", "lot", "slot"] },
    },
  },
  {
    type: "function",
    function: {
      name: "inf_list_passes",
      description: "列出 INF 文件中的所有测试 pass，含中断标记和良品 bin 列表。调用其他 inf 工具前先用此工具确认 pass_id。",
      parameters: { type: "object", properties: DEVICE_LOT_SLOT, required: ["device", "lot", "slot"] },
    },
  },
  {
    type: "function",
    function: {
      name: "inf_compare_passes",
      description: "对比两个 pass 的 die 结果：统计恢复（不良→良品）、退化（良品→不良）、稳定不良的 die 数量。",
      parameters: {
        type: "object",
        properties: {
          ...DEVICE_LOT_SLOT,
          pass_before: { type: "string", description: "基准 pass（如 '5'）" },
          pass_after:  { type: "string", description: "对比 pass（如 '6' 或 'RETESTBIN'）" },
        },
        required: ["device", "lot", "slot", "pass_before", "pass_after"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inf_bin_migration",
      description: "分析两个 pass 间的 bin 流向矩阵，找出可恢复率最高的坏 bin。",
      parameters: {
        type: "object",
        properties: {
          ...DEVICE_LOT_SLOT,
          pass_before: { type: "string", description: "基准 pass" },
          pass_after:  { type: "string", description: "对比 pass" },
        },
        required: ["device", "lot", "slot", "pass_before", "pass_after"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inf_unstable_dies",
      description: "找出在多个 pass 间反复切换良/不良状态的不稳定 die，特别关注最终判为良品但有风险的 die。",
      parameters: {
        type: "object",
        properties: {
          ...DEVICE_LOT_SLOT,
          min_flips: { type: "number", description: "最小翻转次数，默认 1" },
        },
        required: ["device", "lot", "slot"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inf_edge_analysis",
      description: "分析边缘 die 的良率与内部 die 的差异，按环分组统计（环 1 = 最外圈）。",
      parameters: {
        type: "object",
        properties: {
          ...DEVICE_LOT_SLOT, ...PASS_ID,
          edge_rings: { type: "number", description: "边缘环数，默认 2" },
        },
        required: ["device", "lot", "slot"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inf_bin_spatial",
      description: "分析指定 bin 的空间分布：质心、最近邻距离、ASCII 热点图，判断是随机分散还是局部聚集。",
      parameters: {
        type: "object",
        properties: {
          ...DEVICE_LOT_SLOT, ...PASS_ID,
          bin:            { type: "number", description: "要分析的 bin 编号，必填" },
          include_coords: { type: "boolean", description: "是否返回坐标列表，默认 true" },
          max_points:     { type: "number",  description: "坐标列表截断上限，默认 500" },
        },
        required: ["device", "lot", "slot", "bin"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inf_temperature_compare",
      description: "对比常温(pass1)/高温(pass3)/低温(pass5)三温测试，找出仅在某温度失效的 die（温敏失效分析）。",
      parameters: {
        type: "object",
        properties: {
          ...DEVICE_LOT_SLOT,
          pass_room:      { type: "string",  description: "常温 pass_id，默认 '1'" },
          pass_hot:       { type: "string",  description: "高温 pass_id，默认 '3'" },
          pass_cold:      { type: "string",  description: "低温 pass_id，默认 '5'" },
          include_coords: { type: "boolean", description: "是否返回 die 坐标，默认 false" },
          max_points:     { type: "number",  description: "每类别最多返回坐标数，默认 500" },
          category: {
            type: "string",
            description: "仅返回某类别坐标：only_room_fail | only_hot_fail | only_cold_fail | hot_and_cold_fail | all_three_fail",
          },
        },
        required: ["device", "lot", "slot"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inf_cluster_detect",
      description: "检测坏 die 聚集区域（BFS 算法），返回每个 cluster 的质心、大小、局部良率。",
      parameters: {
        type: "object",
        properties: {
          ...DEVICE_LOT_SLOT, ...PASS_ID,
          bad_bins:         { type: "array",   items: { type: "number" }, description: "自定义坏 bin 列表，默认用 INF PSBN" },
          min_cluster_size: { type: "number",  description: "最小 cluster die 数，默认 3" },
          max_gap:          { type: "number",  description: "BFS 最大 Manhattan 距离，默认 2" },
          max_clusters:     { type: "number",  description: "返回 top N，默认 20" },
          include_dies:     { type: "boolean", description: "是否列出 cluster 内 die 坐标" },
        },
        required: ["device", "lot", "slot"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inf_touch_analysis",
      description: "分析探针接触次数（nTouchCount）分布：高接触 die 列表、按 site 统计平均接触次数。",
      parameters: {
        type: "object",
        properties: {
          ...DEVICE_LOT_SLOT, ...PASS_ID,
          min_touch:              { type: "number",  description: "高接触阈值，默认 2" },
          include_high_touch_dies: { type: "boolean", description: "是否返回高接触 die 列表" },
          max_points:             { type: "number",  description: "列表截断上限，默认 200" },
        },
        required: ["device", "lot", "slot"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inf_yield_loss_breakdown",
      description: "按 bin 分解良率损失：每个坏 bin 的 die 数量、占总 die 比例、占坏 die 比例。",
      parameters: {
        type: "object",
        properties: { ...DEVICE_LOT_SLOT, ...PASS_ID },
        required: ["device", "lot", "slot"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inf_partial_probe",
      description: "检测未测 die（在 tyControl 探针范围内但无测试结果），返回未测 die 数量和坐标。",
      parameters: {
        type: "object",
        properties: {
          ...DEVICE_LOT_SLOT,
          include_coords: { type: "boolean", description: "是否返回未测 die 坐标列表" },
          ascii_map:      { type: "boolean", description: "是否生成 ASCII 图（U=未测）" },
        },
        required: ["device", "lot", "slot"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inf_draw_wafer_map",
      description: "生成可交互 SVG HTML 晶圆图（暗色主题、hover tooltip、多 pass 切换）。返回访问 URL，用浏览器打开查看。",
      parameters: {
        type: "object",
        properties: {
          ...DEVICE_LOT_SLOT,
          passes: {
            type: "string",
            description:
              "pass 规格：默认 'final' = 每个 SmWaferPass 物理层（正测/复测，含全部中断段）+ 合成层；" +
              "'all' 同默认；逗号列表如 '3@pre,5@post' 可只画指定段",
          },
          highlight: {
            type: "string",
            description: "高亮模式：'edge'（边缘 die 金色描边）| 'bin:N'（指定 bin 黄色描边，标出 BIN98 时用 bin:98）| 不填=无",
          },
          bin: {
            type: "number",
            description: "等价于 highlight=bin:N；标出某 bin 位置时传此字段（勿省略 lot/device/slot）",
          },
        },
        required: ["device", "lot", "slot"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inf_cluster_shape",
      description: "用 PCA 分析每个 cluster 的形状：aspect_ratio > scratchThreshold 判为「划伤」，否则「粒子污染」。",
      parameters: {
        type: "object",
        properties: {
          ...DEVICE_LOT_SLOT, ...PASS_ID,
          min_cluster_size:  { type: "number", description: "最小 die 数，默认 3" },
          max_gap:           { type: "number", description: "BFS 最大距离，默认 2" },
          scratch_threshold: { type: "number", description: "划伤宽高比阈值，默认 3.0" },
          max_clusters:      { type: "number", description: "返回 top N，默认 20" },
        },
        required: ["device", "lot", "slot"],
      },
    },
  },
  // ── Lot-level tools ──────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "inf_parse_dir",
      description: "解析整批 lot 所有晶圆 INF，返回每片良率汇总（最多 25 片）。",
      parameters: { type: "object", properties: DEVICE_LOT, required: ["device", "lot"] },
    },
  },
  {
    type: "function",
    function: {
      name: "inf_compare_wafers",
      description: "在 lot 内对比所有晶圆良率，标出离群片（>2σ），可含 bin 分布和 pass 详情。",
      parameters: {
        type: "object",
        properties: {
          ...DEVICE_LOT,
          show_bins:   { type: "boolean", description: "是否含各片 bin 分布" },
          show_passes: { type: "boolean", description: "是否含各片 pass 详情" },
        },
        required: ["device", "lot"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inf_lot_die_compare",
      description: "跨晶圆热点分析：找出 lot 内多片晶圆都出现坏 die 的坐标（批次性缺陷热点）。",
      parameters: {
        type: "object",
        properties: {
          ...DEVICE_LOT, ...PASS_ID,
          mode:          { type: "string", description: "'hotspot'（热点列表，默认）| 'coordinate'（查特定坐标）" },
          min_bad_wafers: { type: "number", description: "热点模式：最少几片有坏 die，默认 3" },
          x: { type: "number", description: "coordinate 模式：X 坐标" },
          y: { type: "number", description: "coordinate 模式：Y 坐标" },
        },
        required: ["device", "lot"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inf_lot_heatmap",
      description: "生成 lot 级坏 die 频率热力图 HTML（绿→黄→红表示越来越多晶圆在该位置失效）。返回访问 URL。",
      parameters: {
        type: "object",
        properties: {
          ...DEVICE_LOT,
          pass_id: { type: "string", description: "pass_id 逗号分隔，默认 'final'（如 'final,1,3'）" },
        },
        required: ["device", "lot"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inf_lot_cluster_overlap",
      description: "检测不同晶圆上 cluster 位置的重叠（批次性聚集缺陷），质心距离 ≤ threshold 则归为同一组。",
      parameters: {
        type: "object",
        properties: {
          ...DEVICE_LOT,
          threshold:        { type: "number", description: "质心归组距离阈值，默认 8" },
          min_cluster_size: { type: "number", description: "最小 cluster die 数，默认 3" },
          max_gap:          { type: "number", description: "BFS 最大距离，默认 2" },
        },
        required: ["device", "lot"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inf_slot_trend",
      description: "按槽位顺序绘制良率趋势折线图，判断是否存在漂移（前半段 vs 后半段），生成 HTML 图表。",
      parameters: {
        type: "object",
        properties: {
          ...DEVICE_LOT,
          drift_threshold: { type: "number", description: "前后半段良率差判定阈值，默认 0.02（2%）" },
        },
        required: ["device", "lot"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inf_draw_dut_bin_map",
      description:
        "生成 DUT × BIN 关系晶圆图（无颜色设计）：用横线/竖线/白色实心等图案区分「该DUT测该BIN」「该DUT测其他BIN」「其他DUT测该BIN」四种状态，hover 显示坐标和分类。适用于判断某个坏 bin 是否由特定 DUT 系统性造成。",
      parameters: {
        type: "object",
        properties: {
          ...DEVICE_LOT_SLOT,
          dut: { type: "number", description: "目标 DUT 编号（来自 inf_site_stats 或 query_inf_site_bin_by_dut），必填" },
          bin: { type: "number", description: "目标 BIN 编号，必填" },
          ...PASS_ID,
        },
        required: ["device", "lot", "slot", "dut", "bin"],
      },
    },
  },
] as const;

// ── Dispatch ───────────────────────────────────────────────────────────────

export async function runInfTool(
  name: string,
  args: Record<string, unknown>
): Promise<string | null> {
  const device = argStr(args, "device");
  const lot    = argStr(args, "lot");
  const slot   = args["slot"] != null ? Number(args["slot"]) : NaN;

  // Validate common required fields
  if (!device) return "inf 工具参数错误: device 不能为空";
  if (!lot)    return "inf 工具参数错误: lot 不能为空（需含 '.' 后缀，如 NF12551.1N）";

  try {
    switch (name) {
      // Single-wafer tools
      case "inf_parse_wafer":         return await runParseWafer(args, device, lot, slot);
      case "inf_get_die_map":         return await runGetDieMap(args, device, lot, slot);
      case "inf_site_stats":          return await runSiteStats(args, device, lot, slot);
      case "inf_analyze_wafer":       return await runAnalyzeWafer(args, device, lot, slot);
      case "inf_list_passes":         return await runListPasses(args, device, lot, slot);
      case "inf_compare_passes":      return await runComparePasses(args, device, lot, slot);
      case "inf_bin_migration":       return await runBinMigration(args, device, lot, slot);
      case "inf_unstable_dies":       return await runUnstableDies(args, device, lot, slot);
      case "inf_edge_analysis":       return await runEdgeAnalysis(args, device, lot, slot);
      case "inf_bin_spatial":         return await runBinSpatial(args, device, lot, slot);
      case "inf_temperature_compare": return await runTemperatureCompare(args, device, lot, slot);
      case "inf_cluster_detect":      return await runClusterDetect(args, device, lot, slot);
      case "inf_touch_analysis":      return await runTouchAnalysis(args, device, lot, slot);
      case "inf_yield_loss_breakdown": return await runYieldLossBreakdown(args, device, lot, slot);
      case "inf_partial_probe":       return await runPartialProbe(args, device, lot, slot);
      case "inf_draw_wafer_map":      return await runDrawWaferMap(args, device, lot, slot);
      case "inf_cluster_shape":       return await runClusterShape(args, device, lot, slot);
      // Lot-level tools
      case "inf_parse_dir":           return await runParseDir(args, device, lot);
      case "inf_compare_wafers":      return await runCompareWafers(args, device, lot);
      case "inf_lot_die_compare":     return await runLotDieCompare(args, device, lot);
      case "inf_lot_heatmap":         return await runLotHeatmap(args, device, lot);
      case "inf_lot_cluster_overlap": return await runLotClusterOverlap(args, device, lot);
      case "inf_slot_trend":          return await runSlotTrend(args, device, lot);
      case "inf_draw_dut_bin_map":    return await runDrawDutBinMap(args, device, lot, slot);
      default: return null; // not an inf tool
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `${name} 执行失败: ${msg}`;
  }
}
