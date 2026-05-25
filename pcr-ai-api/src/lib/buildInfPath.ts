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
