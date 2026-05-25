# site-bin-bylot 集成交接说明（报表 · AI Agent）

本文档供 **Claude Code**、Cursor Agent 或其它自动化在实现 **INF wafer map × bin × DUT** 能力时对齐产品设计。  
**REST 接口已实现**；**报表图表**与 **AI Agent 工具/prompt** 按本文档规划，尚未全部落地。

**相关已实现代码：**

| 组件 | 路径 |
| --- | --- |
| Perl | `pcr-ai-api/src/perlscripts/output_site_bin_bylot.pl` |
| 调用封装 | `pcr-ai-api/src/lib/outputSiteBinByLot.ts` |
| 路由 | `pcr-ai-api/src/routes/infAnalysisRoutes.ts` |
| Manifest | `pcr-ai-api/src/lib/apiManifest.ts` |
| 测试 | `pcr-ai-api/test/outputSiteBinByLot.test.ts` |

**勿与 JB Oracle 混淆：** `GET /infcontrol-layer-bins` 的 `BINn` 列来自 `INFLAYERBINLIST`；本接口读 INF 的 `iBinCodeLast` + `iTestSiteLast`，是 **map 上 die 颗数 × 测试 site**。

---

## 1. 业务含义（一句话）

对 **一片 wafer 的一个或多个测试 pass**（INF `PASS_ID`），统计：每个测试结果 **bin**（如 `bin37`）是由 probe 卡上哪个 **DUT（测试 site）** 测得的，以及该 **bin × DUT** 在 map 上的 **die 颗数**。

---

## 2. HTTP API（已实现）

**可复制示例（curl / Dummy / 生产）：** [`pcr-ai-api/docs/SITE_BIN_BY_LOT_API.md`](../pcr-ai-api/docs/SITE_BIN_BY_LOT_API.md)  
**Lot / Device 聚合交接（2026-05-25）：** [`HANDOFF_SITE_BIN_BY_LOT_AGG.md`](HANDOFF_SITE_BIN_BY_LOT_AGG.md)

亦挂载 `/api/v3`、`/api/v4`（同一路由）。

### 2.0 查询模式一览

| 模式 | 参数 | 用途 |
| --- | --- | --- |
| **单片** | `infPath` + `passId` | 一片 wafer；报表 `InfDutDistPanel` |
| **Lot 聚合** | `device` + `lot` + `passId`；可选 `probeCardType` | 一个 lot 下多片 INF 按 pass×bin×dut 累加 |
| **Device 聚合** | `device` + `passId`（**勿传 `lot`**） | 默认 **`topN=10`** 个 TESTEND 最新 lot（最大 50）；`probeCardType` 可选；详见 [`HANDOFF_SITE_BIN_BY_LOT_AGG.md`](HANDOFF_SITE_BIN_BY_LOT_AGG.md) |

```
# 单片
GET /api/v1/inf-analysis/site-bin-bylot?infPath=...&passId=1&passId=2

# Device（生产常用，默认 topN=10）
GET /api/v4/inf-analysis/site-bin-bylot?device=WA03P02G&passId=1
GET /api/v4/inf-analysis/site-bin-bylot?device=WA03P02G&passId=1&topN=20
```

**联调 Dummy 一键 URL（需 `SITE_BIN_BY_LOT_DUMMY=true` 或 `INFCONTROL_LAYER_BINS_DUMMY=true`）：**

```text
http://127.0.0.1:30008/api/v1/inf-analysis/site-bin-bylot?infPath=/data/probe_logs/ps16_SMTPID/teststuffs/infanylist/r_1-1&passId=1&passId=2
```

### 查询参数（单片模式）

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `infPath`（别名 `inf_path`） | 单片必填 | API 主机上可读的 INF 绝对路径；与 `device`+`lot` 互斥 |
| `device` / `lot` / `probeCardType` / `topN` / `testEnd*` | 聚合 | 见 [`HANDOFF_SITE_BIN_BY_LOT_AGG.md`](HANDOFF_SITE_BIN_BY_LOT_AGG.md) §3–4 |
| `passId`（别名 `pass_id`） | 是 | 一个或多个整数；可重复传参或逗号分隔 |

