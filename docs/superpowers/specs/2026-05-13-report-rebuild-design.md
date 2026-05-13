# pcr-ai-report 报表重建设计文档

**日期**: 2026-05-13  
**范围**: `pcr-ai-report/src/reports/` — 重建 YieldMonitorReport、InfcontrolReport，新增 AiAgentReport 占位 tab  
**后端**: 不新增 Oracle 表或列；所有新功能仅组合现有 v3 API 端点，并同步更新 Oracle + Dummy 两条路径（如需后端改动）

---

## 1. 导航结构（5 个 Tab）

| # | Tab 名 | 组件 | 状态 |
|---|--------|------|------|
| 1 | API 目录 | `OverviewReport` | 不变 |
| 2 | ⚡ yield monitor | `YieldMonitorReport` | **重建** |
| 3 | 🔬 JB START | `InfcontrolReport` | **重建** |
| 4 | 🤖 AI 助手 | `AiAgentReport` | **新增（占位）** |
| 5 | 表浏览 | `TableRowsReport` | 不变 |

---

## 2. 视觉风格

全局暗色主题，沿用现有 `theme/chartTheme.ts` 调色板。新增：

- **KPI 卡片**：发光边框（`box-shadow: 0 0 12px rgba(color, 0.4)`）+ 渐变背景 + 数字 count-up 动画（`requestAnimationFrame`，持续 600ms）+ 趋势箭头颜色编码
- **图表**：圆角渐变柱（ECharts `barBorderRadius`）、鼠标悬浮高亮、动画载入（`animationDuration: 600`）
- **筛选 Chips**：毛玻璃效果标签（`backdrop-filter: blur(4px)`），点击 ✕ 弹出删除动画，快捷时间按钮（今天 / 近7天 / 本月）

---

## 3. 分组交互设计（B+C 模式）

### 3.1 图表层：两级下钻

1. **第一级**：按主维度（`lot` 或 `device`）发起 aggregate 请求，结果渲染为条形图或汇总行。
2. **点击行/柱**：在图表下方展开"第二级面板"，自动追加该行的筛选值（如 `lot=DR390`）后发起第二次 aggregate 请求。
3. **第二级子维度切换**：面板内提供维度标签按钮（`cardId` / `slot` / `bin` 等），点击重新发第二次请求，不关闭面板。
4. 再次点击同一行/柱收起面板。

API 调用模式：
```
第一级: GET /api/v3/infcontrol-layer-bins/v3/aggregate?groupBy=lot&<filters>
第二级: GET /api/v3/infcontrol-layer-bins/v3/aggregate?groupBy=cardId,bin&lot=DR390&<filters>
```

### 3.2 聚合表格层：折叠树表

1. 发起单次多维度 aggregate 请求（如 `groupBy=lot,cardId,bin`）。
2. 前端将扁平结果按主维度（`lot`）分组，构建三层树：`LOT → CardId/Slot → Bin`。
3. 每个父节点展示汇总值（坏 die 合计、Yield% 加权平均）。
4. 展开/折叠状态存于本地 `React.useState`，不重新请求。
5. yield monitor 对应树结构：`DEVICE → LOT → ProbeCard → dutNumber`。

---

## 4. ⚡ yield monitor tab（重建）

### 4.1 筛选区

| 字段 | 参数名 | 控件类型 |
|------|--------|----------|
| Device | `device` | 文本输入 |
| LotID | `lotId` | 文本输入 |
| Wafer | `wafer` | 文本输入 |
| Hostname | `hostname` | 文本输入 |
| ProbeCard | `probeCard` | 文本输入 |
| Pass | `pass` | 下拉（全部 / 0 / 1 / 2） |
| 时间范围 | `timestampFrom` / `timestampTo` | 日期时间输入 + 快捷按钮（今天/近7天/本月） |

- 所有字段可任意组合，AND 语义，留空不筛。
- 活跃筛选以 Chip 标签显示于底部，点击 ✕ 清除单项。
- 单一"查询"按钮，并行触发：① list（`limit=500`）② aggregate（timeDay）③ aggregate（probeCard）

### 4.2 KPI 卡片（4 个）

| 卡片 | 数据来源 | 颜色 |
|------|----------|------|
| 触发总数 | aggregate 响应的 `totalRowsMatching`（任一并行 aggregate 请求均带此字段） | 白/蓝 |
| 涉及 Lot 数 | 前端去重 list `rows[].lotId` | 白 |
| 触发最多探针卡 | aggregate `dimensions=probeCard` 结果首行 `parts.probeCard` | 红 |
| 触发最多 DUT | 前端对 list `rows[]` 解析 `dutNumber`（`TRIGGER_LABEL` 中 "on dut# N"），取最高频 | 白 |

