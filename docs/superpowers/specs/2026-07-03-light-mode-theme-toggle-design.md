# 设计：Light Mode 主题切换（2026-07-03）

**状态：** 设计已与用户确认，待写实现计划
**范围：** `pcr-ai-report/` 前端展示层（CSS 变量、ECharts 配色、顶栏按钮），**不碰** `pcr-ai-api` 后端
**用户确认的关键决策：**
1. 无存储主题偏好时，**默认浅色**（新访客首次看到的是 light mode；一旦手动切换，之后按 `localStorage` 记住的选择）。
2. **全站覆盖**：Yield / JB Star / AI Agent 聊天 / 表浏览 / 设置、反馈弹窗、锁屏弹窗、ECharts 图表全部适配浅色，不分优先级、不留死角。

---

## 1. 目标

现状网站只有一套深色 UI（`index.css` 的 `:root` token + 大量组件级硬编码色值 + ECharts 固定深色配色）。本次要做：

1. 新增浅色主题，**风格与深色版本一致**（同样的圆角、阴影层次、渐变强调色逻辑），不是简配色的“反色”。
2. 顶栏加一个可点击的切换按钮（🌙 / ☀️），随时切换，选择持久化。
3. 覆盖全部页面与组件，包括 ECharts 图表本身的坐标轴/分割线/tooltip 配色。

---

## 2. 架构

### 2.1 主题状态：`hooks/useTheme.ts`（新）

```
localStorage key: "pcr-ai-report.theme.v1"   值: "light" | "dark"
```

- 无存储值时，state 初始为 `"light"`（对应用户确认的默认浅色）。
- 提供 `theme`、`setTheme`、`toggleTheme`。
- `useEffect` 里把 `document.documentElement.dataset.theme = theme`，供 CSS `[data-theme="light"]` 选择器使用；深色沿用现有 `:root` 默认值，不需要显式 `[data-theme="dark"]`（无属性时 = 深色，保证旧 `localStorage` 为空的场景也不炸）。

### 2.2 `ThemeContext`（新，`theme/ThemeContext.tsx`）

- `App.tsx` 顶层 `<ThemeContext.Provider value={{theme, toggleTheme}}>` 包裹现有内容。
- 原因：ECharts 配色是深层嵌套组件（`YieldMonitorReport`、`InfcontrolReport`、`DrillDownPanel`、`InfDutDistPanel`）内联构造的，用 Context 比逐层传 props 干净，且和现有 `apiBase` 之类的传参方式保持一致的粒度（这几个图表组件本来就没有拿到 `apiBase` 之外的“全局”状态，Context 是最小侵入方式）。

### 2.3 顶栏按钮

- `App.tsx` 的 `.app-header` 内，`.app-title-block` 同一行右侧新增：
  ```tsx
  <button type="button" className="theme-toggle-btn" onClick={toggleTheme} title="切换主题">
    {theme === "light" ? "☀️" : "🌙"}
  </button>
  ```
  图标代表**当前主题**（浅色下显示☀️、深色下显示🌙），点击后切换到另一种。
- 样式 `.theme-toggle-btn`：圆形、32px、`var(--surface-1)` 背景 + `var(--border)` 描边，hover 时 `border-color: var(--border-hi)`，与 `.btn.ghost` 视觉家族一致但是圆形图标按钮。

---

## 3. CSS 变量改造

### 3.1 `index.css` 的 `:root` token

保留现有深色值作为默认（无 `data-theme` 属性时生效）。新增：

```css
[data-theme="light"] {
  color-scheme: light;

  --bg:        #f6f8fa;
  --surface-1: #ffffff;
  --surface-2: #f0f2f5;
  --surface-3: #e9ecef;
  --border:    rgba(31, 35, 40, 0.12);
  --border-hi: rgba(9, 105, 218, 0.4);

  --text:    #1f2328;
  --muted:   #57606a;
  --dimmed:  #6e7781;

  --accent:   #0969da;
  --accent-2: #8250df;
  --green:    #1a7f37;
  --red:      #cf222e;
  --yellow:   #9a6700;

  --shadow-sm: 0 1px 2px rgba(31,35,40,0.08);
  --shadow-md: 0 4px 16px rgba(31,35,40,0.08);
  --shadow-lg: 0 12px 40px rgba(31,35,40,0.12);
}
```

（配色取自 GitHub Primer light 配色系，跟当前深色版本的 GitHub-dark 系一脉相承，视觉上是同一套设计语言的两个变体。）

### 3.2 硬编码色值清理（关键风险点）

扫描发现 `index.css` 内约 137 处硬编码 `#hex` / `rgba(...)`，其中相当一部分**没有走变量**，直接写死深色值，主要分布在：

