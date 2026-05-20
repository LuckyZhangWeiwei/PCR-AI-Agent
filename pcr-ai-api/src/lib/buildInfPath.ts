export function buildInfPath(device: string, lot: string, slot: number): string {
  const root = (process.env.INF_STORAGE_ROOT ?? "/data/INF").replace(/\/$/, "");
  return `${root}/${device.toUpperCase()}/${lot.toUpperCase()}/r_1-${slot}`;
}
