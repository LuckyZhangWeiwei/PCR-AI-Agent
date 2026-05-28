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
  const normalized = infPath.replace(/\\/g, "/").trim();
  const m = /\/r_1-(\d+)\s*$/i.exec(normalized);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
