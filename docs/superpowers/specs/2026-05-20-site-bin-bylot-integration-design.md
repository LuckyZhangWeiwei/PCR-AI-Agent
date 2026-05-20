# Site-Bin-ByLot Integration Design

**Date:** 2026-05-20  
**Scope:** Implement the full checklist from `docs/SITE_BIN_BY_LOT_INTEGRATION.md`  
**Branch:** `feature/site-bin-bylot-integration`

---

## Context

The REST API `GET /api/v1/inf-analysis/site-bin-bylot` is already implemented and tested.  
This spec covers the remaining P0–P2 items: `buildInfPath` utility, Agent tool, updated prompt, and the `InfDutDistPanel` report component.  
P3 (API accepting `device+lot+slot` params directly) is out of scope for this branch.

### Confirmed infPath rule

```
/data/INF/{DEVICE_UPPER}/{LOT_UPPER}/r_1-{SLOT}
```

- Root overridable via `INF_STORAGE_ROOT` env var (default `/data/INF`).
- Device and Lot are uppercased; slot is the integer wafer slot number.
- Example: device=`WA03P02G`, lot=`NF12551.1N`, slot=3 → `/data/INF/WA03P02G/NF12551.1N/r_1-3`

---

## Backend (pcr-ai-api)

### 1. `src/lib/buildInfPath.ts` (new)

Single exported function shared by the Agent handler and available for tests:

```ts
export function buildInfPath(device: string, lot: string, slot: number): string {
  const root = (process.env.INF_STORAGE_ROOT ?? "/data/INF").replace(/\/$/, "");
  return `${root}/${device.toUpperCase()}/${lot.toUpperCase()}/r_1-${slot}`;
}
```

Add `INF_STORAGE_ROOT` entry to `.env.example`.

### 2. Agent tool schema (`agentToolSchemas.ts`)

Add `query_inf_site_bin_by_dut` entry per the schema in `SITE_BIN_BY_LOT_INTEGRATION.md` Appendix B, with one addition: optional `cardId` string parameter (carried from `query_jb_bins` result, included in response context for richer conclusions).

```json
{
  "name": "query_inf_site_bin_by_dut",
  "parameters": {
    "required": ["device", "lot", "slot"],
    "properties": {
      "device":   { "type": "string" },
      "lot":      { "type": "string" },
      "slot":     { "type": "number" },
      "passId":   { "type": "number" },
      "passIds":  { "type": "array", "items": { "type": "number" } },
      "focusBin": { "type": "number" },
      "cardId":   { "type": "string", "description": "探针卡 ID（来自 query_jb_bins CARDID），用于结论描述" }
    }
  }
}
```

### 3. Agent tool handler (`agentToolHandlers.ts`)

New `toolQueryInfSiteBinByDut(args)`:

1. Validate `device` (string), `lot` (string), `slot` (integer) — return error string if missing.
2. Merge `passId` and `passIds` into a unified `number[]`; default to `[1]` if neither provided.
3. Build `infPath = buildInfPath(device, lot, slot)`.
4. Call `runOutputSiteBinByLot(infPath, passIds)`.
5. If `exitCode !== 0`, return structured error: `{ error: "INF/Perl failed", stderr: ..., hint: "Check INF_STORAGE_ROOT and that the path exists on the API host" }`.
6. Call `parseSiteBinByLotJson(stdout)`.
7. Return JSON string:
   ```json
   {
     "cardId": "<from args, if provided>",
     "device": "...", "lot": "...", "slot": 3,
     "infPath": "...",
     "passes": [ ... ]
   }
   ```
   Fields `bin`/`dieCount`/`dut` must not be swapped (enforced by `parseSiteBinByLotJson`).

Add `case "query_inf_site_bin_by_dut": return toolQueryInfSiteBinByDut(args);` to `runTool`.

### 4. Agent prompt (`agentPrompt.ts`)

In `buildSystemPrompt`:

1. Append the `### INF Wafer Map · DUT 分布` section from `SITE_BIN_BY_LOT_INTEGRATION.md` Appendix A verbatim.
2. Extend the tool list line to include `query_inf_site_bin_by_dut`.
3. Add the two-DUT disambiguation table (Appendix A, "两种 DUT 必须区分").
4. Add explicit call-chain instruction: _"先 query_jb_bins 拿到 CARDID，将 cardId 传入 query_inf_site_bin_by_dut，在结论中写明卡号 + DUT 编号 + bin编号 + 颗数。"_

### 5. Tests (`test/agentInfSiteBin.test.ts`)

- Mock `runOutputSiteBinByLot` to return the fixture JSON from `docs/site-bin-bylot-dummy-r_1-1.passes.json`.
- Test `toolQueryInfSiteBinByDut` with valid args → returns JSON containing `passes[0].bins[0].bin` and correct `dieCount`.
- Test with missing `device` → returns error string.
- Test `buildInfPath` → correct uppercasing and slot suffix.

---

## Frontend (pcr-ai-report)

### 6. `src/utils/buildInfPath.ts` (new)