### 4.3 图表区

| 图表 | 请求 | 说明 |
|------|------|------|
| 每日触发趋势（全宽折线/面积图） | aggregate `dimensions=timeDay` | 横轴日期，纵轴 count |
| ProbeCard 触发排名（横向条形） | aggregate `dimensions=probeCard` | 点击柱 → 下钻：该 probeCard 下按 `timeDay` 趋势 |
| DUT# 触发分布（横向条形） | 前端聚合 list `rows[]` 中的 `dutNumber` | 点击柱 → 下钻：该 dut 下按 `probeCard` 分布（发 aggregate `dimensions=probeCard`） |
| LOT 触发排名（横向条形） | aggregate `dimensions=lotId` | 点击柱 → 下钻：该 lot 下按 `probeCard` 分布（发 `dimensions=probeCard` + `lotId=XXX`） |
| 自由维度聚合（全宽） | aggregate `dimensions=<选中维度>` | 维度标签：lotId/device/probeCard/wafer/hostname/pass；选中后立即重新请求 |

### 4.4 折叠树聚合表

- 请求：`dimensions=device,lotId,probeCard` + 现有筛选（yield monitor aggregate 端点）
- 树结构：`DEVICE → LOT → ProbeCard → 触发次数`（3层折叠）
- 列：维度值 | 触发次数 | 占比

### 4.5 明细表

列：`TIME_STAMP` | `HOSTNAME` | `DEVICE` | `LOTID` | `WAFER` | `PROBECARD` | `dutNumber`（蓝色高亮）

`dutNumber` 从 `TRIGGER_LABEL` 实时解析，正则：`/on dut#\s*(\d+)/i`

---

## 5. 🔬 JB START tab（重建）

### 5.1 筛选区

| 字段 | 参数名 | 控件类型 |
|------|--------|----------|
| Device | `device` | 文本输入 |
| Lot | `lot` | 文本输入 |
| Slot（wafer 号）| `slot` | 文本输入 |
| ProbeCard (CARDID) | `cardId` | 文本输入 |
| Tester Type | `tstype` | 下拉（全部 / UFLEX / …） |
| TesterID | `testerId` | 文本输入 |
| PassID | `passId` | 下拉（全部 / 1 / 2 / …） |
| MES Slot | `mesSlot` | 文本输入 |
| 测试结束时间 | `testEndFrom` / `testEndTo` | 日期时间输入 + 快捷按钮 |

- 所有字段 AND 语义，留空不筛。
- 底部 Chip 显示活跃筛选，单一"查询"按钮，并行触发：① list（`limit=500`）② aggregate bad-bin ranking（`groupBy=bin`）③ aggregate probeCard（`groupBy=cardId,bin`）

### 5.2 KPI 卡片（4 个）

| 卡片 | 数据来源 | 颜色 |
|------|----------|------|
| 匹配 Wafer 数 | aggregate 响应的 `totalRowsMatching` | 白/蓝 |
| 综合 Yield% | 前端计算：`1 - Σbad_die / Σgrossdie`（遍历 list 行） | 绿（≥95%）/ 黄（80-95%）/ 红（<80%） |
| 最差探针卡 | aggregate cardId 结果中坏 die 最多的 `cardId` | 红 |
| Top 不良 Bin | aggregate bin 结果首行 `bin` | 橙/黄 |

**Yield% 计算方法**（前端，无需后端改动）：
```typescript
// v3 list 响应中每行含 bins 数组
const totalBad = rows.reduce((sum, row) => {
  const badDie = row.bins
    .filter(b => !b.isGoodBin)
    .reduce((s, b) => s + b.value, 0);
  return sum + badDie;
}, 0);
const totalGross = rows.reduce((sum, row) => sum + row.grossDie, 0);
const yieldPct = totalGross > 0 ? (1 - totalBad / totalGross) * 100 : null;
```

### 5.3 图表区

| 图表 | 请求 | 说明 |
|------|------|------|
| 各 LOT Yield% 条形图（全宽） | 前端按 `lot` 分组计算各 lot Yield% | 颜色编码：绿≥95% / 黄80-95% / 红<80%；点击柱 → 下钻：该 lot 按 `slot` 分布 |
| 不良 BIN 全量排名（横向条形） | aggregate `groupBy=bin` | 点击柱 → 下钻：该 bin 在各 `cardId` 的分布 |
| ProbeCard 不良 die 对比（横向条形） | aggregate `groupBy=cardId,bin` | 点击柱 → 下钻：该 cardId 下 `slot` 趋势 |
| Slot 趋势（折线/条形，wafer 间比较） | aggregate `groupBy=slot,bin` | 横轴 slot 号，纵轴坏 die；识别边缘/中心规律 |
| 自由维度聚合（全宽） | aggregate `groupBy=<选中维度>` | 维度标签：lot/device/cardId/slot/tstype/passId/testerId/bin（8维）；选中后立即重新请求 |