环境变量见 `pcr-ai-api/.env.example`：`PERL_BIN`、`PERL_SCRIPT_TIMEOUT_MS`、`INF_PATH_ALLOWED_ROOT`（可选，限制 `infPath` 必须在某根目录下）。

### Dummy（联调，不影响 production / dist）

- 开关：`SITE_BIN_BY_LOT_DUMMY=true`，或与 JB 一致 `INFCONTROL_LAYER_BINS_DUMMY=true`；`NODE_ENV=test` 时自动开启。
- 样本：`pcr-ai-api/docs/site-bin-bylot-dummy-r_1-1.passes.json`；**仅**当 `infPath` 等于  
  `/data/probe_logs/ps16_SMTPID/teststuffs/infanylist/r_1-1` 时返回硬编码 `passes`（不调 Perl）。
- 其它 `infPath` 在 Dummy 开启时仍走 Perl 原路径；Dummy 关闭时行为与改前完全一致。

### 响应形状

```json
{
  "meta": { "apiVersion", "requestId", "summary" },
  "infPath": "string",
  "passIds": [1, 2],
  "passes": [
    {
      "passId": 1,
      "bins": [
        {
          "bin": "bin37",
          "duts": [
            { "dut": 5, "dieCount": 120 },
            { "dut": "single", "dieCount": 1 }
          ]
        }
      ]
    }
  ]
}
```

- **`bin`**：BIN 编号标签，`binN` 格式（来自 `iBinCodeLast` 解码）。
- **`dut`**：probe 上测试 site 编号；无 site 层时为 `"single"`。
- **`dieCount`**：该 pass 的 wafer map 上，此 bin 且此 DUT 的 **die 颗数**（不是 BIN 号）。

### 字段书写（结论/UI/Agent 共用）

| 字段 | 含义 | 禁止 |
| --- | --- | --- |
| `bin` | BIN **编号** | 把 `dieCount` 写成 BIN 号 |
| `dieCount` | **颗数** | 把 `dut` 与颗数对调 |
| `dut` | **DUT/site 编号** | 与 Yield 报警里的 dut# 混为一谈 |

---

## 3. 三层数据源（产品模型）

| 层级 | 数据源 | 典型问题 | 报表 / Agent |
| --- | --- | --- | --- |
| **宏观** | Oracle JB `INFCONTROL ⋈ INFLAYERBINLIST` | 哪 LOT、哪卡型、哪 BIN 坏得多？ | `InfcontrolReport` 聚合 + `query_jb_bins` / `aggregate_jb_bins` |
| **报警** | Oracle Yield `YMWEB_YIELDMONITORTRIGGER` | 哪张卡、哪个 DUT **良率不均衡**报警？ | Yield 报表 + `query_yield_triggers` |
| **微观** | 磁盘 INF + Perl | **该片、该 pass** 上坏 bin **落在哪些 map site**？ | **下钻后**调 `site-bin-bylot` / Agent 新工具 |

**结论：** 顶层聚合图 **不能** 承载 DUT 分布；`site-bin-bylot` 是 **wafer 级上下文锁定之后** 的第二次请求。

---

## 4. `infPath`：由 device + lot + slot 程序拼接

运维规则：**只要知道 `device`、`lot`、`slot` 即可唯一确定 INF 路径**；必须在程序中拼接，**不要**让用户或模型填写路径。

### 建议实现

- 单一函数 **`buildInfPath({ device, lot, slot }) → string`**，报表与 Agent handler **共用**。
- 根目录：环境变量 **`INF_STORAGE_ROOT`**（或与现有 **`INF_PATH_ALLOWED_ROOT`** 对齐）。
- 需团队确认并写死的细节（实现前向运维要一条真实样例路径）：
  - 目录分段顺序（如 `{root}/{device}/{lot}/...`）
  - 文件名（如 `slot{n}.inf` vs `{lot}_{slot}.inf`）
  - `slot` 是否补零、`device`/`lot` 的 trim 与大小写

### API 形态（二选一，推荐 B）

| 方案 | 说明 |
| --- | --- |
| A. 仅 `infPath` | 前端/Agent 调 `buildInfPath` 后请求现接口 |
| **B. 增加 `device`+`lot`+`slot`** | 路由或 Agent 工具内 `resolveInfPath()` 再调 Perl；规则只维护一份 |

