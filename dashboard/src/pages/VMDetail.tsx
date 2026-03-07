import { useEffect, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { api, type VMDetail as VMDetailType } from "../lib/api";
import { useToast } from "../components/Toast";
import { TerminalTab } from "../components/TerminalTab";
import { ClaudeCodeTab } from "../components/ClaudeCodeTab";
import { AgentTab } from "../components/AgentTab";
import { AccessPanel } from "../components/AccessPanel";
import { FilesTab } from "../components/FilesTab";

type TabId = "terminal" | "claude" | "codex" | "opencode" | "files" | "access";

const statusColors: Record<string, string> = {
  running: "bg-green-500",
  creating: "bg-yellow-500",
  stopped: "bg-neutral-400",
  error: "bg-red-500",
  snapshotted: "bg-blue-500",
  paused: "bg-blue-500",
};

export function VMDetail() {
  const { slug } = useParams<{ slug: string }>();
  const [vm, setVM] = useState<VMDetailType | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("codex");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pausing, setPausing] = useState(false);
  const { toast } = useToast();
  const navigate = useNavigate();

  useEffect(() => {
    if (!slug) return;
    api
      .getVM(slug)
      .then(setVM)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [slug]);

  // Poll for status updates when VM is snapshotted/paused (waking up)
  useEffect(() => {
    if (!slug || !vm) return;
    if (vm.quota_error) return; // Don't poll if quota exceeded — wake won't proceed
    if (vm.status !== "snapshotted" && vm.status !== "paused" && vm.status !== "creating") return;

    const interval = setInterval(() => {
      api.getVM(slug).then((updated) => {
        setVM(updated);
        if (updated.status === "running" || updated.quota_error) clearInterval(interval);
      }).catch(() => {});
    }, 3000);

    return () => clearInterval(interval);
  }, [slug, vm?.status]);

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 text-neutral-500 text-xs">
        Loading VM...
      </div>
    );
  }

  if (error || !vm) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
        <div className="border border-neutral-300 p-4 text-sm text-red-600">
          {error || "VM not found"}
        </div>
        <Link to="/" className="text-xs underline underline-offset-4 transition-opacity hover:opacity-60 mt-4 inline-block">
          Back to VMs
        </Link>
      </div>
    );
  }

  const tabs: { id: TabId; label: string }[] = [
    { id: "codex", label: "Codex" },
    { id: "opencode", label: "OpenCode" },
    { id: "claude", label: "Claude Code" },
    { id: "terminal", label: "Terminal" },
    { id: "files", label: "Files" },
    { id: "access", label: "Access" },
  ];

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
      {/* Header */}
      <div className="mb-4 sm:mb-6">
        <Link to="/" className="text-xs text-neutral-500 underline underline-offset-4 transition-opacity hover:opacity-60 mb-2 inline-block">
          &larr; VMs
        </Link>
        <div className="flex items-center gap-3 mt-1">
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${statusColors[vm.status] || "bg-neutral-400"}`}
          />
          <h1 className="text-xl sm:text-2xl font-semibold truncate">{vm.name}</h1>
          <span className="text-xs text-neutral-500 hidden sm:inline">{vm.id}</span>
        </div>
        <div className="flex items-center gap-2 mt-3 text-xs">
          <a
            href={vm.url}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4 transition-opacity hover:opacity-60"
          >
            Visit
          </a>
          {vm.repo_url && (
            <>
              <span className="text-neutral-400">|</span>
              <a
                href={vm.repo_url}
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-4 transition-opacity hover:opacity-60"
              >
                GitHub
              </a>
            </>
          )}
          <span className="text-neutral-400">|</span>
          <span className="text-neutral-500 capitalize">
            {vm.role} &middot; {vm.status} &middot;{" "}
            {vm.mem_size_mib >= 1024
              ? `${(vm.mem_size_mib / 1024).toFixed(vm.mem_size_mib % 1024 ? 2 : 0)} GB`
              : `${vm.mem_size_mib} MB`} RAM
          </span>
          {vm.status === "running" && vm.role === "owner" && (
            <>
              <span className="text-neutral-400">|</span>
              <button
                onClick={async () => {
                  if (!window.confirm(`Pause "${vm.name}"? The VM will be snapshotted and can be resumed later.`)) return;
                  // Navigate away immediately to tear down WebSocket/terminal/polling
                  // connections that would otherwise wake the VM right after pausing
                  navigate("/", { state: { pausingVmId: vm.id, pausingVmName: vm.name } });
                }}
                disabled={pausing}
                className="underline underline-offset-4 transition-opacity hover:opacity-60 cursor-pointer disabled:opacity-30"
              >
                {pausing ? "Pausing..." : "Pause"}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Setting up banner */}
      {vm.status === "creating" && (
        <div className="mb-4 border border-neutral-200 px-4 py-3 flex items-center gap-3 bg-panel-chat">
          <div className="w-1.5 h-1.5 rounded-full bg-yellow-500 animate-[pulseDot_1s_ease-in-out_infinite]" />
          <span className="text-xs text-neutral-600">
            {vm.status_detail || "Setting up your VM..."}
          </span>
        </div>
      )}

      {/* RAM quota exceeded banner */}
      {vm.quota_error && (
        <div className="mb-4 border border-red-200 px-4 py-3 flex items-center gap-3 bg-red-50">
          <div className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
          <span className="text-xs text-red-700">
            This VM can't wake up — you've reached your plan's RAM limit ({vm.quota_error.current_ram_mib}/{vm.quota_error.max_ram_mib} MiB in use).{" "}
            Stop another VM or{" "}
            <Link to="/plan" className="underline font-medium">upgrade your plan</Link>.
          </span>
        </div>
      )}

      {/* Waking up banner */}
      {(vm.status === "snapshotted" || vm.status === "paused") && !vm.quota_error && (
        <div className="mb-4 border border-neutral-200 px-4 py-3 flex items-center gap-3 bg-panel-chat">
          <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-[pulseDot_1s_ease-in-out_infinite]" />
          <span className="text-xs text-neutral-600">
            Your VM is waking up from sleep. This usually takes a few seconds.
          </span>
        </div>
      )}

      {/* Tab bar — scrollable on mobile */}
      <div className="flex border-b border-neutral-200 mb-4 sm:mb-6 overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-3 sm:px-4 py-2 text-xs transition-opacity cursor-pointer -mb-px whitespace-nowrap shrink-0 ${
              activeTab === tab.id
                ? "font-semibold opacity-100 border-b border-black"
                : "opacity-60 hover:opacity-80"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div>
        {activeTab === "codex" && <AgentTab vmId={vm.id} agentType="codex" />}
        {activeTab === "opencode" && <AgentTab vmId={vm.id} agentType="opencode" />}
        {activeTab === "terminal" && <TerminalTab vmId={vm.id} />}
        {activeTab === "claude" && (
          <ClaudeCodeTab vmId={vm.id} sshCommand={vm.ssh_command} />
        )}
        {activeTab === "files" && <FilesTab vmId={vm.id} />}
        {activeTab === "access" && (
          <AccessPanel vmId={vm.id} currentUserRole={vm.role} sshCommand={vm.ssh_command} />
        )}
      </div>
    </div>
  );
}
