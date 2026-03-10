import type { ApprovalDecision } from "../lib/api";

interface ApprovalCardProps {
  approvalId: string;
  action: string;
  detail: unknown;
  onRespond: (approvalId: string, decision: ApprovalDecision) => void;
  responded?: boolean;
  agentType?: "codex" | "opencode";
}

export function ApprovalCard({ approvalId, action, detail, onRespond, responded, agentType }: ApprovalCardProps) {
  const detailObj = typeof detail === "object" && detail !== null ? detail as Record<string, unknown> : null;
  const patterns = detailObj?.patterns as string[] | undefined;
  const metadata = detailObj?.metadata as Record<string, unknown> | undefined;
  // Fall back to full JSON dump if detail doesn't have structured fields
  const fallbackStr = !detailObj?.permission && detail ? (typeof detail === "string" ? detail : JSON.stringify(detail, null, 2)) : null;

  return (
    <div className="mb-3 mx-2 border border-neutral-300 bg-surface p-4">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs font-semibold">Approval Required</span>
      </div>
      <p className="text-sm mb-2">{action}</p>
      {patterns && patterns.length > 0 && (
        <div className="text-xs text-neutral-600 bg-background border border-neutral-200 px-3 py-2 mb-3 overflow-x-auto max-h-32">
          {patterns.map((p, i) => (
            <div key={i} className="font-mono">{p}</div>
          ))}
        </div>
      )}
      {metadata && Object.keys(metadata).length > 0 && (
        <pre className="text-xs text-neutral-600 bg-background border border-neutral-200 px-3 py-2 mb-3 overflow-x-auto max-h-24 whitespace-pre-wrap">
          {JSON.stringify(metadata, null, 2)}
        </pre>
      )}
      {fallbackStr && fallbackStr !== "{}" && (
        <pre className="text-xs text-neutral-600 bg-background border border-neutral-200 px-3 py-2 mb-3 overflow-x-auto max-h-32 whitespace-pre-wrap">
          {fallbackStr}
        </pre>
      )}
      {responded ? (
        <span className="text-xs text-neutral-500">Responded</span>
      ) : (
        <div className="flex gap-3">
          <button
            onClick={() => onRespond(approvalId, "accept")}
            className="text-xs underline underline-offset-4 transition-opacity hover:opacity-60 cursor-pointer"
          >
            Accept
          </button>
          {agentType === "codex" && (
            <button
              onClick={() => onRespond(approvalId, "acceptForSession")}
              className="text-xs underline underline-offset-4 transition-opacity hover:opacity-60 cursor-pointer"
            >
              Accept for Session
            </button>
          )}
          {agentType === "opencode" && (
            <button
              onClick={() => onRespond(approvalId, "always")}
              className="text-xs underline underline-offset-4 transition-opacity hover:opacity-60 cursor-pointer"
            >
              Always Allow
            </button>
          )}
          <button
            onClick={() => onRespond(approvalId, "decline")}
            className="text-xs underline underline-offset-4 opacity-60 transition-opacity hover:opacity-80 cursor-pointer"
          >
            Decline
          </button>
        </div>
      )}
    </div>
  );
}
