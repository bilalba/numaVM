import { useEffect, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { api, githubConnectUrl, type VMSummary, type GitHubRepo, type RamQuota } from "../lib/api";
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
  pausing: "bg-yellow-500",
};

function VMCardMenu({
  vm,
  onDelete,
  onClone,
  onPause,
}: {
  vm: VMSummary;
  onDelete: () => void;
  onClone: () => void;
  onPause: () => void;
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
            href={vm.url}
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
            Clone VM
          </button>
          {vm.role === "owner" && vm.status === "running" && (
            <button
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setOpen(false);
                onPause();
              }}
              className="block w-full text-left px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-100 transition-colors cursor-pointer"
            >
              Pause VM
            </button>
          )}
          {vm.role === "owner" && (
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
                  Delete VM
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function VMList() {
  const [vms, setVMs] = useState<VMSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [showSshKeys, setShowSshKeys] = useState(false);
  const [githubStatus, setGithubStatus] = useState<{ connected: boolean; username: string | null } | null>(null);
  const [repoMode, setRepoMode] = useState<"none" | "existing" | "new">("none");
  const [repoSearch, setRepoSearch] = useState("");
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [reposHasMore, setReposHasMore] = useState(false);
  const [reposPage, setReposPage] = useState(1);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [newRepoName, setNewRepoName] = useState("");
  const [newRepoPrivate, setNewRepoPrivate] = useState(true);
  const [memSizeMib, setMemSizeMib] = useState(512);
  const [ramQuota, setRamQuota] = useState<RamQuota | null>(null);
  const [pausingIds, setPausingIds] = useState<Set<string>>(new Set());
  const [githubBannerDismissed, setGithubBannerDismissed] = useState(() => {
    try { return sessionStorage.getItem("github-banner-dismissed") === "1"; } catch { return false; }
  });
  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadVMs = () => {
    api
      .listVMs()
      .then((data) => setVMs(data.vms))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  const loadQuota = () => {
    api.getRamQuota().then(setRamQuota).catch(() => {});
  };

  // Handle incoming pause from VMDetail page
  useEffect(() => {
    const state = location.state as { pausingVmId?: string; pausingVmName?: string } | null;
    if (!state?.pausingVmId) return;
    const { pausingVmId, pausingVmName } = state;
    // Clear the location state so refresh doesn't re-trigger
    window.history.replaceState({}, "");
    setPausingIds((prev) => new Set(prev).add(pausingVmId));
    api.pauseVM(pausingVmId).then(
      () => { toast(`Paused ${pausingVmName || pausingVmId}`, "success"); loadVMs(); loadQuota(); },
      (err: any) => toast(err.message, "error"),
    ).finally(() => {
      setPausingIds((prev) => { const next = new Set(prev); next.delete(pausingVmId); return next; });
    });
  }, [location.state]);

  useEffect(() => {
    loadVMs();
    loadQuota();
    api.getGithubStatus().then(setGithubStatus).catch(() => {});
  }, []);

  const loadRepos = (query: string, page: number) => {
    setReposLoading(true);
    api.listGithubRepos(query || undefined, page)
      .then((data) => {
        setRepos(page === 1 ? data.repos : (prev) => [...prev, ...data.repos]);
        setReposHasMore(data.hasMore);
        setReposPage(page);
      })
      .catch(() => {})
      .finally(() => setReposLoading(false));
  };

  useEffect(() => {
    if (repoMode !== "existing") return;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      loadRepos(repoSearch, 1);
    }, repoSearch ? 300 : 0);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [repoSearch, repoMode]);

  const resetRepoState = () => {
    setRepoMode("none");
    setRepoSearch("");
    setRepos([]);
    setReposHasMore(false);
    setReposPage(1);
    setSelectedRepo(null);
    setNewRepoName("");
    setNewRepoPrivate(true);
    setMemSizeMib(512);
  };

  const handleDelete = async (vm: VMSummary) => {
    try {
      await api.deleteVM(vm.id);
      toast(`Deleted ${vm.name}`, "success");
      loadVMs();
      loadQuota();
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  const handleClone = async (vm: VMSummary) => {
    const isRunning = vm.status === "running";
    const msg = isRunning
      ? `This will briefly pause "${vm.name}" to copy its disk state. It will resume automatically after cloning.\n\nContinue?`
      : `Clone "${vm.name}"? This will create a copy with the same files and configuration.`;
    if (!window.confirm(msg)) return;

    setCreating(true);
    toast("Cloning VM...", "info");
    try {
      const result = await api.cloneVM(vm.id);
      toast(`Cloned as ${result.name}`, "success");
      setLoading(true);
      loadVMs();
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setCreating(false);
    }
  };

  const handlePause = async (vm: VMSummary) => {
    if (!window.confirm(`Pause "${vm.name}"? The VM will be snapshotted and can be resumed later.`)) return;
    setPausingIds((prev) => new Set(prev).add(vm.id));
    try {
      await api.pauseVM(vm.id);
      toast(`Paused ${vm.name}`, "success");
      loadVMs();
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setPausingIds((prev) => { const next = new Set(prev); next.delete(vm.id); return next; });
    }
  };

  const canCreate = () => {
    if (!newName.trim()) return false;
    if (repoMode === "existing" && !selectedRepo) return false;
    if (repoMode === "new" && !newRepoName.trim()) return false;
    return true;
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canCreate()) return;
    setCreating(true);
    try {
      let ghRepo: string | undefined;
      if (repoMode === "existing" && selectedRepo) {
        ghRepo = selectedRepo;
      } else if (repoMode === "new" && newRepoName.trim()) {
        const created = await api.createGithubRepo(newRepoName.trim(), newRepoPrivate);
        ghRepo = created.fullName;
      }
      await api.createVM({ name: newName.trim(), gh_repo: ghRepo, mem_size_mib: memSizeMib });
      setNewName("");
      setShowCreate(false);
      resetRepoState();
      setLoading(true);
      loadVMs();
      loadQuota();
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
        <h1 className="text-2xl font-semibold">VMs</h1>
        <div className="flex items-center gap-4">
          <button
            onClick={() => setShowSshKeys(!showSshKeys)}
            className="text-xs underline underline-offset-4 transition-opacity hover:opacity-60 cursor-pointer"
          >
            {showSshKeys ? "Close" : "SSH Keys"}
          </button>
          <button
            onClick={() => {
              setShowCreate(!showCreate);
              if (showCreate) resetRepoState();
            }}
            className="text-xs underline underline-offset-4 transition-opacity hover:opacity-60 cursor-pointer"
          >
            {showCreate ? "Cancel" : "New VM"}
          </button>
        </div>
      </div>

      {showSshKeys && (
        <div className="mb-6">
          <SshKeysPanel />
        </div>
      )}

      {/* GitHub connection banner (dismissable, only when not connected) */}
      {githubStatus && !githubStatus.connected && !githubBannerDismissed && (
        <div className="mb-6 border border-neutral-200 px-5 py-4 flex items-center justify-between bg-panel-chat">
          <span className="text-xs text-neutral-600">
            Connect GitHub to clone and push to your repositories
          </span>
          <div className="flex items-center gap-3 shrink-0 ml-4">
            <a
              href={githubConnectUrl(window.location.href)}
              className="text-xs font-medium underline underline-offset-4 transition-opacity hover:opacity-60"
            >
              Connect GitHub
            </a>
            <button
              onClick={() => {
                setGithubBannerDismissed(true);
                try { sessionStorage.setItem("github-banner-dismissed", "1"); } catch {}
              }}
              className="text-neutral-400 hover:text-neutral-600 transition-colors cursor-pointer"
              title="Dismiss"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M3 3l8 8M11 3l-8 8" />
              </svg>
            </button>
          </div>
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
                placeholder="VM name"
                maxLength={64}
                className="w-full border-0 border-b border-neutral-300 bg-transparent px-0 py-1 text-sm text-black placeholder:text-neutral-500 focus:border-black focus:outline-none"
                autoFocus
              />
              <p className="text-[10px] text-neutral-500 mt-1">A unique slug will be auto-generated for your subdomain.</p>
            </div>
            <button
              type="submit"
              disabled={creating || !canCreate()}
              className="text-xs underline underline-offset-4 transition-opacity hover:opacity-60 disabled:opacity-30 cursor-pointer shrink-0 pb-1"
            >
              {creating ? "Creating..." : "Create"}
            </button>
          </div>

          {/* RAM selector */}
          <div className="mt-4 pt-4 border-t border-neutral-200">
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-neutral-600">Memory</label>
              {ramQuota && (
                <span className="text-[10px] text-neutral-400">
                  <span className={ramQuota.plan === "free" ? "text-amber-600" : "text-neutral-400"}>
                    {ramQuota.plan_label}
                    {ramQuota.trial_active && ramQuota.trial_expires_at && (
                      <> &middot; trial ends {relativeTime(ramQuota.trial_expires_at)}</>
                    )}
                  </span>
                  {" \u00B7 "}
                  {ramQuota.used_mib} / {ramQuota.max_mib} MB used
                </span>
              )}
            </div>
            <div className="flex gap-1.5">
              {[256, 512, 768, 1024, 1280, 1536].map((size) => {
                const notInPlan = ramQuota ? !ramQuota.valid_mem_sizes.includes(size) : false;
                const exceedsQuota = ramQuota ? ramQuota.used_mib + size > ramQuota.max_mib : false;
                const disabled = notInPlan || exceedsQuota;
                const label = size >= 1024 ? `${(size / 1024).toFixed(size % 1024 ? 2 : 0)} GB` : `${size} MB`;
                return (
                  <button
                    key={size}
                    type="button"
                    disabled={disabled}
                    onClick={() => setMemSizeMib(size)}
                    title={notInPlan ? `Requires Base plan` : exceedsQuota ? "Exceeds quota" : undefined}
                    className={`flex-1 py-1.5 text-xs border transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed ${
                      memSizeMib === size
                        ? "border-black bg-white font-medium"
                        : "border-neutral-200 bg-neutral-50 hover:border-neutral-300"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Repo picker — only when GitHub is connected */}
          {githubStatus?.connected && (
            <div className="mt-4 pt-4 border-t border-neutral-200">
              <label className="text-xs text-neutral-600 mb-2 block">Repository</label>
              <div className="flex gap-4 text-xs mb-3">
                {(["none", "existing", "new"] as const).map((mode) => (
                  <label key={mode} className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="radio"
                      name="repoMode"
                      checked={repoMode === mode}
                      onChange={() => {
                        setRepoMode(mode);
                        setSelectedRepo(null);
                        setRepoSearch("");
                        setNewRepoName("");
                      }}
                      className="accent-black w-3 h-3"
                    />
                    <span className="text-neutral-700">
                      {mode === "none" ? "No repo" : mode === "existing" ? "Existing repo" : "Create new repo"}
                    </span>
                  </label>
                ))}
              </div>

              {repoMode === "existing" && (
                <div>
                  <input
                    type="text"
                    value={repoSearch}
                    onChange={(e) => setRepoSearch(e.target.value)}
                    placeholder="Search repositories..."
                    className="w-full border-0 border-b border-neutral-300 bg-transparent px-0 py-1 text-sm text-black placeholder:text-neutral-500 focus:border-black focus:outline-none mb-2"
                  />
                  <div className="max-h-48 overflow-y-auto">
                    {reposLoading && repos.length === 0 ? (
                      <p className="text-xs text-neutral-500 py-2">Loading...</p>
                    ) : repos.length === 0 ? (
                      <p className="text-xs text-neutral-500 py-2">No repositories found</p>
                    ) : (
                      repos.map((repo) => (
                        <button
                          key={repo.fullName}
                          type="button"
                          onClick={() => setSelectedRepo(repo.fullName)}
                          className={`w-full text-left px-3 py-2 text-xs border transition-colors cursor-pointer mb-1 ${
                            selectedRepo === repo.fullName
                              ? "border-black bg-white"
                              : "border-neutral-200 bg-neutral-50 hover:border-neutral-300"
                          }`}
                        >
                          <span className="font-medium">{repo.fullName}</span>
                          {repo.private && <span className="text-neutral-400 ml-2">private</span>}
                        </button>
                      ))
                    )}
                    {reposHasMore && (
                      <button
                        type="button"
                        onClick={() => loadRepos(repoSearch, reposPage + 1)}
                        disabled={reposLoading}
                        className="text-xs underline underline-offset-4 text-neutral-500 hover:text-neutral-700 transition-colors cursor-pointer py-1 disabled:opacity-30"
                      >
                        {reposLoading ? "Loading..." : "Load more"}
                      </button>
                    )}
                  </div>
                </div>
              )}

              {repoMode === "new" && (
                <div className="flex gap-4 items-end">
                  <div className="flex-1">
                    <input
                      type="text"
                      value={newRepoName}
                      onChange={(e) => setNewRepoName(e.target.value)}
                      placeholder="Repository name"
                      maxLength={100}
                      className="w-full border-0 border-b border-neutral-300 bg-transparent px-0 py-1 text-sm text-black placeholder:text-neutral-500 focus:border-black focus:outline-none"
                    />
                  </div>
                  <label className="flex items-center gap-1.5 text-xs text-neutral-600 cursor-pointer shrink-0 pb-1">
                    <input
                      type="checkbox"
                      checked={newRepoPrivate}
                      onChange={(e) => setNewRepoPrivate(e.target.checked)}
                      className="accent-black w-3 h-3"
                    />
                    Private
                  </label>
                </div>
              )}
            </div>
          )}
        </form>
      )}

      {error && (
        <div className="mb-6 border border-neutral-300 p-4 text-sm text-red-600">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-neutral-500 text-xs">Loading VMs...</p>
      ) : vms.length === 0 ? (
        <div className="text-center py-16">
          <h2 className="text-2xl font-semibold mb-3">Welcome to NumaVM</h2>
          <p className="text-xs text-neutral-600 mb-8 max-w-lg mx-auto">
            Create always-on development VMs with built-in AI agents, web terminals, and team collaboration.
          </p>
          <button
            onClick={() => setShowCreate(true)}
            className="text-xs underline underline-offset-4 transition-opacity hover:opacity-60 cursor-pointer mb-12"
          >
            Create Your First VM
          </button>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 max-w-3xl mx-auto text-left">
            <div className="bg-panel-chat border border-neutral-200 p-5">
              <div className="text-sm font-semibold mb-2">Terminal</div>
              <p className="text-xs text-neutral-600">Full web terminal with SSH access to your persistent VM.</p>
            </div>
            <div className="bg-panel-chat border border-neutral-200 p-5">
              <div className="text-sm font-semibold mb-2">AI Agents</div>
              <p className="text-xs text-neutral-600">Drive Codex, Claude Code, and OpenCode from a unified chat interface.</p>
            </div>
            <div className="bg-panel-chat border border-neutral-200 p-5">
              <div className="text-sm font-semibold mb-2">Collaboration</div>
              <p className="text-xs text-neutral-600">Share VMs with your team using role-based access control.</p>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {vms.map((vm) => {
            const isPausing = pausingIds.has(vm.id);
            const displayStatus = isPausing ? "pausing" : vm.status;
            return (
            <div
              key={vm.id}
              onClick={() => !isPausing && navigate(`/vm/${vm.id}`)}
              className={`bg-panel-chat border border-neutral-200 p-5 transition-opacity cursor-pointer ${isPausing ? "opacity-60" : "hover:opacity-80"}`}
            >
              <div className="flex items-center gap-2 mb-2">
                <span
                  className={`w-1.5 h-1.5 rounded-full ${isPausing ? "bg-yellow-500 animate-pulse" : statusColors[vm.status] || "bg-neutral-400"}`}
                />
                <span className="text-sm font-semibold truncate flex-1">{vm.name}</span>
                <VMCardMenu
                  vm={vm}
                  onDelete={() => handleDelete(vm)}
                  onClone={() => handleClone(vm)}
                  onPause={() => handlePause(vm)}
                />
              </div>
              <p className="text-xs text-neutral-500 mb-3">{vm.id}</p>
              <div className="flex items-center justify-between text-xs text-neutral-500">
                <span className="capitalize">{isPausing ? "Pausing..." : vm.role}</span>
                <span>
                  {vm.mem_size_mib >= 1024
                    ? `${(vm.mem_size_mib / 1024).toFixed(vm.mem_size_mib % 1024 ? 2 : 0)} GB`
                    : `${vm.mem_size_mib} MB`}
                  {" RAM"}
                </span>
                <span>{relativeTime(vm.created_at)}</span>
              </div>
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
