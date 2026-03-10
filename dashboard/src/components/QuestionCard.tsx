import { useState } from "react";

interface QuestionOption {
  label: string;
  description: string;
}

interface QuestionInfo {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

interface QuestionCardProps {
  questionId: string;
  questions: QuestionInfo[];
  onAnswer: (questionId: string, answers: string[][]) => void;
  onReject: (questionId: string) => void;
  responded?: boolean;
}

export function QuestionCard({ questionId, questions, onAnswer, onReject, responded }: QuestionCardProps) {
  // Track selected options per question (index → set of selected labels)
  const [selections, setSelections] = useState<Map<number, Set<string>>>(new Map());
  const [customInputs, setCustomInputs] = useState<Map<number, string>>(new Map());

  const toggleOption = (qIdx: number, label: string, multiple: boolean) => {
    setSelections((prev) => {
      const next = new Map(prev);
      const current = new Set(next.get(qIdx) || []);
      if (current.has(label)) {
        current.delete(label);
      } else {
        if (!multiple) current.clear();
        current.add(label);
      }
      next.set(qIdx, current);
      return next;
    });
  };

  const handleSubmit = () => {
    const answers: string[][] = questions.map((q, i) => {
      const selected = Array.from(selections.get(i) || []);
      const custom = customInputs.get(i)?.trim();
      if (custom) selected.push(custom);
      return selected;
    });
    onAnswer(questionId, answers);
  };

  const hasAnySelection = questions.some((_, i) => {
    const sel = selections.get(i);
    const custom = customInputs.get(i)?.trim();
    return (sel && sel.size > 0) || !!custom;
  });

  if (responded) {
    return (
      <div className="mb-3 mx-2 border border-neutral-200 bg-surface p-4">
        <span className="text-xs text-neutral-500">Question answered</span>
      </div>
    );
  }

  return (
    <div className="mb-3 mx-2 border border-neutral-300 bg-surface p-4">
      {questions.map((q, qIdx) => (
        <div key={qIdx} className={qIdx > 0 ? "mt-4 pt-4 border-t border-neutral-200" : ""}>
          {q.header && (
            <span className="text-[10px] text-neutral-400 uppercase tracking-wider">{q.header}</span>
          )}
          <p className="text-sm mt-1 mb-3">{q.question}</p>
          <div className="flex flex-col gap-1.5">
            {q.options.map((opt) => {
              const isSelected = selections.get(qIdx)?.has(opt.label) || false;
              return (
                <button
                  key={opt.label}
                  onClick={() => toggleOption(qIdx, opt.label, !!q.multiple)}
                  className={`text-left px-3 py-2 border text-xs cursor-pointer transition-colors ${
                    isSelected
                      ? "border-foreground bg-background font-semibold"
                      : "border-neutral-200 hover:border-neutral-400"
                  }`}
                >
                  <span>{opt.label}</span>
                  {opt.description && (
                    <span className="text-neutral-500 ml-2">{opt.description}</span>
                  )}
                </button>
              );
            })}
          </div>
          {(q.custom !== false) && (
            <input
              type="text"
              value={customInputs.get(qIdx) || ""}
              onChange={(e) => setCustomInputs((prev) => new Map(prev).set(qIdx, e.target.value))}
              placeholder="Or type a custom answer..."
              className="mt-2 w-full border-0 border-b border-neutral-300 bg-transparent px-0 py-1 text-xs text-foreground placeholder:text-neutral-400 focus:border-foreground focus:outline-none"
            />
          )}
        </div>
      ))}
      <div className="flex gap-3 mt-4">
        <button
          onClick={handleSubmit}
          disabled={!hasAnySelection}
          className="text-xs underline underline-offset-4 transition-opacity hover:opacity-60 disabled:opacity-30 cursor-pointer"
        >
          Submit
        </button>
        <button
          onClick={() => onReject(questionId)}
          className="text-xs underline underline-offset-4 opacity-60 transition-opacity hover:opacity-80 cursor-pointer"
        >
          Skip
        </button>
      </div>
    </div>
  );
}
