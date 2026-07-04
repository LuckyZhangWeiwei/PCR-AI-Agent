# Light Mode 主题切换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `pcr-ai-report` 加一套浅色主题（默认浅色，localStorage 记忆），顶栏可切换，全站（含 ECharts 图表）风格一致。

**Architecture:** CSS 自定义属性驱动主题（`[data-theme="light"]` 覆盖 `:root`），`useTheme` hook 负责状态+持久化+写 `document.documentElement.dataset.theme`。绝大多数纯 DOM 内联样式直接改用 `var(--x)`（浏览器自动按主题解析，无需 JS 感知）；只有 ECharts **canvas** 绘制部分（`axisLabel`/`splitLine`/`series.itemStyle`/`markLine` 等颜色）无法解析 CSS 变量，这部分改用 `theme/chartTheme.ts` 新增的 `getChartPalette(theme)` / `selectionTierColors(theme, hue)` / `getStatusTierColors(theme)` 返回真实色值，由 `useTheme()` 提供的 `theme` 驱动。ECharts **tooltip**（DOM 渲染，非 canvas）可以直接用 `var()`。

**Tech Stack:** React 19 + TypeScript + Vite，ECharts 6（`echarts` npm 包），无新增依赖。

## Global Constraints

- 不改动 `pcr-ai-api`（纯前端）。
- 不新增依赖包。
- 默认主题 = **浅色**（无 `localStorage` 记录时）；一旦用户切换，记住选择，不跟随系统 `prefers-color-scheme`。
- 全站覆盖：Yield Monitor / JB Star / AI Agent / 表浏览 / 设置 / 反馈弹窗 / 锁屏弹窗 / 所有 ECharts 图表。
- 每个任务完成后跑 `cd pcr-ai-report && npm run build`（`tsc -b && vite build`）确认无类型错误；这是本项目里最接近“测试”的信号（该包没有单元测试框架）。
- 设计依据：[`docs/superpowers/specs/2026-07-03-light-mode-theme-toggle-design.md`](../specs/2026-07-03-light-mode-theme-toggle-design.md)。

---

### Task 1: 主题状态基础设施（hook + context + 顶栏按钮）

**Files:**
- Create: `pcr-ai-report/src/hooks/useTheme.ts`
- Create: `pcr-ai-report/src/theme/ThemeContext.tsx`
- Modify: `pcr-ai-report/src/App.tsx`
- Modify: `pcr-ai-report/src/index.css`（只加按钮样式，主题变量在 Task 3）

**Interfaces:**
- Produces: `useTheme(): { theme: "light" | "dark"; toggleTheme: () => void; setTheme: (t: "light"|"dark") => void }`（`hooks/useTheme.ts`，内部 hook，仅供 `ThemeContext` 使用）。
- Produces: `ThemeProvider`（组件）、`useThemeContext(): { theme: "light" | "dark"; toggleTheme: () => void }`（`theme/ThemeContext.tsx`）— **后续所有任务里，组件读取当前主题一律调用 `useThemeContext()`**，不要重复造 hook。

- [ ] **Step 1: 创建 `useTheme.ts`**

```ts
// pcr-ai-report/src/hooks/useTheme.ts
import { useCallback, useEffect, useState } from "react";

export type ThemeName = "light" | "dark";

const STORAGE_KEY = "pcr-ai-report.theme.v1";

function readStoredTheme(): ThemeName {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  return raw === "dark" ? "dark" : "light";
}

export function useTheme() {
  const [theme, setThemeState] = useState<ThemeName>(readStoredTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  const setTheme = useCallback((next: ThemeName) => setThemeState(next), []);
  const toggleTheme = useCallback(
    () => setThemeState((t) => (t === "light" ? "dark" : "light")),
    []
  );

  return { theme, setTheme, toggleTheme };
}
```

- [ ] **Step 2: 创建 `ThemeContext.tsx`**

```tsx
// pcr-ai-report/src/theme/ThemeContext.tsx
import { createContext, useContext, type ReactNode } from "react";
import { useTheme, type ThemeName } from "../hooks/useTheme";

type ThemeContextValue = {
  theme: ThemeName;
  toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { theme, toggleTheme } = useTheme();
  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useThemeContext(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useThemeContext must be used inside ThemeProvider");
  return ctx;
}
```

- [ ] **Step 3: 在 `App.tsx` 顶层包裹 `ThemeProvider` 并加按钮**

在 `App.tsx` 顶部导入区加入：

```tsx
import { ThemeProvider, useThemeContext } from "./theme/ThemeContext";
```

把默认导出的 `App` 重命名为内部组件 `AppShell`，新增一个薄的默认导出包裹 `ThemeProvider`：

```tsx
export default function App() {
  return (
    <ThemeProvider>
      <AppShell />
    </ThemeProvider>
  );
}

function AppShell() {
  const { theme, toggleTheme } = useThemeContext();
  // ... 原来 export default function App() 的全部函数体搬到这里 ...
```

（即：把原 `export default function App() {` 改成 `function AppShell() {`，函数体不变，只在函数体最前面加上 `const { theme, toggleTheme } = useThemeContext();`；文件末尾原来的收尾 `}` 之后再追加上面的新 `export default function App()`。）

在 `.app-title-block` 同一行内、`app-header` 内新增按钮（放在 `<span className="app-hint">` 之前，作为 `.app-title-block` 的兄弟节点，让它贴右上角）：

```tsx
      <header className="app-header">
        <button
          type="button"
          className="theme-toggle-btn"
          onClick={toggleTheme}
          title="切换主题"
          aria-label="切换主题"
        >
          {theme === "light" ? "☀️" : "🌙"}
        </button>
        <div className="app-title-block">
```

- [ ] **Step 4: 按钮样式（`index.css` 追加，不要放进 Task 3 的 `[data-theme="light"]` 块）**

在 `index.css` 的 `.app-header` 规则后面追加：

```css
.theme-toggle-btn {
  position: absolute;
  top: 14px;
  right: 0;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: var(--surface-1);
  color: var(--text);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: border-color 0.15s, background 0.15s;
}
.theme-toggle-btn:hover {
  border-color: var(--border-hi);
  background: var(--surface-2);
}
```

`.app-header` 已经是 `position: relative`（见现有 CSS），所以 `position: absolute` 的按钮会相对它定位，不需要改 `.app-header` 本身。

- [ ] **Step 5: 验证**

```bash
cd pcr-ai-report
npm run build
npm run dev
```

浏览器打开，确认：
1. 页面加载后 `document.documentElement.dataset.theme === "light"`（开发者工具 Elements 面板看 `<html data-theme="light">`）。
2. 点击顶栏圆形按钮，属性切到 `"dark"`，图标从 ☀️ 变 🌙。
3. 刷新页面，主题保持上次选择（`localStorage` 里 `pcr-ai-report.theme.v1` 有值）。
4. 此时页面视觉应该**几乎不变**（因为浅色 CSS 变量还没加，Task 3 才加）——这一步只验证状态机本身工作正常。

- [ ] **Step 6: Commit**

```bash
git add pcr-ai-report/src/hooks/useTheme.ts pcr-ai-report/src/theme/ThemeContext.tsx pcr-ai-report/src/App.tsx pcr-ai-report/src/index.css
git commit -m "feat(report): add theme toggle state + header button"
```

---

### Task 2: `chartTheme.ts` 重构为主题感知调色板

**Files:**
- Modify: `pcr-ai-report/src/theme/chartTheme.ts`（完整重写，见下方最终内容）

**Interfaces:**
- Consumes: 无（叶子模块）。
- Produces（后续任务 8/9/10 消费，函数签名务必照抄）：
  - `type ChartTheme = "light" | "dark"`
  - `getChartPalette(theme: ChartTheme): { axisColor: string; textColor: string; splitLine: string; accent: string; accent2: string; accent3: string; haloRgb: string }`
  - `getStatusTierColors(theme: ChartTheme): { green: {border,bright,glow}; yellow: {border,bright,glow}; red: {border,bright,glow} }`
  - `selectionTierColors(theme: ChartTheme, hue: "blue-deep"|"blue-light"|"purple"|"orange"|"gold"): { base: string; bright: string; dim: string }`
  - `baseChartOption(theme?: ChartTheme): Record<string, unknown>`（默认 `"dark"`，向后兼容）
  - `horizontalBarChartBase(theme?: ChartTheme): Record<string, unknown>`
  - 其余现有导出（`horizontalBarCategoryAxisLabel`、`horizontalBarCategoryAxisLabelFull`、`rankBarChartHeight`、`drillBarChartHeight`、`JB_SLOT_TREND_CHART_HEIGHT`、`verticalBarChartGrid`、`YIELD_TREND_CHART_HEIGHT`、`yieldTrendChartGrid`）**原样保留，不改**。
  - **移除**旧的模块级常量导出：`chartAxisColor`、`chartTextColor`、`chartSplitLine`、`chartAccent`、`chartAccent2`、`chartAccent3`（Task 8/9/10 会同步删除所有 import 这些名字的地方，不留死代码）。

- [ ] **Step 1: 用以下内容整体替换 `chartTheme.ts`**

