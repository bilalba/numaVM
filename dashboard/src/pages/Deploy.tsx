import { useEffect, useState, useCallback, useRef } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type Quota } from "../lib/api";
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
  const [vmName, setVMName] = useState("");
  const [nameStatus, setNameStatus] = useState<"idle" | "checking" | "available" | "taken" | "invalid" | "reserved" | "too_short">("idle");
  const [nameMessage, setNameMessage] = useState("");
  const [vmId, setVMId] = useState<string | null>(null);
  const [vmReady, setVMReady] = useState(false);
  const [appUrl, setAppUrl] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [memSizeMib, setMemSizeMib] = useState<number>(256);
  const [diskSizeGib, setDiskSizeGib] = useState<number>(1);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const nameCheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch quota on mount
  useEffect(() => {
    api.getRamQuota().then((q) => {
      setQuota(q);
      // Set defaults to first valid size
      if (q.valid_mem_sizes.length > 0 && !q.valid_mem_sizes.includes(256)) {
        setMemSizeMib(q.valid_mem_sizes[0]);
      }
      if (q.valid_disk_sizes.length > 0 && !q.valid_disk_sizes.includes(1)) {
        setDiskSizeGib(q.valid_disk_sizes[0]);
      }
    }).catch(() => {});
  }, []);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // Client-side name validation + debounced availability check
  useEffect(() => {
    if (nameCheckTimer.current) clearTimeout(nameCheckTimer.current);
    const name = vmName;

    if (!name) {
      setNameStatus("idle");
      setNameMessage("");
      return;
    }
    if (name.length < 4) {
      setNameStatus("too_short");
      setNameMessage(`${4 - name.length} more character${4 - name.length === 1 ? "" : "s"} needed`);
      return;
    }
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name) || name.includes("--")) {
      setNameStatus("invalid");
      setNameMessage("Only lowercase letters, numbers, and hyphens");
      return;
    }
    if (name.length > 40) {
      setNameStatus("invalid");
      setNameMessage("Maximum 40 characters");
      return;
    }

    setNameStatus("checking");
    setNameMessage("");
    nameCheckTimer.current = setTimeout(() => {
      api.checkNameAvailability(name).then((res) => {
        if (name !== vmName) return;
        if (res.available) {
          setNameStatus("available");
          setNameMessage("");
        } else if (res.reason === "reserved") {
          setNameStatus("reserved");
          setNameMessage("This name is reserved");
        } else if (res.reason === "taken") {
          setNameStatus("taken");
          setNameMessage("Already taken");
        } else {
          setNameStatus("invalid");
          setNameMessage(res.message || "Invalid name");
        }
      }).catch(() => {
        setNameStatus("idle");
      });
    }, 300);
    return () => { if (nameCheckTimer.current) clearTimeout(nameCheckTimer.current); };
  }, [vmName]);

  const handleNameChange = (value: string) => {
    setVMName(value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
  };

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
        // Normalize repo name for VM name (lowercase, valid chars only)
        setVMName(data.name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, ""));
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
    if (!parsed || !vmName.trim()) return;
    setDeploying(true);
    setDeployLogs([]);
    setDeployError(null);
    setVMId(null);
    setVMReady(false);
    setAppUrl(null);

    try {
      const result = await api.createVM({ name: vmName.trim(), gh_repo: parsed, mem_size_mib: memSizeMib, disk_size_gib: diskSizeGib });
      setVMId(result.id);
      if (result.url) setAppUrl(result.url);

      // Poll for real status updates
      let lastDetail = "";
      pollRef.current = setInterval(async () => {
        try {
          const vm = await api.getVM(result.id);
          // Append new status_detail lines
          if (vm.status_detail && vm.status_detail !== lastDetail) {
            lastDetail = vm.status_detail;
            if (vm.status_detail.startsWith("Error:")) {
              setDeployError(vm.status_detail);
              // Don't stop deploying — VM is still usable via SSH
              if (pollRef.current) clearInterval(pollRef.current);
              setDeploying(false);
              setVMReady(true); // still show the link
              return;
            }
            setDeployLogs((prev) => [...prev, vm.status_detail!]);
          }
          // Done — VM is running
          if (vm.status === "running") {
            if (pollRef.current) clearInterval(pollRef.current);
            setDeployLogs((prev) => [...prev, "Ready"]);
            setDeploying(false);
            setVMReady(true);
          }
          // Failed
          if (vm.status === "error") {
            if (pollRef.current) clearInterval(pollRef.current);
            setDeployError(vm.status_detail || "VM creation failed");
            setDeploying(false);
          }
        } catch {
          // VM may have been deleted on error rollback
          if (pollRef.current) clearInterval(pollRef.current);
          setDeployError("VM creation failed");
          setDeploying(false);
        }
      }, 1000);
    } catch (err: any) {
      setDeployError(err.message || "Failed to create VM");
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

      <h1 className="text-lg font-medium text-foreground mb-6">Deploy a repository</h1>

      {/* Repo input */}
      <form onSubmit={handleRepoSubmit} className="mb-6">
        <label className="text-neutral-600 mb-1 block">GitHub repository</label>
        <div className="flex gap-3 items-end">
          <input
            type="text"
            value={repoInput}
            onChange={(e) => setRepoInput(e.target.value)}
            placeholder="owner/repo or https://github.com/owner/repo"
            className="flex-1 border-0 border-b border-neutral-300 bg-transparent px-0 py-1 text-sm text-foreground placeholder:text-neutral-400 focus:border-foreground focus:outline-none"
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
                className="text-sm font-medium text-foreground hover:underline"
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
            <label className="text-neutral-600 mb-1 block">VM name</label>
            <input
              type="text"
              value={vmName}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="my-project"
              maxLength={40}
              disabled={deploying}
              className="w-full border-0 border-b border-neutral-300 bg-transparent px-0 py-1 text-sm text-foreground placeholder:text-neutral-500 focus:border-foreground focus:outline-none disabled:opacity-50"
              style={{ textTransform: "lowercase" }}
            />
            <div className="flex items-center justify-between mt-1">
              <div className="text-[10px]">
                {nameStatus === "idle" && <span className="text-neutral-400">Your VM's web address and SSH username</span>}
                {nameStatus === "too_short" && <span className="text-neutral-400">{nameMessage}</span>}
                {nameStatus === "checking" && <span className="text-neutral-400">Checking...</span>}
                {nameStatus === "available" && <span className="text-green-600">Available</span>}
                {nameStatus === "taken" && <span className="text-red-500">{nameMessage}</span>}
                {nameStatus === "reserved" && <span className="text-red-500">{nameMessage}</span>}
                {nameStatus === "invalid" && <span className="text-red-500">{nameMessage}</span>}
              </div>
              {vmName.length >= 4 && nameStatus !== "invalid" && nameStatus !== "reserved" && (
                <span className="text-[10px] text-neutral-400">{vmName}.{(import.meta.env.VITE_API_URL || "//api.localhost").replace(/^\/\/api\./, "").replace(/^api\./, "")}</span>
              )}
            </div>
          </div>

          {/* Advanced options */}
          {!vmId && (
            <div className="mb-6">
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="text-neutral-400 hover:text-neutral-600 text-[11px] cursor-pointer"
              >
                {showAdvanced ? "\u25BE" : "\u25B8"} Advanced
              </button>
              {showAdvanced && quota && (
                <div className="mt-3 space-y-3 pl-3 border-l border-neutral-200">
                  <div>
                    <label className="text-neutral-500 text-[11px] block mb-1">RAM</label>
                    <select
                      value={memSizeMib}
                      onChange={(e) => setMemSizeMib(Number(e.target.value))}
                      disabled={deploying}
                      className="border border-neutral-300 rounded px-2 py-1 text-xs bg-transparent text-foreground w-full"
                    >
                      {quota.valid_mem_sizes.map((s) => (
                        <option key={s} value={s}>{s >= 1024 ? `${(s / 1024).toFixed(1)} GiB` : `${s} MiB`}</option>
                      ))}
                    </select>
                    <p className="text-neutral-400 text-[10px] mt-1">
                      {quota.available_mib} MiB available of {quota.max_mib} MiB
                    </p>
                  </div>
                  <div>
                    <label className="text-neutral-500 text-[11px] block mb-1">Disk</label>
                    <select
                      value={diskSizeGib}
                      onChange={(e) => setDiskSizeGib(Number(e.target.value))}
                      disabled={deploying}
                      className="border border-neutral-300 rounded px-2 py-1 text-xs bg-transparent text-foreground w-full"
                    >
                      {quota.valid_disk_sizes.map((s) => (
                        <option key={s} value={s}>{s} GiB</option>
                      ))}
                    </select>
                    <p className="text-neutral-400 text-[10px] mt-1">
                      {quota.disk_available_gib} GiB available of {quota.disk_max_gib} GiB
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          {!vmId && (
            <button
              onClick={handleDeploy}
              disabled={deploying || nameStatus !== "available"}
              className="w-full py-2 bg-foreground text-background rounded hover:opacity-80 disabled:opacity-50 cursor-pointer text-xs"
            >
              {deploying ? "Launching..." : "Launch VM"}
            </button>
          )}

          {/* Real progress log */}
          {deployLogs.length > 0 && (
            <div className="mt-4 font-mono text-[11px] leading-relaxed">
              {deployLogs.map((msg, i) => {
                const isLatest = i === deployLogs.length - 1;
                const isDone = msg === "Ready";
                return (
                  <div key={i} className={`flex items-center gap-2 ${isDone ? "text-green-600" : isLatest && deploying ? "text-foreground" : "text-neutral-400"}`}>
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

          {/* Links section — visible once we have a VM ID */}
          {vmId && (
            <div className="mt-5 border-t border-neutral-200 pt-4 space-y-2">
              <Link
                to={`/vm/${vmId}`}
                className="flex items-center justify-between w-full text-xs py-2 px-3 rounded bg-neutral-100 hover:bg-neutral-200 transition-colors text-foreground"
              >
                <span>Open VM</span>
                <span className="text-neutral-400">&rarr;</span>
              </Link>
              {appUrl && vmReady && (
                <a
                  href={appUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between w-full text-xs py-2 px-3 rounded bg-neutral-100 hover:bg-neutral-200 transition-colors text-foreground"
                >
                  <span>View app</span>
                  <span className="font-mono text-neutral-400 text-[10px]">{appUrl.replace(/^https?:\/\//, '')}</span>
                </a>
              )}
            </div>
          )}

          {!deploying && !deployError && deployLogs.length === 0 && !vmId && (
            <p className="text-neutral-400 mt-3 text-center">
              Creates a VM and clones this repository.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