**`passId`** 仍来自 Oracle 行 `PASSID` 或用户 sort 用语（见 §6），**不能**从路径推导。

---

## 5. 报表（pcr-ai-report）集成设计

### 5.1 何时请求 API

| 上下文 | 是否调用 |
| --- | --- |
| device / probeCardType / 全库 bin 排名 | **否** |
| 仅有 lot、无 slot | **否**（路径不唯一） |
| **device + lot + slot 已确定** | **可以** |
| 再带 **passId**（行或筛选） | **最适合** |

触发方式（等价）：

1. **下钻**落到 slot（树表 `device → lot → slot`，或 LOT 图下钻到 slot）。
2. **明细表选中一行**（含 `DEVICE`、`LOT`、`SLOT`、`PASSID`）。

未到 slot 时详情区占位文案示例：「选择 slot 或点击明细行以查看 DUT 分布」。

### 5.2 与现有 JB 下钻的关系

```
JB 聚合图 → 点柱 → fetchDrill (Oracle) → DrillDownPanel
                ↓（wafer 已锁定）
        buildInfPath(device, lot, slot)
                ↓
        GET …/inf-analysis/site-bin-bylot?…&passId=
                ↓
        详情区：bin × DUT 图（可高亮当前下钻的 bin）
```

- **Oracle 下钻**：继续回答「还有多少、按什么维度分」。
- **site-bin-bylot**：只回答「哪个 **map site** 测出该 bin」。
- **不要**占 JB 首页 chart grid 常驻位；放在 `DrillDownPanel` 下、明细展开或侧栏 **「INF · DUT 分布」**。

### 5.3 推荐图表

| 场景 | 图表 |
| --- | --- |
| 单 pass、多 bin | **堆叠条形图**：X = BIN 号，stack = 各 `dut`，Y = `dieCount` |
| 多 pass 对比 | 分组柱或小 multiples（每 pass 一张） |
| bin/DUT 数量少 | 可选 **热力图** bin × dut |

**标题上下文：** 展示 `LOT`、`SLOT`、`PASSID`、`CARDID`（来自 Oracle 行）；图内主维度是 **DUT**，卡号仅作标题说明。

**禁止：** 在 device/lot 级趋势图里堆叠「全库 DUT」；用本接口替换 JB bin 排名。

### 5.4 实现清单（报表）

- [ ] `buildInfPath`（与 API 共用模块或复制规则文档）
- [ ] `api/paths.ts` 增加常量（如 `/api/v1/inf-analysis/site-bin-bylot` 或 v4 前缀）
- [ ] `InfcontrolReport`：wafer 锁定后 `apiGetJson`，loading/错误态
- [ ] ECharts 堆叠条 + 可选 `focusBin` 高亮
- [ ] 文件不存在时友好错误（展示解析出的路径供运维）

---

## 6. Pass / sort 与 Oracle 字段

| 用户说法 | JB / INF `passId` |
| --- | --- |
| sort1 / 常温 | 1 |
| sort2 / 高温 | 3 |
| sort3 / 低温 | 5 |

JB 列表字段：`DEVICE`、`LOT`、`SLOT`、`PASSID`、`CARDID`（与 Yield 的 `wafer`/`lotId` 命名不同，见 `agentPrompt.ts` 跨域表）。

同一片 wafer（lot + slot）、同一 `passId` 可能有多条记录（`PASSTYPE=TEST` / `INTERRUPT`，`passNum` 递增）；查 JB 时 API 已含 INTERRUPT。INF 工具按 **passId** 读 map，不按 `passNum` 拆文件。

---

## 7. AI Agent 集成设计

### 7.1 建议新增工具

**名称：** `query_inf_site_bin_by_dut`

**参数（模型可见）：**

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `device` | 是 | 与 JB `DEVICE` 一致 |
| `lot` | 是 | 含 `.` 后缀，原样传入 |
| `slot` | 是 | wafer 槽位 |
| `passId` | 否 | 与 sort 映射；省略时先用 `query_jb_bins` 取行上 `PASSID` |
| `passIds` | 否 | 多 pass 对比 |
| `focusBin` | 否 | 结论聚焦某一 BIN |