```ts
/** Shared ECharts styling — theme-aware (see https://echarts.apache.org/handbook/zh/get-started/) */

export type ChartTheme = "light" | "dark";

type ChartPalette = {
  axisColor: string;
  textColor: string;
  splitLine: string;
  accent: string;
  accent2: string;
  accent3: string;
  /** RGB triplet (no "rgba(" wrapper) for halo/highlight strokes that must contrast with the canvas background */
  haloRgb: string;
};

const CHART_PALETTES: Record<ChartTheme, ChartPalette> = {
  dark: {
    axisColor: "#8b949e",
    textColor: "#e6edf3",
    splitLine: "rgba(240, 246, 252, 0.06)",
    accent: "#58a6ff",
    accent2: "#a371f7",
    accent3: "#3fb950",
    haloRgb: "255,255,255",
  },
  light: {
    axisColor: "#57606a",
    textColor: "#1f2328",
    splitLine: "rgba(31, 35, 40, 0.08)",
    accent: "#0969da",
    accent2: "#8250df",
    accent3: "#1a7f37",
    haloRgb: "31,35,40",
  },
};

export function getChartPalette(theme: ChartTheme = "dark"): ChartPalette {
  return CHART_PALETTES[theme];
}

type StatusTier = { border: string; bright: string; glow: string };
type StatusTierColors = { green: StatusTier; yellow: StatusTier; red: StatusTier };

const STATUS_TIERS: Record<ChartTheme, StatusTierColors> = {
  dark: {
    green: { border: "#238636", bright: "#3fb950", glow: "rgba(63,185,80,0.3)" },
    yellow: { border: "#9e6a03", bright: "#d29922", glow: "rgba(210,153,34,0.3)" },
    red: { border: "#da3633", bright: "#ff7b72", glow: "rgba(218,54,51,0.3)" },
  },
  light: {
    green: { border: "#1a7f37", bright: "#2da44e", glow: "rgba(26,127,55,0.22)" },
    yellow: { border: "#9a6700", bright: "#bf8700", glow: "rgba(154,103,0,0.2)" },
    red: { border: "#cf222e", bright: "#e5534b", glow: "rgba(207,34,46,0.2)" },
  },
};

/** Threshold-based (yield%) coloring for ranking charts: default/selected/other-selected-dimmed. */
export function getStatusTierColors(theme: ChartTheme = "dark"): StatusTierColors {
  return STATUS_TIERS[theme];
}

type SelectionTier = { base: string; bright: string; dim: string };
export type SelectionHue = "blue-deep" | "blue-light" | "purple" | "orange" | "gold";

const SELECTION_TIERS: Record<ChartTheme, Record<SelectionHue, SelectionTier>> = {
  dark: {
    "blue-deep": { base: "#58a6ff", bright: "#2080ff", dim: "rgba(88,166,255,0.3)" },
    "blue-light": { base: "#79c0ff", bright: "#58a6ff", dim: "rgba(121,192,255,0.2)" },
    purple: { base: "#a371f7", bright: "#bf8dff", dim: "rgba(163,113,247,0.3)" },
    orange: { base: "#f0883e", bright: "#ff9f60", dim: "rgba(240,136,62,0.3)" },
    gold: { base: "#e6b450", bright: "#ffd070", dim: "rgba(230,180,80,0.3)" },
  },
  light: {
    "blue-deep": { base: "#0969da", bright: "#2f81f7", dim: "rgba(9,105,218,0.25)" },
    "blue-light": { base: "#2f81f7", bright: "#0969da", dim: "rgba(47,129,247,0.18)" },
    purple: { base: "#8250df", bright: "#a371f7", dim: "rgba(130,80,223,0.22)" },
    orange: { base: "#bc4c00", bright: "#d1720f", dim: "rgba(188,76,0,0.2)" },
    gold: { base: "#9a6700", bright: "#bf8700", dim: "rgba(154,103,0,0.2)" },
  },
};

/** Ranking-chart selection highlight: unselected base / selected-bright / other-selected-dimmed. */
export function selectionTierColors(theme: ChartTheme = "dark", hue: SelectionHue): SelectionTier {
  return SELECTION_TIERS[theme][hue];
}

export function baseChartOption(theme: ChartTheme = "dark"): Record<string, unknown> {
  const p = getChartPalette(theme);
  return {
    backgroundColor: "transparent",
    textStyle: {
      color: p.textColor,
      fontFamily:
        'ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif',
    },
    tooltip: {
      backgroundColor: "var(--surface-1)",
      borderColor: "var(--border)",
      textStyle: { color: "var(--text)" },
      /** 避免父级 .chart-card overflow:hidden 裁切悬浮层 */
      appendToBody: true,
      confine: false,
    },
    grid: {
      left: 48,
      right: 24,
      top: 40,
      bottom: 48,
      containLabel: true,
    },
  };
}

/** 横向排名条图：窄列网格里须截断 y 轴类目，否则条形区被挤没只剩「标签+数值」像表格 */
export function horizontalBarChartBase(theme: ChartTheme = "dark"): Record<string, unknown> {
  const base = baseChartOption(theme);
  return {
    ...base,
    grid: {
      left: 8,
      right: 44,
      top: 8,
      bottom: 8,
      containLabel: true,
    },
    tooltip: {
      ...(base.tooltip as Record<string, unknown>),
      trigger: "axis",
      axisPointer: { type: "shadow" },
    },
  };
}

export const horizontalBarCategoryAxisLabel = {
  color: "#e6edf3",
  fontSize: 11,
  width: 96,
  overflow: "truncate" as const,
  ellipsis: "...",
};

/** 较长类目（如 LOT Yield% Top）— 不截断，配合 grid.containLabel 自动留白 */
export const horizontalBarCategoryAxisLabelFull = {
  color: "#e6edf3",
  fontSize: 11,
};

export type BarChartHeightVariant = "default" | "medium" | "compact";

/** 排名条图高度（按可见条数） */
export function rankBarChartHeight(
  rowCount: number,
  maxRows = 20,
  variant: BarChartHeightVariant = "default"
): number {
  const n = Math.min(Math.max(rowCount, 1), maxRows);
  if (variant === "compact") return Math.max(118, n * 15 + 30);
  if (variant === "medium") return Math.max(138, n * 16.5 + 38);
  return Math.max(148, n * 18 + 40);
}

/** 下钻面板内条图 */
export function drillBarChartHeight(
  rowCount: number,
  maxRows = 10,
  variant: BarChartHeightVariant = "default"
): number {
  const n = Math.min(Math.max(rowCount, 1), maxRows);
  if (variant === "compact") return Math.max(108, n * 17 + 28);
  if (variant === "medium") return Math.max(118, n * 18.5 + 32);
  return Math.max(124, n * 20 + 36);
}

/** JB Slot 趋势图固定高度（介于原 240 与紧凑 176 之间） */
export const JB_SLOT_TREND_CHART_HEIGHT = 200;

/** 纵向柱图（如 Slot 趋势）— 较紧的 grid */
export const verticalBarChartGrid = {
  left: 36,
  right: 12,
  top: 10,
  bottom: 28,
  containLabel: true,
};

export const YIELD_TREND_CHART_HEIGHT = 168;

/** 折线趋势图（每日触发量）— 较紧的 grid */
export const yieldTrendChartGrid = {
  left: 40,
  right: 12,
  top: 24,
  bottom: 32,
  containLabel: true,
};
```

> 注：`horizontalBarCategoryAxisLabel(Full)` 的 `color` 保留字面量 `"#e6edf3"` 而不是走 palette——这两个是 y 轴类目标签，画在 canvas 上但**当前所有调用点都不传 theme**（后续任务里会看到它们是对象字面量，不是函数），为了不在这次重构里引入新的必传参数导致连锁修改爆炸，这两个先维持深色数值；Task 9 会在实际用到的地方对着 `theme` 做一次性覆盖（`axisLabel: {...horizontalBarCategoryAxisLabel, color: palette.axisColor}`）。

- [ ] **Step 2: 编译检查（此时其它文件还在 import 旧常量，预期会报错，属于正常中间状态）**

```bash
cd pcr-ai-report
npm run build
```

Expected: `tsc` 报错 `Module '"../theme/chartTheme"' has no exported member 'chartAxisColor'` 等——这是预期的，因为消费文件还没改（Task 8/9/10 负责）。**这一步不需要修复报错，只是留痕；不要 commit 一个编译失败的中间状态。**

- [ ] **Step 3: Commit**

因为这一步单独 commit 会导致仓库编译失败（其余文件还引用旧导出），**把这次改动和 Task 8 合并提交**：跳过本任务的单独 commit，改动保留在工作区，继续做 Task 8（YieldMonitorReport.tsx）后一起提交。Task 8 的 Step 末尾会包含 `chartTheme.ts` 一起 commit 的说明。

---

### Task 3: `index.css` — 浅色变量 + 机壳级硬编码色值清理

**Files:**
- Modify: `pcr-ai-report/src/index.css`

**Interfaces:**
- Produces（后续 CSS 文件与内联样式消费）：
  - RGB 三元组变量：`--fg-rgb`、`--accent-rgb`、`--accent-2-rgb`、`--green-rgb`、`--red-rgb`、`--yellow-rgb`（用法：`rgba(var(--accent-rgb), 0.3)`）。
  - `--red-text`（深色下比 `--red` 更亮、浅色下等于 `--red`，用于深色卡片上的红字）。
  - 维度标签色：`--dim-mask`、`--dim-device`、`--dim-lot`、`--dim-pass`、`--dim-slot`、`--dim-card`。

- [ ] **Step 1: 在 `:root` 块内追加 token（紧跟在现有 `--yellow` 之后，`--shadow-sm` 之前）**

```css
  --fg-rgb:       240,246,252;
  --accent-rgb:   88,166,255;
  --accent-2-rgb: 163,113,247;
  --green-rgb:    63,185,80;
  --red-rgb:      248,81,73;
  --yellow-rgb:   210,153,34;
  --red-text:     #ff7b72;

  --dim-mask:   #79c0ff;
  --dim-device: #d2a8ff;
  --dim-lot:    #3fb950;
  --dim-pass:   #ff7b72;
  --dim-slot:   #e6b450;
  --dim-card:   #58a6ff;

```

- [ ] **Step 2: 在 `:root` 块结束的 `}` 之后新增 `[data-theme="light"]` 块**

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

  --fg-rgb:       31,35,40;
  --accent-rgb:   9,105,218;
  --accent-2-rgb: 130,80,223;
  --green-rgb:    26,127,55;
  --red-rgb:      207,34,46;
  --yellow-rgb:   154,103,0;
  --red-text:     #cf222e;

  --dim-mask:   #0969da;
  --dim-device: #8250df;
  --dim-lot:    #1a7f37;
  --dim-pass:   #cf222e;
  --dim-slot:   #9a6700;
  --dim-card:   #0969da;
}
```

- [ ] **Step 3: 把 rgba 字面量替换为 `rgba(var(--x-rgb), alpha)`**

对 `index.css` 执行以下精确替换（`replace_all: true`，每一行原文都出现不止一次，用 Edit 工具的 `replace_all` 一次性替换所有匹配）：

| old_string（完整匹配） | new_string |
| --- | --- |
| `rgba(240,246,252,0.07)` | `rgba(var(--fg-rgb),0.07)` |
| `rgba(240,246,252,0.12)` | `rgba(var(--fg-rgb),0.12)` |
| `rgba(240,246,252,0.22)` | `rgba(var(--fg-rgb),0.22)` |
| `rgba(240,246,252,0.03)` | `rgba(var(--fg-rgb),0.03)` |
| `rgba(240,246,252,0.04)` | `rgba(var(--fg-rgb),0.04)` |
| `rgba(240,246,252,0.015)` | `rgba(var(--fg-rgb),0.015)` |
| `rgba(240,246,252,0.025)` | `rgba(var(--fg-rgb),0.025)` |
| `rgba(240, 246, 252, 0.16)` | `rgba(var(--fg-rgb),0.16)` |
| `rgba(240, 246, 252, 0.1)` | `rgba(var(--fg-rgb),0.1)`（多处：`.yield-trend-block`、`.report-reorder-item-head`、`.report-reorder-close`、`.inf-dut-standalone-row`、`.report-chart-panel` ×3） |
| `rgba(240, 246, 252, 0.08)` | `rgba(var(--fg-rgb),0.08)` |
| `rgba(240, 246, 252, 0.04)` | `rgba(var(--fg-rgb),0.04)`（`.report-reorder-drag-head`、`.report-layout-reset-bar` 等，含空格版本，与上面无空格版本分开处理） |
| `rgba(88, 166, 255, 0.07)` | `rgba(var(--accent-rgb),0.07)` |
| `rgba(88, 166, 255, 0.18)` | `rgba(var(--accent-rgb),0.18)` |
| `rgba(88,166,255,0.12)` | `rgba(var(--accent-rgb),0.12)` |
| `rgba(88,166,255,0.2)` | `rgba(var(--accent-rgb),0.2)` |
| `rgba(88,166,255,0.32)` | `rgba(var(--accent-rgb),0.32)` |
| `rgba(88,166,255,0.1)` | `rgba(var(--accent-rgb),0.1)`（`.filter-grid input:focus` 与 `.ai-agent-textarea:focus` 各一处、`.rollup` 等，`replace_all` 会一次性处理全部，逐一检查 diff 确认没有误伤非 box-shadow 场景） |
| `rgba(88, 166, 255, 0.08)` | `rgba(var(--accent-rgb),0.08)` |
| `rgba(88, 166, 255, 0.28)` | `rgba(var(--accent-rgb),0.28)` |
| `rgba(88, 166, 255, 0.10)` | `rgba(var(--accent-rgb),0.10)` |
| `rgba(88, 166, 255, 0.45)` | `rgba(var(--accent-rgb),0.45)` |
| `rgba(88, 166, 255, 0.2)` | `rgba(var(--accent-rgb),0.2)` |
| `rgba(88, 166, 255, 0.55)` | `rgba(var(--accent-rgb),0.55)` |
| `rgba(88, 166, 255, 0.14)` | `rgba(var(--accent-rgb),0.14)` |
| `rgba(163, 113, 247, 0.1)` | `rgba(var(--accent-2-rgb),0.1)` |
| `rgba(163, 113, 247, 0.28)` | `rgba(var(--accent-2-rgb),0.28)` |
| `rgba(163,113,247,0.45)` | `rgba(var(--accent-2-rgb),0.45)` |
| `rgba(163,113,247,0.06)` | `rgba(var(--accent-2-rgb),0.06)` |
| `rgba(163,113,247,0.07)` | `rgba(var(--accent-2-rgb),0.07)` |
| `rgba(88,166,255,0.2)` | `rgba(var(--accent-rgb),0.2)`（若上面已处理过同值可跳过重复项） |
| `rgba(56, 139, 253, 0.35)` | `rgba(var(--accent-rgb),0.35)` |
| `rgba(56, 139, 253, 0.12)` | `rgba(var(--accent-rgb),0.12)` |
| `rgba(56, 139, 253, 0.2)` | `rgba(var(--accent-rgb),0.2)` |
| `rgba(56, 139, 253, 0.55)` | `rgba(var(--accent-rgb),0.55)` |
| `rgba(248,81,73,0.4)` | `rgba(var(--red-rgb),0.4)` |
| `rgba(248,81,73,0.07)` | `rgba(var(--red-rgb),0.07)` |
| `rgba(248, 81, 73, 0.45)` | `rgba(var(--red-rgb),0.45)` |
| `rgba(248, 81, 73, 0.12)` | `rgba(var(--red-rgb),0.12)` |
| `rgba(63,185,80,0.4)` | `rgba(var(--green-rgb),0.4)` |
| `rgba(63, 185, 80, 0.18)` | `rgba(var(--green-rgb),0.18)` |
| `rgba(63, 185, 80, 0.35)` | `rgba(var(--green-rgb),0.35)` |
| `rgba(200, 80, 80, 0.18)` | `rgba(var(--red-rgb),0.18)` |
| `rgba(200, 80, 80, 0.35)` | `rgba(var(--red-rgb),0.35)` |

不要用一次 `replace_all: true` 打包所有行——按表格逐条用 Edit（多数字符串在文件中只出现 1~3 次），每条替换后跑一次 `npm run build` 里的 `tsc -b` 太慢，改完全部再统一验证即可，但**改的时候要读一遍上下文**，确认没有把颜色值相同、但语义不同的两处误伤（比如 `0.1` 出现频率很高，务必核对上下文是 border/background 还是无关属性）。

- [ ] **Step 4: 独立十六进制字面量替换（非 rgba，`replace_all: true` 安全，因为这些字面量在文件里语义单一）**

| old_string | new_string |
| --- | --- |
| `background: #0d1117;` （`.yield-trend-block`、`.report-chart-panel` ×3、`LotUnderperformingDutsPanel` 不在这个文件） | `background: var(--bg);` |
| `color: #0d1117;`（`.btn.primary`） | `color: var(--bg);`（按钮文字色沿用「主背景色」以保证在渐变按钮上仍是深色文字——浅色主题下 `--bg` 是 `#f6f8fa`，在亮色渐变按钮上依然够深，读起来正常；不需要额外新 token） |
| `#161b22`（`.funnel-step` `background:`） | `var(--surface-1)` |
| `#30363d`（`.funnel-step` `border:`、`.funnel-step-selecting` 无关跳过） | `var(--border)` |
| `#6e7681`（`.funnel-step-name` `color:`、`.dut-dist-html-legend-item` 附近如有） | `var(--dimmed)` |
| `#8b949e`（`.chart-drill-hint`、`.agent-status` 附近等 `color:` 场景） | `var(--muted)` |
| `#e6edf3`（`.funnel-step-val` 的 fallback `var(--step-color, #e6edf3)`、`.pill strong` 附近等） | `var(--text)`（注意 `var(--step-color, #e6edf3)` 这种 CSS 变量 fallback 语法要改成 `var(--step-color, var(--text))`——CSS 允许变量的 fallback 里再嵌一个变量，合法） |
| `#58a6ff`（`.funnel-step--done`/`.funnel-back-btn:hover` 的 `border-color:`/`color:`，`.report-layout-reset-bar` 附近如有；**不要碰** `linear-gradient(...)` 里的 `#58a6ff`，那些是装饰性品牌渐变，保持不变） | `var(--accent)` |
| `#3fb950`（`.agent-status-on` `color:`） | `var(--green)` |
| `#e06c6c`（`.agent-status-off` `color:`） | `var(--red-text)` |
| `#484f58`（`.funnel-arrow` `color:`） | `var(--dimmed)` |
| `#c9d1d9`（`.filter-grid-more-toggle:hover` `color:`） | `var(--text)` |
| `#79c0ff`（`.report-desc code` `color:` 里那一处，如果和渐变里的 `#79c0ff` 混在一起要小心区分——只改 `.report-desc code { color: #79c0ff; ... }` 这一处，装饰性 `linear-gradient` 里的不要动） | `var(--accent)` |
| `#a371f7`（`.report-desc .desc-arrow` `color:` 那一处；渐变里的不要动） | `var(--accent-2)` |
| `#ffdcd7`（`.alert.error` `color:`） | `#ffdcd7` 保留原样但**只在深色下**——改成条件：把这一行从 `:root` 挪到没有 `[data-theme="light"]` 覆盖时使用深色字面量；简化做法：直接把 `color: #ffdcd7;` 改成 `color: var(--red-text);`（够用，不需要单独的第七个 token） |
| `#ffa198`（`.pill.bad` `color:`） | `var(--red-text)` |
| `#7ee787`（`.pill.ok` `color:`） | `var(--green)` |

