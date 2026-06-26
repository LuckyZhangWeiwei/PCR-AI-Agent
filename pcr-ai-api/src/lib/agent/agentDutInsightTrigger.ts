/** 智能触发：何时跑 DUT 集中度分析（拉 INF）。 */
const CARD_DUT_INTENT_RE =
  /\bdut\b|触点|\bsite\b|针点|是.*卡.*还是.*工艺|卡.*(问题|缺陷)|工艺.*问题|集中在哪|哪个\s*dut|哪些\s*dut/i;

export function shouldRunDutAnalysis(
  userText: string,
  jbPayload: Record<string, unknown>
): boolean {
  if (CARD_DUT_INTENT_RE.test(userText)) return true;
  const alerts = jbPayload["clusteredBadBinAlerts"];
  return Array.isArray(alerts) && alerts.length > 0;
}