**禁止：** 参数中出现 `infPath`；**禁止**向用户索要路径。

**Handler：** `buildInfPath` → `runOutputSiteBinByLot` → 规范化 JSON 回传（保留 `bin`/`dieCount`/`dut` 语义说明）。

### 7.2 推荐调用链

```
用户问题
  → query_jb_bins / aggregate_jb_bins（锁定 device+lot+slot+passId）
  → query_inf_site_bin_by_dut
  → 中文结论；可选 generate_chart（堆叠 bar，labels=BIN 号，series=各 DUT 的 dieCount）
```

### 7.3 两种「DUT」必须区分

| 来源 | 含义 |
| --- | --- |
| Yield `TRIGGER_LABEL` / dut# | 良率不均衡 **报警** 上的测试位 |
| INF `query_inf_site_bin_by_dut` 的 `dut` | **该片该 pass map** 上测出该 bin 的 site# |

### 7.4 何时调用 / 何时不调用

| 用户意图 | 做法 |
| --- | --- |
| 哪个 site/DUT 测出坏 bin、是否偏位 | JB 取 slot+pass → INF 工具 |
| 哪种卡/哪个 lot 坏 bin 多 | 仅 JB 聚合，**不调** INF |
| 对比报警 dut# 与 map site | Yield + JB 定位 wafer → INF；分三源写结论 |

**澄清规则：** 缺 slot 可用 JB 补全；缺 pass 可只问 sort1/2/3 **一次**；**不得**因缺少 infPath 追问用户。

### 7.5 系统提示词增补（待写入 `agentPrompt.ts`）

实现 Agent 时，在 `buildSystemPrompt` 中增加专节 **「INF Wafer Map · DUT 分布」**，并：

1. 工具列表增加 `query_inf_site_bin_by_dut`。
2. 在「两张表」后描述第三数据源及调用前置条件。
3. 在「领域知识」中增加 **两种 DUT** 对照表。
4. 在「何时联合两表」表增加 INF 一行。
5. 在「澄清优先」中注明 infPath 由服务端拼接。
6. 图表节补充：INF 用堆叠 bar，labels 为 BIN 号，不要把 DUT 号写进 BIN 标签。

完整 prompt 段落与工具 JSON schema 见本文档 **附录 A、附录 B**（与 2026-05-20 设计讨论一致）。

### 7.6 实现清单（Agent）

- [ ] `agentToolSchemas.ts` 注册工具
- [ ] `agentToolHandlers.ts` + `buildInfPath` + 调 `runOutputSiteBinByLot`
- [ ] `agentPrompt.ts` 粘贴附录 A，更新工具列表与相关节
- [ ] 测试：mock INF 或集成测试跳过无 Perl 环境
- [ ] 改 prompt 时同步 `agentJbBinFormat` 口径说明（bin/dieCount 不可对调）

---

## 8. 与 Oracle JB 对账（可选 UX）

详情区或 Agent 结论可加一句：INF 来自 map 层，JB 来自 `BINn` 列；同一 bin 两侧总数**可能接近但不保证相等**，勿强行宣称一致。

---

## 9. 实现优先级建议

| 阶段 | 内容 |
| --- | --- |
| P0 | 确认 `buildInfPath` 路径模板 + 环境变量；单测 `buildInfPath` |
| P1 | Agent 工具 + prompt（无报表也可服务聊天） |
| P2 | `InfcontrolReport` 下钻/明细触发 + 堆叠条图 |
| P3 | API 可选 `device`+`lot`+`slot` 查询参数（避免前后端规则分叉） |

---

## 10. 交接检查清单

- [ ] 已读本文档 + `pcr-ai-api/CLAUDE.md` §6（site-bin-bylot 路由）+ `outputSiteBinByLot.ts`
- [ ] `buildInfPath` 与运维确认过**至少一条**生产样例路径
- [ ] 报表：仅在 device+lot+slot（+passId）后请求；不占顶层聚合图
- [ ] Agent：新工具不传 infPath；两种 DUT 不混；bin/dieCount/dut 不写反
- [ ] 发布 API：`npm run build`（含 `copy-perlscripts.mjs`）；主机需 Perl + INFAnalysis
- [ ] 未将 INF DUT 数据并入 v4 `aggregate` 的 `groupBy`（无此维度）