- [ ] **Step 5: `.settings-lock-box` 系列统一到共享变量（历史遗留的独立配色，顺手统一）**

把这一段：

```css
.settings-lock-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 32px 40px;
  background: #111827;
  border: 1px solid #374151;
  border-radius: 12px;
  min-width: 260px;
}
```

改成：

```css
.settings-lock-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 32px 40px;
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: 12px;
  min-width: 260px;
  box-shadow: var(--shadow-md);
}
```

把这一段：

```css
.settings-lock-label {
  margin: 0;
  font-size: 14px;
  color: #9ca3af;
}
```

改成 `color: var(--muted);`。

把这一段：

```css
.settings-lock-input {
  width: 100%;
  padding: 8px 12px;
  background: #1f2937;
  border: 1px solid #4b5563;
  border-radius: 6px;
  color: #e5e7eb;
  font-size: 15px;
  text-align: center;
  letter-spacing: 0.15em;
  outline: none;
}
```

改成：

```css
.settings-lock-input {
  width: 100%;
  padding: 8px 12px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  font-size: 15px;
  text-align: center;
  letter-spacing: 0.15em;
  outline: none;
}
```

`.settings-lock-input:focus { border-color: #6366f1; }` → `border-color: var(--accent);`
`.settings-lock-input--error { border-color: #ef4444; ... }` → `border-color: var(--red);`
`.settings-lock-error { ... color: #f87171; }` → `color: var(--red-text);`
`.settings-lock-submit { ... background: #4f46e5; ... color: #fff; }` → `background: var(--accent); ... color: #fff;`（按钮文字白色两个主题都合适，不用改）
`.settings-lock-submit:hover { background: #6366f1; }` → `background: var(--accent-2);`

- [ ] **Step 6: 验证没有遗漏**

```bash
cd pcr-ai-report
node -e "
const fs = require('fs');
const css = fs.readFileSync('src/index.css', 'utf8');
const bad = css.match(/#(?:0d1117|161b22|0f141c|1c2330|e6edf3|8b949e|6e7681|111827|374151|1f2937|4b5563|9ca3af|e5e7eb)\b/g);
console.log(bad ?? 'CLEAN');
"
```

Expected: `CLEAN`（允许残留的是装饰性 `linear-gradient` 品牌色，如 `.app-title-main`、`.app-brand-badge` 的渐变——这些不在上面的黑名单正则里，故意保留）。

- [ ] **Step 7: `npm run build` 确认无 CSS/TS 错误，然后手动切换主题看一眼**

```bash
npm run build
npm run dev
```

浏览器切到浅色，确认：顶栏、Tab、按钮、卡片、筛选框、KPI 条、可拖拽布局边框、漏斗步骤条、设置页锁屏弹窗都变成白底深字，没有残留纯黑背景块。

- [ ] **Step 8: Commit**

```bash
git add pcr-ai-report/src/index.css
git commit -m "feat(report): light theme tokens + shell CSS variable cleanup"
```

---

### Task 4: `DataTable.css` + `QueryInspector.css` 清理

**Files:**
- Modify: `pcr-ai-report/src/components/DataTable.css`
- Modify: `pcr-ai-report/src/components/QueryInspector.css`

**Interfaces:** 无新增，纯字面量替换。

- [ ] **Step 1: `DataTable.css` 替换**

```css
.data-table-filter-input {
  width: 100%;
  box-sizing: border-box;
  background: rgba(var(--fg-rgb), 0.06);
  border: 1px solid rgba(var(--fg-rgb), 0.12);
  border-radius: 4px;
  color: var(--text);
  font-size: 11px;
  padding: 3px 7px;
  outline: none;
  font-family: inherit;
}

.data-table-filter-input::placeholder {
  color: rgba(var(--fg-rgb), 0.28);
}
```

（替换原来 `background: rgba(255, 255, 255, 0.06);` / `border: 1px solid rgba(255, 255, 255, 0.12);` / `color: #e6edf3;` / `color: rgba(255, 255, 255, 0.28);` 这四行；`accent-color: #58a6ff;` 改成 `accent-color: var(--accent);`；其余该文件已经全部走 `var(--border)/var(--surface-2/3)/var(--muted)`，不用动。）

- [ ] **Step 2: `QueryInspector.css` 替换**

第 4 行 `background: rgba(240, 246, 252, 0.03);` → `background: rgba(var(--fg-rgb), 0.03);`。其余该文件已全部走变量，不用动。

- [ ] **Step 3: 验证**

```bash
cd pcr-ai-report && npm run build
```

- [ ] **Step 4: Commit**

```bash
git add pcr-ai-report/src/components/DataTable.css pcr-ai-report/src/components/QueryInspector.css
git commit -m "fix(report): theme-aware colors in DataTable/QueryInspector CSS"
```

---

### Task 5: `FeedbackModal.css` 重新映射

**Files:**
- Modify: `pcr-ai-report/src/components/FeedbackModal.css`（整体替换为下方内容）

该文件此前用的是一套独立的、从未真正被覆盖过的 `var(--bg-card, #1a2744)` 式写法（`--bg-card` 从未在 `index.css` 定义，所以实际上一直吃的是 fallback 硬编码值）。这次改成引用 Task 3 已经建立的共享变量。

- [ ] **Step 1: 整体替换文件内容**

```css
.feedback-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.feedback-modal {
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 20px 24px;
  width: 420px;
  max-width: 92vw;
  display: flex;
  flex-direction: column;
  gap: 14px;
  color: var(--text);
  box-shadow: var(--shadow-lg);
}

.feedback-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 0.97rem;
  font-weight: 600;
}

.feedback-modal-close {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text);
  font-size: 1.1rem;
  padding: 2px 6px;
  border-radius: 4px;
  opacity: 0.7;
}
.feedback-modal-close:hover { opacity: 1; }

.feedback-modal-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.feedback-chip {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 20px;
  padding: 5px 14px;
  font-size: 0.87rem;
  cursor: pointer;
  color: var(--text);
  transition: background 0.15s, border-color 0.15s;
}
.feedback-chip:hover { border-color: var(--accent); }
.feedback-chip--active {
  background: rgba(var(--accent-rgb), 0.16);
  border-color: var(--accent);
  color: var(--accent);
}

.feedback-modal-label {
  font-size: 0.85rem;
  color: var(--muted);
  display: block;
  margin-bottom: 6px;
}

.feedback-modal-textarea {
  width: 100%;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  padding: 8px 10px;
  font-size: 0.88rem;
  resize: vertical;
  font-family: inherit;
  box-sizing: border-box;
}
.feedback-modal-textarea:focus {
  outline: none;
  border-color: var(--border-hi);
}

.feedback-modal-error {
  color: var(--red-text);
  font-size: 0.85rem;
}

.feedback-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.feedback-modal-cancel {
  background: none;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 16px;
  font-size: 0.87rem;
  cursor: pointer;
  color: var(--text);
}
.feedback-modal-cancel:hover { border-color: var(--accent); }

.feedback-modal-submit {
  background: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 6px;
  padding: 6px 18px;
  font-size: 0.87rem;
  cursor: pointer;
  color: #fff;
  transition: opacity 0.15s;
}
.feedback-modal-submit:hover:not(:disabled) { opacity: 0.85; }
.feedback-modal-submit:disabled { opacity: 0.5; cursor: default; }
```

- [ ] **Step 2: 验证**

```bash
cd pcr-ai-report && npm run build && npm run dev
```

