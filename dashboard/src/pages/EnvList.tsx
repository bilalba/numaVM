import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type EnvSummary } from "../lib/api";
import { useToast } from "../components/Toast";
import { SshKeysPanel } from "../components/SshKeysPanel";
import { relativeTime } from "../lib/time";

const statusColors: Record<string, string> = {
  running: "bg-green-500",
  creating: "bg-yellow-500",
  stopped: "bg-neutral-400",
  error: "bg-red-500",
  snapshotted: "bg-blue-500",
  paused: "bg-blue-500",
};

export function EnvList() {
  const [envs, setEnvs] = useState<EnvSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [ghRepo, setGhRepo] = useState("");
  const [creating, setCreating] = useState(false);
  const [showSshKeys, setShowSshKeys] = useState(false);
  const { toast } = useToast();

  const loadEnvs = () => {
    api
      .listEnvs()
      .then((data) => setEnvs(data.envs))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(loadEnvs, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    try {
      await api.createEnv({
        name: newName.trim(),
        ...(ghRepo.trim() ? { gh_repo: ghRepo.trim() } : {}),
      });
      setNewName("");
      setGhRepo("");
      setShowCreate(false);
      setLoading(true);
      loadEnvs();
    } catch (err: any) {
      setError(err.message);
      toast(err.message, "error");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-semibold">Environments</h1>
        <div className="flex items-center gap-4">
          <button
            onClick={() => setShowSshKeys(!showSshKeys)}
            className="text-xs underline underline-offset-4 transition-opacity hover:opacity-60 cursor-pointer"
          >
            {showSshKeys ? "Close" : "SSH Keys"}
          </button>
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="text-xs underline underline-offset-4 transition-opacity hover:opacity-60 cursor-pointer"
          >
            {showCreate ? "Cancel" : "New Environment"}
          </button>
        </div>
      </div>

      {showSshKeys && (
        <div className="mb-6">
          <SshKeysPanel />
        </div>
      )}

      {showCreate && (
        <form
          onSubmit={handleCreate}
          className="mb-6 bg-panel-chat border border-neutral-200 p-5"
        >
          <div className="flex gap-4 items-end mb-2">
            <div className="flex-1">
              <label className="text-xs text-neutral-600 mb-1 block">Name</label>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Environment name"
                maxLength={64}
                className="w-full border-0 border-b border-neutral-300 bg-transparent px-0 py-1 text-sm text-black placeholder:text-neutral-500 focus:border-black focus:outline-none"
                autoFocus
              />
              <p className="text-[10px] text-neutral-500 mt-1">A unique slug will be auto-generated for your subdomain.</p>
            </div>
            <div className="w-56">
              <label className="text-xs text-neutral-600 mb-1 block">Repository</label>
              <input
                type="text"
                value={ghRepo}
                onChange={(e) => setGhRepo(e.target.value)}
                placeholder="owner/repo (optional)"
                className="w-full border-0 border-b border-neutral-300 bg-transparent px-0 py-1 text-sm text-black placeholder:text-neutral-500 focus:border-black focus:outline-none"
              />
              <p className="text-[10px] text-neutral-500 mt-1">Leave empty to auto-create a new repo, or paste owner/repo.</p>
            </div>
            <button
              type="submit"
              disabled={creating || !newName.trim()}
              className="text-xs underline underline-offset-4 transition-opacity hover:opacity-60 disabled:opacity-30 cursor-pointer shrink-0 pb-1"
            >
              {creating ? "Creating..." : "Create"}
            </button>
          </div>
        </form>
      )}

      {error && (
        <div className="mb-6 border border-neutral-300 p-4 text-sm text-red-600">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-neutral-500 text-xs">Loading environments...</p>
      ) : envs.length === 0 ? (
        <div className="text-center py-16">
          <h2 className="text-2xl font-semibold mb-3">Welcome to DeployMagi</h2>
          <p className="text-xs text-neutral-600 mb-8 max-w-lg mx-auto">
            Create always-on development environments with built-in AI agents, web terminals, and team collaboration.
          </p>
          <button
            onClick={() => setShowCreate(true)}
            className="text-xs underline underline-offset-4 transition-opacity hover:opacity-60 cursor-pointer mb-12"
          >
            Create Your First Environment
          </button>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 max-w-3xl mx-auto text-left">
            <div className="bg-panel-chat border border-neutral-200 p-5">
              <div className="text-sm font-semibold mb-2">Terminal</div>
              <p className="text-xs text-neutral-600">Full web terminal with SSH access to your persistent environment.</p>
            </div>
            <div className="bg-panel-chat border border-neutral-200 p-5">
              <div className="text-sm font-semibold mb-2">AI Agents</div>
              <p className="text-xs text-neutral-600">Drive Codex, Claude Code, and OpenCode from a unified chat interface.</p>
            </div>
            <div className="bg-panel-chat border border-neutral-200 p-5">
              <div className="text-sm font-semibold mb-2">Collaboration</div>
              <p className="text-xs text-neutral-600">Share environments with your team using role-based access control.</p>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {envs.map((env) => (
            <Link
              key={env.id}
              to={`/env/${env.id}`}
              className="block bg-panel-chat border border-neutral-200 p-5 transition-opacity hover:opacity-80"
            >
              <div className="flex items-center gap-2 mb-2">
                <span
                  className={`w-1.5 h-1.5 rounded-full ${statusColors[env.status] || "bg-neutral-400"}`}
                />
                <span className="text-sm font-semibold truncate">{env.name}</span>
              </div>
              <p className="text-xs text-neutral-500 mb-3">{env.id}</p>
              <div className="flex items-center justify-between text-xs text-neutral-500">
                <span className="capitalize">{env.role}</span>
                <span>{relativeTime(env.created_at)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
