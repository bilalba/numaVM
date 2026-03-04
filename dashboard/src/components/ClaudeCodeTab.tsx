import { useEffect, useState } from "react";
import { api, type ClaudeSession } from "../lib/api";
import { relativeTime } from "../lib/time";

interface ClaudeCodeTabProps {
  envId: string;
  sshCommand: string;
}

export function ClaudeCodeTab({ envId, sshCommand }: ClaudeCodeTabProps) {
  const [sessions, setSessions] = useState<ClaudeSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api
      .getClaudeSessions(envId)
      .then((data) => setSessions(data.sessions))
      .catch(() => setSessions([]))
      .finally(() => setLoading(false));
  }, [envId]);

  const copyToClipboard = async () => {
    await navigator.clipboard.writeText(sshCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-6">
      {/* SSH Connection */}
      <div className="bg-[#141414] border border-[#333] rounded-lg p-6">
        <h3 className="text-lg font-semibold mb-4">Connect via SSH</h3>
        <div className="flex items-center gap-3">
          <code className="flex-1 bg-[#0a0a0a] px-4 py-2.5 rounded font-mono text-sm text-[#e5e5e5] border border-[#333]">
            {sshCommand}
          </code>
          <button
            onClick={copyToClipboard}
            className="px-4 py-2.5 bg-[#333] hover:bg-[#444] text-sm rounded transition-colors cursor-pointer"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
        <p className="text-sm text-[#999] mt-3">
          Or use the <strong>Terminal</strong> tab for a browser-based terminal.
        </p>
      </div>

      {/* Auth Instructions */}
      <div className="bg-[#141414] border border-[#333] rounded-lg p-6">
        <h3 className="text-lg font-semibold mb-2">Authentication</h3>
        <p className="text-sm text-[#999] mb-3">
          Your GitHub SSH keys are pre-configured.
        </p>
        <p className="text-sm text-[#999]">
          Set <code className="text-[#e5e5e5] bg-[#0a0a0a] px-1.5 py-0.5 rounded">ANTHROPIC_API_KEY</code> in
          your shell, or run{" "}
          <code className="text-[#e5e5e5] bg-[#0a0a0a] px-1.5 py-0.5 rounded">claude /login</code> to
          authenticate interactively.
        </p>
        <p className="text-sm text-[#999] mt-2">
          Run <code className="text-[#e5e5e5] bg-[#0a0a0a] px-1.5 py-0.5 rounded">claude</code> in{" "}
          <code className="text-[#e5e5e5] bg-[#0a0a0a] px-1.5 py-0.5 rounded">~/repo</code> to start.
        </p>
      </div>

      {/* Recent Sessions */}
      <div className="bg-[#141414] border border-[#333] rounded-lg p-6">
        <h3 className="text-lg font-semibold mb-4">Recent Sessions</h3>
        {loading ? (
          <p className="text-sm text-[#999]">Loading sessions...</p>
        ) : sessions.length === 0 ? (
          <p className="text-sm text-[#999]">
            No sessions yet. Run <code className="text-[#e5e5e5] bg-[#0a0a0a] px-1.5 py-0.5 rounded">claude</code> in the terminal to create one.
          </p>
        ) : (
          <ul className="space-y-2">
            {sessions.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between px-3 py-2 bg-[#0a0a0a] rounded border border-[#333]"
              >
                <span className="text-sm truncate">
                  {s.title || `Session ${s.id.slice(0, 8)}`}
                </span>
                <span className="text-xs text-[#999] ml-4 shrink-0">
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
