export function getInfStorageRoot(): string {
  return (process.env.INF_STORAGE_ROOT ?? "/data/INF").replace(/\/$/, "");
}

export function buildInfDeviceDir(device: string): string {
  const root = getInfStorageRoot();
  return `${root}/${device.toUpperCase()}`;
}

export function buildInfLotDir(device: string, lot: string): string {
  return `${buildInfDeviceDir(device)}/${lot.toUpperCase()}`;
}

export function buildInfPath(device: string, lot: string, slot: number): string {
  return `${buildInfLotDir(device, lot)}/r_1-${slot}`;
}

/** Parse wafer slot from INF path suffix `.../r_1-{slot}`. */
export function parseInfWaferSlotFromPath(infPath: string): number | null {
  const coords = parseInfWaferCoordsFromPath(infPath);
  return coords?.slot ?? null;
}

/** Parse `{root}/{DEVICE}/{LOT}/r_1-{slot}` — device/lot casing preserved from path. */
export function parseInfWaferCoordsFromPath(
  infPath: string
): { device: string; lot: string; slot: number } | null {
  const normalized = infPath.replace(/\\/g, "/").trim();
  const m = /\/([^/]+)\/([^/]+)\/r_1-(\d+)\s*$/i.exec(normalized);
  if (!m) return null;
  const slot = parseInt(m[3]!, 10);
  if (!Number.isFinite(slot) || slot < 1) return null;
  const device = m[1]!.trim();
  const lot = m[2]!.trim();
  if (!device || !lot) return null;
  return { device, lot, slot };
}
