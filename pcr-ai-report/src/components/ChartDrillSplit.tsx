import type { ReactNode } from "react";

type Props = {
  hint?: ReactNode;
  chart: ReactNode;
  drill?: ReactNode | null;
};

/** Main chart on the left; drill-down panel on the right when open. */
export function ChartDrillSplit({ hint, chart, drill }: Props) {
  const open = drill != null;
  return (
    <div className="chart-drill-block">
      {hint ? <div className="chart-drill-hint">{hint}</div> : null}
      <div className={`chart-drill-row${open ? "" : " chart-drill-row--solo"}`}>
        <div className="chart-drill-main">{chart}</div>
        {open ? <div className="chart-drill-side">{drill}</div> : null}
      </div>
    </div>
  );
}
