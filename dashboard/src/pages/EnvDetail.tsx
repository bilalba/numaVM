import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api, type EnvDetail as EnvDetailType } from "../lib/api";
import { TerminalTab } from "../components/TerminalTab";
import { ClaudeCodeTab } from "../components/ClaudeCodeTab";
import { AgentTab } from "../components/AgentTab";
import { AccessPanel } from "../components/AccessPanel";
import { FilesTab } from "../components/FilesTab";
import { FileBrowser } from "../components/FileBrowser";

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
  const [fileBrowserCollapsed, setFileBrowserCollapsed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
    if (env.status !== "snapshotted" && env.status !== "paused" && env.status !== "creating") return;

    const interval = setInterval(() => {
      api.getEnv(slug).then((updated) => {
        setEnv(updated);
        if (updated.status === "running") clearInterval(interval);
      }).catch(() => {});
    }, 3000);

    return () => clearInterval(interval);
  }, [slug, env?.status]);

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-6 py-8 text-neutral-500 text-xs">
        Loading environment...
      </div>
    );
  }

  if (error || !env) {
    return (
      <div className="max-w-7xl mx-auto px-6 py-8">
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
    <div className="max-w-7xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="mb-6">
        <Link to="/" className="text-xs text-neutral-500 underline underline-offset-4 transition-opacity hover:opacity-60 mb-2 inline-block">
          &larr; Environments
        </Link>
        <div className="flex items-center gap-3 mt-1">
          <span
            className={`w-2 h-2 rounded-full ${statusColors[env.status] || "bg-neutral-400"}`}
          />
          <h1 className="text-2xl font-semibold">{env.name}</h1>
          <span className="text-xs text-neutral-500">{env.id}</span>
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
          <span className="text-neutral-400">|</span>
          <a
            href={env.repo_url}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4 transition-opacity hover:opacity-60"
          >
            GitHub
          </a>
          <span className="text-neutral-400">|</span>
          <span className="text-neutral-500 capitalize">
            {env.role} &middot; {env.status}
          </span>
        </div>
      </div>

      {/* Setting up banner */}
      {env.status === "creating" && (
        <div className="mb-4 border border-neutral-200 px-4 py-3 flex items-center gap-3 bg-panel-chat">
          <div className="w-1.5 h-1.5 rounded-full bg-yellow-500 animate-[pulseDot_1s_ease-in-out_infinite]" />
          <span className="text-xs text-neutral-600">
            Your environment is being set up. This usually takes a minute.
          </span>
        </div>
      )}

      {/* Waking up banner */}
      {(env.status === "snapshotted" || env.status === "paused") && (
        <div className="mb-4 border border-neutral-200 px-4 py-3 flex items-center gap-3 bg-panel-chat">
          <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-[pulseDot_1s_ease-in-out_infinite]" />
          <span className="text-xs text-neutral-600">
            Your environment is waking up from sleep. This usually takes a few seconds.
          </span>
        </div>
      )}

      {/* Tab bar */}
      <div className="flex border-b border-neutral-200 mb-6">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-xs transition-opacity cursor-pointer -mb-px ${
              activeTab === tab.id
                ? "font-semibold opacity-100 border-b border-black"
                : "opacity-60 hover:opacity-80"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content with file browser sidebar */}
      <div className="flex gap-4">
        <FileBrowser
          envId={env.id}
          collapsed={fileBrowserCollapsed}
          onToggleCollapse={() => setFileBrowserCollapsed((c) => !c)}
        />
        <div className="flex-1 min-w-0">
          {activeTab === "codex" && <AgentTab envId={env.id} agentType="codex" />}
          {activeTab === "opencode" && <AgentTab envId={env.id} agentType="opencode" />}
          {activeTab === "terminal" && <TerminalTab envId={env.id} />}
          {activeTab === "claude" && (
            <ClaudeCodeTab envId={env.id} sshCommand={env.ssh_command} />
          )}
          {activeTab === "files" && <FilesTab envId={env.id} />}
          {activeTab === "access" && (
            <AccessPanel envId={env.id} currentUserRole={env.role} />
          )}
        </div>
      </div>
    </div>
  );
}
