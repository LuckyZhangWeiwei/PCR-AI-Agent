// pcr-ai-api/src/lib/agent/agentChartTool.ts

export interface ChartData {
  labels: string[];
  series: { name: string; values: number[] }[];
}

export interface ChartSentinel {
  __chartOption: object;
}

export interface ClarificationSentinel {
  __clarification: string;
}

export function buildChartOption(
  chartType: "bar" | "line" | "pie" | "scatter",
  title: string,
  data: ChartData
): object {
  if (chartType === "pie") {
    const pieData = data.labels.map((label, i) => ({
      name: label,
      value: data.series[0]?.values[i] ?? 0,
    }));
    return {
      title: { text: title, left: "center" },
      tooltip: { trigger: "item" },
      legend: { orient: "vertical", left: "left" },
      series: [{ type: "pie", radius: "50%", data: pieData }],
    };
  }

  const xAxis =
    chartType === "scatter"
      ? undefined
      : { type: "category", data: data.labels, axisLabel: { rotate: 30 } };

  const series = data.series.map((s) => {
    if (chartType === "scatter") {
      return {
        name: s.name,
        type: "scatter",
        data: data.labels.map((label, i) => [label, s.values[i] ?? 0]),
      };
    }
    return { name: s.name, type: chartType, data: s.values };
  });

  return {
    title: { text: title },
    tooltip: { trigger: "axis" },
    legend: { data: data.series.map((s) => s.name) },
    xAxis,
    yAxis: { type: "value" },
    series,
  };
}
