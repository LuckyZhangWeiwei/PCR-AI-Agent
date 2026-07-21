# Cursor 修复交接（2026-07-21 · 给 Claude Code）

> **执行者：** Cursor Agent  
> **读者：** Claude Code / 接手 Agent DUT×BIN 晶圆图的 Agent  
> **前置阅读：** [`HANDOFF_INF_WAFER_MAP_AND_AGENT_TABLE_UX.md`](HANDOFF_INF_WAFER_MAP_AND_AGENT_TABLE_UX.md) §5（`inf_draw_dut_bin_map`）  
> **分支：** `refactor/api-domain-split`  
> **范围：** Agent `inf_draw_dut_bin_map` 在指定 pass（如高温=pass3）上目标 BIN 显示为 0，尽管正测层实际有该 BIN×DUT

---

## 0. 一眼结论

| 项 | 状态 | 说明 |
|---|---|---|
| **现象** | ✅ 已修 | `WA00P23N / NF13390.1K / Slot 1` 高温 DUT0×BIN8：图上 BIN8=0、双匹配=0，仅 3 颗 DUT0 横线 |
| **根因** | ✅ 已定位 | 数字 `pass_id` 把同 PASS_ID 的 **RETESTBIN** 与 **TEST** 合并；复测覆盖 die bin，把正测层目标 BIN 抹成 0 |
| **改法** | ✅ 已合入 | DUT×BIN 图对 1/3/5 **只读 PASS_TYPE=TEST**（对齐 site-bin-bylot）；目标 BIN 仍为 0 时自动扫描其它层 |
| **部署后复验** | ⏭ 待做 | `cd pcr-ai-api && npm run build && pm2 reload` 后重问同一句；应见白色双匹配 / 非 0 的 BIN8 |

---

## 1. 问题复现

用户问：

> 帮我画一片 NF13390.1K 高温第一片 wafermap，highlight 出来 dut0 bin8 的分布

Agent 走 `agentDutBinMapRoute` → `inf_draw_dut_bin_map`（高温→`pass_id=3`），返回：

- Pass: **3**
- DUT0 测的 die: **3**
- BIN8 出现: **0** / 双匹配: **0**
- 警告：该 pass 中 BIN8 为 0，请改用其他 pass_id

用户确认 **DUT0 实际有 BIN8**（与 site-bin / 正测层观感一致）。

---

## 2. 根因：TEST+RETEST 合并 vs site-bin 只读 TEST

| 路径 | 行为 |
|---|---|
| **`output_site_bin_bylot.pl`** | 仅 `PASS_TYPE=TEST` + `iBinCodeLast` / `iTestSiteLast` |
| **修复前 `getDiesForPassId("3")`** | 合并该 PASS_ID 下 **全部** SmWaferPass（含 RETESTBIN）；后写覆盖前写 |
| **结果** | 复测改掉的 die 上，正测 BIN8 消失 → 图上 BIN8=0 |

Dummy 样本 `pcr-ai-api/docs/inf-dummy-r_1-1` 可直接复现：

| 层 | dies | BIN8 | DUT0×BIN8 |
|---|---|---|---|
| Pass 3 **TEST** | 1106 | **4** | **2** |
| Pass 3 **RETESTBIN** | 27 | 0 | 0 |
| Pass 3 **MERGED**（旧行为） | 1106 | **0** | **0** |

晶圆图「Pass N（合成）」tab 仍需要 TEST+RETEST 合并（显示复测后结果）；**DUT×BIN 关系图**必须与 site-bin 口径一致，只看正测。

---

## 3. 修复

### 3.1 `getDiesForPassId` 可选 `passTypes`

**文件：** `pcr-ai-api/src/lib/infWaferMap/infWaferMapPassSpecs.ts`