```ts
export function buildInfPath(device: string, lot: string, slot: number): string {
  const root = (import.meta.env.VITE_INF_STORAGE_ROOT ?? "/data/INF").replace(/\/$/, "");
  return `${root}/${device.toUpperCase()}/${lot.toUpperCase()}/r_1-${slot}`;
}
```

`.env.example` / `.env.development` note: `VITE_INF_STORAGE_ROOT` optional, default `/data/INF`.

### 7. `src/api/paths.ts`

```ts
export const SITE_BIN_BY_LOT_PATH = "/api/v1/inf-analysis/site-bin-bylot";
```

(Uses v1 path, which is also mounted at v3/v4 — keeps the path stable regardless of API_PREFIX changes.)

### 8. `src/api/types.ts`

```ts
export type SiteBinDutEntry = { dut: number | "single"; dieCount: number };
export type SiteBinEntry    = { bin: string; duts: SiteBinDutEntry[] };
export type SiteBinPass     = { passId: number; bins: SiteBinEntry[] };
export type SiteBinByLotResponse = {
  meta: { apiVersion: string; requestId: string; summary: string };
  infPath: string;
  passIds: number[];
  passes: SiteBinPass[];
};
```

### 9. `src/components/InfDutDistPanel.tsx` (new)

**Props:**

```ts
type Props = {
  device: string;
  lot: string;
  slot: number;
  passIds: number[];
  cardId?: string;
  focusBin?: string;
  apiBase: string;
  onClose: () => void;
};
```

**Behavior:**

- On mount / when `device+lot+slot+passIds` change: call `apiGetJson<SiteBinByLotResponse>(apiBase, SITE_BIN_BY_LOT_PATH, { infPath: buildInfPath(device, lot, slot), passId: passIds })`.
- Loading: show 160px-height placeholder (consistent with today's DrillDownPanel fix).
- Error / file-not-found: show `"INF 文件不存在或无法读取，路径: {infPath}"` with the resolved path for ops debugging.
- Success: for each `pass` in `response.passes`, render one ECharts stacked bar:
  - X axis: BIN labels (e.g. `bin37`)
  - Series: one per unique DUT (e.g. `DUT 5`, `DUT 3`, `single`)
  - Y axis: dieCount
  - `focusBin` matching x-label: highlight that bar group with brighter `itemStyle.color`
- Title: `INF · DUT 分布 — LOT {lot} · Slot {slot}${cardId ? " · 卡 " + cardId : ""}`
- Close button (`✕`) calls `onClose`.

### 10. `InfcontrolReport.tsx` — state and trigger points

Add state:

```ts
type InfCtx = {
  device: string; lot: string; slot: number;
  passIds: number[];
  cardId?: string;
  focusBin?: string;
} | null;
const [infCtx, setInfCtx] = useState<InfCtx>(null);
```

**Trigger 1 — DrillDownPanel drill to slot level:**  
When `drillState.parentDimKey === "slot"` or a bar click provides a slot value, extract `device` and `lot` from `formRef`/current form state, `slot` from the clicked group value, `cardId` from form `cardId` field (if set). Call `setInfCtx({ device, lot, slot, passIds: [1,3,5], cardId })` (default all sort passes). Clear `infCtx` when drill closes.

**Trigger 2 — Detail table row click:**  
Each row in the detail `DataTable` gets `onClick`. Extract `DEVICE`, `LOT`, `SLOT`, `PASSID`, `CARDID` from the row object. Call `setInfCtx({ device: row.DEVICE, lot: row.LOT, slot: Number(row.SLOT), passIds: [Number(row.PASSID)], cardId: row.CARDID })`.

**Render:**  
After the `DrillDownPanel` (and after the detail table), render:

```tsx
{infCtx && (
  <InfDutDistPanel
    {...infCtx}
    apiBase={apiBase}
    onClose={() => setInfCtx(null)}
  />
)}
```

---

## Out of scope (this branch)

- **P3**: API accepting `device+lot+slot` query params (avoids path rule duplication) — separate PR.
- Any changes to `TableRowsReport` or `YieldMonitorReport`.
- UI changes to DrillDownPanel internals.

---

## Acceptance checklist

- [ ] `buildInfPath("WA03P02G", "NF12551.1N", 3)` → `/data/INF/WA03P02G/NF12551.1N/r_1-3`
- [ ] Agent tool `query_inf_site_bin_by_dut` returns correct bin/dieCount/dut (not swapped)
- [ ] Agent prompt contains INF section and updated tool list
- [ ] `npm test` (pcr-ai-api) passes including new `agentInfSiteBin.test.ts`
- [ ] `npm run typecheck` (pcr-ai-api) passes
- [ ] `InfDutDistPanel` renders stacked bar; loading placeholder visible during fetch
- [ ] Drill to slot in JB Star report → INF panel appears below DrillDownPanel
- [ ] Click detail row with DEVICE+LOT+SLOT+PASSID → INF panel appears
- [ ] Close button dismisses the panel
- [ ] `npm run build` (pcr-ai-report) passes
