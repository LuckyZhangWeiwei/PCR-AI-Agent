import { useState } from "react";
import type { TreeNode } from "../utils/yieldCalc";

type TreeTableProps = {
  roots: TreeNode[];
  /** Human-readable label for the "Total" column header */
  totalHeader?: string;
  /** Optional: render extra content next to a node's total */
  renderExtra?: (node: TreeNode, depth: number) => React.ReactNode;
};

const INDENT_PX = 16;
const DEPTH_COLORS = ["var(--dim-card)", "var(--dim-device)", "var(--dim-lot)", "var(--dim-slot)"];

function depthColor(depth: number): string {
  return DEPTH_COLORS[depth % DEPTH_COLORS.length];
}

function NodeRow({
  node,
  depth,
  totalHeader,
  renderExtra,
}: {
  node: TreeNode;
  depth: number;
  totalHeader?: string;
  renderExtra?: (node: TreeNode, depth: number) => React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasChildren = node.children.length > 0;
  const color = depthColor(depth);

  return (
    <>
      <tr
        style={{ cursor: hasChildren ? "pointer" : "default" }}
        onClick={() => hasChildren && setExpanded((e) => !e)}
      >
        <td
          style={{
            paddingLeft: 8 + depth * INDENT_PX,
            paddingTop: 5,
            paddingBottom: 5,
            color,
            fontWeight: depth === 0 ? 600 : 400,
            fontSize: 13,
            borderBottom: "1px solid rgba(var(--fg-rgb),0.06)",
            whiteSpace: "nowrap",
          }}
        >
          {hasChildren && (
            <span style={{ marginRight: 6, fontSize: 10, opacity: 0.7 }}>
              {expanded ? "▼" : "▶"}
            </span>
          )}
          <span style={{ fontSize: 11, color: "var(--dimmed)", marginRight: 4 }}>
            {node.dimKey}:
          </span>
          {node.dimValue}
        </td>
        <td
          style={{
            textAlign: "right",
            paddingRight: 16,
            paddingTop: 5,
            paddingBottom: 5,
            fontSize: 13,
            color: "var(--text)",
            borderBottom: "1px solid rgba(var(--fg-rgb),0.06)",
          }}
        >
          {node.total.toLocaleString()}
        </td>
        {renderExtra && (
          <td
            style={{
              paddingTop: 5,
              paddingBottom: 5,
              borderBottom: "1px solid rgba(var(--fg-rgb),0.06)",
              fontSize: 12,
            }}
          >
            {renderExtra(node, depth)}
          </td>
        )}
      </tr>
      {expanded &&
        node.children.map((child) => (
          <NodeRow
            key={child.id}
            node={child}
            depth={depth + 1}
            totalHeader={totalHeader}
            renderExtra={renderExtra}
          />
        ))}
    </>
  );
}

export function TreeTable({ roots, totalHeader = "Count", renderExtra }: TreeTableProps) {
  if (roots.length === 0) {
    return (
      <div style={{ color: "var(--muted)", fontSize: 14, padding: "12px 0" }}>
        暂无数据
      </div>
    );
  }
  return (
    <div style={{ overflowX: "auto" }}>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 13,
        }}
      >
        <thead>
          <tr>
            <th
              style={{
                textAlign: "left",
                padding: "6px 8px",
                fontSize: 12,
                color: "var(--muted)",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                borderBottom: "1px solid rgba(var(--fg-rgb),0.12)",
              }}
            >
              维度
            </th>
            <th
              style={{
                textAlign: "right",
                paddingRight: 16,
                padding: "6px 16px 6px 8px",
                fontSize: 12,
                color: "var(--muted)",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                borderBottom: "1px solid rgba(var(--fg-rgb),0.12)",
              }}
            >
              {totalHeader}
            </th>
            {renderExtra && (
              <th
                style={{
                  padding: "6px 8px",
                  fontSize: 12,
                  color: "var(--muted)",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  borderBottom: "1px solid rgba(var(--fg-rgb),0.12)",
                }}
              >
                附加
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {roots.map((node) => (
            <NodeRow
              key={node.id}
              node={node}
              depth={0}
              totalHeader={totalHeader}
              renderExtra={renderExtra}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
