# 下一步行动清单（给 Cursor）— 2026-06-27

> 接力文档。问题背景与根因见 [`HANDOFF_AGENT_ISSUES_2026-06-27_ROUND2.md`](HANDOFF_AGENT_ISSUES_2026-06-27_ROUND2.md)。
> **原则**：一次只打透一个，每步**真库验证到闭环**再下一个，别攒一批盲改。每步完成跑 `npm test` + `npm run typecheck`（在 `pcr-ai-api/`）。

---

## 当前状态快照

| 项 | 状态 |
|---|---|
| **P-A** get_filter_values 空（Oracle 空串陷阱 `!= ''`） | ✅ 代码已修（commit `0177538` + `53bfb97`，含 device-by-mask 4 处 + probeCardType 枚举 2 处）；**❗待真库端到端验证** |
| **P-B** 「测试了什么lot」答成单 lot | ✅ 代码改完 + 单测过（`ce96b91`）；**待真库 curl 验证** |
| **P-C** 「4张卡对比」答成单卡 | ✅ 代码改完 + 单测过（`ce96b91`）；**待真库 curl 验证** |
| **P-D** 平台纯 bin 无定位 | ✅ 脚注 + prompt（`ce96b91`）；**待真库 curl 验证** |
| **P-E** device 串味 | ✅ prompt 提醒（`ce96b91`） |
| **P-F** query_lot_dut_bin_agg good bin 混入 + focusBin 未生效 | ⬜ **未做（本轮主要代码任务）** |

> 全部命令里的 `<API_HOST>` 换成实际地址（本机 `localhost`，或服务器内网 IP）。curl 走 LLM 的需服务器配了 `AGENT_API_KEY` / `SILICONFLOW_API_KEY`，否则在 body 的 `agentConfig.apiKey` 里填。

---

## 步骤 1（最优先）：真库端到端验证 P-A，把闭环闭上

### 1a. SQL 探针（不经 LLM，最直接）
```bash
cd pcr-ai-api
PCR_AI_LOCAL_DUMMY=false npx tsx scripts/probe-device-by-mask.ts P11C
PCR_AI_LOCAL_DUMMY=false npx tsx scripts/probe-device-by-mask.ts N55Z
```
**判定**：`yield/full` 和 `jb/full` 两段 `rowCount` 应 **> 0**（修复前是 0）。若仍为 0 → 修复没生效/还有别的条件，把整段输出贴回。

### 1b. 端到端（走 LLM，验证 Agent 真的能枚举到 device）
```bash
curl -N -X POST http://<API_HOST>:30008/api/v4/agent/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"P11C 最近的测试情况"}],"agentConfig":{"maxRounds":5}}'
```
**判定**：SSE 流里 `get_filter_values(domain:both, field:device, mask:P11C)` 的结果应含 **`WB01P11C`**，不再是 `{"values":[],"totalDistinct":0}`。

> ⚠️ 前提：服务器须已 `npm run build && pm2 reload`（把 `0177538` + `53bfb97` 部署上去），否则跑的还是旧 dist。

---

## 步骤 2：真库 curl 验证 P-B / P-C / P-D

逐条发问，看回答对不对（每条预期见下）。多轮场景按顺序发、带 `sessionId` 续跑。

| 问句 | 预期（对） | 错（回归） |
|---|---|---|
| `都测试了什么lot`（先问一句平台/产品建立上下文） | 直接出 **lot 列表** | 单 lot 逐片概况 |
| `测了哪些lot` | lot 列表 | 单 lot |
| `把这4张probecard的测试情况做对比`（先问 `9416 卡的测试情况` 建立上下文） | 进 LLM 做**跨卡综述** | 0.0s 秒回单 lot 卡表 |
| `uflex 最近三天的测试情况` → 再 `哪个lot bin40最多` | 第二问出 **bin+lot 关联表** | 只有 bin 没 lot |

curl 模板同 1b，改 `content`。把每条的最终中文回答（或关键片段）贴回判定。

---

## 步骤 3：实现 + 验证 P-F（本轮主要代码任务）

### 现象
`query_lot_dut_bin_agg` 的「坏 die 的 DUT 集中度」表：
1. 把 **good bin（BIN1/BIN55）混进来**，且「总坏die」列对 good bin 填的是 good die 数（`102685/26125/7050`）。
2. `focusBin:79` 仍混出 **BIN55**（非 focus bin）→ **focusBin 未严格生效**。

### 定位 + 改法
1. **先查 focusBin 传递链**（这是现象 2 的直接原因，也能顺带缓解现象 1）：
   - `grep` 出 `query_lot_dut_bin_agg` 的 handler（`agentToolHandlers.ts`），看它调用 `buildDutConcentrationInsights`（[agentDutConcentration.ts:37](../pcr-ai-api/src/lib/agent/agentDutConcentration.ts#L37)）时，**有没有把工具入参 `focusBin` 传成 `opts.focusBins`**。`buildDutConcentrationInsights` 内的 `if (focus && !focus.has(bin)) continue` 是对的，怀疑 handler 断链（没传 / 传错字段名）。补上即可。
2. **排除 good bin**（现象 1，针对无 focusBin 的概况场景）：
   - `SiteBinPass.bins` 的 entry **不带 good 标志**，需调用方传 good bin 集合。good bin 来源看 `query_lot_dut_bin_agg` 拿到的 site-bin 数据里是否有 `good_bins` / 参考 [`infGoodBins.ts`](../pcr-ai-report/src/utils/infGoodBins.ts) 口径（前端）或 API 侧 `isGoodBin`。
   - 给 `buildDutConcentrationInsights` 的 `DutConcentrationOptions` 加 `goodBins?: Set<number>`，循环里 `if (goodBins?.has(bin)) continue;`（放在 `parseBinNumber` 之后）。handler 调用时传入。
3. 排除 good bin 后，「总坏die」列对剩下的 bad bin 本就是坏 die 数，语义自动正确；如仍需明确，核对列取数。

### dummy-parity
- 查 `query_lot_dut_bin_agg` 是否有 dummy 路径（`SITE_BIN_BY_LOT_DUMMY` / `INFCONTROL_LAYER_BINS_DUMMY`）。若两路径都经 `buildDutConcentrationInsights` 则改一处即可；若 dummy 另有渲染分支，**两边同步**。

### 验证（真库 curl，多轮）
```
1) NF13322.1J 哪一片 wafer bin79 最多        # 建立 device+lot 上下文
2) 哪个卡 哪个dut 测试出的 bin79 最多          # 触发 query_lot_dut_bin_agg(focusBin:79)
```
**判定**：DUT 集中度表里 **只剩 BIN79**（focusBin 生效），不再有 BIN1/BIN55；good bin 不出现在「坏die」表。加单测覆盖 `buildDutConcentrationInsights` 的 goodBins 排除 + focusBins 过滤。

---

## 提交规范（每步收尾）
- 跑 `npm test` + `npm run typecheck`，全绿。
- 改 SQL/WHERE/响应形状 → **dummy-parity 双路径同步**。
- 更新 `docs/DEV_LOG.md`（顶部加条目）+ `docs/TODO.md`（勾掉对应项）。
- **不要提交 `.claude/settings.local.json`**。
- 真库验证的探针输出 / curl 回答，贴回对话或写进 `scratchpad/`，供复核。

---

## 一句话给 Cursor
**先做步骤 1（验证 P-A 真好了），再步骤 2（验证 P-B/C/D），最后步骤 3（写 P-F）。每步真库验证到闭环再继续——别跳过验证直接堆代码。**
