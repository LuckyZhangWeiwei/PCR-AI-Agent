// pcr-ai-api/src/lib/agent/tools/agentToolInfSiteBin.ts
import {
  runOutputSiteBinByLot,
  parseSiteBinByLotJson,
} from "../../outputSiteBinByLot.js";
import { tryResolveSiteBinByLotDummy } from "../../outputSiteBinByLotDummy.js";
import { buildInfPath } from "../../buildInfPath.js";
import { truncateResult } from "./agentToolHandlers.js";
import { compactSiteBinPasses } from "./agentToolDutBinAgg.js";

export async function toolQueryInfSiteBinByDut(
  args: Record<string, unknown>,
  maxChars: number
): Promise<string> {
  const device = typeof args["device"] === "string" ? args["device"].trim() : "";
  const lot    = typeof args["lot"]    === "string" ? args["lot"].trim()    : "";
  const slotRaw = args["slot"];
  const slot = typeof slotRaw === "number" ? Math.round(slotRaw) : NaN;
  const cardId = typeof args["cardId"] === "string" ? args["cardId"].trim() : undefined;

  if (!device) return "query_inf_site_bin_by_dut 参数错误: device 不能为空";
  if (!lot)    return "query_inf_site_bin_by_dut 参数错误: lot 不能为空";
  if (!Number.isFinite(slot)) return "query_inf_site_bin_by_dut 参数错误: slot 必须是整数";

  const passIds: number[] = [];
  if (typeof args["passId"] === "number") passIds.push(Math.round(args["passId"]));
  if (Array.isArray(args["passIds"])) {
    for (const p of args["passIds"]) {
      if (typeof p === "number") passIds.push(Math.round(p));
    }
  }
  if (passIds.length === 0) passIds.push(1, 3, 5);

  const infPath = buildInfPath(device, lot, slot);

  const dummy = tryResolveSiteBinByLotDummy(infPath, passIds);
  if (dummy) {
    const result = { cardId, device, lot, slot, infPath, passes: compactSiteBinPasses(dummy.passes) };
    return truncateResult(result, maxChars);
  }

  const { stdout, stderr, exitCode } = await runOutputSiteBinByLot(infPath, passIds);
  if (exitCode !== 0) {
    return truncateResult({
      error: "INF/Perl 失败",
      stderr: stderr.slice(0, 500),
      hint: "检查 INF_STORAGE_ROOT 及 infPath 在 API 主机上是否可读",
    }, maxChars);
  }
  try {
    const data = parseSiteBinByLotJson(stdout);
    const compacted = { cardId, device, lot, slot, infPath, passes: compactSiteBinPasses(data.passes) };
    return truncateResult(compacted, maxChars);
  } catch (e) {
    return `INF 解析失败: ${e instanceof Error ? e.message : String(e)}`;
  }
}
