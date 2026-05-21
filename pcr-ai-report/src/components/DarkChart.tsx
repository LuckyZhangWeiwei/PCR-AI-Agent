import { useEffect, useRef } from "react";
import ReactECharts from "echarts-for-react";
import type { ECharts, EChartsOption } from "echarts";

type Props = {
  option: EChartsOption;
  height?: number | string;
  className?: string;
  onEvents?: Record<string, (params: unknown) => void>;
  onChartReady?: (chart: ECharts) => void;
};

export function DarkChart({
  option,
  height = 360,
  className,
  onEvents,
  onChartReady,
}: Props) {
  const chartRef = useRef<ReactECharts>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      chartRef.current?.getEchartsInstance()?.resize();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={wrapRef} style={{ height, width: "100%" }}>
      <ReactECharts
        ref={chartRef}
        className={className}
        option={option}
        style={{ height: "100%", width: "100%" }}
        opts={{ renderer: "canvas" }}
        notMerge
        lazyUpdate
        onEvents={onEvents}
        onChartReady={(inst) => onChartReady?.(inst)}
      />
    </div>
  );
}
