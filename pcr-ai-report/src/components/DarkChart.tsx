import ReactECharts from "echarts-for-react";
import type { EChartsOption } from "echarts";

type Props = {
  option: EChartsOption;
  height?: number | string;
  className?: string;
};

export function DarkChart({ option, height = 360, className }: Props) {
  return (
    <ReactECharts
      className={className}
      option={option}
      style={{ height, width: "100%" }}
      opts={{ renderer: "canvas" }}
      notMerge
      lazyUpdate
    />
  );
}
