# Cursor 修复交接（2026-07-06 · 给 Claude Code）

> **执行者：** Cursor Agent  
> **读者：** Claude Code / 接手 INF 晶圆图 HTML 的 Agent  
> **前置阅读：** [`HANDOFF_INF_WAFER_MAP_AND_AGENT_TABLE_UX.md`](HANDOFF_INF_WAFER_MAP_AND_AGENT_TABLE_UX.md) §1 / §2  
> **分支：** `feat/jb-route-resolver`  
> **范围：** Agent 晶圆图 notch（三角）位置错误 — INF `dNotchAngle` 与 SVG 角度基准不一致

---

## 0. 一眼结论

| 项 | 状态 | 说明 |
|---|---|---|
| **现象** | ✅ 已修 | `WA10P97C / NF13305.1N / Slot 7` 等 wafermap：notch 三角画在**左侧**，实际应在**底部** |
| **根因** | ✅ 已定位 | INF `MdBlank.dNotchAngle` 与 SVG `appendNotch` 使用**不同 0° 基准**；此前 2026-07-05 恢复 notch 时误把 INF 角度当 SVG 角度直传 |
| **改法** | ✅ 已合入 | `infNotchAngleToSvg()` 在 `readDieGeometry` 内转换；`appendNotch` 本身无需改 |
| **部署后复验** | ⏭ 待做 | `npm run build && pm2 reload` 后 Agent 重画同片 wafermap，三角应在圆底部（6 点钟） |

---

## 1. 问题复现

用户通过 Agent `inf_draw_wafer_map` 绘制：

- Device: `WA10P97C`
- Lot: `NF13305.1N`
- Slot: `7`

晶圆 die 网格方向正确，但 **notch 小三角出现在圆左侧（9 点钟）**，与现场/INF 语义（notch 在底部）不符。

Dummy 样本 `pcr-ai-api/docs/inf-dummy-r_1-1` 中各 `MdBlank` 均为 `dNotchAngle:180.0`，修复前同样画在左侧。

---

## 2. 根因：两套角度约定

| 来源 | 0° 方向 | 90° | 180° | 270° | 旋转方向 |
|---|---|---|---|---|---|
| **INF `dNotchAngle`** | 上（12 点） | 右 | **下（6 点）** | 左 | 顺时针 |
| **SVG `appendNotch`** | 右（3 点） | **下（6 点）** | 左 | 上 | 顺时针（y 向下） |

2026-07-05 提交 `5983828` 恢复 `appendNotch` 时，注释写「0=右/90=下/180=左/270=上，与 die 网格同坐标系」，但 **`readDieGeometry` 直接把 INF 数值传给 HTML**，未做基准转换。

因此 INF `180`（语义=底部）被当成 SVG `180°`（数学上=左侧）。

---

## 3. 修复

### 3.1 转换公式

**文件：** `pcr-ai-api/src/lib/infWaferMap.ts`

```typescript
export function infNotchAngleToSvg(infAngle: number): number {
  return ((infAngle - 90) % 360 + 360) % 360;
}
```

| INF `dNotchAngle` | 语义 | 转换后 SVG° | 屏幕位置 |
|---|---|---|---|
| 180 | 下 | 90 | 底部 ✓ |
| 270 | 左 | 180 | 左侧 |
| 90 | 右 | 0 | 右侧 |
| 0 | 上 | 270 | 顶部 |

`readDieGeometry()` 读取 `MdMapResult → MdBlank → dNotchAngle`（缺省仍 **270**），经 `infNotchAngleToSvg` 后写入 `WaferResult.notchAngle`，供：

- `infWaferMapHtml.generateWaferMapHtml`
- `generateLotHeatmapHtml`
- `generateDutBinMapHtml`

**`appendNotch`（`infWaferMapHtml.ts`）逻辑不变** — 仍按 SVG 约定用 `cos/sin` 画三角。

### 3.2 数据流（不变部分）

```
INF 文件
  → parseInf → readDieGeometry (+ infNotchAngleToSvg)
  → runDrawWaferMap / runDrawDutBinMap / lot heatmap
  → generate*Html(..., notchAngle)
  → appendNotch(cx, cy, r, notchAngle)
  → /wafermaps/*.html
```

---

## 4. 测试

**文件：** `pcr-ai-api/test/infWaferMapPassSpecs.test.ts`

| 用例 | 断言 |
|---|---|
| `infNotchAngleToSvg maps INF dNotchAngle to SVG canvas degrees` | 180→90、270→180、90→0、0→270 |
| `readDieGeometry converts dummy INF dNotchAngle 180 to SVG bottom (90)` | fixture `inf-dummy-r_1-1` |

```bash
cd pcr-ai-api
npm test -- test/infWaferMapPassSpecs.test.ts
```

---

## 5. 部署与人工复验

```bash
cd pcr-ai-api
npm run build
npm run pm2:reload   # 或目标环境等价 reload
```

Agent 或 REST 工具重画：

```
inf_draw_wafer_map(device=WA10P97C, lot=NF13305.1N, slot=7)
```

打开返回的 `/wafermaps/…html`：**灰色 notch 三角应在圆底部**，与 die 阵列朝向一致。

---

## 6. 勿改 / 常见误区

1. **不要在 `appendNotch` 里再减 90°** — 转换只在 `readDieGeometry` 一处，避免 double-offset。
2. **不要改 die 坐标映射** — 本次仅 notch 角度；die 网格与 `NlCoordSys`（`yPol:-1`）原本正确。
3. **Dummy-parity** — 纯 Node 几何转换，无 Oracle/Dummy 双路径；无需改 `*Dummy.ts`。
4. **旧文档行** — `HANDOFF_INF_WAFER_MAP_AND_AGENT_TABLE_UX.md` §1 表格中 notch 一行已更正为「INF→SVG 转换」描述。

---

## 7. 变更文件清单

| 文件 | 变更 |
|---|---|
| `pcr-ai-api/src/lib/infWaferMap.ts` | 新增 `infNotchAngleToSvg`；`readDieGeometry` 应用转换 |
| `pcr-ai-api/test/infWaferMapPassSpecs.test.ts` | 角度映射 + fixture 回归 |
| `docs/HANDOFF_INF_WAFER_MAP_AND_AGENT_TABLE_UX.md` | §1 notch 行更正 |
| `docs/HANDOFF_CURSOR_FIX_WAFERMAP_NOTCH_ANGLE_2026-07-06.md` | 本文 |
