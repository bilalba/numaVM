import { useState } from "react";

interface ClaudeCodeTabProps {
  vmId: string;
  sshCommand: string;
}

export function ClaudeCodeTab({ sshCommand }: ClaudeCodeTabProps) {
  const [copied, setCopied] = useState(false);

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
        <p className="text-xs text-neutral-500">
          Set <code className="text-foreground bg-surface border border-neutral-100 px-1.5 py-0.5 text-xs">ANTHROPIC_API_KEY</code> in
          your shell, or run{" "}
          <code className="text-foreground bg-surface border border-neutral-100 px-1.5 py-0.5 text-xs">claude /login</code> to
          authenticate interactively.
        </p>
      </div>
    </div>
  );
}
