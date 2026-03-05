interface ApprovalCardProps {
  approvalId: string;
  action: string;
  detail: unknown;
  onRespond: (approvalId: string, decision: "accept" | "always" | "decline") => void;
  responded?: boolean;
  agentType?: "codex" | "opencode";
}

export function ApprovalCard({ approvalId, action, detail, onRespond, responded, agentType }: ApprovalCardProps) {
  const detailStr = typeof detail === "string" ? detail : JSON.stringify(detail, null, 2);

  return (
    <div className="mb-3 mx-2 border border-neutral-300 bg-white p-4">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs font-semibold">Approval Required</span>
      </div>
      <p className="text-sm mb-2">{action}</p>
      {detailStr && detailStr !== "{}" && (
        <pre className="text-xs text-neutral-600 bg-[#f8f4ee] border border-neutral-200 px-3 py-2 mb-3 overflow-x-auto max-h-32 whitespace-pre-wrap">
          {detailStr}
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
