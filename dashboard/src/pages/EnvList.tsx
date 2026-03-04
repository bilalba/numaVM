import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type EnvSummary } from "../lib/api";
import { useToast } from "../components/Toast";
import { relativeTime } from "../lib/time";

const statusColors: Record<string, string> = {
  running: "bg-green-500",
  creating: "bg-yellow-500",
  stopped: "bg-gray-500",
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
        <h1 className="text-2xl font-bold">Environments</h1>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
        >
          New Environment
        </button>
      </div>

      {showCreate && (
        <form
          onSubmit={handleCreate}
          className="mb-6 bg-[#141414] border border-[#333] rounded-lg p-5"
        >
          <div className="flex gap-3 mb-2">
            <div className="flex-1">
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Environment name"
                maxLength={64}
                className="w-full bg-[#0a0a0a] border border-[#333] rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
                autoFocus
              />
              <p className="text-[10px] text-[#666] mt-1">A unique slug will be auto-generated for your subdomain.</p>
            </div>
            <div className="w-56">
              <input
                type="text"
                value={ghRepo}
                onChange={(e) => setGhRepo(e.target.value)}
                placeholder="owner/repo (optional)"
                className="w-full bg-[#0a0a0a] border border-[#333] rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
              />
              <p className="text-[10px] text-[#666] mt-1">Leave empty to auto-create a new repo, or paste owner/repo.</p>
            </div>
            <button
              type="submit"
              disabled={creating || !newName.trim()}
              className="px-4 py-2 h-[38px] bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded transition-colors cursor-pointer shrink-0"
            >
              {creating ? "Creating..." : "Create"}
            </button>
          </div>
        </form>
      )}

      {error && (
        <div className="mb-6 bg-red-900/30 border border-red-800 rounded-lg p-4 text-red-300 text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-[#999]">Loading environments...</p>
      ) : envs.length === 0 ? (
        <div className="text-center py-16">
          <h2 className="text-2xl font-bold mb-3">Welcome to DeployMagi</h2>
          <p className="text-[#999] mb-8 max-w-lg mx-auto">
            Create always-on development environments with built-in AI agents, web terminals, and team collaboration.
          </p>
          <button
            onClick={() => setShowCreate(true)}
            className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors cursor-pointer mb-12"
          >
            Create Your First Environment
          </button>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 max-w-3xl mx-auto text-left">
            <div className="bg-[#141414] border border-[#333] rounded-lg p-5">
              <div className="text-lg mb-2">Terminal</div>
              <p className="text-sm text-[#999]">Full web terminal with SSH access to your persistent Docker container.</p>
            </div>
            <div className="bg-[#141414] border border-[#333] rounded-lg p-5">
              <div className="text-lg mb-2">AI Agents</div>
              <p className="text-sm text-[#999]">Drive Codex, Claude Code, and OpenCode from a unified chat interface.</p>
            </div>
            <div className="bg-[#141414] border border-[#333] rounded-lg p-5">
              <div className="text-lg mb-2">Collaboration</div>
              <p className="text-sm text-[#999]">Share environments with your team using role-based access control.</p>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {envs.map((env) => (
            <Link
              key={env.id}
              to={`/env/${env.id}`}
              className="block bg-[#141414] border border-[#333] rounded-lg p-5 hover:border-[#555] transition-colors"
            >
              <div className="flex items-center gap-2 mb-2">
                <span
                  className={`w-2 h-2 rounded-full ${statusColors[env.status] || "bg-gray-500"}`}
                />
                <span className="font-semibold truncate">{env.name}</span>
              </div>
              <p className="text-xs font-mono text-[#999] mb-3">{env.id}</p>
              <div className="flex items-center justify-between text-xs text-[#999]">
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
