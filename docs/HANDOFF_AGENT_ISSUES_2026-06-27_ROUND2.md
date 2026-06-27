# Agent 问题交接（2026-06-27 第二轮 · 真库验证后）

> 给 **Cursor / 下一位** 的可执行排查 + 修复清单。本轮日志来自 `Desktop/New folder (3)`（**最新代码已 `npm run build` 部署后**的真库会话）。
> **硬规则**：改 WHERE / 筛选 / 排序 / 响应形状必须 **Oracle 与 Dummy 双路径同步**（dummy-parity）；改后跑 `npm test` + `npm run typecheck`（在 `pcr-ai-api/`）。

---

## ✅ 本轮已确认「生效、勿动」

- **P2 · 按指定 BIN 给 lot 排行**：`n55z 哪个lot bin35最多` → 正确按 BIN35 颗数降序（`DR42190.1X 1402 > DR42192.1H 1397 > … > DR41662.1J 968`），非坏 die 总量。`buildBinFocusedLotRankingMarkdown` 工作正常。
- **BIN×卡归因**：`bin35 集中在哪张卡` → `9416-04 65.8% / 9416-03 21.8% / 9416-01 12.4%`，正确。
- **卡型跨 lot 综述**：`9416 四张卡分别怎样` → YM 报警对比 + JB 跨 lot 良率，正确。

> 这些是上一轮（commit `5547c6a`）的成果，**不要回改**。

---

## 🔴 P-A（最高优先）：`get_filter_values` device-by-mask 真库恒空，但同 mask 的 query_* 有数据

### 现象（4 会话一致）
| mask | `get_filter_values(domain:both,field:device,mask)` | 同会话 `query_yield_triggers(mask)` / `query_jb_bins(mask)` |
|---|---|---|
| P11C | `{"values":[],"totalDistinct":0,"devices":[]}` | `WB01P11C`（14 行）/ 有数据 |
| N55Z | 空 | `WC13N55Z` / 有数据 |
| N48A | 空 | `WA88888811N48A` / 有数据 |
| N94W | 空 | `WK71N94W` / 有数据 |