打开 AI Agent 标签页，触发一次反馈弹窗（点击某条 AI 回复的 👍/👎），深色/浅色下都看一眼卡片、chip、输入框、按钮。

- [ ] **Step 3: Commit**

```bash
git add pcr-ai-report/src/components/FeedbackModal.css
git commit -m "fix(report): remap FeedbackModal.css to shared theme tokens"
```

---

### Task 6: `AiAgentReport.css` 重新映射

**Files:**
- Modify: `pcr-ai-report/src/reports/AiAgentReport.css`（整体替换为下方内容）

设计要点（对照 spec §3.3）：AI 气泡沿用中性 surface/border/text；用户气泡、工具 chip、聊天输入发送按钮统一走「蓝色 tint」；成功/澄清类走「绿色 tint」；错误/重试走「红色 tint」；代码块/表格走既有 surface-2/3。

- [ ] **Step 1: 整体替换文件内容**

```css
/* AI Agent Report — fill tab-panel grid row; scroll only inside .ai-agent-messages */
.ai-agent-report {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  max-height: 100%;
  overflow: hidden;
}

.ai-agent-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.ai-agent-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.ai-agent-toolbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ai-agent-btn-new,
.ai-agent-btn-save {
  padding: 4px 12px;
  font-size: 12px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--muted);
  border-radius: 4px;
  cursor: pointer;
}

.ai-agent-btn-new:hover,
.ai-agent-btn-save:hover:not(:disabled) {
  background: var(--surface-3);
  color: var(--text);
}

.ai-agent-btn-save:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.ai-agent-messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 6px 10px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.ai-msg {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}

.ai-msg--user {
  justify-content: flex-end;
}

.rav-defs {
  position: absolute;
  width: 0;
  height: 0;
  overflow: hidden;
}

/* Avatars */
.ai-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  flex-shrink: 0;
  margin-top: 1px;
  -webkit-user-select: none;
  user-select: none;
}

.ai-avatar--ai {
  width: 34px;
  height: 34px;
  background: transparent;
  border: none;
  border-radius: 50%;
  order: -1;
  filter: drop-shadow(0 1px 4px rgba(33, 150, 243, 0.35));
}

.ai-avatar--user {
  background: rgba(var(--green-rgb), 0.14);
  color: var(--green);
  border: 1px solid rgba(var(--green-rgb), 0.35);
  order: 1;
}

.ai-msg--user .ai-msg-bubble {
  background: rgba(var(--accent-rgb), 0.16);
  color: var(--text);
  border-radius: 12px 12px 2px 12px;
  padding: 5px 9px;
  max-width: 70%;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.3;
}

/* Avatar + 正文列（气泡与反馈上下排列，反馈不在右侧） */
.ai-msg--ai .ai-msg-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0;
}

.ai-msg--ai .ai-msg-bubble {
  background: var(--surface-1);
  color: var(--text);
  border-radius: 2px 12px 12px 12px;
  padding: 5px 8px;
  max-width: 100%;
  white-space: pre-wrap;
  word-break: break-word;
  border: 1px solid var(--border);
  font-size: 13px;
  line-height: 1.28;
}

/* Markdown prose inside AI bubbles */
.ai-msg-bubble--md {
  white-space: normal;
  line-height: 1.28;
}
.ai-msg-bubble--md p { margin: 0; }
.ai-msg-bubble--md p + p { margin-top: 0; }
.ai-msg-bubble--md p:last-child { margin-bottom: 0; }
.ai-msg-bubble--md ul,
.ai-msg-bubble--md ol {
  margin: 0 0 0 1em;
  padding: 0;
}
.ai-msg-bubble--md ul + ul,
.ai-msg-bubble--md ol + ol,
.ai-msg-bubble--md p + ul,
.ai-msg-bubble--md p + ol {
  margin-top: 0;
}
.ai-msg-bubble--md li {
  margin: 0;
  padding: 0;
  line-height: 1.25;
}
.ai-msg-bubble--md li + li {
  margin-top: 0;
}
/* react-markdown wraps list items in <p>; inline avoids extra block gaps */
.ai-msg-bubble--md li > p {
  margin: 0;
  padding: 0;
  display: inline;
}
.ai-msg-bubble--md strong { color: var(--text); }
.ai-msg-bubble--md em { color: var(--muted); }
/* GFM ~~…~~ or ~…~ must not show as strikethrough in agent replies */
.ai-msg-bubble--md del,
.ai-msg-bubble--md s {
  text-decoration: none;
}
.ai-msg-bubble--md code {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 1px 5px;
  font-family: monospace;
  font-size: 12px;
  color: var(--green);
}
.ai-msg-bubble--md pre {
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 6px 10px;
  overflow-x: auto;
  margin: 4px 0;
}
.ai-msg-bubble--md pre code {
  background: none;
  border: none;
  padding: 0;
  color: var(--green);
}
.ai-msg-bubble--md table {
  border-collapse: collapse;
  width: max-content;
  max-width: 100%;
  margin: 4px 0;
  font-size: 12px;
}
/* 实测数据表：横向滚动，避免长结论列撑破气泡宽度 */
.ai-md-data {
  overflow-x: auto;
  margin-bottom: 10px;
  padding-bottom: 2px;
}
.ai-md-data table {
  width: max-content;
  min-width: min(100%, 480px);
}
.ai-md-commentary {
  margin-top: 4px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}
.ai-md-commentary table {
  display: none;
}
.ai-msg-bubble--md th,
.ai-msg-bubble--md td {
  border: 1px solid var(--border);
  padding: 3px 7px;
  text-align: left;
}
.ai-msg-bubble--md th { background: var(--surface-2); color: var(--muted); }
.ai-msg-bubble--md tr:nth-child(even) td { background: var(--surface-2); }
.ai-msg-bubble--md h1,
.ai-msg-bubble--md h2,
.ai-msg-bubble--md h3 {
  color: var(--muted);
  margin: 0;
  font-size: 13px;
  line-height: 1.28;
}
.ai-msg-bubble--md blockquote {
  border-left: 3px solid var(--border);
  margin: 0;
  padding: 0 6px;
  color: var(--muted);
  font-style: italic;
}
.ai-msg-bubble--md hr {
  border: none;
  border-top: 1px solid var(--border);
  margin: 2px 0;
}

.ai-wafermap-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  background: #1565c0;
  color: #e3f2fd !important;
  border-radius: 4px;
  font-size: 0.88em;
  font-weight: 600;
  text-decoration: none !important;
  transition: background 0.15s;
}
.ai-wafermap-link:hover {
  background: #1976d2;
}

.ai-img-placeholder {
  color: var(--dimmed);
  font-style: italic;
  font-size: 0.9em;
}

.ai-cursor {
  display: inline-block;
  width: 8px;
  height: 14px;
  background: var(--muted);
  margin-left: 2px;
  vertical-align: middle;
  animation: blink 1s step-start infinite;
}

.ai-status-hint {
  color: var(--muted);
  font-style: italic;
  font-size: 0.9em;
}

@keyframes blink {
  50% { opacity: 0; }
}

.ai-msg--tool {
  flex-direction: column;
  max-width: 90%;
}

/* Tool chips row — rendered inside the AI message block */
.ai-tool-chips-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 4px;
}

.ai-tool-chips-label {
  font-size: 11px;
  color: var(--muted);
  font-style: italic;
  white-space: nowrap;
  flex-shrink: 0;
}

.ai-cursor--inline {
  display: inline-block;
  width: 6px;
  height: 13px;
  background: var(--accent);
  border-radius: 1px;
  animation: blink 1s step-start infinite;
  vertical-align: middle;
  margin-left: 2px;
  flex-shrink: 0;
}

.ai-tool-toggle {
  background: rgba(var(--accent-rgb), 0.1);
  border: 1px solid rgba(var(--accent-rgb), 0.35);
  color: var(--accent);
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 12px;
  cursor: pointer;
  text-align: left;
  white-space: nowrap;
  transition: background 0.15s, border-color 0.15s;
}

.ai-tool-toggle:hover {
  background: rgba(var(--accent-rgb), 0.18);
  border-color: rgba(var(--accent-rgb), 0.55);
}

.ai-tool-detail {
  margin-top: 4px;
  padding: 6px 10px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 11px;
  color: var(--muted);
  font-family: monospace;
  white-space: pre-wrap;
  word-break: break-all;
}

.ai-msg--chart {
  width: 100%;
  max-width: 700px;
}

.ai-chart-wrap {
  display: block;
  width: 100%;
  min-height: 320px;
}

.ai-chart-actions {
  display: flex;
  justify-content: flex-end;
  padding: 4px 0 2px;
}

.ai-chart-dl-btn {
  background: none;
  border: 1px solid rgba(var(--accent-rgb), 0.4);
  border-radius: 5px;
  color: var(--muted);
  font-size: 0.85rem;
  padding: 2px 7px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
  line-height: 1;
}
.ai-chart-dl-btn:hover {
  color: var(--accent);
  border-color: var(--accent);
  background: rgba(var(--accent-rgb), 0.1);
}

.ai-export-btn {
  font-size: 0.9rem;
  opacity: 0.7;
}
.ai-export-btn:hover {
  opacity: 1;
  color: var(--accent);
}

.ai-msg--error {
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  color: var(--red-text);
  font-size: 13px;
  padding: 6px 10px;
  background: rgba(var(--red-rgb), 0.1);
  border: 1px solid rgba(var(--red-rgb), 0.35);
  border-radius: 6px;
  max-width: 90%;
}

.ai-error-text {
  line-height: 1.4;
}

.ai-error-retry {
  padding: 4px 12px;
  background: rgba(var(--red-rgb), 0.14);
  border: 1px solid rgba(var(--red-rgb), 0.45);
  color: var(--red-text);
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}

.ai-error-retry:hover:not(:disabled) {
  background: rgba(var(--red-rgb), 0.22);
}

.ai-error-retry:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.ai-agent-input-area {
  display: flex;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
  align-items: center;
}

.ai-agent-input {
  flex: 1;
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 8px 10px;
  border-radius: 6px;
  resize: none;
  font-size: 14px;
  font-family: inherit;
  line-height: 1.4;
}

.ai-agent-input:focus {
  outline: none;
  border-color: var(--border-hi);
}

.ai-agent-send {
  padding: 8px 16px;
  background: rgba(var(--accent-rgb), 0.16);
  border: 1px solid rgba(var(--accent-rgb), 0.5);
  color: var(--accent);
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
  white-space: nowrap;
}

.ai-agent-send:hover:not(:disabled) {
  background: rgba(var(--accent-rgb), 0.26);
}

.ai-agent-send--retry {
  background: rgba(var(--red-rgb), 0.14);
  border-color: rgba(var(--red-rgb), 0.45);
  color: var(--red-text);
}

.ai-agent-send--retry:hover:not(:disabled) {
  background: rgba(var(--red-rgb), 0.22);
}

.ai-agent-send--cancel {
  background: rgba(var(--red-rgb), 0.1);
  border-color: rgba(var(--red-rgb), 0.35);
  color: var(--red-text);
}

.ai-agent-send--cancel:hover {
  background: rgba(var(--red-rgb), 0.18);
}

.ai-agent-send:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.ai-agent-processing-hint {
  padding: 4px 12px 0;
  font-size: 11px;
  color: var(--yellow);
  flex-shrink: 0;
  animation: hint-pulse 1.6s ease-in-out infinite;
}

@keyframes hint-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}

.ai-msg--clarification {
  max-width: 85%;
}

.ai-clarification-bubble {
  background: rgba(var(--green-rgb), 0.1);
  border: 1px solid rgba(var(--green-rgb), 0.35);
  color: var(--green);
  border-radius: 2px 12px 12px 12px;
  padding: 5px 8px;
  font-size: 13px;
  line-height: 1.28;
  white-space: pre-wrap;
  word-break: break-word;
}

.ai-plan-confirm {
  margin-top: 6px;
  padding: 4px 12px;
  background: rgba(var(--green-rgb), 0.14);
  border: 1px solid rgba(var(--green-rgb), 0.45);
  color: var(--green);
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}

.ai-plan-confirm:hover {
  background: rgba(var(--green-rgb), 0.22);
}

.ai-feedback-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding-left: 2px;
  width: 100%;
  max-width: 100%;
}
.ai-feedback-btn { background: none; border: 1px solid rgba(var(--accent-rgb), 0.4); border-radius: 5px; cursor: pointer; font-size: 1.05rem; padding: 4px 9px; opacity: 0.65; transition: opacity 0.15s, border-color 0.15s, background 0.15s; line-height: 1; }
.ai-feedback-btn:hover { opacity: 1; border-color: var(--accent); background: rgba(var(--accent-rgb),0.12); }
.ai-feedback-btn--regen { margin-left: 8px; border-left: 1px solid rgba(var(--accent-rgb), 0.4); padding-left: 12px; border-radius: 0; border-right: none; border-top: none; border-bottom: none; background: none; }
.ai-feedback-btn--regen:hover { border-left-color: var(--accent); background: none; }
.ai-feedback-thanks { font-size: 0.8rem; color: var(--muted); font-style: italic; }
.ai-feedback-hint {
  flex: 1;
  min-width: 0;
  margin: 0 12px;
  font-size: 0.82rem;
  color: var(--red-text);
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── ask_clarification option buttons ─────────────────────────── */
.ai-clarification-options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.ai-clarification-option {
  padding: 4px 14px;
  border-radius: 999px;
  border: 1px solid var(--accent);
  background: transparent;
  color: var(--accent);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
  white-space: nowrap;
}

.ai-clarification-option:hover:not(:disabled) {
  background: var(--accent);
  color: #fff;
}

.ai-clarification-option--chosen,
.ai-clarification-option:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
```

