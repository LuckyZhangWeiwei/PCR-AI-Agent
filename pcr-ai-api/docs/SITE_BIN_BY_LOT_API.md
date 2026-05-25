# GET /inf-analysis/site-bin-bylot 使用说明

按 **一片 wafer 的一个或多个测试 pass**，从 **INF 文件**（wafer map）统计：每个测试结果 **bin** 由 probe 卡上哪个 **DUT（测试 site）** 测得，以及 map 上 **die 颗数**。

> 与 JB Oracle `GET /infcontrol-layer-bins` **不是同一数据源**（后者是 `INFLAYERBINLIST` 的 BIN 列计数）。  
> 集成设计（报表下钻、Agent）：[`../../docs/SITE_BIN_BY_LOT_INTEGRATION.md`](../../docs/SITE_BIN_BY_LOT_INTEGRATION.md)

---

## 1. 什么时候用这个接口

- 已经知道 **哪片 wafer**（`infPath`，通常由 `device + lot + slot` 拼出）和 **哪几次测试 pass**（`passId`）。
- 需要回答：「**BIN37 是不是集中在 DUT 5？**」「**sort2 这次测试各 site 上坏 bin 怎么分布？**」
- **不要**在只有 lot / 卡型、还不知道 slot 时调用（没有唯一 INF 文件）。

典型顺序（与报表一致）：

1. 用 JB 列表/聚合锁定 `device`、`lot`、`slot`、`passId`（`GET /api/v4/infcontrol-layer-bins/v4` 等）。
2. 程序拼 `infPath`（见 §3）。
3. 调本接口拿 **bin × DUT** 分布。

---

## 2. 请求

| 项 | 值 |
| --- | --- |
| 方法 | `GET`（**只读**；不修改、不删除 INF 文件） |
| 路径 | `/api/v1/inf-analysis/site-bin-bylot`（亦可用 `/api/v3/...`、`/api/v4/...`） |

### 2.1 三种调用模式（互斥）

| 模式 | 查询参数 | 说明 |
| --- | --- | --- |
| **单片 wafer**（原有） | `infPath` + `passId` | 读**一个** INF 文件 |
| **Lot 聚合** | `device` + `lot` + `passId`；可选 `probeCardType` | 见 §2.2 |
| **Device 聚合** | `device` + `passId`（**不要**传 `lot`） | 默认 `topN=10` 最新 lot；见 §2.4 |

**不要**同时传 `infPath` 与 `device`。

### 2.2 公共参数

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `passId` | 是 | 一个或多个 INF `PASS_ID`；可 `passId=1&passId=2` 或 `passId=1,2`；别名 `pass_id` |
| `probeCardType` | Lot/Device 聚合时见下 | 与 JB **`PROBECARDTYPE`** 一致：`CARDID` 首个 `-` 前一段（如 `9400-01` → `9400`） |
| `topN` / `topn` | Device 可选 | 默认 **10**，最大 **50**；按 `MAX(TESTEND)` 取最新 N 个 lot |
| `testEndFrom` / `testEndTo` 等 | Device / Lot+JB 可选 | 未传则默认 UTC 最近一年；见 [`../docs/HANDOFF_SITE_BIN_BY_LOT_AGG.md`](../docs/HANDOFF_SITE_BIN_BY_LOT_AGG.md) |

Perl 在匹配 `PASS_ID` 后还会过滤 **`PASS_TYPE='TEST'`**（与 JB **`PASSTYPE=TEST`** 一致）。

### 2.3 Lot 聚合（`device` + `lot`）

**路径规则：** `{INF_STORAGE_ROOT}/{DEVICE大写}/{LOT大写}/r_1-{slot}`（默认根 `/data/INF`）。

| 是否传 `probeCardType` | 行为 |
| --- | --- |
| **不传**（兼容原逻辑） | 扫描 lot 目录下**全部** `r_1-{slot}` 文件，按 pass×bin×dut **累加** `dieCount` |
| **传** | 先查 JB（`PASSTYPE=TEST` + 同 `probeCardType` + `passId`），只对命中的 wafer 读 INF 并累加；磁盘无文件记入 `skippedInfPaths` |

```bash
# 目录扫描（整 lot 下所有片）
curl -s "http://10.192.130.89:30008/api/v1/inf-analysis/site-bin-bylot?device=WA03P02G&lot=NF12551.1N&passId=1"

# 同卡型过滤（推荐与 JB 下钻一致）
curl -s "http://10.192.130.89:30008/api/v1/inf-analysis/site-bin-bylot?device=WA03P02G&lot=NF12551.1N&probeCardType=8037&passId=1"
```

响应除 `passes` 外还有：`meta.aggregateScope: "lot"`、`device`、`lot`、`lotDir`、`waferCount`、`waferSlots`；带卡型时另有 `probeCardType`。

上限：`SITE_BIN_BY_LOT_MAX_WAFERS`（默认 **25** 片）。

