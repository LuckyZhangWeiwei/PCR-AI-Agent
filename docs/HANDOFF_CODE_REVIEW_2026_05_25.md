# Code Review 修复 + Agent 工程经验提示词 — Cursor 交接

**日期：** 2026-05-25（Code Review 后修复 + agentPrompt 工程经验章节）  
**分支：** `feat/report-ux-dut-bin-agg`  
**修改包：** `pcr-ai-api`、`pcr-ai-report`

---

## 1. 给下一位的一句话

本次无新功能，只做 **4 项代码质量修复**（前后端计算分歧、路由重构、并行 IO、调试残留清理）+ **1 项 Agent Prompt 增强**（工程经验参考章节）。所有改动均通过 typecheck 和 138 个测试（0 失败）。

---

## 2. 四项修复详情

### 2.1 前后端 yieldCalc 逻辑对齐

**文件：** [`pcr-ai-report/src/utils/yieldCalc.ts`](../pcr-ai-report/src/utils/yieldCalc.ts) — `computeYieldPct`

**问题：** `secondPct === null` 的 guard 在 `goodUp === 0` 检查之前，导致边缘情况（上半段 goodDie=0 且下半段 grossDie=0）时：
- API（`jbYieldCalc.ts`）返回 `null`（无法计算）
- 前端返回 `0%`（错误）

**修复：** 先计算 `goodUp`，若 `goodUp === 0` 直接返回 `secondPct`（可能为 null），再做 null guard。逻辑现与 API `computeSegmentedWholeWafer` 完全一致。

> **维护提示：** `pcr-ai-api/src/lib/jbYieldCalc.ts` 与 `pcr-ai-report/src/utils/yieldCalc.ts` 实现了相同的拆分逻辑（前后端无共享代码），修改任一侧的 INTERRUPT/续测判断规则时，**必须同步另一侧**。

---

### 2.2 路由处理器拆分

**文件：** [`pcr-ai-api/src/routes/infAnalysisRoutes.ts`](../pcr-ai-api/src/routes/infAnalysisRoutes.ts)

**问题：** 单个路由处理器约 400 行，5 层嵌套 try/catch，难以维护。

**修复：** 将三条聚合路径抽为独立 async 函数：

| 函数 | 触发条件 | 对应模式 |
|---|---|---|
| `handleLotWithCardType` | `device` + `lot` + `probeCardType` | JB 卡型过滤后聚合 |
| `handleLotByDirectory` | `device` + `lot`（无卡型）| 扫 lot 目录全部 wafer |
| `handleDeviceAgg` | `device`（无 `lot`）| topN 最新 lot 聚合 |

主路由 handler 现只做参数解析和分发，嵌套层级从 5 层降至 2 层。功能语义**完全不变**。

---

### 2.3 并行文件可读性检查

**文件：** [`pcr-ai-api/src/lib/siteBinByLotWaferResolve.ts`](../pcr-ai-api/src/lib/siteBinByLotWaferResolve.ts) — `resolveSiteBinWafersWithSkips`

**问题：** 原实现对 JB 匹配到的每个 wafer INF 路径串行调用 `fs.promises.access`（for…await 循环）。device 聚合场景下（topN=10 lot × ~25 wafers/lot = ~250 次文件检查）在网络共享路径上延迟可观。

**修复：** 改为 `Promise.allSettled` 并行发起所有文件检查，按结果分类填入 `wafers`（可读）和 `skippedInfPaths`（不可读）。语义不变，顺序对应 `fromJb` 数组索引。

---

### 2.4 调试脚本清理

**目录：** `pcr-ai-api/scripts/`

删除排查 slot 良率 bug 时留下的 8 个一次性诊断脚本：

| 删除文件 | 原用途 |
|---|---|
| `dump-slot-rows.ts` | 查看某 lot 的原始 slot 行 |
| `find-full-cassette-lot.ts` | 找满片（4848 grossDie）的 lot |
| `find-lot-by-yield.ts` | 按良率阈值查 lot |
| `print-slot-breakdown.ts` | 打印 slot INTERRUPT/续测详情 |
| `print-slot-yield.ts` | 打印每 slot 良率 |
| `print-slot-yield-api.ts` | 通过 API 打印 slot 良率 |
| `scan-lots-4848.ts` | 扫描 4848 grossDie 的 lot |
| `scan-passnum.ts` | 扫描 PASSNUM 字段分布 |

保留的 4 个构建用 `.mjs` 脚本不受影响（`copy-perlscripts`、`verify-dist-no-undici`、`write-api-v3-doc`、`write-site-bin-dummy-fixture`）。

---

## 3. Agent Prompt 工程经验章节

**文件：** [`pcr-ai-api/src/lib/agent/agentPrompt.ts`](../pcr-ai-api/src/lib/agent/agentPrompt.ts)

在「枚举 lot 内所有 wafer」和「回复质量要求」之间新增 `## 工程经验参考（诊断辅助）` 章节（约 45 行），包含四张精炼参考表和一个 3 步诊断流程：

| 子节 | 覆盖内容 |
|---|---|
| **DUT 报警模式 → 探针卡根因** | 5 种 delta_diff 报警模式（单DUT/多DUT/全卡/换批突发/随时间递增）→ 可能根因 + 建议行动 |
| **坏 Bin 分布特征 → 工艺/测试机判断** | 集中型/分散型/梯度/奇偶slot/全片失效/仅1~2片异常 → 常见解读 |
| **温度层（sort）失效关联** | sort1/2/3（passId=1/3/5）各自失效 → 常温参数/热漏电流/低温不稳/物理缺陷 |
| **INTERRUPT 工程含义** | 产生原因、续测逻辑（completionHalf 才是真实结果）、大量 INTERRUPT 排查方向 |
| **联合诊断 3 步流程** | aggregate 整批 → 横向对比趋势 → slot 钻取，以「探针卡问题 vs 工艺问题」作结论 |

> 该章节仅提供诊断辅助参考，Prompt 明确标注"不替代工具查询"，不影响工具调用逻辑。

**部署生效条件：** `pcr-ai-api` 重新 build + pm2 reload 后，新会话即加载新 prompt。已有 session 不受影响（session 级历史不含 system prompt）。

---

## 4. 验证状态

| 验证项 | 结果 |
|---|---|
| `pcr-ai-api npm run typecheck` | ✅ 通过 |
| `pcr-ai-api npm test` | ✅ 138 tests，136 pass，2 skip，0 fail |
| `pcr-ai-report npm run build` | ✅ tsc + vite 构建成功 |

---

## 5. 下一步建议

- 部署：`npm run build + pm2:reload`（API）；`npm run pack:dist`（前端）
- 若需验证工程经验 prompt 效果：在 AI Agent 中问「某批 lot 有 INTERRUPT 记录，怎么看？」或「某张卡报警次数在增加，是什么原因？」，观察 Agent 是否引用经验参考给出更具体的诊断建议
