type Props = { apiBase: string };

export function AiAgentReport(_props: Props) {
  return (
    <div className="report-panel">
      <div className="report-panel-header">
        <div>
          <h2>🤖 AI 助手</h2>
          <p className="report-desc">
            下一阶段接入 Node.js Agent + 硅基流动 Function Call，通过自然语言查询
            yield monitor 和 JB START 数据。
          </p>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 16,
          marginTop: 8,
        }}
      >
        {/* Chat input placeholder */}
        <div
          style={{
            border: "1px dashed rgba(163,113,247,0.35)",
            borderRadius: 8,
            padding: 20,
            minHeight: 200,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div style={{ fontSize: 12, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            对话框（预留）
          </div>
          <div
            style={{
              flex: 1,
              background: "rgba(163,113,247,0.05)",
              borderRadius: 6,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#6e40c9",
              fontSize: 13,
            }}
          >
            自然语言输入区
          </div>
        </div>

        {/* Result placeholder */}
        <div
          style={{
            border: "1px dashed rgba(163,113,247,0.35)",
            borderRadius: 8,
            padding: 20,
            minHeight: 200,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div style={{ fontSize: 12, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            结构化结果（预留）
          </div>
          <div
            style={{
              flex: 1,
              background: "rgba(163,113,247,0.05)",
              borderRadius: 6,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#6e40c9",
              fontSize: 13,
            }}
          >
            工具调用状态 / 图表 / 表格
          </div>
        </div>
      </div>
    </div>
  );
}
