import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { AggregateGroup } from "../api/types";

export type DrillCacheEntry = {
  val: string;
  tabs: Record<string, AggregateGroup[]>;
};

export type DrillCacheRef = MutableRefObject<Record<string, DrillCacheEntry>>;

/** Sum counts from a pre-fetched multi-dimension aggregate tree. */
export function drillFromTree(
  treeGroups: AggregateGroup[],
  filterKey: string,
  filterVal: string,
  subDimKeys: string[]
): AggregateGroup[] {
  const sums = new Map<string, number>();
  const partsMap = new Map<string, Record<string, string>>();
  for (const g of treeGroups) {
    if (g.parts[filterKey] !== filterVal) continue;
    const subParts: Record<string, string> = {};
    let valid = true;
    for (const k of subDimKeys) {
      const v = g.parts[k];
      if (v === undefined) {
        valid = false;
        break;
      }
      subParts[k] = v;
    }
    if (!valid) continue;
    const key = subDimKeys.map((k) => subParts[k]).join("\x00");
    sums.set(key, (sums.get(key) ?? 0) + g.count);
    if (!partsMap.has(key)) partsMap.set(key, subParts);
  }
  return [...sums.entries()]
    .map(([key, count]) => ({ key, count, parts: partsMap.get(key)! }))
    .sort((a, b) => b.count - a.count);
}

export function storeDrillTab<T extends {
  parentDimKey: string;
  parentDimVal: string;
  subDim: string;
  groups: AggregateGroup[];
  loading: boolean;
  error: string | null;
}>(
  parentDimKey: string,
  parentDimVal: string,
  subDim: string,
  groups: AggregateGroup[],
  drillCacheRef: DrillCacheRef,
  setDrills: Dispatch<SetStateAction<Record<string, T>>>
): void {
  if (
    !drillCacheRef.current[parentDimKey] ||
    drillCacheRef.current[parentDimKey].val !== parentDimVal
  ) {
    drillCacheRef.current[parentDimKey] = { val: parentDimVal, tabs: {} };
  }
  drillCacheRef.current[parentDimKey].tabs[subDim] = groups;
  setDrills((prev) => ({
    ...prev,
    [parentDimKey]: {
      parentDimKey,
      parentDimVal,
      subDim,
      groups,
      loading: false,
      error: null,
    } as T,
  }));
}