（`.ai-wafermap-link` 保持字面量 `#1565c0`/`#e3f2fd`/`#1976d2` 不变——它是自带白底蓝字的实心徽章，在两种主题背景上都是同一个自洽的色块，不需要跟随主题。）

- [ ] **Step 2: 验证**

```bash
cd pcr-ai-report && npm run build && npm run dev
```

打开 AI Agent 标签页，分别在深色/浅色下发一条消息、展开工具详情、看一次 clarification 选项按钮、错误重试按钮（可以先故意把 API Key 清空触发一次错误）。

- [ ] **Step 3: Commit**

```bash
git add pcr-ai-report/src/reports/AiAgentReport.css
git commit -m "fix(report): remap AiAgentReport.css to shared theme tokens"
```

---

### Task 7: `KpiCard.tsx` + `LotUnderperformingDutsPanel.tsx` + `yieldCalc.ts` — var() 化

**Files:**
- Modify: `pcr-ai-report/src/components/KpiCard.tsx`（整体替换）
- Modify: `pcr-ai-report/src/components/LotUnderperformingDutsPanel.tsx`（整体替换）
- Modify: `pcr-ai-report/src/utils/yieldCalc.ts`（只改 `yieldColor` 函数）

这三个文件都是**纯 DOM 内联样式**（不涉及 ECharts canvas），可以直接用 `var(--x)` / `rgba(var(--x-rgb),alpha)` 字符串，浏览器自动按主题解析，**不需要 `useThemeContext()`**。

- [ ] **Step 1: 整体替换 `KpiCard.tsx`**

```tsx
import { useCountUp } from "../hooks/useCountUp";

export type KpiColor = "blue" | "green" | "red" | "yellow" | "white";

const COLOR_MAP: Record<
  KpiColor,
  { border: string; glow: string; text: string }
> = {
  blue:   { border: "rgba(var(--accent-rgb),0.55)", glow: "rgba(var(--accent-rgb),0.3)", text: "var(--accent)" },
  green:  { border: "rgba(var(--green-rgb),0.55)",  glow: "rgba(var(--green-rgb),0.25)", text: "var(--green)" },
  red:    { border: "rgba(var(--red-rgb),0.55)",    glow: "rgba(var(--red-rgb),0.3)",    text: "var(--red-text)" },
  yellow: { border: "rgba(var(--yellow-rgb),0.55)", glow: "rgba(var(--yellow-rgb),0.3)", text: "var(--yellow)" },
  white:  { border: "var(--border)", glow: "transparent", text: "var(--text)" },
};

type Props = {
  label: string;
  /** Numeric → animated count-up. String → displayed as-is. null → "—". */
  value: number | string | null;
  subtext?: string;
  color?: KpiColor;
  /** When false, title is shown only on the parent drag bar (e.g. reorder strips). */
  showLabel?: boolean;
};

function AnimatedNumber({ value }: { value: number }) {
  const n = useCountUp(value);
  return <>{n.toLocaleString()}</>;
}

export function KpiCard({
  label,
  value,
  subtext,
  color = "white",
  showLabel = true,
}: Props) {
  const c = COLOR_MAP[color];
  return (
    <div
      className={showLabel ? "kpi-card" : "kpi-card kpi-card--in-strip"}
      style={{
        background: "var(--bg)",
        border: `1px solid ${c.border}`,
        borderRadius: 8,
        padding: "12px 16px",
        textAlign: "center",
        boxShadow: `0 0 12px ${c.glow}`,
      }}
    >
      {showLabel && (
        <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 4 }}>
          {label}
        </div>
      )}
      <div
        className="kpi-card-value"
        style={{ fontSize: 22, fontWeight: 700, color: c.text, margin: "2px 0" }}
      >
        {value === null || value === undefined
          ? "—"
          : typeof value === "number"
          ? <AnimatedNumber value={value} />
          : value}
      </div>
      {(subtext || !showLabel) && (
        <div className="kpi-card-subtext" style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
          {subtext ?? " "}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 整体替换 `LotUnderperformingDutsPanel.tsx`**

只改样式相关的字面量（业务逻辑一行不动）：

```tsx
import { useEffect, useState } from "react";
import { apiGetJson } from "../api/client";
import { LOT_UNDERPERFORMING_DUTS_PATH } from "../api/paths";

type DutRow = {
  dut: number;
  goodDie: number;
  totalDie: number;
  yieldPct: number;
  gapToThresholdPct?: number;
};

type PassResult = {
  passId: number;
  sortLabel: string;
  dutCount: number;
  lotGoodDie: number;
  lotTotalDie: number;
  baseline: {
    method: "lotOverall";
    yieldPct: number;
    thresholdPct: number;
    thresholdRatio: number;
  } | null;
  underperformingDuts: DutRow[];
};

export type LotUnderperformingDutsResponse = {
  device: string;
  lot: string;
  probeCardType?: string;
  passIds: number[];
  waferCount: number;
  filters: { thresholdRatio: number; baselineMethod: string };
  passes: PassResult[];
};

type Props = {
  apiBase: string;
  lot: string;
  device?: string;
  thresholdRatio?: number;
};

