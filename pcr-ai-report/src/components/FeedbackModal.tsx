import "./FeedbackModal.css";
import { useState } from "react";

const CATEGORIES = [
  "回答不准确",
  "数据有误",
  "回答不完整",
  "其他",
] as const;
type Category = (typeof CATEGORIES)[number];

interface Props {
  apiBase: string;
  sessionId: string;
  question: string;
  answer: string;
  onSubmit: () => void;
  onClose: () => void;
}

export function FeedbackModal({
  apiBase,
  sessionId,
  question,
  answer,
  onSubmit,
  onClose,
}: Props) {
  const [category, setCategory] = useState<Category | "">("");
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async () => {
    if (!category) {
      setError("请选择一个反馈类别");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(`${apiBase}/api/v4/agent/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          question,
          answer: answer.slice(0, 1500),
          kind: "bad",
          category,
          comment: comment.trim() || undefined,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onSubmit();
    } catch {
      setError("提交失败，请重试");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="feedback-modal-overlay" onClick={onClose}>
      <div
        className="feedback-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="feedback-modal-header">
          <span>这条回答哪里不好？</span>
          <button
            type="button"
            className="feedback-modal-close"
            aria-label="关闭反馈"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="feedback-modal-chips">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              type="button"
              className={`feedback-chip${category === cat ? " feedback-chip--active" : ""}`}
              onClick={() => {
                setCategory(cat);
                setError("");
              }}
            >
              {cat}
            </button>
          ))}
        </div>

        <div>
          <label className="feedback-modal-label">详细说明（选填）</label>
          <textarea
            className="feedback-modal-textarea"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            maxLength={1000}
            placeholder="描述具体问题…"
          />
        </div>

        {error && <div className="feedback-modal-error">{error}</div>}

        <div className="feedback-modal-actions">
          <button
            type="button"
            className="feedback-modal-cancel"
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            className="feedback-modal-submit"
            onClick={() => void handleSubmit()}
            disabled={submitting}
          >
            {submitting ? "提交中…" : "提交反馈"}
          </button>
        </div>
      </div>
    </div>
  );
}