### 5.4 折叠树聚合表

- 请求：`groupBy=device,lot,cardId,bin` + 现有筛选（最多 8 维，在允许范围内）
- 树结构：`DEVICE → LOT → CardId → Bin`（4 层折叠）
- 列：维度值 | 坏 die 合计 | Yield%（仅 DEVICE/LOT 层级显示，需 GROSSDIE；可从 list rows 中按 device+lot 分组计算）

### 5.5 明细表

列：`TESTEND` | `DEVICE / LOT` | `SLOT` | `CARDID` | `PASSID` | `Yield%`（绿色，前端计算） | `Top Bad Bin`

---

## 6. 🤖 AI 助手 tab（占位）

渲染一个静态占位面板，包含：
- 标题："AI 助手（开发中）"
- 说明文字：下一阶段接入 Node.js Agent + 硅基流动 Function Call
- 预留布局框架：对话框区 + 结果区（空白 placeholder div，加虚线边框）

不实现任何功能逻辑。

---

## 7. 前端实现约定

### 7.1 并行请求模式

每个 tab 点击"查询"后，使用 `Promise.allSettled` 并行发起多个 `apiGetJson` 请求，各自有独立的 loading/error 状态，互不阻塞渲染。

```typescript
const [listResult, binRankResult, cardResult] = await Promise.allSettled([
  apiGetJson<ListResp>(apiBase, `${API_PREFIX}/infcontrol-layer-bins/v3`, listParams),
  apiGetJson<AggResp>(apiBase, `${API_PREFIX}/infcontrol-layer-bins/v3/aggregate`, { groupBy: 'bin', ...filters }),
  apiGetJson<AggResp>(apiBase, `${API_PREFIX}/infcontrol-layer-bins/v3/aggregate`, { groupBy: 'cardId,bin', ...filters }),
]);
```

### 7.2 两级下钻状态

```typescript
type DrillDown = {
  parentDim: string;   // e.g. "lot"
  parentVal: string;   // e.g. "DR390"
  subDim: string;      // e.g. "cardId"
  data: AggRow[] | null;
  loading: boolean;
};
const [drillDown, setDrillDown] = useState<DrillDown | null>(null);
```

点击图表柱/行时 set drillDown，清空时 set null。

### 7.3 折叠树表

```typescript
type TreeNode = {
  key: string;
  label: string;
  value: number;        // 坏 die 合计 / 触发数
  yieldPct?: number;
  children?: TreeNode[];
  expanded: boolean;
};
```

前端将 aggregate 扁平数组按维度顺序 reduce 成树，不重新发请求。

### 7.4 Count-up 动画

```typescript
function useCountUp(target: number, duration = 600) {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    let start = 0;
    const step = (ts: number) => {
      if (!start) start = ts;
      const progress = Math.min((ts - start) / duration, 1);
      setDisplay(Math.round(progress * target));
      if (progress < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, [target, duration]);
  return display;
}
```

### 7.5 文件拆分建议

重建后的两个报表组件预计较大，建议按以下方式拆分（实现时决定）：

- `YieldMonitorReport.tsx` — 主组件（筛选、查询逻辑、布局）
- `YieldMonitorCharts.tsx` — 图表子组件
- `InfcontrolReport.tsx` — 主组件
- `InfcontrolCharts.tsx` — 图表子组件
- `components/TreeTable.tsx` — 可复用折叠树表（两个 tab 共享）
- `components/KpiCard.tsx` — 可复用 KPI 卡片（含 count-up）
- `components/DrillDownPanel.tsx` — 可复用下钻面板

---

## 8. 后端变更（如需）

当前设计**不需要**新增 API 端点或修改 Oracle 表结构。所有功能通过组合现有 v3 端点实现。

若实现过程中发现必要的后端改动，遵守 Dummy-Oracle 同步规则：
- 同时修改 Oracle SQL 路径（`*Sql.ts` 或 `routes/api.ts`）
- 同时修改对应 `*Dummy.ts` 文件
- 通过 `npm test`（Dummy 路径）验证

---

## 9. 不在范围内

- 新增 Oracle 表或列
- AI 助手 tab 的实际功能（下一阶段）
- 导出 CSV / Excel 功能
- 用户权限 / 登录
- 移动端适配
