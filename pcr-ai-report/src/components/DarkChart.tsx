import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";

type Props = {
  option: EChartsOption;
  height?: number | string;
  className?: string;
  onEvents?: Record<string, (params: unknown) => void>;
};

export function DarkChart({ option, height = 360, className, onEvents }: Props) {
  return (
    <ReactECharts
      className={className}
      option={option}
      style={{ height, width: "100%" }}
      opts={{ renderer: "canvas" }}
      notMerge
      lazyUpdate
      onEvents={onEvents}
    />
  );
}
