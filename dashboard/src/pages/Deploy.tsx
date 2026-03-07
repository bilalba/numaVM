import { useEffect, useState, useCallback, useRef } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { useToast } from "../components/Toast";

interface RepoInfo {
  full_name: string;
  name: string;
  description: string | null;
  default_branch: string;
  language: string | null;
  stargazers_count: number;
  owner: { login: string; avatar_url: string };
  private?: boolean;
}

function parseRepo(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // "owner/repo"
  if (/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(trimmed)) return trimmed;
  // "https://github.com/owner/repo" or "https://github.com/owner/repo/tree/main/..."
  try {
    const url = new URL(trimmed);
    if (url.hostname === "github.com") {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    }
  } catch {}
  return null;
}

export function Deploy() {
  const [searchParams] = useSearchParams();
  const { toast } = useToast();

  const initialRepo = searchParams.get("repo") || "";

  const [repoInput, setRepoInput] = useState(initialRepo);
  const [repoInfo, setRepoInfo] = useState<RepoInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [deployLogs, setDeployLogs] = useState<string[]>([]);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [envName, setEnvName] = useState("");
  const [envId, setEnvId] = useState<string | null>(null);
  const [envReady, setEnvReady] = useState(false);
  const [appUrl, setAppUrl] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const fetchRepo = useCallback((raw: string) => {
    const parsed = parseRepo(raw);
    if (!parsed) {
      setRepoInfo(null);
      setError(raw.trim() ? "Invalid format. Use owner/repo or a GitHub URL." : null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setRepoInfo(null);
    fetch(`https://api.github.com/repos/${parsed}`, {
      headers: { Accept: "application/vnd.github.v3+json" },
    })
      .then((r) => {
        if (!r.ok) throw new Error(r.status === 404 ? "Repository not found or is private" : "Failed to fetch repository info");
        return r.json();
      })
      .then((data: RepoInfo) => {
        if (data.private) {
          setError("This repository is private. Only public repos can be deployed.");
          return;
        }
        setRepoInfo(data);
        setEnvName(data.name);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  // Auto-fetch if ?repo= is in URL
  useEffect(() => {
    if (initialRepo) fetchRepo(initialRepo);
  }, [initialRepo, fetchRepo]);

  function handleRepoSubmit(e: React.FormEvent) {
    e.preventDefault();
    fetchRepo(repoInput);
  }

  async function handleDeploy() {
    const parsed = parseRepo(repoInput);
    if (!parsed || !envName.trim()) return;
    setDeploying(true);
    setDeployLogs([]);
    setDeployError(null);
    setEnvId(null);
    setEnvReady(false);
    setAppUrl(null);

    try {
      const result = await api.createEnv({ name: envName.trim(), gh_repo: parsed });
      setEnvId(result.id);
      if (result.url) setAppUrl(result.url);

      // Poll for real status updates
      let lastDetail = "";
      pollRef.current = setInterval(async () => {
        try {
          const env = await api.getEnv(result.id);
          // Append new status_detail lines
          if (env.status_detail && env.status_detail !== lastDetail) {
            lastDetail = env.status_detail;
            if (env.status_detail.startsWith("Error:")) {
              setDeployError(env.status_detail);
              // Don't stop deploying — env is still usable via SSH
              if (pollRef.current) clearInterval(pollRef.current);
              setDeploying(false);
              setEnvReady(true); // still show the link
              return;
            }
            setDeployLogs((prev) => [...prev, env.status_detail!]);
          }
          // Done — env is running
          if (env.status === "running") {
            if (pollRef.current) clearInterval(pollRef.current);
            setDeployLogs((prev) => [...prev, "Ready"]);
            setDeploying(false);
            setEnvReady(true);
          }
          // Failed
          if (env.status === "error") {
            if (pollRef.current) clearInterval(pollRef.current);
            setDeployError(env.status_detail || "VM creation failed");
            setDeploying(false);
          }
        } catch {
          // env may have been deleted on error rollback
          if (pollRef.current) clearInterval(pollRef.current);
          setDeployError("Environment creation failed");
          setDeploying(false);
        }
      }, 1000);
    } catch (err: any) {
      setDeployError(err.message || "Failed to create environment");
      setDeploying(false);
    }
  }

  return (
    <div className="max-w-lg mx-auto px-4 py-12 text-xs">
      <div className="mb-6">
        <Link to="/" className="text-neutral-400 hover:text-neutral-600 hover:underline">
          &larr; Back
        </Link>
      </div>

      <h1 className="text-lg font-medium text-neutral-900 mb-6">Deploy a repository</h1>

      {/* Repo input */}
      <form onSubmit={handleRepoSubmit} className="mb-6">
        <label className="text-neutral-600 mb-1 block">GitHub repository</label>
        <div className="flex gap-3 items-end">
          <input
            type="text"
            value={repoInput}
            onChange={(e) => setRepoInput(e.target.value)}
            placeholder="owner/repo or https://github.com/owner/repo"
            className="flex-1 border-0 border-b border-neutral-300 bg-transparent px-0 py-1 text-sm text-black placeholder:text-neutral-400 focus:border-black focus:outline-none"
            autoFocus={!initialRepo}
          />
          <button
            type="submit"
            disabled={loading || !repoInput.trim()}
            className="text-xs underline underline-offset-4 transition-opacity hover:opacity-60 disabled:opacity-30 cursor-pointer shrink-0 pb-1"
          >
            {loading ? "Loading..." : "Lookup"}
          </button>
        </div>
      </form>

      {/* Error */}
      {error && (
        <div className="border border-neutral-200 rounded p-4 bg-panel-chat mb-6">
          <p className="text-neutral-500">{error}</p>
        </div>
      )}

      {/* Repo card + deploy form */}
      {repoInfo && (
        <div className="border border-neutral-200 rounded p-6 bg-panel-chat">
          <div className="flex items-start gap-4 mb-6">
            <img
              src={repoInfo.owner.avatar_url}
              alt={repoInfo.owner.login}
              className="w-10 h-10 rounded"
            />
            <div className="min-w-0 flex-1">
              <a
                href={`https://github.com/${repoInfo.full_name}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-medium text-neutral-900 hover:underline"
              >
                {repoInfo.full_name}
              </a>
              {repoInfo.description && (
                <p className="text-neutral-500 mt-1 leading-relaxed">{repoInfo.description}</p>
              )}
              <div className="flex items-center gap-3 mt-2 text-neutral-400">
                {repoInfo.language && <span>{repoInfo.language}</span>}
                <span>{repoInfo.stargazers_count.toLocaleString()} stars</span>
                <span>{repoInfo.default_branch}</span>
              </div>
            </div>
          </div>

          <div className="mb-6">
            <label className="text-neutral-600 mb-1 block">Environment name</label>
            <input
              type="text"
              value={envName}
              onChange={(e) => setEnvName(e.target.value)}
              maxLength={64}
              disabled={deploying}
              className="w-full border-0 border-b border-neutral-300 bg-transparent px-0 py-1 text-sm text-black placeholder:text-neutral-500 focus:border-black focus:outline-none disabled:opacity-50"
            />
          </div>

          {!envId && (
            <button
              onClick={handleDeploy}
              disabled={deploying || !envName.trim()}
              className="w-full py-2 bg-neutral-900 text-white rounded hover:bg-neutral-800 disabled:opacity-50 cursor-pointer text-xs"
            >
              {deploying ? "Launching..." : "Launch Environment"}
            </button>
          )}

          {/* Real progress log */}
          {deployLogs.length > 0 && (
            <div className="mt-4 font-mono text-[11px] leading-relaxed">
              {deployLogs.map((msg, i) => {
                const isLatest = i === deployLogs.length - 1;
                const isDone = msg === "Ready";
                return (
                  <div key={i} className={`flex items-center gap-2 ${isDone ? "text-green-600" : isLatest && deploying ? "text-neutral-900" : "text-neutral-400"}`}>
                    <span className="w-3 text-center shrink-0">
                      {isDone ? "\u2713" : isLatest && deploying ? <span className="inline-block animate-pulse">{"\u25CF"}</span> : "\u2713"}
                    </span>
                    <span>{msg}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Deploy error */}
          {deployError && (
            <div className="mt-4 text-red-600 text-[11px]">
              {deployError}
            </div>
          )}

          {/* Links section — visible once we have an env ID */}
          {envId && (
            <div className="mt-5 border-t border-neutral-200 pt-4 space-y-2">
              <Link
                to={`/env/${envId}`}
                className="flex items-center justify-between w-full text-xs py-2 px-3 rounded bg-neutral-100 hover:bg-neutral-200 transition-colors text-neutral-900"
              >
                <span>Open environment</span>
                <span className="text-neutral-400">&rarr;</span>
              </Link>
              {appUrl && envReady && (
                <a
                  href={appUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between w-full text-xs py-2 px-3 rounded bg-neutral-100 hover:bg-neutral-200 transition-colors text-neutral-900"
                >
                  <span>View app</span>
                  <span className="font-mono text-neutral-400 text-[10px]">{appUrl.replace(/^https?:\/\//, '')}</span>
                </a>
              )}
            </div>
          )}

          {!deploying && !deployError && deployLogs.length === 0 && !envId && (
            <p className="text-neutral-400 mt-3 text-center">
              Creates a VM and clones this repository.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