### 2.4 Device 聚合（`device` + `passId`，无 `lot`）

跨该 device 下**所有 lot** 中、JB 命中且 INF 可读的 wafer，按同一 `passId` 累加。

**Lot 范围：** 在 JB 候选行内按每个 lot 的 **MAX(TESTEND)** 降序，默认只取最新 **`topN=10`** 个 lot（`topN` 最大 **50**）。响应含 `topN`、`selectedLots`（选中 lot 列表，新→旧）。

**时间窗（与层控 v3 一致）：** 未传 `testStart*` / `testEnd*` 时，先在 **UTC 最近一年** `TESTEND` 内筛 lot，再取 topN。

| `probeCardType` | 行为 |
| --- | --- |
| **不传**（推荐） | Oracle/Dummy 查 `device`+`passId` 下 TEST 行；若仅 **一种** 卡型则自动使用；**多种** 卡型 → **400**（须显式传 `probeCardType`） |
| **传** | 只聚合该卡型对应 wafer |

```bash
# 仅 device + pass（默认 topN=10 个最新 lot）
curl -s "http://10.192.130.89:30008/api/v1/inf-analysis/site-bin-bylot?device=WA03P02G&passId=1"

# 扩大到 20 个 lot（上限 50）
curl -s "http://10.192.130.89:30008/api/v1/inf-analysis/site-bin-bylot?device=WA03P02G&passId=1&topN=20"

# 显式指定卡型（同一 device+pass 存在多种卡时）
curl -s "http://10.192.130.89:30008/api/v1/inf-analysis/site-bin-bylot?device=WA03P02G&probeCardType=8037&passId=1"
```

响应：`meta.aggregateScope: "device"`、`topN`、`selectedLots[]`、`deviceDir`、`waferLots[]`、`probeCardType`、`testEndWindow`、`waferCount`、`waferSlots`、`passes`。

上限：`SITE_BIN_BY_LOT_MAX_WAFERS_DEVICE`（默认 **100** 片）。

### 2.5 单片 wafer（`infPath`）

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `infPath` | 是 | API **服务器本机**上的 INF 绝对路径；别名 `inf_path` |

**sort 与 passId（与 JB 一致）：**

| 用户说法 | `passId` |
| --- | --- |
| sort1 / 常温 | `1` |
| sort2 / 高温 | `3` |
| sort3 / 低温 | `5` |

---

## 3. `infPath` 怎么来（单片模式）

程序拼接（与 `buildInfPath` 一致）：

```text
{INF_STORAGE_ROOT}/{DEVICE大写}/{LOT大写}/r_1-{slot}
```

示例：`device=WA03P02G`、`lot=NF12551.1N`、`slot=3` → `/data/INF/WA03P02G/NF12551.1N/r_1-3`

Lot/Device 聚合**不需要**传 `infPath`，由服务端按上式解析路径。

联调 Dummy 单片固定路径见 §4。

---

## 4. 示例 A：本地 Dummy（无需 Perl / INF）

在 `pcr-ai-api/.env` 中任选其一：

```env
SITE_BIN_BY_LOT_DUMMY=true
# 或
INFCONTROL_LAYER_BINS_DUMMY=true
```

启动 API（`npm run dev`，默认端口 **30008**）。**不要**用 `npm run build` 后的 `dist` 进程测 Dummy（production/dist 恒关 Dummy）。

### curl

```bash
curl -s "http://127.0.0.1:30008/api/v1/inf-analysis/site-bin-bylot?infPath=/data/probe_logs/ps16_SMTPID/teststuffs/infanylist/r_1-1&passId=1&passId=2"
```

浏览器或 Postman 可直接打开（需 URL 编码时只对路径中的特殊字符编码；本路径无需编码）：

```text
http://127.0.0.1:30008/api/v1/inf-analysis/site-bin-bylot?infPath=/data/probe_logs/ps16_SMTPID/teststuffs/infanylist/r_1-1&passId=1&passId=2
```

### 预期

- HTTP **200**
- `infPath` 回显请求路径
- `passIds`: `[1, 2]`
- `passes`: 样本里仅有 **pass 1** 的完整 bin×DUT 数据（30 个 bin）；请求了 pass 2 但样本无 pass 2 时，**不会**出现空的 pass 2 对象

### 看某一 bin（如 bin55）是否偏某些 DUT

在响应 `passes[0].bins` 中找到 `"bin": "bin55"`，看 `duts[]` 里各 `dut` 的 `dieCount` 占比（良品 bin，各 site 颗数应较接近）。

---

## 5. 示例 B：生产 / 真 INF（Perl）

API 主机需安装 **Perl + INFAnalysis**，并已 `npm run build`（含 `dist/perlscripts/output_site_bin_bylot.pl`）。

`.env` 示例：

```env
PERL_BIN=/usr/local/bin/perl
PERL_SCRIPT_TIMEOUT_MS=120000
# 可选：只允许读某目录下的 INF
# INF_PATH_ALLOWED_ROOT=/data/probe_logs
```

