import { useEffect, useState } from "react";
import { api, type ClaudeSession } from "../lib/api";
import { relativeTime } from "../lib/time";

interface ClaudeCodeTabProps {
  vmId: string;
  sshCommand: string;
}

export function ClaudeCodeTab({ vmId, sshCommand }: ClaudeCodeTabProps) {
  const [sessions, setSessions] = useState<ClaudeSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api
      .getClaudeSessions(vmId)
      .then((data) => setSessions(data.sessions))
      .catch(() => setSessions([]))
      .finally(() => setLoading(false));
  }, [vmId]);

  const copyToClipboard = async () => {
    await navigator.clipboard.writeText(sshCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-6">
      {/* SSH Connection */}
      <div className="bg-panel-chat border border-neutral-200 p-5">
        <h3 className="text-sm font-semibold mb-4">Connect via SSH</h3>
        <div className="flex items-center gap-3">
          <code className="flex-1 bg-surface border border-neutral-200 px-4 py-2 text-xs">
            {sshCommand}
          </code>
          <button
            onClick={copyToClipboard}
            className="text-xs underline underline-offset-4 transition-opacity hover:opacity-60 cursor-pointer"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
        <p className="text-xs text-neutral-500 mt-3">
          Or use the <strong>Terminal</strong> tab for a browser-based terminal.
        </p>
      </div>

      {/* Auth Instructions */}
      <div className="bg-panel-chat border border-neutral-200 p-5">
        <h3 className="text-sm font-semibold mb-2">Authentication</h3>
        <p className="text-xs text-neutral-500 mb-3">
          Your GitHub SSH keys are pre-configured.
        </p>
        <p className="text-xs text-neutral-500">
          Set <code className="text-foreground bg-surface border border-neutral-100 px-1.5 py-0.5 text-xs">ANTHROPIC_API_KEY</code> in
          your shell, or run{" "}
          <code className="text-foreground bg-surface border border-neutral-100 px-1.5 py-0.5 text-xs">claude /login</code> to
          authenticate interactively.
        </p>
        <p className="text-xs text-neutral-500 mt-2">
          Run <code className="text-foreground bg-surface border border-neutral-100 px-1.5 py-0.5 text-xs">claude</code> in{" "}
          <code className="text-foreground bg-surface border border-neutral-100 px-1.5 py-0.5 text-xs">~/repo</code> to start.
        </p>
      </div>

      {/* Recent Sessions */}
      <div className="bg-panel-chat border border-neutral-200 p-5">
        <h3 className="text-sm font-semibold mb-4">Recent Sessions</h3>
        {loading ? (
          <p className="text-xs text-neutral-500">Loading sessions...</p>
        ) : sessions.length === 0 ? (
          <p className="text-xs text-neutral-500">
            No sessions yet. Run <code className="text-foreground bg-surface border border-neutral-100 px-1.5 py-0.5 text-xs">claude</code> in the terminal to create one.
          </p>
        ) : (
          <ul className="space-y-0">
            {sessions.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between px-3 py-2 border-b border-neutral-100 last:border-b-0"
              >
                <span className="text-xs truncate">
                  {s.title || `Session ${s.id.slice(0, 8)}`}
                </span>
                <span className="text-[10px] text-neutral-500 ml-4 shrink-0">
                  {s.updatedAt
                    ? relativeTime(s.updatedAt)
                    : s.createdAt
                      ? relativeTime(s.createdAt)
                      : "—"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