- `.report-reorder-item`、`.yield-trend-block`、`.report-chart-panel`、`.inf-dut-standalone-row`：直接写 `background: #0d1117` / `border-color: rgba(240,246,252,0.1)` 等 → 改成 `var(--bg)` / `var(--border)`。
- `.funnel-step`、`.funnel-back-btn` 等：`background: #161b22`、`border: 1px solid #30363d` → 改用 `var(--surface-1)` / `var(--border)`。
- `.settings-lock-box` 系列：独立写死的深色配色（`#111827`/`#1f2937`/`#374151`）→ 改用共享变量，视觉上会和其余卡片统一（目前这块用的是另一套不同的深色，属于历史遗留不一致，顺手统一）。
- 语义色（红/绿状态 pill、`.query-chip` 蓝色系）：这些在浅色背景上对比度可能不够，需要重新挑一版饱和度更高/更暗的色号而不是直接复用变量（比如 `.pill.ok` 的 `#7ee787` 在白底上太浅），单独在 `[data-theme="light"]` 里覆盖这几个 class。

### 3.3 组件级 CSS 文件

- **`AiAgentReport.css`**（101 处硬编码）、**`FeedbackModal.css`**（25 处）、**`DataTable.css`**（12 处）、**`QueryInspector.css`**（1 处）：逐一替换为共享变量；无法映射到现有变量的语义色（如聊天气泡的用户/AI 气泡区分色）在 `[data-theme="light"]` 里单独覆盖对应 class。
- 不新建独立的“light 专用 CSS 文件”，统一在原文件里用变量 + `[data-theme="light"]` 覆盖块，保持与现有代码组织方式一致，避免维护两份并行样式。

### 3.4 内联 TSX 硬编码颜色

`KpiCard.tsx`、`TreeTable.tsx`、`DrillDownPanel.tsx`、`InfDutDistPanel.tsx`、`LotUnderperformingDutsPanel.tsx`、`yieldCalc.ts`：

- 良率状态色（红/黄/绿分级）**语义在两套主题下相同**，暂定复用同一色号（在两种背景上都测试对比度，若不够再各自覆盖）。
- 明确的背景/边框类硬编码（例如某些卡片直接写 `background: "#0d1117"` 的 `style` 属性）→ 通过 `useTheme()` 拿到 `theme`，按需要 in-line 三元或改成 CSS class 引用变量（优先改 class，减少 TSX 里的条件逻辑）。

---

## 4. ECharts 图表主题

### 4.1 现状问题

`theme/chartTheme.ts` 导出的是**模块级常量**（`chartAxisColor` 等），被 5 个文件几十处直接引用；`DrillDownPanel.tsx:49` 还有 `const COL_PANEL = chartAccent`，这是**模块顶层**赋值，只会在首次 import 时求值一次，主题切换后不会更新（就算把 `chartAccent` 改成动态的，这行也不会重新取值）。

### 4.2 改造方案

- `chartTheme.ts` 新增 `getChartPalette(theme: "light" | "dark")`，返回：
  ```ts
  { axisColor, textColor, splitLine, tooltipBg, tooltipBorder, accent, accent2, accent3 }
  ```
  深色沿用现有色值；浅色配一套新色（轴文字/分割线用深灰而非浅灰，tooltip 背景改白底半透明）。
- `baseChartOption(theme)`、`horizontalBarChartBase(theme)` 改为接收 `theme` 参数，内部调用 `getChartPalette(theme)`。
- 5 个消费文件（`YieldMonitorReport.tsx`、`InfcontrolReport.tsx`、`DrillDownPanel.tsx`、`InfDutDistPanel.tsx`）改为 `const { theme } = useTheme()`（或从 `ThemeContext` 读取），在组件函数体内（不是模块顶层）计算 `const palette = getChartPalette(theme)`，替换原来的模块级常量引用；`DrillDownPanel.tsx` 的 `COL_PANEL` 挪进组件函数体。
- 图表本身依赖 `theme` 重新渲染：由于这些函数是在组件 render 时调用生成 ECharts `option` 对象的，只要组件因为 `useTheme()`（走 Context）触发重渲染，`option` 会带新配色重新传给 ECharts，不需要额外的强制刷新逻辑。

---

## 5. 验证计划

`npm run dev` 起前端，浏览器里对深色 / 浅色分别走一遍：

1. Yield Monitor：查询区、KPI 条、趋势图、排名图 + 下钻面板、可拖拽布局。
2. JB Star：同上 + INF DUT 分布堆叠图 + 低良率 DUT 表/散点。
3. AI Agent：聊天气泡（用户/AI 区分色）、状态提示文字、工具结果展开块、生成的图表。
4. 表浏览。
5. 设置页：密码锁弹窗、API 面板、Agent 配置、API 目录。
6. 反馈弹窗（`FeedbackModal`）。

确认没有「浅色模式下残留黑底卡片」「文字对比度过低」「图表轴线看不清」这几类问题；顶栏按钮切换后全部区域应同步变化，无需刷新页面。

---

## 6. 明确不做的事

- 不做「跟随系统 `prefers-color-scheme`」自动切换（用户已选择“默认浅色”而非“跟随系统”）。
- 不新增第三种主题（如高对比度）。
- 不改动后端 `pcr-ai-api`，纯前端改动。
- 不改变现有深色配色数值（除非是本文档明确指出的“历史遗留不一致顺手统一”项，如 `.settings-lock-box`）。