### curl

将 `infPath` 换成**该机上真实存在**的 INF 文件，例如：

```bash
curl -s "http://10.192.130.89:30008/api/v1/inf-analysis/site-bin-bylot?infPath=/data/probe_logs/ps16_SMTPID/teststuffs/infanylist/r_1-1&passId=1&passId=2"
```

### 成功响应片段（结构同 Dummy，数值来自 Perl）

```json
{
  "meta": {
    "apiVersion": "1",
    "requestId": "…",
    "summary": "Per wafer test pass … iBinCodeLast + iTestSiteLast …"
  },
  "infPath": "/data/probe_logs/ps16_SMTPID/teststuffs/infanylist/r_1-1",
  "passIds": [1, 2],
  "passes": [
    {
      "passId": 1,
      "bins": [
        {
          "bin": "bin37",
          "duts": [
            { "dut": 5, "dieCount": 120 },
            { "dut": 12, "dieCount": 8 }
          ]
        }
      ]
    }
  ]
}
```

**读结论时注意：**

- `bin` = BIN **编号**（如 `bin37` → BIN 37）
- `dieCount` = **颗数**（勿写成「BIN120」）
- `dut` = 测试 **site 编号**（整数）；`"single"` 表示无 site 层汇总

---

## 6. 示例 C：前端 `fetch`（报表详情区）

```typescript
const apiBase = "http://127.0.0.1:30008"; // 或设置页里的 API 地址
const infPath =
  "/data/probe_logs/ps16_SMTPID/teststuffs/infanylist/r_1-1";
const params = new URLSearchParams({ infPath });
params.append("passId", "1");
params.append("passId", "2");

const res = await fetch(
  `${apiBase}/api/v1/inf-analysis/site-bin-bylot?${params}`
);
if (!res.ok) throw new Error(await res.text());
const data = await res.json();

// 堆叠图：labels = bins，series = 各 dut 的 dieCount
const pass1 = data.passes.find((p: { passId: number }) => p.passId === 1);
const bin37 = pass1?.bins.find((b: { bin: string }) => b.bin === "bin37");
console.log(bin37?.duts);
```

Vite 开发若走代理：base 用 `window.location.origin`，路径仍为 `/api/v1/inf-analysis/site-bin-bylot?...`（见 `pcr-ai-report` 的 `VITE_DEV_API_VIA_PROXY`）。

---

## 7. 错误示例

| HTTP | `code` | 常见原因 |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | 缺少 `passId`；`infPath` 与 `device` 同传；Device 聚合无 `probeCardType`；wafer 数超上限 |
| 404 | `LOT_INF_NOT_FOUND` | lot 目录无 `r_1-*`；JB 无匹配行；JB 有匹配但 INF 均不可读 |
| 502 | `PERL_SCRIPT_FAILED` | INF 不存在、Perl 报错、无 INFAnalysis 模块 |
| 502 | `PERL_OUTPUT_PARSE_FAILED` | Perl 未输出合法 JSON |
| 504 | `PERL_SCRIPT_TIMEOUT` | 超过 `PERL_SCRIPT_TIMEOUT_MS` |

```bash
# 单片缺 passId → 400
curl -s "http://127.0.0.1:30008/api/v1/inf-analysis/site-bin-bylot?infPath=/tmp/x.inf"

# 缺 passId → 400
curl -s "http://127.0.0.1:30008/api/v1/inf-analysis/site-bin-bylot?device=WA03P02G"
```

---

## 8. 与 JB 列表字段对照

| 本接口 | JB `infcontrol-layer-bins` 行字段 |
| --- | --- |
| （拼进 `infPath`）`device` | `DEVICE` |
| （拼进 `infPath`）`lot` | `LOT` |
| （拼进 `infPath`）`slot` | `SLOT` |
| `passId` | `PASSID` |
| `dut`（响应） | **无**（JB 只有 BIN 列合计，无 map site） |

---

## 9. 相关文件

| 文件 | 说明 |
| --- | --- |
| `src/routes/infAnalysisRoutes.ts` | 路由（单片 / lot / device 分支） |
| `src/lib/outputSiteBinByLot.ts` | 校验、Perl、目录扫描与 JB 聚合 |
| `src/lib/siteBinByLotWaferResolve.ts` | JB 查 wafer 列表 + `probeCardType` 过滤 |
| `src/lib/buildInfPath.ts` | `buildInfPath` / `buildInfLotDir` / `buildInfDeviceDir` |
| `src/lib/outputSiteBinByLotDummy.ts` | Dummy 开关与固定路径 |
| `docs/site-bin-bylot-dummy-r_1-1.passes.json` | Dummy 样本数据 |
| `test/outputSiteBinByLot.test.ts` | 单测 |
| `.env.example` | 环境变量 |

Manifest 中的条目：`GET /api/v1/inf-analysis/site-bin-bylot`（`apiManifest.ts`）。