```typescript
export type GetDiesForPassIdOptions = {
  /** 纯数字 PASS_ID 时只合并这些 PASS_TYPE（大小写不敏感） */
  passTypes?: readonly string[];
};

getDiesForPassId(root, goodBins, "3", { passTypes: ["TEST"] });
```

- `final` / `N@pre` / `RETESTBIN:N` / `__block:N`：**不受**该过滤影响  
- 默认不传 `passTypes` → 行为与改前相同（晶圆图合成 tab 不回归）

### 3.2 `resolveDutBinMapDies`（DUT×BIN 专用）

同文件导出：

1. 数字 pass → **TEST only**  
2. 若该层目标 BIN 颗数仍为 0 → 扫描 `1` / `3` / `5` / `final`，选 BIN 最多的一层，并附 `fallbackNote`  
3. `inf_draw_dut_bin_map`（`infToolsVisualization.ts`）改为调用此函数，不再直接 `getDiesForPassId` 无过滤合并

### 3.3 Prompt

`agent/prompt/sections/domainSection.ts`：补充「数字 passId 只读正测层、服务端可自动换 pass」说明。

---

## 4. 改动文件

| 文件 | 变更 |
|---|---|
| `pcr-ai-api/src/lib/infWaferMap/infWaferMapPassSpecs.ts` | `GetDiesForPassIdOptions`、`resolveDutBinMapDies` |
| `pcr-ai-api/src/lib/infTools/singleWafer/infToolsVisualization.ts` | `runDrawDutBinMap` 改用 `resolveDutBinMapDies` |
| `pcr-ai-api/src/lib/agent/prompt/sections/domainSection.ts` | passId 规则补丁 |
| `pcr-ai-api/test/infWaferMapPassSpecs.test.ts` | 两例：TEST-only 保留 BIN8；resolve 不回退 |

---

## 5. 测试

```bash
cd pcr-ai-api
npx tsx --test test/infWaferMapPassSpecs.test.ts
# 关键断言：
# - getDiesForPassId(passTypes:TEST) keeps BIN that RETEST merge would wipe
# - resolveDutBinMapDies uses TEST-only for numeric pass (no RETEST wipe)
npm run typecheck
```

---

## 6. 部署与复验

```bash
cd pcr-ai-api && npm ci && npm run build && pm2 reload
```

| 话术 | 预期 |
|---|---|
| `帮我画 NF13390.1K 高温第一片 DUT0 BIN8 分布` | Pass 3、**BIN8 > 0**、有白色双匹配（若正测确有）；勿再报「该 pass BIN8=0」仅因合并了复测 |
| 普通 `inf_draw_wafer_map` pass 合成 tab | 仍可为 TEST+RETEST 合并（未改默认 `getDiesForPassId`） |

⏭ **真库复验**（部署后）：同一 lot/slot；对照 `query_inf_site_bin_by_dut(passId:3, focusDut:0, focusBin:8)` 的 die 数是否与图例一致。

---

## 7. 勿破坏的约定

1. **晶圆图「Pass N（合成）」** 仍用无过滤的 `getDiesForPassId(passId)` — 不要全局改成 TEST-only。  
2. **DUT×BIN** 必须与 **site-bin-bylot（PASS_TYPE=TEST）** 同口径。  
3. **dummy-parity**：本批未改 Oracle WHERE；仅 INF 解析路径。  
4. 其它 `inf_*` 工具若也需要「与 site-bin 比 DUT×BIN」，应显式传 `{ passTypes: ["TEST"] }` 或复用 `resolveDutBinMapDies`，勿 silently 改全局默认。

---

## 8. 给 Claude Code 的下一步（可选）

- [ ] 部署后对 `NF13390.1K` slot1 高温 DUT0×BIN8 真库点验  
- [ ] 评估 `inf_site_stats` / 空间分析等是否也应默认 TEST-only（当前未改，避免扩大范围）  
- [ ] 若用户要看「复测后」DUT×BIN，可另加 `pass_id=3@retest` 或显式合成开关（尚未实现）