### 已排除（不要再往这些方向查）
1. **不是旧 dist**：用户已 `npm run build` 重新部署，仍空。
2. **不是 mask 匹配逻辑**：能查到的 `query_yield_triggers` 与返回空的 `get_filter_values` **用同一段** `deviceMaskOracleWhere`（[deviceMask.ts:45-50](../pcr-ai-api/src/lib/deviceMask.ts#L45-L50)），其中第二节 `UPPER(TRIM(col)) LIKE '%'||UPPER(:mask)||'%'` 对 `WB01P11C` **必然命中** `P11C`。
3. **不是 `FETCH FIRST` 老 Oracle 语法**：`query_yield_triggers` 走的 `buildYieldMonitorTriggersV3Sql`（[apiV3ListSql.ts:138](../pcr-ai-api/src/lib/apiV3ListSql.ts#L138)）**也用 `FETCH FIRST :lim ROWS ONLY` 且能跑**。
4. **范围更宽反而空**：filter 的 device-by-mask SQL **不加时间窗**，JB 侧**不限 PASSTYPE**——比能查到的 query 范围更宽，逻辑上更不该空。→ **纯靠读代码无法解释，必须看真库实际执行的 SQL + 行数。**

### 涉及文件
- 空的两条 SQL：[agentFilterValuesTool.ts](../pcr-ai-api/src/lib/agent/agentFilterValuesTool.ts)
  - `oracleYieldDeviceByMaskMap`（约 481-517，`withProbeWebConnection`，表 `YMWEB_YIELDMONITORTRIGGER`，含 `UPPER(TRIM(t."TYPE"))='DELTA_DIFF'`）
  - `oracleJbDeviceByMaskMap`（约 519-555，`withConnection`，`INFCONTROL t1 JOIN INFLAYERBINLIST t2 ON t1.KEYNUMBER=t2.KEYNUMBER`）
  - 入口 `runGetFilterValues` domain==="both" 分支（约 820-842）
- 能查到的对照：`toolQueryYieldTriggers`（[agentToolHandlers.ts:156-184](../pcr-ai-api/src/lib/agent/agentToolHandlers.ts#L156-L184)）→ `parseYieldMonitorTriggerV3Query`（[yieldMonitorTriggerFilters.ts:218-224](../pcr-ai-api/src/lib/yieldMonitorTriggerFilters.ts#L218-L224)）
- 诊断日志：`logAgentSql`（[agentSqlDebugLog.ts](../pcr-ai-api/src/lib/agent/agentSqlDebugLog.ts)，`AGENT_SQL_DEBUG` 默认 true，打到 **stderr**）

### 第 0 步（最快，推荐）：直接跑 SQL 探针，**不经过 LLM**
P-A 是 **SQL 层**问题，LLM 只是触发器——别绕 LLM + 翻日志，直接对真库复跑那两条 SQL 的二分变体。脚本已备好：
```bash
cd pcr-ai-api && PCR_AI_LOCAL_DUMMY=false npx tsx scripts/probe-device-by-mask.ts P11C
```
（必须在能连真库的环境：服务器，或本机 `.env` 配好 `ORACLE_*`。换 mask 改末尾参数。）
它依次打印 `yield/full`(复现空) → `yield/noType` → `yield/onlyMask` → `yield/distinctType`(TYPE 裸值) → `jb/full` → `jb/onlyMaskNoJoin` 各段的 `rowCount`。**哪段从 0 变非 0，就是被哪个 WHERE 条件杀光行**；任一段抛 `❌ ERROR(ORA-xxxxx)` 则「空」其实是被吞的异常。把整段输出贴回 Claude 即可定位。

### 第 1 步（备选）：抓真实 SQL（钥匙，已默认开启）
在 AI 里问一次 `P11C 最近的测试情况`，然后到服务器：
```bash
pm2 logs <进程名> --err --lines 400 | grep -i DeviceByMask
# 或
tail -n 800 ~/.pm2/logs/<进程名>-error.log | grep -i DeviceByMask
```
会有两条：
```
[agentSql/filterValues:yieldDeviceByMask] binds={"mask":"P11C","lim":50}
  SQL: SELECT grp_key, last_test ... WHERE UPPER(TRIM(t."TYPE"))='DELTA_DIFF' ...
[agentSql/filterValues:yieldDeviceByMask:result] ... {"rowCount":0,"sampleDevices":[]}
```
**重点看**：
- (a) `binds.mask` 实际值是否真的是 `"P11C"`（会不会被 `resolveDeviceMaskArg` / filterBy 解析坏成空或别的值）；
- (b) `rowCount` 是否真为 0；
- (c) 同段日志里有没有 **ORA-xxxxx** 报错（若有，则"空"其实是被吞掉的异常，见下「异常吞没」假设）。

### 第 2 步：把完整 SQL 贴真库二分复跑（定位是哪个条件杀光行）
对 **yield 侧** SQL，从真库逐步删条件，找出从哪一步开始有行：
1. 只留 `deviceMaskOracleWhere`（去掉 `TYPE='DELTA_DIFF'`、去掉 `NOT REGEXP_LIKE(LOTID,...)`）→ 有行吗？
2. 加回 `TYPE='DELTA_DIFF'` → **重点怀疑**：真库 `TYPE` 列实际值是否真是 `delta_diff`？大小写 / 前后空格 / 是否带其它值？（`query_yield_triggers` 返回的行 `TYPE:"delta_diff"`，但那是 enrich 后的展示值，**未必等于库内裸值**——务必查裸值 `SELECT DISTINCT "TYPE" FROM YMWEB_YIELDMONITORTRIGGER WHERE ...`。）
3. 加回 `NOT REGEXP_LIKE(LOTID,'^(kk|gg|c)','i')` → 注意：**`'c'` 前缀**会把所有以 c/C 开头的 LOT 排除，确认目标 lot（如 `TR2...` / `DR4...` / `NF1...`）不被误伤。

对 **JB 侧** SQL 同法二分（它没有 TYPE 条件，重点查 `INFCONTROL⋈INFLAYERBINLIST` 的 JOIN 键 `KEYNUMBER` 与 `t1.DEVICE` 列）。

### 候选假设（按可能性排序，逐一证伪）
1. **真库 `TYPE` 裸值 ≠ `'DELTA_DIFF'`**（大小写/空格/枚举差异）→ yield 侧被 `TYPE` 条件清零。这是 yield 侧最可能的元凶。**注意 JB 侧无 TYPE 条件却也空**，所以单这条不能解释全部，但可能 yield/JB 各有独立原因。
2. **`binds.mask` 被解析坏**（空串 → `LIKE '%%'` 命中全部、或被截断）。看日志 (a) 即可证伪。
3. **异常被吞没**：`oracleDeviceByMaskBoth` 里 `Promise.all([yield, jb])` 任一抛错 → 冒泡到 `runGetFilterValues` 的 try-catch → 返回 `"get_filter_values 错误: ..."`。**确认用户看到的到底是空 JSON 还是 `错误:` 字符串**（口语"空"可能混淆二者）。若是错误，完整 SQL 直接复跑即可定位 ORA 码。
4. **连接池/库不一致**：yield 走 `withProbeWebConnection`。确认该池连的库里 `YMWEB_YIELDMONITORTRIGGER.DEVICE` 确有值且 `query_yield_triggers` 与 filter 命中**同一张表**。

### 修复后回归
- 真机验证 P11C/N55Z/N48A/N94W 都能枚举出 device；
- **dummy-parity**：dummy 路径（`dummyDeviceByMaskBoth`）已正常，勿破坏；
- 已有形状回归 `test/agentFilterValues.test.ts`，按真因补针对性用例。

> 实害提示：即便 filter 空，Agent 仍会用 query_* fallback 给出最终答案，所以**不是致命**，但浪费一次工具轮、且偶发误导。优先级高是因为它是 P1/P6「看起来没生效」的根。

---

## 🟠 P-B：「都测试了什么lot」第一次答成**单个 lot 详情**

### 现象
`uflex 最近三天` 之后问 `都测试了什么lot` → 第一次只回单 lot `NF13252.1X` 的逐片良率（答非所问）；用户重复问一次，第二次才列出全部 54 个 lot。

### 根因
`isLotListingQuestion`（[agentJbDeterministicReply.ts:120](../pcr-ai-api/src/lib/agent/agentJbDeterministicReply.ts#L120)）的正则**未覆盖「(测试了)什么lot / 测了哪些lot」这类口语**。它认 `所有lot/全部lot/列出…lot/有哪些lot`，但 `都测试了什么lot`、`测了什么lot`、`都有什么lot` 全部落空 → `detectJbReplyMode` 继续往下走到 `isLotOverviewQuestion` → 单 lot 概况。

### 待办
- 在 `isLotListingQuestion` 增加分支，覆盖：
  `/(都|有|测试了|测了|跑了|做了)?\s*(什么|哪些|多少)\s*(lot|批次)/i`、`/(lot|批次)\s*(都|有)?\s*(有哪些|是什么|测了什么)/i`。
- 小心**不要**误吞「这片有哪些 wafer / 逐片」（已有 SEC_WAFER_ENUM 排除，保持）。
- 纯文本检测，**不涉及 SQL/dummy-parity**。加单测到 `test/agentJbDeterministicReply.test.ts`。

---

## 🟠 P-C：「把这4张probecard的测试情况做对比」答成**单 lot 卡表**（0.0s 秒回，连答 2 次）

### 现象
`把这4张probecard 的测试情况 做一个对比` → 0.0s 直出**单 lot `DR44436.1W` 的「探针卡/机台」小表**，完全没做对比。改说法 `9416-01/02/03/04 分别怎样` 才正确对比。

### 根因
`detectJbReplyMode`（[agentJbDeterministicReply.ts:706-730](../pcr-ai-api/src/lib/agent/agentJbDeterministicReply.ts#L706-L730)）里 `isProbeCardQuestion`→`equipment`（第 715 行）**优先级太高**。`isProbeCardQuestion`（83 行）匹配 `probe\s*card`，所以「4张probecard对比」先命中 equipment（单 lot 卡/机台表），轮不到「多卡对比」判断。

### 待办
- 新增 `isMultiCardComparisonQuestion(text)`：要求**对比意图 + 多卡信号**，如
  `/对比|比较|分别|各自|哪.*张.*更|哪.*张.*差/` **且** `/(这|那)?\s*\d+\s*张|多张|几张|各\s*卡|每\s*张|\d{4}[-‑].*\d{4}[-‑]/`。
- 在 `detectJbReplyMode` **`isProbeCardQuestion` 之前** bail：命中则 `return "generic"`（交回 LLM 做跨卡综述，参照上一轮 `isCardTypeLevelOverviewQuestion` 的 bail 思路）。
- 防回归：单卡问句（`这片用什么卡` / `9416-03 用的卡`）**仍走 equipment**——单测两类都要覆盖（`test/agentJbDeterministicReply.test.ts`）。

---

## 🟡 P-D：范围宽时**只输出 BIN、没有 lot**，跨多 lot 无定位价值

### 现象
`uflex 最近三天的测试情况` → 只给「主要坏 BIN 排行」（BIN40 4552 / BIN4 2217 …），但这三天跨 **54 个 lot**，混在一起算总和，工程上无法定位是哪批的问题。

### 根因（两层）
1. **LLM 选了 `aggregate_jb_bins(groupBy:"bin")`**（图省事看总览），底层数据本就没 lot 维度。
2. **确定性层** `buildAggregateBinRankingMarkdown` 老实渲染纯 bin 排行（无 lot 维度时它就只能出 bin）。

### 区分（别一刀切）
- **已锁定单 lot**（上下文已有具体 lot）→ 纯 bin 排行**合理**，保留。
- **范围宽**（平台/产品/时间窗、payload 跨多 lot 无单一 lot）→ 纯 bin **无意义**，需带 lot。

### 待办
- **prompt 引导**（[agentPrompt.ts](../pcr-ai-api/src/lib/agent/agentPrompt.ts)）：问「平台/产品/最近N天 测试情况」且无单一 lot 时，聚合带 lot 维度（`groupBy:"bin,lot"`）或先走 `lot_listing` 列出各 lot。
- **确定性兜底**：渲染前若检测到 `groupBy` 仅 `bin` 且 payload 跨多 lot（`multiLotDistinctCount>1` / `recentLots.length>1`），**不出纯 bin 表**，改为 bin+lot 关联表（复用 `buildMultiLotBinTable` / `buildBinFocusedLotRankingMarkdown` 思路）或提示「按 lot 下钻」。
- 改聚合渲染/维度记得 **dummy-parity** + `npm test`。

---

## 🟢 P-E（低优先）：N94W 会话混入上一产品 device 的 stray 工具调用
`mqw5rjgk` 中查 N94W 时，LLM 误发了一次 `query_jb_bins(device:"WA88888811N48A")`（上一轮 N48A 残留）。**最终答案用的是正确的 WK71N94W**，实害小。可在 prompt / 历史压缩侧提醒「device 须取本轮 mask 解析值，勿沿用上一产品」。

## 🟢 P-F（低优先）：`query_lot_dut_bin_agg` 把 **good bin 混进「坏die DUT集中度」表**，且「总坏die」列实为 good die 数
多个会话工具输出首行是 `BIN1 / BIN55`（good bin），`总坏die` 列填的是 good die 总数（如 `102685 / 26125 / 7050`）。应：(1) 渲染该表时**排除 good bin**（复用 `infGoodBins` 口径；`SiteBinPass.bins` entry 不带 good 标志，需调用方传入 goodBins 集合给 `buildDutConcentrationInsights`）；(2) 修正列名/取数，使「总坏die」真为坏 die。

**另外**：`mqw4k5og` 会话里 `query_lot_dut_bin_agg(focusBin:79)` 的输出仍混出 **BIN55**（非 focus bin），说明 **focusBin 未严格生效**——`buildDutConcentrationInsights` 的 `focusBins` 过滤（`if (focus && !focus.has(bin)) continue`）正确，但 **handler 可能没把 `focusBin` 传成 `opts.focusBins`**。一并查 `query_lot_dut_bin_agg` handler 的 focusBin → `DutConcentrationOptions.focusBins` 传递链（[agentDutConcentration.ts:44](../pcr-ai-api/src/lib/agent/agentDutConcentration.ts#L44)）。

---

## 端到端验证 + 结果回传（给 Cursor）

两类问题用两种验证方式，别混：

### A. P-A（SQL 层）→ 直接跑脚本，**不用 LLM**
见上方「第 0 步」。`npx tsx scripts/probe-device-by-mask.ts <mask>` → 把输出贴回 / 写进 `scratchpad/probe-result.txt` 回传给 Claude 分析。这是定位 P-A 最快路径。

### B. P-B / P-C / P-D（路由 + LLM 行为）→ 走 LLM 端到端，看回答对不对
用 curl 直接打 Agent SSE 接口提问（不用开浏览器）：
```bash
curl -N -X POST http://localhost:30008/api/v4/agent/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"都测试了什么lot"}],"agentConfig":{"maxRounds":5}}'
```
- `apiKey` 不传则回退服务器 env `AGENT_API_KEY` / `SILICONFLOW_API_KEY`；没配就在 `agentConfig.apiKey` 里填。
- SSE 流里能看到工具调用与最终中文回答；**确定性表是否正确、有没有答非所问**直接可判。
- 多轮场景（如 P-C「先列 4 张卡，再问对比」）按顺序发多次，带上 `sessionId` 续跑。
- 验证清单：
  - P-B：问 `都测试了什么lot` / `测了哪些lot` → 应直接出 **lot 列表**，不是单 lot 概况。
  - P-C：问 `把这4张probecard的测试情况做对比` → 应进 LLM 做**跨卡综述**，不是单 lot 卡表秒回。
  - P-D：问 `uflex 最近三天的测试情况` 后追问 `哪个lot bin40最多` → 应出 **bin+lot 关联表**。
- 把 SSE 输出（或关键片段）贴回 Claude 即可。SQL 相关疑点再配合 pm2 `[agentSql/...]` 日志。

> 反馈环要点：**一次只验证/打透一个问题到闭环**，把脚本或 curl 的真实输出回传，Claude 据此判断真好了没——而不是攒一批日志再盲改。

---

## 执行顺序建议
1. **P-A**：先抓 pm2 日志（`DeviceByMask` 两条）→ 真库二分 → 定位（最可能是 yield 侧 `TYPE` 裸值不匹配 / 或异常吞没）。
2. **P-B、P-C**：纯文本检测正则，改动小、风险低、收益直接，配单测。
3. **P-D**：prompt + 确定性兜底，注意 dummy-parity。
4. **P-E、P-F**：有余力再做。

每步完成跑 `npm test` + `npm run typecheck`（`pcr-ai-api/`），保持 Oracle/Dummy 双路径同步。