export function LotUnderperformingDutsPanel({
  apiBase,
  lot,
  device,
  thresholdRatio = 0.75,
}: Props) {
  const [data, setData] = useState<LotUnderperformingDutsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const lotTrim = lot.trim();
    if (!lotTrim) {
      setData(null);
      setError(null);
      return;
    }

    const params: Record<string, string | number> = {
      lot: lotTrim,
      thresholdRatio,
    };
    const deviceTrim = device?.trim();
    if (deviceTrim) params.device = deviceTrim;

    let cancelled = false;
    setLoading(true);
    setError(null);
    void apiGetJson<LotUnderperformingDutsResponse>(apiBase, LOT_UNDERPERFORMING_DUTS_PATH, params)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setData(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [apiBase, lot, device, thresholdRatio]);

  if (!lot.trim()) return null;

  return (
    <div
      className="report-chart-panel"
      style={{
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: 16,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: "var(--text)" }}>
        低良率 DUT（DUT 良率 &lt; lot 整体 × {thresholdRatio}）
      </div>
      {loading ? (
        <p className="muted small">正在加载 INF DUT 良率…</p>
      ) : error ? (
        <p style={{ color: "var(--red-text)", fontSize: 12 }}>{error}</p>
      ) : data ? (
        <>
          <p className="muted small" style={{ margin: "0 0 12px" }}>
            {data.device} · {data.lot}
            {data.probeCardType ? ` · 卡型 ${data.probeCardType}` : ""} · {data.waferCount} 片 wafer
          </p>
          {data.passes.map((pass) => (
            <div key={pass.passId} style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 6 }}>
                {pass.sortLabel}
                {pass.baseline
                  ? ` — lot 整体 ${pass.baseline.yieldPct}% · 阈值 ${pass.baseline.thresholdPct}%`
                  : " — 无有效 die 数据"}
              </div>
              {pass.underperformingDuts.length === 0 ? (
                <p className="muted small" style={{ margin: 0 }}>
                  无低于阈值的 DUT
                </p>
              ) : (
                <table className="data-table" style={{ fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th>DUT</th>
                      <th>良率%</th>
                      <th>good/total</th>
                      <th>距阈值%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pass.underperformingDuts.map((d) => (
                      <tr key={d.dut}>
                        <td>DUT{d.dut}</td>
                        <td>{d.yieldPct}</td>
                        <td>
                          {d.goodDie}/{d.totalDie}
                        </td>
                        <td>{d.gapToThresholdPct ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 3: 改 `yieldCalc.ts` 的 `yieldColor`**

把：

```ts
export function yieldColor(pct: number | null): string {
  if (pct === null) return "#8b949e";
  if (pct >= 95) return "#3fb950";
  if (pct >= 80) return "#d29922";
  return "#ff7b72";
}
```

改成：

```ts
export function yieldColor(pct: number | null): string {
  if (pct === null) return "var(--muted)";
  if (pct >= 95) return "var(--green)";
  if (pct >= 80) return "var(--yellow)";
  return "var(--red-text)";
}
```

（当前两处调用点——`InfcontrolReport.tsx:435` 的 React `style={{color: yieldColor(yp)}}` 和 `InfcontrolReport.tsx:1318` 的 tooltip HTML 字符串 `style="color:${yieldColor(...)}"`——都是真实 DOM/HTML 渲染路径，`var()` 在这两处都能被浏览器正常解析，不会画到 canvas 里，因此不需要额外的 `theme` 参数。）

- [ ] **Step 4: 验证**

```bash
cd pcr-ai-report && npm run build
```

- [ ] **Step 5: Commit**

```bash
git add pcr-ai-report/src/components/KpiCard.tsx pcr-ai-report/src/components/LotUnderperformingDutsPanel.tsx pcr-ai-report/src/utils/yieldCalc.ts
git commit -m "fix(report): KpiCard/LotUnderperformingDutsPanel/yieldColor use theme CSS variables"
```

---

### Task 8: `YieldMonitorReport.tsx` — 接入图表主题 + `chartTheme.ts` 一并提交

**Files:**
- Modify: `pcr-ai-report/src/reports/YieldMonitorReport.tsx`
- （本任务同时提交 Task 2 里改好但未提交的 `pcr-ai-report/src/theme/chartTheme.ts`）

**Interfaces:**
- Consumes: `useThemeContext()`（Task 1）、`getChartPalette`、`getStatusTierColors`（未用到）、`selectionTierColors`（Task 2）。

- [ ] **Step 1: 改 import 块**

把：

```ts
import {
  baseChartOption,
  chartAccent,
  chartAccent2,
  chartAccent3,
  chartAxisColor,
  chartSplitLine,
  ...
  horizontalBarChartBase,
  ...
  yieldTrendChartGrid,
} from "../theme/chartTheme";
```

改成（保留原有其它未列出的导出名不变，只删掉 5 个常量、加 `getChartPalette`/`selectionTierColors`）：

```ts
import {
  baseChartOption,
  getChartPalette,
  selectionTierColors,
  horizontalBarCategoryAxisLabel,
  horizontalBarChartBase,
  rankBarChartHeight,
  YIELD_TREND_CHART_HEIGHT,
  yieldTrendChartGrid,
} from "../theme/chartTheme";
```

（按文件顶部实际保留的其它符号名调整——原则是：只删除 `chartAccent`/`chartAccent2`/`chartAccent3`/`chartAxisColor`/`chartSplitLine` 这 5 个，新增 `getChartPalette`/`selectionTierColors` 这 2 个，其余保持原样。）

在 import 之后、组件函数体顶部加：

```ts
import { useThemeContext } from "../theme/ThemeContext";
```

组件函数体最前面加一行（紧跟其它 hooks 之后即可）：

```ts
const { theme } = useThemeContext();
const chartPalette = getChartPalette(theme);
```

- [ ] **Step 2: `timeTrendOption`（约第 700-745 行）替换 `chartAxisColor`/`chartSplitLine`/`chartAccent`**

把：

```tsx
    return {
      ...baseChartOption(),
      grid: yieldTrendChartGrid,
      xAxis: {
        type: "category",
        data: dates,
        axisLabel: { color: chartAxisColor, fontSize: 10, rotate: 30 },
      },
      yAxis: {
        type: "value",
        axisLabel: { color: chartAxisColor },
        splitLine: { lineStyle: { color: chartSplitLine } },
      },
      series: [
        {
          type: "line",
          data: counts,
          smooth: true,
          areaStyle: {
            color: {
              type: "linear",
              x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: "rgba(88,166,255,0.3)" },
                { offset: 1, color: "rgba(88,166,255,0.02)" },
              ],
            },
          },
          lineStyle: { color: chartAccent, width: 2 },
          itemStyle: { color: chartAccent },
          animationDuration: 600,
        },
      ],
      tooltip: { trigger: "axis" },
    };
```

改成：

```tsx
    return {
      ...baseChartOption(theme),
      grid: yieldTrendChartGrid,
      xAxis: {
        type: "category",
        data: dates,
        axisLabel: { color: chartPalette.axisColor, fontSize: 10, rotate: 30 },
      },
      yAxis: {
        type: "value",
        axisLabel: { color: chartPalette.axisColor },
        splitLine: { lineStyle: { color: chartPalette.splitLine } },
      },
      series: [
        {
          type: "line",
          data: counts,
          smooth: true,
          areaStyle: {
            color: {
              type: "linear",
              x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: `rgba(${theme === "light" ? "9,105,218" : "88,166,255"},0.3)` },
                { offset: 1, color: `rgba(${theme === "light" ? "9,105,218" : "88,166,255"},0.02)` },
              ],
            },
          },
          lineStyle: { color: chartPalette.accent, width: 2 },
          itemStyle: { color: chartPalette.accent },
          animationDuration: 600,
        },
      ],
      tooltip: { trigger: "axis" },
    };
```

同时把这个 `useMemo` 的依赖数组从 `[aggTime]` 改成 `[aggTime, theme]`（原文件是 `}, [aggTime]);`——搜索该行加 `theme`）。

- [ ] **Step 3: `cardTypeOption`（约第 748-789 行）**

把：

```tsx
    const COL = chartAccent2, COL_B = "#bf8dff", COL_D = "rgba(163,113,247,0.3)";
    return {
      ...horizontalBarChartBase(),
      xAxis: {
        type: "value",
        axisLabel: { color: chartAxisColor },
        splitLine: { lineStyle: { color: chartSplitLine } },
      },
      yAxis: {
        type: "category",
        data: sorted.map((g) => g.parts.probeCardType ?? g.key),
        axisLabel: horizontalBarCategoryAxisLabel,
      },
```

改成：

```tsx
    const { base: COL, bright: COL_B, dim: COL_D } = selectionTierColors(theme, "purple");
    return {
      ...horizontalBarChartBase(theme),
      xAxis: {
        type: "value",
        axisLabel: { color: chartPalette.axisColor },
        splitLine: { lineStyle: { color: chartPalette.splitLine } },
      },
      yAxis: {
        type: "category",
        data: sorted.map((g) => g.parts.probeCardType ?? g.key),
        axisLabel: { ...horizontalBarCategoryAxisLabel, color: chartPalette.axisColor },
      },
```

下面的 `label: { show: true, position: "right", color: chartAxisColor, fontSize: 10 }` → `color: chartPalette.axisColor`（此函数内共 1 处，直接替换）。

依赖数组 `}, [aggCardType, selectedCardTypeName]);` → `}, [aggCardType, selectedCardTypeName, theme]);`。

- [ ] **Step 4: `dutOption`（约第 808-838 行）**

同样模式：`...horizontalBarChartBase()` → `...horizontalBarChartBase(theme)`；两处 `axisLabel: { color: chartAxisColor }` → `axisLabel: { color: chartPalette.axisColor }`；`splitLine: { lineStyle: { color: chartSplitLine } }` → `splitLine: { lineStyle: { color: chartPalette.splitLine } }`；`axisLabel: horizontalBarCategoryAxisLabel` → `axisLabel: { ...horizontalBarCategoryAxisLabel, color: chartPalette.axisColor }`；`itemStyle: { color: chartAccent3, ... }` → `itemStyle: { color: chartPalette.accent3, ... }`；`label: {..., color: chartAxisColor, ...}` → `color: chartPalette.axisColor`。依赖数组 `}, [dutTally]);` → `}, [dutTally, theme]);`。

- [ ] **Step 5: `dutDistributionFooter`（约第 840-894 行）里的纯 DOM 内联样式**

把：

```tsx
          <span style={{ fontSize: 12, color: "#58a6ff", fontWeight: 600 }}>
```

改成 `color: "var(--accent)"`。

把：

```tsx
              style={{ color: "#ff7b72", borderColor: "rgba(248,81,73,0.3)" }}
```

改成 `{ color: "var(--red-text)", borderColor: "rgba(var(--red-rgb),0.3)" }`。

三处 `color: "#8b949e"`（loading/empty 提示文案）→ `color: "var(--muted)"`。

- [ ] **Step 6: `lotOption`（约第 902-943 行）**

```tsx
    const COL = "#f0883e", COL_B = "#ff9f60", COL_D = "rgba(240,136,62,0.3)";
```

改成：

```tsx
    const { base: COL, bright: COL_B, dim: COL_D } = selectionTierColors(theme, "orange");
```

其余（`horizontalBarChartBase()`→`horizontalBarChartBase(theme)`、两处 `chartAxisColor`→`chartPalette.axisColor`、`chartSplitLine`→`chartPalette.splitLine`、`horizontalBarCategoryAxisLabel`→`{ ...horizontalBarCategoryAxisLabel, color: chartPalette.axisColor }`、`label` 里的 `chartAxisColor`→`chartPalette.axisColor`）按 Step 3/4 的同款模式改。依赖数组加 `theme`。

- [ ] **Step 7: `deviceOption`（约第 945-980 行）**

```tsx
    const COL = "#79c0ff", COL_B = "#58a6ff", COL_D = "rgba(88,166,255,0.2)";
```

改成：

```tsx
    const { base: COL, bright: COL_B, dim: COL_D } = selectionTierColors(theme, "blue-light");
```

其余同款模式替换，依赖数组加 `theme`。

- [ ] **Step 8: 全文件扫描，确认没有漏改的旧符号**

```bash
cd pcr-ai-report
node -e "
const fs = require('fs');
const t = fs.readFileSync('src/reports/YieldMonitorReport.tsx','utf8');
const bad = t.match(/chartAxisColor|chartSplitLine|chartAccent2?3?\b|horizontalBarChartBase\(\)|baseChartOption\(\)/g);
console.log(bad ?? 'CLEAN');
"
```

Expected: `CLEAN`（如果打印出匹配项，说明还有遗漏，回去补上 `(theme)` 或 `chartPalette.xxx`）。

- [ ] **Step 9: 编译验证**

```bash
npm run build
```

Expected: 无 TS 报错（`chartTheme.ts` 的旧导出已删除，此时应该所有消费方都改完了这一个文件；如果报错提示别的文件还在用旧符号，说明还没轮到那个文件的任务，属于中间状态——继续往下做 Task 9/10 即可，不要为了让这一步单独通过而临时改别的文件)。

- [ ] **Step 10: Commit（把 Task 2 的 `chartTheme.ts` 一起提交）**

```bash
git add pcr-ai-report/src/theme/chartTheme.ts pcr-ai-report/src/reports/YieldMonitorReport.tsx
git commit -m "feat(report): theme-aware chart palette + YieldMonitorReport charts follow theme"
```

---

### Task 9: `InfcontrolReport.tsx` — 接入图表主题

**Files:**
- Modify: `pcr-ai-report/src/reports/InfcontrolReport.tsx`

这是本次改动量最大的单文件任务。逐段按下面的锚点替换；每一段锚点都取自文件当前内容，改完之后建议整段重新 Read 一次确认。

- [ ] **Step 1: import 块**

把文件顶部 `from "../theme/chartTheme"` 的 import 列表里的 `chartAxisColor`、`chartSplitLine` 删掉，加入 `getChartPalette`、`getStatusTierColors`、`selectionTierColors`；其余符号名（`horizontalBarChartBase`、`horizontalBarCategoryAxisLabel`、`horizontalBarCategoryAxisLabelFull`、`verticalBarChartGrid`、`rankBarChartHeight` 等）保持不变。另加：

```ts
import { useThemeContext } from "../theme/ThemeContext";
```

组件函数体顶部加：

```ts
const { theme } = useThemeContext();
const chartPalette = getChartPalette(theme);
```

- [ ] **Step 2: `FUNNEL_LEVEL_DEFS`（约第 553-560 行）**

把：

```ts
const FUNNEL_LEVEL_DEFS: ReadonlyArray<{ key: string; label: string; color: string }> = [
  { key: "mask",   label: "Mask",      color: "#79c0ff" },
  { key: "device", label: "Device",    color: "#d2a8ff" },
  { key: "lot",    label: "Lot",       color: "#3fb950" },
  { key: "passId", label: "Pass",      color: "#ff7b72" },
  { key: "slot",   label: "Wafer ID",  color: "#e6b450" },
  { key: "cardId", label: "ProbeCard", color: "#58a6ff" },
];
```

改成（这几个值只会被塞进 CSS 自定义属性 `--step-color` 走 DOM 渲染，直接用 var()）：

```ts
const FUNNEL_LEVEL_DEFS: ReadonlyArray<{ key: string; label: string; color: string }> = [
  { key: "mask",   label: "Mask",      color: "var(--dim-mask)" },
  { key: "device", label: "Device",    color: "var(--dim-device)" },
  { key: "lot",    label: "Lot",       color: "var(--dim-lot)" },
  { key: "passId", label: "Pass",      color: "var(--dim-pass)" },
  { key: "slot",   label: "Wafer ID",  color: "var(--dim-slot)" },
  { key: "cardId", label: "ProbeCard", color: "var(--dim-card)" },
];
```

- [ ] **Step 3: 两处「bad die 排名图」的 tooltip 三件套（约第 685-703 行、723-743 行）**

两处都是同样的模式，各出现一次，逐一替换。第一处：

```tsx
          tooltip: {
            trigger: "axis",
            backgroundColor: "#161b22",
            borderColor: "#30363d",
            textStyle: { color: "#e6edf3", fontSize: 12 },
```

改成：

```tsx
          tooltip: {
            trigger: "axis",
            backgroundColor: "var(--surface-1)",
            borderColor: "var(--border)",
            textStyle: { color: "var(--text)", fontSize: 12 },
```

第二处一模一样的 4 行文本再改一次（`trigger: "axis",` 后面紧跟 `backgroundColor: "#161b22",` 的第二次出现）。

同一函数里的 `axisLabel: { color: chartAxisColor, fontSize: 10, rotate: 30 },` → `axisLabel: { color: chartPalette.axisColor, fontSize: 10, rotate: 30 },`；两处 `axisLabel: { color: chartAxisColor },` → `axisLabel: { color: chartPalette.axisColor },`；两处 `splitLine: { lineStyle: { color: chartSplitLine } },` → `splitLine: { lineStyle: { color: chartPalette.splitLine } },`；`axisLabel: { ...horizontalBarCategoryAxisLabel, interval: 0 },` → `axisLabel: { ...horizontalBarCategoryAxisLabel, interval: 0, color: chartPalette.axisColor },`；两处 `label: { show: true, position: "right", color: chartAxisColor, fontSize: 10 }` → `color: chartPalette.axisColor`；两处 `...horizontalBarChartBase(),` → `...horizontalBarChartBase(theme),`。

- [ ] **Step 4: `lotYieldOption`（约第 1298-1365 行）**

tooltip 三件套（第三处）同 Step 3 手法替换：

```tsx
        backgroundColor: "#161b22",
        borderColor: "#30363d",
        textStyle: { color: "#e6edf3", fontSize: 12 },
```

→

```tsx
        backgroundColor: "var(--surface-1)",
        borderColor: "var(--border)",
        textStyle: { color: "var(--text)", fontSize: 12 },
```

`axisLabel: { color: chartAxisColor, formatter: "{value}%" },` → `axisLabel: { color: chartPalette.axisColor, formatter: "{value}%" },`；`splitLine: { lineStyle: { color: chartSplitLine } },` → `splitLine: { lineStyle: { color: chartPalette.splitLine } },`；`axisLabel: { ...horizontalBarCategoryAxisLabelFull, interval: 0 },` → 加 `color: chartPalette.axisColor`；`...horizontalBarChartBase(),` → `...horizontalBarChartBase(theme),`。

三层色的核心替换——把：

```tsx
            const base   = d.yieldPct >= 95 ? "#238636" : d.yieldPct >= 80 ? "#9e6a03" : "#da3633";
            const bright = d.yieldPct >= 95 ? "#3fb950" : d.yieldPct >= 80 ? "#d29922" : "#f85149";
            const dim    = d.yieldPct >= 95 ? "rgba(35,134,54,0.3)" : d.yieldPct >= 80 ? "rgba(158,106,3,0.3)" : "rgba(218,54,51,0.3)";
```

改成：

```tsx
            const tiers = getStatusTierColors(theme);
            const tier = d.yieldPct >= 95 ? tiers.green : d.yieldPct >= 80 ? tiers.yellow : tiers.red;
            const base = tier.border;
            const bright = tier.bright;
            const dim = tier.glow;
```

`label: { show: true, position: "right", color: chartAxisColor, ...}` → `color: chartPalette.axisColor`。依赖数组 `}, [lotYieldData, selectedLotLabel]);` → 加 `theme`（准确名字以文件里 `useMemo` 结尾那一行实际依赖数组为准，只追加 `theme`）。

- [ ] **Step 5: `cardTypeOption`（约第 1371-1414 行，ProbeCard Type 排名图）**

```tsx
    const COL = "#e6b450", COL_B = "#ffd070", COL_D = "rgba(230,180,80,0.3)";
```

→

```tsx
    const { base: COL, bright: COL_B, dim: COL_D } = selectionTierColors(theme, "gold");
```

其余（`axisLabel`/`splitLine`/`horizontalBarChartBase`/`label` 里的 `chartAxisColor`/`chartSplitLine`）按前面同款模式替换。依赖数组加 `theme`。

- [ ] **Step 6: `deviceOption`（约第 1417-1460 行）**

```tsx
    const COL = "#79c0ff", COL_B = "#58a6ff", COL_D = "rgba(121,192,255,0.2)";
```

→

```tsx
    const { base: COL, bright: COL_B, dim: COL_D } = selectionTierColors(theme, "blue-light");
```

其余同款模式替换，依赖数组加 `theme`。

- [ ] **Step 7: 其余 DOM 内联样式（非 canvas）**

逐处替换（`replace_all: true` 对下面每一行分别安全，因为在本文件里语义单一）：

| old | new |
| --- | --- |
| `color: "#e0824a"` | `color: "var(--yellow)"` |
| `color: "rgba(240,246,252,0.03)"` 里没有这个具体写法就跳过；实际是 `background: "rgba(240, 246, 252, 0.03)"`（若出现） | `background: "rgba(var(--fg-rgb),0.03)"` |
| `"--step-color": "#ff9500"` | 保持不变（装饰性 active 态强调色，两个主题都够用，不改） |
| `color: "#ff7b72", fontSize: 12, margin: "12px 0"` 等 error 文案里的 `"#ff7b72"` | `"var(--red-text)"` |
| `background: "#0d1117", border: "1px solid rgba(240,246,252,0.1)"`（两处面板容器，约 1857/1899 行附近） | `background: "var(--bg)", border: "1px solid var(--border)"` |
| 面板容器内 `color: "#8b949e"` | `color: "var(--muted)"` |
| `color: "#6e7681"`（多处小字提示） | `color: "var(--dimmed)"` |
| `color: "#58a6ff"`（约 1921 行 `<span style={{ marginLeft: 8, color: "#58a6ff" }}>`） | `color: "var(--accent)"` |
| `color: "#f85149"`（field-hint 里的错误色，约 1927 行） | `color: "var(--red-text)"` |
| `color: "#8b949e", fontSize: 12`（约 2160 行的 `→` 箭头） | `color: "var(--muted)"` |
| `color: "#ff7b72", ... background: "rgba(248,81,73,0.08)"`（约 2289-2291 行） | `color: "var(--red-text)", background: "rgba(var(--red-rgb),0.08)"` |

- [ ] **Step 8: 白色描边/阴影（scatter halo，如果本文件里有 `rgba(255,255,255,` 系列——先 grep 确认）**

```bash
cd pcr-ai-report
grep -n "rgba(255,255,255" src/reports/InfcontrolReport.tsx || echo "NONE"
```

如果有结果，把每处 `rgba(255,255,255,` 开头的三个数字组替换成 `` `rgba(${chartPalette.haloRgb === "31,35,40" ? "31,35,40" : "255,255,255"},` ``——更简洁的写法是直接用 `` `rgba(${chartPalette.haloRgb},alpha)` `` 模板字符串（`chartPalette` 已在函数体顶部声明），把原有的固定 alpha 数值保留。若 grep 无结果（该颜色实际在 `InfDutDistPanel.tsx`，Task 10 处理），跳过此步。

- [ ] **Step 9: 全文件扫描确认无遗漏**

```bash
cd pcr-ai-report
node -e "
const fs = require('fs');
const t = fs.readFileSync('src/reports/InfcontrolReport.tsx','utf8');
const bad = t.match(/chartAxisColor|chartSplitLine|#161b22|#30363d|#e6edf3\b|#8b949e|#6e7681|#f85149|#ff7b72(?!.*step-color)/g);
console.log(bad ?? 'CLEAN');
"
```

Expected: `CLEAN` 或仅剩 `--step-color` 相关的一处（已确认保留不动）。逐条核对残留项来源，若确实是遗漏则回去补替换。

- [ ] **Step 10: 编译验证**

```bash
npm run build
```

- [ ] **Step 11: Commit**

```bash
git add pcr-ai-report/src/reports/InfcontrolReport.tsx
git commit -m "fix(report): InfcontrolReport charts + inline styles follow theme"
```

---

### Task 10: `DrillDownPanel.tsx` + `InfDutDistPanel.tsx` — 接入图表主题

**Files:**
- Modify: `pcr-ai-report/src/components/DrillDownPanel.tsx`
- Modify: `pcr-ai-report/src/components/InfDutDistPanel.tsx`

- [ ] **Step 1: `DrillDownPanel.tsx` — import + 顶层 `COL_PANEL*`**

把：

```tsx
import {
  chartAccent,
  chartAxisColor,
  drillBarChartHeight,
  horizontalBarCategoryAxisLabel,
  horizontalBarChartBase,
  type BarChartHeightVariant,
} from "../theme/chartTheme";
```

改成：

```tsx
import {
  drillBarChartHeight,
  horizontalBarCategoryAxisLabel,
  horizontalBarChartBase,
  getChartPalette,
  selectionTierColors,
  type BarChartHeightVariant,
} from "../theme/chartTheme";
import { useThemeContext } from "../theme/ThemeContext";
```

删掉模块顶层的：

```ts
const COL_PANEL = chartAccent;
const COL_PANEL_B = "#2080ff";
const COL_PANEL_D = "rgba(88,166,255,0.3)";
```

（这正是 spec 里点名的 bug——模块顶层求值、主题切换不生效——搬进组件函数体内。）

- [ ] **Step 2: 组件函数体顶部加 theme 相关变量**

在 `export function DrillDownPanel({ ... }: Props) {` 的函数体第一行（`const barHeightVariant = ...` 之前）加：

```tsx
  const { theme } = useThemeContext();
  const chartPalette = getChartPalette(theme);
  const { base: COL_PANEL, bright: COL_PANEL_B, dim: COL_PANEL_D } = selectionTierColors(theme, "blue-deep");
```

- [ ] **Step 3: `option` 对象里的替换**

把：

```tsx
  const option: EChartsOption = {
    ...horizontalBarChartBase(),
    xAxis: {
      type: "value",
      axisLabel: { color: chartAxisColor, fontSize: 11 },
      splitLine: { lineStyle: { color: "rgba(240,246,252,0.06)" } },
    },
    yAxis: {
      type: "category",
      data: labels,
      axisLabel: { ...horizontalBarCategoryAxisLabel, interval: 0 },
    },
```

改成：

```tsx
  const option: EChartsOption = {
    ...horizontalBarChartBase(theme),
    xAxis: {
      type: "value",
      axisLabel: { color: chartPalette.axisColor, fontSize: 11 },
      splitLine: { lineStyle: { color: chartPalette.splitLine } },
    },
    yAxis: {
      type: "category",
      data: labels,
      axisLabel: { ...horizontalBarCategoryAxisLabel, interval: 0, color: chartPalette.axisColor },
    },
```

下面 `label: { show: true, position: "right", color: chartAxisColor, fontSize: 10 }` → `color: chartPalette.axisColor`。

- [ ] **Step 4: 面板容器 + 头部文字（纯 DOM，直接 var()）**

```tsx
      style={{
        border: "1px solid #388bfd",
        borderRadius: 8,
        background: "#0d1929",
```

改成：

```tsx
      style={{
        border: "1px solid rgba(var(--accent-rgb),0.45)",
        borderRadius: 8,
        background: "var(--surface-2)",
```

```tsx
        <span style={{ fontSize: 12, color: "#58a6ff", fontWeight: 600 }}>
          ↳ {title}
          {multiSelect && (selectedKeys?.size ?? 0) > 0 ? (
            <span style={{ marginLeft: 8, color: "#8b949e", fontWeight: 400 }}>
```

改成 `color: "var(--accent)"` 与 `color: "var(--muted)"`。

```tsx
              style={
                opt.value === activeSubDim
                  ? {
                      background: "rgba(56,139,253,0.2)",
                      borderColor: "#388bfd",
                      color: "#58a6ff",
                    }
                  : undefined
              }
```

改成：

```tsx
              style={
                opt.value === activeSubDim
                  ? {
                      background: "rgba(var(--accent-rgb),0.2)",
                      borderColor: "var(--accent)",
                      color: "var(--accent)",
                    }
                  : undefined
              }
```

```tsx
            style={{ color: "#ff7b72", borderColor: "rgba(248,81,73,0.3)" }}
```

→ `{ color: "var(--red-text)", borderColor: "rgba(var(--red-rgb),0.3)" }`。

`{!loading && error && (<div style={{ color: "#ff7b72", ...` → `color: "var(--red-text)"`。

`color: "#8b949e"`（加载态/空态两处）→ `color: "var(--muted)"`；`background: "rgba(240,246,252,0.03)"` → `background: "rgba(var(--fg-rgb),0.03)"`。

- [ ] **Step 5: 依赖数组**

`useMemo`/`useCallback` 若有依赖 `option` 构建过程中用到 `theme`，本组件的 `option` 是每次渲染都重新计算的普通 `const`（不是 `useMemo`），所以不需要加依赖数组——确认一下：Read 过的原文件里 `option` 确实是普通 `const option: EChartsOption = {...}`，每次渲染重建，天然会跟着 `theme` 变化重新计算，不需要额外处理。

- [ ] **Step 6: `InfDutDistPanel.tsx` — import + 顶部**

把：

```tsx
import {
  baseChartOption,
  chartAxisColor,
} from "../theme/chartTheme";
```

改成：

```tsx
import {
  baseChartOption,
  getChartPalette,
} from "../theme/chartTheme";
import { useThemeContext } from "../theme/ThemeContext";
```

在组件函数体（`export function InfDutDistPanel({...}: Props) {`）顶部加：

```tsx
  const { theme } = useThemeContext();
  const chartPalette = getChartPalette(theme);
```

- [ ] **Step 7: tooltip HTML 片段里的悬浮高亮色（约第 74 行，DOM tooltip 内联样式字符串，可直接用 var()）**

把：

```ts
        ? "background:rgba(88,166,255,0.32);border-radius:4px;padding:2px 7px;margin:-2px -7px;font-weight:700;color:#fff;box-shadow:0 0 0 1px rgba(88,166,255,0.45);"
```

改成：

```ts
        ? "background:rgba(var(--accent-rgb),0.32);border-radius:4px;padding:2px 7px;margin:-2px -7px;font-weight:700;color:#fff;box-shadow:0 0 0 1px rgba(var(--accent-rgb),0.45);"
```

（这段字符串会被塞进 tooltip formatter 返回的 HTML，ECharts 把它当普通 DOM innerHTML 处理，浏览器会解析 `rgba(var(--accent-rgb),X)`。）

- [ ] **Step 8: `dutDistTooltip` 内的 `baseChartOption()` 调用（约第 105 行）**

```ts
  const base = baseChartOption().tooltip as Record<string, unknown> | undefined;
```

→

```ts
  const base = baseChartOption(theme).tooltip as Record<string, unknown> | undefined;
```

（此函数需要能拿到 `theme`——检查函数签名：`function dutDistTooltip(hoveredSeriesRef?: {...}): EChartsOption["tooltip"]` 是模块级函数，不在组件内部，拿不到 `useThemeContext()`。把签名改成接收 `theme` 参数：）

```ts
function dutDistTooltip(
  theme: ChartTheme,
  hoveredSeriesRef?: { current: number | null }
): EChartsOption["tooltip"] {
  const base = baseChartOption(theme).tooltip as Record<string, unknown> | undefined;
  ...
```

并在文件顶部 import 里加 `type ChartTheme`（从 `"../theme/chartTheme"` 一并导入），调用处（组件内部调用 `dutDistTooltip(...)` 的地方）改成 `dutDistTooltip(theme, hoveredSeriesRef)`（先 grep 确认调用点数量）：

```bash
cd pcr-ai-report
grep -n "dutDistTooltip(" src/components/InfDutDistPanel.tsx
```

对每个调用点在第一个参数位置插入 `theme,`。

- [ ] **Step 9: 第 578 行附近 `...baseChartOption()` 与 axisLabel**

```tsx
    ...baseChartOption(),
```

改成 `...baseChartOption(theme),`。

```tsx
      axisLabel: { color: chartAxisColor, rotate: bins.length > 8 ? 30 : 0, fontSize: 11 },
```

→ `color: chartPalette.axisColor`。

```tsx
      nameTextStyle: { color: chartAxisColor, fontSize: 9, align: "left" },
```

→ `color: chartPalette.axisColor`。

第 600 行附近单独一行 `color: chartAxisColor,` → `color: chartPalette.axisColor,`。

- [ ] **Step 10: 分类色板（约第 168-182 行）——不改**

这是固定的分类调色板数组（每个 DUT 一个固定颜色，跨主题保持不变，属于设计决定），**保留原样**，不要改。

- [ ] **Step 11: 白色描边/阴影（约第 263-265、555-556 行）**

```tsx
    borderColor: "rgba(255,255,255,0.85)",
```

→

```tsx
    borderColor: `rgba(${chartPalette.haloRgb},0.85)`,
```

（注意原来是双引号字符串字面量，改完是模板字符串，外层如果被对象字面量语法包裹要确认逗号/引号语法正确）。

```tsx
    shadowColor: "rgba(255,255,255,0.28)",
```

→

```tsx
    shadowColor: `rgba(${chartPalette.haloRgb},0.28)`,
```

```tsx
            shadowColor: "rgba(255,255,255,0.55)",
            borderColor: "rgba(255,255,255,0.75)",
```

→

```tsx
            shadowColor: `rgba(${chartPalette.haloRgb},0.55)`,
            borderColor: `rgba(${chartPalette.haloRgb},0.75)`,
```

- [ ] **Step 12: 第 605 行 splitLine**

```tsx
      splitLine: { lineStyle: { color: "rgba(240,246,252,0.06)" } },
```

→

```tsx
      splitLine: { lineStyle: { color: chartPalette.splitLine } },
```

- [ ] **Step 13: 第 710-753 行附近的 DOM 内联样式**

```tsx
            background: "rgba(240,246,252,0.04)",
```

→ `background: "rgba(var(--fg-rgb),0.04)"`。

```tsx
            color: "#6e7681",
```

→ `color: "var(--dimmed)"`（多处同值，逐一替换）。

```tsx
    <div style={{ color: "#f85149", fontSize: 13 }}>
```

→ `color: "var(--red-text)"`。

```tsx
            <div style={{ color: "#8b949e", fontSize: 13 }}>
```

→ `color: "var(--muted)"`（该值出现的每一处提示文案都替换）。

- [ ] **Step 14: 全文件扫描**

```bash
cd pcr-ai-report
node -e "
const fs = require('fs');
for (const f of ['src/components/DrillDownPanel.tsx','src/components/InfDutDistPanel.tsx']) {
  const t = fs.readFileSync(f,'utf8');
  const bad = t.match(/chartAxisColor|chartSplitLine|chartAccent|rgba\(255,255,255|#161b22|#30363d/g);
  console.log(f, bad ?? 'CLEAN');
}
"
```

Expected: 两个文件都打印 `CLEAN`。

- [ ] **Step 15: 编译验证**

```bash
npm run build
```

- [ ] **Step 16: Commit**

```bash
git add pcr-ai-report/src/components/DrillDownPanel.tsx pcr-ai-report/src/components/InfDutDistPanel.tsx
git commit -m "fix(report): DrillDownPanel/InfDutDistPanel charts follow theme"
```

---

### Task 11: `AiAgentReport.tsx` — 图表导出背景色主题感知

**Files:**
- Modify: `pcr-ai-report/src/reports/AiAgentReport.tsx`

**Interfaces:**
- Consumes: `useThemeContext()`。

- [ ] **Step 1: 定位 `getDataURL` 调用**

```bash
cd pcr-ai-report
grep -n "getDataURL" src/reports/AiAgentReport.tsx
```

- [ ] **Step 2: 加 theme 依赖**

在组件函数体顶部（其它 hooks 附近）加：

```tsx
const { theme } = useThemeContext();
```

并在文件顶部 import 区加：

```tsx
import { useThemeContext } from "../theme/ThemeContext";
```

把：

```tsx
const dataUrl = instance.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: "#141414" });
```

改成：

```tsx
const dataUrl = instance.getDataURL({
  type: "png",
  pixelRatio: 2,
  backgroundColor: theme === "light" ? "#ffffff" : "#141414",
});
```

（PNG 导出走 canvas `toDataURL`，同样不能用 CSS `var()`，需要真实色值；这里直接用 `theme` 三元判断即可，不需要走 `getChartPalette`，因为只有这一处用到。）

RobotAvatar 内联 SVG（`stopColor`/`fill` 那一段，约第 84-142 行）**保持不动**——它是自带配色的头像图标，不随主题变化，两种背景上都好看。

- [ ] **Step 3: 验证**

```bash
npm run build
npm run dev
```

在 AI Agent 里让模型生成一张图表（或问一个会触发 `generate_chart` 的问题），分别在深色/浅色下点下载按钮，确认导出的 PNG 背景色分别是深色/白色，不是那种「白图配深色方块背景」的违和结果。

- [ ] **Step 4: Commit**

```bash
git add pcr-ai-report/src/reports/AiAgentReport.tsx
git commit -m "fix(report): chart PNG export background follows theme"
```

---

### Task 12: 全站人工验收

**Files:** 无代码改动（本任务只验证，不改文件）。

- [ ] **Step 1: 启动开发服务器**

```bash
cd pcr-ai-report
npm run dev
```

- [ ] **Step 2: 浅色模式走查（默认应该就是浅色，因为还没手动切换过）**

逐个打开并检查有没有残留黑底卡片 / 低对比度文字 / 图表看不清坐标轴：
1. Yield Monitor：查询区展开/折叠、KPI 条、每日趋势折线图、ProbeCard Type / DUT 排名图 + 下钻面板、可拖拽布局拖动一次。
2. JB Star：查询区、漏斗下钻（Mask→Device→Lot→ProbeCardType→CardId 每一步点一下）、LOT Yield% 排名图、ProbeCard Type / Device 排名图、INF DUT 分布堆叠图、低良率 DUT 表格 + 散点图（如果有测试数据触发得到的话）。
3. AI Agent：发一条消息、展开工具详情 chip、看 `正在思考…` 状态提示、错误重试按钮（可临时清空 API Key 触发）、生成一张图表并下载 PNG、点 👍/👎 弹出反馈弹窗。
4. 表浏览：任意选一张表查询。
5. 设置页（URL 加 `?settings=true`）：密码锁弹窗（密码 `!QA2ws3e9`）、API 面板、Agent 配置区所有输入框、API 目录列表。

- [ ] **Step 3: 深色模式走查**

点顶栏 🌙 按钮切到深色，重复 Step 2 的全部清单，确认与切换前（原有深色 UI）视觉一致，没有因为本次改动引入回归（尤其关注：图表坐标轴文字颜色、tooltip 背景、KPI 卡片发光色、漏斗步骤条颜色）。

- [ ] **Step 4: 切换持久化**

刷新页面确认主题记忆生效；清空 `localStorage` 里的 `pcr-ai-report.theme.v1` 后刷新，确认回到默认浅色。

- [ ] **Step 5: 生产构建走一遍**

```bash
npm run build
npm run preview
```

用 `npm run preview` 起的生产构建再快速过一遍 Step 2 的清单（至少 Yield Monitor + AI Agent 两个 tab），确认生产构建下 CSS 变量/主题切换行为与 dev 一致。

- [ ] **Step 6: 记录结果**

如果发现视觉问题，回到对应任务的文件里修（不新开任务，直接修正对应 Task 的产物），修完重新跑一遍本任务的相关子项。全部通过后，本任务不需要 commit（没有代码改动）。

---

## Self-Review 记录

- **Spec 覆盖**：默认浅色 + localStorage 记忆（Task 1）、顶栏按钮（Task 1）、全站覆盖（Task 3-11 覆盖 index.css / DataTable / QueryInspector / FeedbackModal / AiAgentReport.css / KpiCard / LotUnderperformingDutsPanel / yieldCalc / YieldMonitorReport / InfcontrolReport / DrillDownPanel / InfDutDistPanel / AiAgentReport.tsx 的图表导出）、ECharts 图表配色（Task 2 + 8/9/10）、验收（Task 12）——spec 六个章节均有对应任务。
- **占位符扫描**：所有替换均给出具体 old/new 字符串或完整文件内容，未发现「TBD / 视情况处理」类占位表述。
- **类型一致性**：`ChartTheme`、`getChartPalette`、`getStatusTierColors`、`selectionTierColors`、`SelectionHue` 的签名在 Task 2 定义后，Task 8/9/10 均按同一签名调用，无改名不一致。`useThemeContext()` 返回的 `{theme, toggleTheme}` 字段名在 Task 1 定义后全程复用。
- **已知的有意简化**（均已在对应任务里注明，非遗漏）：分类色板（`InfDutDistPanel.tsx` 固定 DUT 配色）、漏斗 `--step-color` 的 active 态强调橙色、`.ai-wafermap-link` 品牌蓝色块、头部/徽章装饰性渐变、`RobotAvatar` SVG——这几处刻意保持两个主题下颜色一致，因为它们要么是自带背景的实心色块，要么是装饰性品牌元素，不属于「必须跟随主题」的界面语义色。

---

Plan complete and saved to `docs/superpowers/plans/2026-07-03-light-mode-theme-toggle.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