---

## 附录 A — `agentPrompt.ts` 增补正文（复制用）

```markdown
### INF Wafer Map · DUT 分布（query_inf_site_bin_by_dut）

**业务含义：一片 wafer、某一个测试 pass 上，wafer map 上每个测试结果 bin 是由 probe 卡上哪个 DUT（测试 site）测出来的，以及该 bin×DUT 的 die 颗数。**

- 数据来源：服务器磁盘 INF 文件（非 Oracle）。路径由服务端根据 **device + lot + slot** 自动拼接，**禁止**向用户索要 infPath，**禁止**在工具参数中传入路径。
- 与 JB STAR：JB 回答坏 bin 总量；INF 回答 bin 落在哪些 map site——是下钻补充，不替代 query_jb_bins。
- 与 Yield Monitor：Yield 的 dut# 是报警位；INF 的 dut 是 map site。名称相似，**不可混用**。

**调用前置（须同时满足）：**
1. 已有 device、lot、slot（slot 与 JB SLOT 一致）。
2. 最好有 passId（sort1/2/3 → 1/3/5；或 JB 行 PASSID）。无 pass 时先 query_jb_bins 再 INF；仍无法确定则只问 sort 一次。
3. **禁止**在仅 device / 仅 lot / 仅 probeCardType 级调用。

**推荐顺序：** query_jb_bins → query_inf_site_bin_by_dut →（可选）generate_chart 堆叠 bar。

**字段：** bin=BIN编号，dieCount=颗数，dut=site编号；禁止「DUT37 有 8 颗 bin5」类对调。

**失败：** INF/Perl 失败时用 [REFLECT] 说明，勿用 aggregate 猜 DUT 分布。

### 两种 DUT 必须区分

| 来源 | 含义 |
| --- | --- |
| Yield TRIGGER_LABEL | 良率不均衡报警 DUT |
| query_inf_site_bin_by_dut | 该片该 pass map 上的 site# |

| 用户问 map/site 测出坏 bin | 先 JB 锁定 device+lot+slot+passId，再 INF 工具 |
```

更新工具列表行：

```markdown
可用工具：query_yield_triggers, aggregate_yield_triggers, query_jb_bins, aggregate_jb_bins, query_inf_site_bin_by_dut, generate_chart, ask_clarification, get_filter_values。
```

---

## 附录 B — `query_inf_site_bin_by_dut` 工具 schema（复制用）

```json
{
  "type": "function",
  "function": {
    "name": "query_inf_site_bin_by_dut",
    "description": "读取该片 wafer 的 INF（服务端由 device+lot+slot 拼路径），按 pass 统计各 bin 由哪个 DUT(site) 测得及 dieCount。非 Oracle JB；与 query_jb_bins 数据源不同。",
    "parameters": {
      "type": "object",
      "properties": {
        "device": { "type": "string", "description": "产品代码，必填" },
        "lot": { "type": "string", "description": "批次 ID，含 '.' 后缀，必填" },
        "slot": { "type": "number", "description": "wafer 槽位 SLOT，必填" },
        "passId": { "type": "number", "description": "PASS_ID；sort1/2/3→1/3/5" },
        "passIds": { "type": "array", "items": { "type": "number" } },
        "focusBin": { "type": "number", "description": "只展开某一 BIN" }
      },
      "required": ["device", "lot", "slot"]
    }
  }
}
```

---

## 附录 C — 典型用户问句 → 工具序列

| 用户问句 | 工具序列 |
| --- | --- |
| NF12551.1N 第 3 片 sort2，bin37 是否集中在同一 DUT？ | `query_jb_bins`(lot,slot,passId=3) → `query_inf_site_bin_by_dut`(…,focusBin=37) |
| WA03P02G 哪种卡坏 bin 多？ | 仅 `aggregate_jb_bins` |
| 和报警 dut5 对一下 | `query_yield_triggers` + `query_jb_bins` → `query_inf_site_bin_by_dut`；分三源写结论 |

---

*文档版本：2026-05-25（增补 Lot/Device 聚合索引）。路径模板待运维确认后回填 §4。实现与本文冲突时以源码与 manifest 为准，并应更新本文。*
