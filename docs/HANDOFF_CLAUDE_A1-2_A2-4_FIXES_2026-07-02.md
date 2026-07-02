# Claude → Cursor 交接：A1-2 卡级归因误路由 + A2-4 空 scope 空转（2026-07-02）

> **执行者：** Claude Code（沙箱：可改代码 + 跑单测/dummy，**无真库/真 LLM**）
> **分支：** `feat/jb-route-resolver`
> **前置：** Cursor `8a6f841`（mask 快路 + A1-4 fan-out）留下的两个待办
> **本次改动：** A1-2、A2-4 两处路由修复 + 单测；**未翻任何开关，未 merge main**

---

## 0. 一眼结论

| 项 | 现象（Cursor 真库） | Claude 修复 | 需 Cursor 复验 |
|---|---|---|---|
| **A1-2** | 二轮「BIN35 集中在哪张卡」误走 `query_lot_dut_bin_agg`（单 lot DUT 集中度），未派发 `aggregate_jb_bins(bin,cardId)` | 改 `isDutBinConcentrationQuestion` 门：区分 DUT 级 vs 卡级 | `verify-step2-dispatch.mjs a1-2` 首轮应为 `aggregate_jb_bins`，出 BIN×卡表 |
| **A2-4** | `ZZZZZ 哪个卡测出bin99 多` → 250s idle 超时（LLM 拿无效 scope 空转） | 新增 PRE_LLM 末端兜底 `tryRunUnscopedBinClarifyDirectRoute`：无效 token + 零 scope → 确定性澄清 | `verify-step2-dispatch.mjs a2-4` 应出澄清文本、**无 error 事件** |

**本地 CI：** `npm test` **461 pass / 0 fail / 4 skip**（3 次稳定）；`typecheck` + `build`（含 verify-dist-no-undici）✅。

---

## 1. A1-2 根因与修复

**根因：** 「BIN35 集中在哪张卡」**同时**匹配两个判定：
- `isBinCardAttributionQuestion`（BIN + 哪张卡）→ 应走 `bin_card_attribution` 语义派发（`aggregate_jb_bins(groupBy:"bin,cardId")`）；
- `isDutBinConcentrationQuestion`（BIN + `卡`）→ P-F `tryRunDutBinAggDirectRoute`（`query_lot_dut_bin_agg`，单 lot DUT 集中度）。

而 PRE_LLM 顺序里 **P-F（`tryRunDutBinAggDirectRoute`）在语义派发之前**。A1-2 的 setup `n55z 最近测试情况` 经 `tryRunMaskScopeDirectRoute` 缓存了 primary lot，P-F 用 `inferLotFromHistory` 拿到该 lot → 抢先路由成**单 lot DUT 集中度**（错误 scope）。

**修复（`agentLoop.ts` `isDutBinConcentrationQuestion`）：**
```ts
export function isDutBinConcentrationQuestion(text: string): boolean {
  const focusBin = extractBinFromUserText(text);
  if (focusBin == null) return false;
  if (/(dut|触点|探针)/i.test(text)) return true;              // DUT 级 → P-F
  if (/(卡|card)/i.test(text)) return !isBinCardAttributionQuestion(text); // 纯卡级归因 → 让给派发
  return false;
}
```

**不回归验证（沙箱）：**
- P-F 问句 `哪个卡 哪个dut 测试出的 bin79 最多`（含 dut）→ 仍 `true` → 仍走 P-F ✓
- A1-1 turn1 `n55z 哪个卡测出bin35 多` → 无 history lot，P-F 本就 bail，行为不变 ✓
- `isBadBinRankingQuestion` 有具体 bin 号即返回 false（agentJbDeterministicReply.ts:565），故 scopedBadBin（PRE_LLM 位置4）不会抢在语义派发（位置9）前拦截 A1-2 ✓

