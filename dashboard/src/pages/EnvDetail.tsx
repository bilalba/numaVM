import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api, type EnvDetail as EnvDetailType } from "../lib/api";
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

export function EnvDetail() {
  const { slug } = useParams<{ slug: string }>();
  const [env, setEnv] = useState<EnvDetailType | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("codex");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pausing, setPausing] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    if (!slug) return;
    api
      .getEnv(slug)
      .then(setEnv)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [slug]);

  // Poll for status updates when env is snapshotted/paused (waking up)
  useEffect(() => {
    if (!slug || !env) return;
    if (env.quota_error) return; // Don't poll if quota exceeded — wake won't proceed
    if (env.status !== "snapshotted" && env.status !== "paused" && env.status !== "creating") return;

    const interval = setInterval(() => {
      api.getEnv(slug).then((updated) => {
        setEnv(updated);
        if (updated.status === "running" || updated.quota_error) clearInterval(interval);
      }).catch(() => {});
    }, 3000);

    return () => clearInterval(interval);
  }, [slug, env?.status]);

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 text-neutral-500 text-xs">
        Loading environment...
      </div>
    );
  }

  if (error || !env) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
        <div className="border border-neutral-300 p-4 text-sm text-red-600">
          {error || "Environment not found"}
        </div>
        <Link to="/" className="text-xs underline underline-offset-4 transition-opacity hover:opacity-60 mt-4 inline-block">
          Back to environments
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
          &larr; Environments
        </Link>
        <div className="flex items-center gap-3 mt-1">
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${statusColors[env.status] || "bg-neutral-400"}`}
          />
          <h1 className="text-xl sm:text-2xl font-semibold truncate">{env.name}</h1>
          <span className="text-xs text-neutral-500 hidden sm:inline">{env.id}</span>
        </div>
        <div className="flex items-center gap-2 mt-3 text-xs">
          <a
            href={env.url}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4 transition-opacity hover:opacity-60"
          >
            Visit
          </a>
          {env.repo_url && (
            <>
              <span className="text-neutral-400">|</span>
              <a
                href={env.repo_url}
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
            {env.role} &middot; {env.status} &middot;{" "}
            {env.mem_size_mib >= 1024
              ? `${(env.mem_size_mib / 1024).toFixed(env.mem_size_mib % 1024 ? 2 : 0)} GB`
              : `${env.mem_size_mib} MB`} RAM
          </span>
          {env.status === "running" && env.role === "owner" && (
            <>
              <span className="text-neutral-400">|</span>
              <button
                onClick={async () => {
                  if (!window.confirm(`Pause "${env.name}"? The environment will be snapshotted and can be resumed later.`)) return;
                  setPausing(true);
                  try {
                    await api.pauseEnv(env.id);
                    toast(`Paused ${env.name}`, "success");
                    setEnv({ ...env, status: "snapshotted" });
                  } catch (err: any) {
                    toast(err.message, "error");
                  } finally {
                    setPausing(false);
                  }
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
      {env.status === "creating" && (
        <div className="mb-4 border border-neutral-200 px-4 py-3 flex items-center gap-3 bg-panel-chat">
          <div className="w-1.5 h-1.5 rounded-full bg-yellow-500 animate-[pulseDot_1s_ease-in-out_infinite]" />
          <span className="text-xs text-neutral-600">
            {env.status_detail || "Setting up your environment..."}
          </span>
        </div>
      )}

      {/* RAM quota exceeded banner */}
      {env.quota_error && (
        <div className="mb-4 border border-red-200 px-4 py-3 flex items-center gap-3 bg-red-50">
          <div className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
          <span className="text-xs text-red-700">
            This environment can't wake up — you've reached your plan's RAM limit ({env.quota_error.current_ram_mib}/{env.quota_error.max_ram_mib} MiB in use).{" "}
            Stop another environment or{" "}
            <Link to="/plan" className="underline font-medium">upgrade your plan</Link>.
          </span>
        </div>
      )}

      {/* Waking up banner */}
      {(env.status === "snapshotted" || env.status === "paused") && !env.quota_error && (
        <div className="mb-4 border border-neutral-200 px-4 py-3 flex items-center gap-3 bg-panel-chat">
          <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-[pulseDot_1s_ease-in-out_infinite]" />
          <span className="text-xs text-neutral-600">
            Your environment is waking up from sleep. This usually takes a few seconds.
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
        {activeTab === "codex" && <AgentTab envId={env.id} agentType="codex" />}
        {activeTab === "opencode" && <AgentTab envId={env.id} agentType="opencode" />}
        {activeTab === "terminal" && <TerminalTab envId={env.id} />}
        {activeTab === "claude" && (
          <ClaudeCodeTab envId={env.id} sshCommand={env.ssh_command} />
        )}
        {activeTab === "files" && <FilesTab envId={env.id} />}
        {activeTab === "access" && (
          <AccessPanel envId={env.id} currentUserRole={env.role} sshCommand={env.ssh_command} />
        )}
      </div>
    </div>
  );
}
