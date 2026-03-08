import { useState, useEffect, useRef, useCallback } from "react";
import type { CodexModel, AgentSession, ReasoningEffort, ApprovalPolicy, SandboxPolicy } from "../lib/api";

type PaletteMode =
  | "commands"
  | "models"
  | "effort"
  | "sessions"
  | "approval"
  | "sandbox";

interface CommandItem {
  id: string;
  label: string;
  description?: string;
  badge?: string;
  action: () => void;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  agentType: "codex" | "opencode";
  // Data
  codexModels: CodexModel[];
  sessions: AgentSession[];
  // Current state
  currentModel: string;
  currentEffort: ReasoningEffort | null;
  currentApprovalPolicy: ApprovalPolicy;
  currentSandboxPolicy: SandboxPolicy;
  isAuthenticated: boolean;
  // Callbacks
  onSelectModel: (modelId: string) => void;
  onSelectEffort: (effort: ReasoningEffort) => void;
  onNewSession: () => void;
  onSwitchSession: (sessionId: string) => void;
  onArchiveSession: () => void;
  onChangeCwd: () => void;
  onApprovalPolicy: (policy: ApprovalPolicy) => void;
  onSandboxPolicy: (policy: SandboxPolicy) => void;
  onSignOut?: () => void;
}

export function CommandPalette({
  isOpen,
  onClose,
  agentType,
  codexModels,
  sessions,
  currentModel,
  currentEffort,
  currentApprovalPolicy,
  currentSandboxPolicy,
  isAuthenticated,
  onSelectModel,
  onSelectEffort,
  onNewSession,
  onSwitchSession,
  onArchiveSession,
  onChangeCwd,
  onApprovalPolicy,
  onSandboxPolicy,
  onSignOut,
}: CommandPaletteProps) {
  const [mode, setMode] = useState<PaletteMode>("commands");
  const [search, setSearch] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset state when opening
  useEffect(() => {
    if (isOpen) {
      setMode("commands");
      setSearch("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [isOpen]);

  // Get available reasoning efforts for current model
  const currentModelObj = codexModels.find((m) => m.id === currentModel);
  const availableEfforts = currentModelObj?.reasoningEffort || ["low", "medium", "high"];

  const getItems = useCallback((): CommandItem[] => {
    switch (mode) {
      case "commands": {
        const items: CommandItem[] = [];
        if (agentType === "codex" && codexModels.length > 0) {
          items.push({
            id: "select-model",
            label: "Select Model",
            description: currentModel || "Default",
            action: () => { setMode("models"); setSearch(""); setSelectedIndex(0); },
          });
        }
        if (agentType === "codex") {
          items.push({
            id: "reasoning-effort",
            label: "Reasoning Effort",
            description: currentEffort || "Default",
            action: () => { setMode("effort"); setSearch(""); setSelectedIndex(0); },
          });
        }
        items.push({
          id: "new-session",
          label: "New Session",
          action: () => { onNewSession(); onClose(); },
        });
        if (sessions.length > 0) {
          items.push({
            id: "switch-session",
            label: "Switch Session",
            description: `${sessions.length} sessions`,
            action: () => { setMode("sessions"); setSearch(""); setSelectedIndex(0); },
          });
          items.push({
            id: "archive-session",
            label: "Archive Session",
            description: "Close current session",
            action: () => { onArchiveSession(); onClose(); },
          });
        }
        items.push({
          id: "change-cwd",
          label: "Change Working Directory",
          action: () => { onChangeCwd(); onClose(); },
        });
        if (agentType === "codex") {
          items.push({
            id: "approval-policy",
            label: "Approval Policy",
            description: formatApprovalPolicy(currentApprovalPolicy),
            action: () => { setMode("approval"); setSearch(""); setSelectedIndex(0); },
          });
          items.push({
            id: "sandbox-policy",
            label: "Sandbox Policy",
            description: formatSandboxPolicy(currentSandboxPolicy),
            action: () => { setMode("sandbox"); setSearch(""); setSelectedIndex(0); },
          });
        }
        if (agentType === "codex" && isAuthenticated && onSignOut) {
          items.push({
            id: "sign-out",
            label: "Sign Out",
            action: () => { onSignOut(); onClose(); },
          });
        }
        return items;
      }

      case "models":
        return codexModels.map((m) => ({
          id: m.id,
          label: m.displayName,
          badge: m.isDefault ? "default" : m.id === currentModel ? "current" : undefined,
          action: () => { onSelectModel(m.id); setMode("commands"); },
        }));

      case "effort":
        return (availableEfforts as ReasoningEffort[]).map((e) => ({
          id: e,
          label: e.charAt(0).toUpperCase() + e.slice(1),
          badge: e === currentEffort ? "current" : undefined,
          action: () => { onSelectEffort(e); setMode("commands"); },
        }));

      case "sessions":
        return sessions.map((s) => ({
          id: s.id,
          label: s.title || `Session ${s.id.slice(0, 8)}`,
          description: s.status,
          action: () => { onSwitchSession(s.id); onClose(); },
        }));

      case "approval":
        return ([
          { id: "on-request", label: "On Request", desc: "Ask before each action" },
          { id: "unless-allow-listed", label: "Unless Trusted", desc: "Auto-approve trusted commands" },
          { id: "never", label: "Never", desc: "Auto-approve everything" },
        ] as const).map((p) => ({
          id: p.id,
          label: p.label,
          description: p.desc,
          badge: p.id === currentApprovalPolicy ? "current" : undefined,
          action: () => { onApprovalPolicy(p.id as ApprovalPolicy); setMode("commands"); },
        }));

      case "sandbox":
        return ([
          { id: "read-only", label: "Read Only", desc: "No file writes" },
          { id: "workspace-write", label: "Workspace Write", desc: "Write within workspace" },
          { id: "full-access", label: "Full Access", desc: "Unrestricted file access" },
        ] as const).map((p) => ({
          id: p.id,
          label: p.label,
          description: p.desc,
          badge: p.id === currentSandboxPolicy ? "current" : undefined,
          action: () => { onSandboxPolicy(p.id as SandboxPolicy); setMode("commands"); },
        }));
    }
  }, [mode, agentType, codexModels, sessions, currentModel, currentEffort, currentApprovalPolicy, currentSandboxPolicy, isAuthenticated, availableEfforts, onSelectModel, onSelectEffort, onNewSession, onSwitchSession, onArchiveSession, onChangeCwd, onApprovalPolicy, onSandboxPolicy, onSignOut, onClose]);

  const items = getItems();
  const filtered = search
    ? items.filter((item) => item.label.toLowerCase().includes(search.toLowerCase()))
    : items;

  // Clamp selected index
  useEffect(() => {
    if (selectedIndex >= filtered.length) {
      setSelectedIndex(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, selectedIndex]);

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const selected = list.children[selectedIndex] as HTMLElement;
    if (selected) {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && filtered[selectedIndex]) {
      e.preventDefault();
      filtered[selectedIndex].action();
    } else if (e.key === "Backspace" && !search && mode !== "commands") {
      e.preventDefault();
      setMode("commands");
      setSelectedIndex(0);
    }
  };

  if (!isOpen) return null;

  const modeLabel: Record<PaletteMode, string> = {
    commands: "Commands",
    models: "Select Model",
    effort: "Reasoning Effort",
    sessions: "Switch Session",
    approval: "Approval Policy",
    sandbox: "Sandbox Policy",
  };

  return (
    <div
      className="fixed inset-0 bg-black/30 flex justify-center z-50"
      style={{ paddingTop: "20vh" }}
      onClick={onClose}
    >
      <div
        className="bg-surface border border-neutral-300 w-full max-w-[500px] h-fit max-h-[60vh] flex flex-col shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center border-b border-neutral-200 px-3">
          {mode !== "commands" && (
            <button
              onClick={() => { setMode("commands"); setSearch(""); setSelectedIndex(0); }}
              className="text-xs text-neutral-500 hover:text-foreground cursor-pointer mr-2 shrink-0"
            >
              &larr;
            </button>
          )}
          <span className="text-[10px] text-neutral-400 shrink-0 mr-2">{modeLabel[mode]}</span>
          <input
            ref={inputRef}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setSelectedIndex(0); }}
            onKeyDown={handleKeyDown}
            placeholder="Type to filter..."
            className="flex-1 border-0 bg-transparent px-0 py-2.5 text-sm text-foreground placeholder:text-neutral-400 focus:outline-none"
          />
        </div>

        {/* Items */}
        <div ref={listRef} className="flex-1 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <p className="text-xs text-neutral-500 px-3 py-4 text-center">No matches</p>
          ) : (
            filtered.map((item, i) => (
              <button
                key={item.id}
                onClick={item.action}
                onMouseEnter={() => setSelectedIndex(i)}
                className={`w-full text-left px-3 py-2 flex items-center justify-between cursor-pointer transition-colors ${
                  i === selectedIndex ? "bg-neutral-100" : "hover:bg-neutral-100"
                }`}
              >
                <div className="min-w-0">
                  <span className="text-xs text-foreground">{item.label}</span>
                  {item.description && (
                    <span className="text-[10px] text-neutral-500 ml-2">{item.description}</span>
                  )}
                </div>
                {item.badge && (
                  <span className="text-[9px] text-neutral-400 border border-neutral-200 px-1.5 py-0.5 shrink-0 ml-2">
                    {item.badge}
                  </span>
                )}
              </button>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-neutral-200 px-3 py-1.5 flex items-center gap-4">
          <span className="text-[10px] text-neutral-400">
            <kbd className="border border-neutral-200 px-1 py-0.5 text-[9px]">&uarr;&darr;</kbd> navigate
          </span>
          <span className="text-[10px] text-neutral-400">
            <kbd className="border border-neutral-200 px-1 py-0.5 text-[9px]">&crarr;</kbd> select
          </span>
          <span className="text-[10px] text-neutral-400">
            <kbd className="border border-neutral-200 px-1 py-0.5 text-[9px]">esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}

function formatApprovalPolicy(p: ApprovalPolicy): string {
  switch (p) {
    case "on-request": return "On Request";
    case "unless-allow-listed": return "Unless Trusted";
    case "never": return "Never";
  }
}

function formatSandboxPolicy(p: SandboxPolicy): string {
  switch (p) {
    case "read-only": return "Read Only";
    case "workspace-write": return "Workspace Write";
    case "full-access": return "Full Access";
  }
}