**复验期望（部署本 dist + `JB_DETERMINISTIC_DISPATCH=true`）：**
`verify-step2-dispatch.mjs a1-2` → 首轮 `aggregate_jb_bins`（args 含 `groupBy:"bin,cardId"`），文本出 ≥2 张卡 + BIN35。

---

## 2. A2-4 根因与修复

**根因：** `ZZZZZ` 既非 device（非 WA/WC/WB 全码）也非 mask（非 `[A-Z]\d{2}[A-Z]`），`scopedBadBinAggregateArgsFromUser` 解析不到任何 scope → 语义派发 `planFor` 返回 null → 无直连路由接住 → LLM 拿 `ZZZZZ` 空转到 250s idle 超时。

**修复（新文件 `agentJbUnscopedBinRoute.ts` + `agentLoop.ts` 薄包 `tryRunUnscopedBinClarifyDirectRoute`）：**
仅当**全部**满足时兜底澄清：
1. 有 BIN 编号；
2. 是 bin 归因 / 坏bin排行 / BIN×lot排行 类问句；
3. 无 lot（句 + history）；
4. device/mask/tester/platform 均无法解析；
5. 无时间窗；
6. 句中有**无法识别的疑似 scope token**（≥4 连续大写字母，非 BIN/DUT/LOT… 业务词，如 `ZZZZZ`）。

置于 PRE_LLM 直连链**末端**（语义派发之后）——所有能解析 scope 的路由都没接住时才兜底。

**blast radius 说明（红线：不降现有质量）：**
- **纯中文无 token** 的 `哪片卡 bin35 出得最多`（B2-3）→ 第 6 条不满足 → **不拦截**，仍交 LLM 澄清（现状，已判可接受）；
- **能解析 scope** 的 `N55Z / WC13N55Z … 哪张卡 bin35` → 第 4 条不满足 → **不拦截**，走正常派发；
- 只把「带无效 token 会 250s 空转」的死路变成快速澄清，理论上无正例回归。

**复验期望：** `verify-step2-dispatch.mjs a2-4` → 有 >20 字澄清文本、**无 SSE error**（脚本判 PASS 条件）。

---

## 3. 改动文件

| 文件 | 改动 |
|---|---|
| `src/lib/agent/agentLoop.ts` | 改 `isDutBinConcentrationQuestion`（导出，供单测）；新增 `tryRunUnscopedBinClarifyDirectRoute` 并注册到 `PRE_LLM_DIRECT_ROUTES` 末端 |
| `src/lib/agent/agentJbUnscopedBinRoute.ts` | **新文件**：`canRunUnscopedBinClarify` / `findUnrecognizedScopeToken` / `buildUnscopedBinClarifyMessage` |
| `test/agentLoop.test.ts` | A1-2：`isDutBinConcentrationQuestion` DUT 级 vs 卡级 |
| `test/agentJbUnscopedBinRoute.test.ts` | **新文件**：A2-4 门控 7 例 |

---

## 4. 复现命令

```bash
cd pcr-ai-api
npm ci && npm run build && npm test            # 期望 461 pass / 0 fail
pm2 reload <app>

# 真库复验（JB_DETERMINISTIC_DISPATCH=true）
VERIFY_OUT=../scratchpad/step2-a12-a24-2026-07-02.txt node scripts/verify-step2-dispatch.mjs all
```

**回传给 Claude：** A1-2 首轮工具名 + 是否出 BIN×卡表；A2-4 是否出澄清文本且无 error。若 A1-2 真库仍误路由，抓该 session 首轮 `tool_start` 事件（确认是 `aggregate_jb_bins` 还是 `query_lot_dut_bin_agg`）。

---

## 5. 仍未动（非本次范围）

- **agentEval live 误分类率**（`AGENT_EVAL_LIVE=1`）— 需服务器 key，与本次路由正交。
- **A1-4 fan-out 延迟** — Cursor 已实测 `lots=5` ✅；串行逐 lot query 有 SSE 心跳，不 idle 超时，属延迟非正确性，暂不动。
- **FLIP 开关** — 遵用户决策，Claude 不翻。
