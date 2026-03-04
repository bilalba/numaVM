interface ApprovalCardProps {
  approvalId: string;
  action: string;
  detail: unknown;
  onRespond: (approvalId: string, decision: "accept" | "decline") => void;
  responded?: boolean;
}

export function ApprovalCard({ approvalId, action, detail, onRespond, responded }: ApprovalCardProps) {
  const detailStr = typeof detail === "string" ? detail : JSON.stringify(detail, null, 2);

  return (
    <div className="mb-3 mx-2 bg-yellow-900/20 border border-yellow-700/50 rounded-lg p-4">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-yellow-400 text-sm font-medium">Approval Required</span>
      </div>
      <p className="text-sm text-[#e5e5e5] mb-2">{action}</p>
      {detailStr && detailStr !== "{}" && (
        <pre className="text-xs text-[#999] bg-[#0a0a0a] rounded px-3 py-2 mb-3 overflow-x-auto max-h-32 whitespace-pre-wrap">
          {detailStr}
        </pre>
      )}
      {responded ? (
        <span className="text-xs text-[#666]">Responded</span>
      ) : (
        <div className="flex gap-2">
          <button
            onClick={() => onRespond(approvalId, "accept")}
            className="px-3 py-1.5 bg-green-700 hover:bg-green-600 text-white text-xs font-medium rounded transition-colors cursor-pointer"
          >
            Accept
          </button>
          <button
            onClick={() => onRespond(approvalId, "decline")}
            className="px-3 py-1.5 bg-red-700 hover:bg-red-600 text-white text-xs font-medium rounded transition-colors cursor-pointer"
          >
            Decline
          </button>
        </div>
      )}
    </div>
  );
}
