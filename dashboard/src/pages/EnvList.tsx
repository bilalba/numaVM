import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
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

function EnvCardMenu({
  env,
  onDelete,
  onClone,
}: {
  env: EnvSummary;
  onDelete: () => void;
  onClone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setConfirming(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(!open);
          setConfirming(false);
        }}
        className="p-1 -m-1 text-neutral-400 hover:text-neutral-700 transition-colors cursor-pointer"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <circle cx="8" cy="3" r="1.5" />
          <circle cx="8" cy="8" r="1.5" />
          <circle cx="8" cy="13" r="1.5" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-6 z-50 min-w-[160px] bg-white border border-neutral-200 shadow-sm py-1">
          <a
            href={env.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="block px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100 transition-colors"
          >
            Visit Page
          </a>
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
              onClone();
            }}
            className="block w-full text-left px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100 transition-colors cursor-pointer"
          >
            Clone Environment
          </button>
          {env.role === "owner" && (
            <>
              <div className="border-t border-neutral-200 my-1" />
              {confirming ? (
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setOpen(false);
                    setConfirming(false);
                    onDelete();
                  }}
                  className="block w-full text-left px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 transition-colors cursor-pointer"
                >
                  Confirm Delete
                </button>
              ) : (
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setConfirming(true);
                  }}
                  className="block w-full text-left px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 transition-colors cursor-pointer"
                >
                  Delete Environment
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function EnvList() {
  const [envs, setEnvs] = useState<EnvSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [showSshKeys, setShowSshKeys] = useState(false);
  const { toast } = useToast();
  const navigate = useNavigate();

  const loadEnvs = () => {
    api
      .listEnvs()
      .then((data) => setEnvs(data.envs))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(loadEnvs, []);

  const handleDelete = async (env: EnvSummary) => {
    try {
      await api.deleteEnv(env.id);
      toast(`Deleted ${env.name}`, "success");
      loadEnvs();
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  const handleClone = async (env: EnvSummary) => {
    setCreating(true);
    try {
      const result = await api.createEnv({
        name: `${env.name} (copy)`,
      });
      toast(`Cloned as ${result.name || env.name + " (copy)"}`, "success");
      setLoading(true);
      loadEnvs();
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setCreating(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    try {
      await api.createEnv({ name: newName.trim() });
      setNewName("");
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
            <div
              key={env.id}
              onClick={() => navigate(`/env/${env.id}`)}
              className="bg-panel-chat border border-neutral-200 p-5 transition-opacity hover:opacity-80 cursor-pointer"
            >
              <div className="flex items-center gap-2 mb-2">
                <span
                  className={`w-1.5 h-1.5 rounded-full ${statusColors[env.status] || "bg-neutral-400"}`}
                />
                <span className="text-sm font-semibold truncate flex-1">{env.name}</span>
                <EnvCardMenu
                  env={env}
                  onDelete={() => handleDelete(env)}
                  onClone={() => handleClone(env)}
                />
              </div>
              <p className="text-xs text-neutral-500 mb-3">{env.id}</p>
              <div className="flex items-center justify-between text-xs text-neutral-500">
                <span className="capitalize">{env.role}</span>
                <span>{relativeTime(env.created_at)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
