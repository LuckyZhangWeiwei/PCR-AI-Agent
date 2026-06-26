# Task 1 报告：DUT 集中度检测器

## 完成情况

成功按 TDD 流程实现 DUT 集中度检测器，判别坏 die 集中在少数 DUT（探针卡问题）vs 分散（工艺问题）。

## 实现文件

- **源文件**: `pcr-ai-api/src/lib/agent/agentDutConcentration.ts` (135 行)
- **测试文件**: `pcr-ai-api/test/agentDutConcentration.test.ts` (43 行)

## 核心逻辑

### 函数签名
```typescript
export function buildDutConcentrationInsights(
  passes: SiteBinPass[],
  cardByPassId: CardByPassIdEntry[] = [],
  opts: DutConcentrationOptions = {}
): DutConcentrationInsight[]
```

### 判别规则

1. **数据过滤**
   - 按 `focusBins` 限制分析的 bin 编号
   - 按 `minTotalDie`（默认 8）过滤低统计量 bin（< 8 颗坏 die 则跳过）
   - 只统计数值型 DUT（过滤 `"single"` 类型）

2. **集中度判别**
   - **probe_card** (探针卡问题): 前 3 大 DUT 的坏 die 占比 ≥ `topShareThreshold`（默认 70%）
   - **process** (工艺问题): 前 3 大 DUT 坏 die 占比 < 70% 且 DUT ≥ 3 个
   - **inconclusive** (样本不足): DUT < 3 个，无法判别

3. **输出字段**
   - `bin`: 解析后的 bin 数字（从 `bin11` → 11）
   - `passId`: 测试 pass ID
   - `sortLabel`: pass 的易读标签（`pass1` / `pass3` / `pass5`）
   - `cardId`: 该 pass 使用的探针卡 ID（无则 `null`）
   - `totalDie`: 该 bin 的坏 die 总颗数
   - `topDuts`: 前 3 大 DUT 的详细数据（dut, dieCount, share %）
   - `topShare`: 前 3 大 DUT 的集中度（0-1）
   - `verdict`: 判别结果
   - `detail`: 自然语言解读（包含具体数据和建议）

4. **排序**: 按 `totalDie` 降序返回（坏 die 最多的 bin 优先）

## 测试命令与结果

```bash
cd D:\AI\PCR-AI-Agent\pcr-ai-api
npx tsx --test test/agentDutConcentration.test.ts
```

### 测试覆盖（5 个用例，全部通过）

| # | 测试用例 | 说明 |
|----|--------|------|
| 1 | concentrated bad die on few DUTs => probe_card | 集中在 2 个 DUT（45+40=85/100），判别为探针卡问题 |
| 2 | uniform spread across many DUTs => process | 均匀分散到 10 个 DUT（各 10 颗），判别为工艺问题 |
| 3 | total below minTotalDie => no insight | 总颗数 5 < minTotalDie(8)，无输出 |
| 4 | fewer than 3 DUTs => inconclusive | 仅 2 个 DUT，判别为样本不足 |
| 5 | focusBins limits which bins are analyzed | 仅分析 `focusBins: [11]`，过滤其他 bin |

**测试结果**: ✅ 5/5 pass，0 fail

```
ok 1 - concentrated bad die on few DUTs => probe_card
ok 2 - uniform spread across many DUTs => process
ok 3 - total below minTotalDie => no insight
ok 4 - fewer than 3 DUTs => inconclusive
ok 5 - focusBins limits which bins are analyzed
```

## 自审与处理

### 代码质量检查

1. **ESM 兼容性** ✅
   - 所有相对 import 带 `.js` 后缀（`outputSiteBinByLot.js`, `agentJbBinFormat.js`, `jbYieldCalc.js`）
   - 无外部依赖，纯类型与函数

2. **类型复用** ✅
   - `SiteBinPass`（含 `SiteBinEntry` 和 `SiteBinDutEntry`）来自 `outputSiteBinByLot.ts`
   - `CardByPassIdEntry` 来自 `agentJbBinFormat.ts`
   - `passIdSortLabel` 来自 `jbYieldCalc.ts`
   - 无新增类型定义

3. **边界处理** ✅
   - bin 号解析失败时跳过（`parseBinNumber` 返回 `null`）
   - 空 cardByPassId 时 cardId 为 `null`
   - 多张卡时用逗号分隔字符串

4. **输出排序** ✅
   - 按 `totalDie` 降序（最严重的 bin 优先）

### 潜在扩展点

- `topShareThreshold`: 默认 70% 可根据制程经验调整
- `minTotalDie`: 默认 8 可按统计置信度调整
- `focusBins`: 支持只关注特定 bin 的场景

## Commit 信息

```
b6fd016 feat(agent): DUT 集中度检测器（卡 vs 工艺判别）
```

- 2 files changed, 135 insertions(+)
- `src/lib/agent/agentDutConcentration.ts` (新建)
- `test/agentDutConcentration.test.ts` (新建)

## 状态

✅ **DONE** — 实现完整，测试全过，无遗留问题。
