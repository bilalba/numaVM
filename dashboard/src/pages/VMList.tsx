import { useEffect, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { api, githubConnectUrl, type VMSummary, type GitHubRepo, type RamQuota, type ImageInfo } from "../lib/api";
import { useToast } from "../components/Toast";
import { relativeTime } from "../lib/time";

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

const statusColors: Record<string, string> = {
  running: "bg-green-500",
  creating: "bg-yellow-500",
  stopped: "bg-neutral-400",
  error: "bg-red-500",
  snapshotted: "bg-blue-500",
  paused: "bg-blue-500",
  pausing: "bg-yellow-500",
  deleting: "bg-red-500",
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
        className="p-1 -m-1 text-neutral-400 hover:text-foreground transition-colors cursor-pointer"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <circle cx="8" cy="3" r="1.5" />
          <circle cx="8" cy="8" r="1.5" />
          <circle cx="8" cy="13" r="1.5" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-6 z-50 min-w-[160px] bg-surface border border-neutral-200 shadow-sm py-1">
          <a
            href={vm.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="block px-3 py-1.5 text-xs text-foreground hover:bg-neutral-100 transition-colors"
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
            className="block w-full text-left px-3 py-1.5 text-xs text-foreground hover:bg-neutral-100 transition-colors cursor-pointer"
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
              className="block w-full text-left px-3 py-1.5 text-xs text-foreground hover:bg-neutral-100 transition-colors cursor-pointer"
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
  const [nameStatus, setNameStatus] = useState<"idle" | "checking" | "available" | "taken" | "invalid" | "reserved" | "too_short">("idle");
  const [nameMessage, setNameMessage] = useState("");
  const [creating, setCreating] = useState(false);
  const [githubStatus, setGithubStatus] = useState<{ connected: boolean; username: string | null; dev_mode?: boolean } | null>(null);
  const [repoMode, setRepoMode] = useState<"none" | "existing" | "new">("none");
  const [repoSearch, setRepoSearch] = useState("");
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [reposHasMore, setReposHasMore] = useState(false);
  const [reposPage, setReposPage] = useState(1);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [newRepoName, setNewRepoName] = useState("");
  const [newRepoPrivate, setNewRepoPrivate] = useState(true);
  const [memSizeMib, setMemSizeMib] = useState(256);
  const [diskSizeGib, setDiskSizeGib] = useState(1);
  const [initialPrompt, setInitialPrompt] = useState("");
  const [selectedImage, setSelectedImage] = useState("alpine");
  const [availableImages, setAvailableImages] = useState<ImageInfo[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [ramQuota, setRamQuota] = useState<RamQuota | null>(null);
  const [pausingIds, setPausingIds] = useState<Set<string>>(new Set());
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [githubBannerDismissed, setGithubBannerDismissed] = useState(() => {
    try { return sessionStorage.getItem("github-banner-dismissed") === "1"; } catch { return false; }
  });
  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nameCheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    api.getImages().then((data) => {
      setAvailableImages(data.images);
      setSelectedImage(data.default);
    }).catch(() => {});
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

  // Client-side name validation + debounced availability check
  useEffect(() => {
    if (nameCheckTimer.current) clearTimeout(nameCheckTimer.current);
    const name = newName;

    if (!name) {
      setNameStatus("idle");
      setNameMessage("");
      return;
    }

    // Client-side checks first
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
        // Only update if name hasn't changed
        if (name !== newName) return;
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
  }, [newName]);

  const resetRepoState = () => {
    setRepoMode("none");
    setRepoSearch("");
    setRepos([]);
    setReposHasMore(false);
    setReposPage(1);
    setSelectedRepo(null);
    setNewRepoName("");
    setNewRepoPrivate(true);
    setMemSizeMib(ramQuota?.valid_mem_sizes?.[0] ?? 256);
    setDiskSizeGib(ramQuota?.valid_disk_sizes?.[0] ?? 1);
    setSelectedImage("alpine");
    setShowAdvanced(false);
    setNameStatus("idle");
    setNameMessage("");
  };

  const handleDelete = async (vm: VMSummary) => {
    setDeletingIds((prev) => new Set(prev).add(vm.id));
    try {
      await api.deleteVM(vm.id);
      toast(`Deleted ${vm.name}`, "success");
      loadVMs();
      loadQuota();
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setDeletingIds((prev) => { const next = new Set(prev); next.delete(vm.id); return next; });
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
    if (nameStatus !== "available") return false;
    if (repoMode === "existing" && !selectedRepo) return false;
    if (repoMode === "new" && !newRepoName.trim()) return false;
    return true;
  };

  const handleNameChange = (value: string) => {
    // Normalize: lowercase, strip invalid chars
    setNewName(value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
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
      const prompt = initialPrompt.trim() || undefined;
      const newVM = await api.createVM({ name: newName.trim(), gh_repo: ghRepo, mem_size_mib: memSizeMib, disk_size_gib: diskSizeGib, image: selectedImage, initial_prompt: prompt });
      setNewName("");
      setInitialPrompt("");
      setShowCreate(false);
      resetRepoState();
      navigate(`/vm/${newVM.id}?tab=opencode`, { state: { pendingSession: !!prompt, vmData: newVM } });
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

      {/* GitHub connection banner (dismissable, only when not connected) */}
      {githubStatus?.dev_mode && githubStatus && !githubStatus.connected && !githubBannerDismissed && (
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => { setShowCreate(false); resetRepoState(); }}>
          <form
            onSubmit={handleCreate}
            onClick={(e) => e.stopPropagation()}
            className="bg-panel-chat border border-neutral-200 p-6 w-full max-w-lg mx-4 max-h-[80vh] overflow-y-auto"
          >
            <h2 className="text-sm font-semibold mb-4">New VM</h2>

            <div className="mb-3">
              <label className="text-xs text-neutral-600 mb-1 block">Name</label>
              <input
                type="text"
                value={newName}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="my-project"
                maxLength={40}
                className="w-full border-0 border-b border-neutral-300 bg-transparent px-0 py-1 text-sm text-foreground placeholder:text-neutral-500 focus:border-foreground focus:outline-none"
                style={{ textTransform: "lowercase" }}
                autoFocus
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
                {newName.length >= 4 && nameStatus !== "invalid" && nameStatus !== "reserved" && (
                  <span className="text-[10px] text-neutral-400">{newName}.{(import.meta.env.VITE_API_URL || "//api.localhost").replace(/^\/\/api\./, "").replace(/^api\./, "")}</span>
                )}
              </div>
            </div>

            {/* Initial prompt */}
            <div className="mb-3">
              <label className="text-xs text-neutral-600 mb-1 block">Prompt <span className="text-neutral-400">(optional)</span></label>
              <textarea
                value={initialPrompt}
                onChange={(e) => setInitialPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (canCreate()) handleCreate(e);
                  }
                }}
                placeholder="Start an OpenCode session with this prompt..."
                rows={1}
                className="w-full border-0 border-b border-neutral-300 bg-transparent px-0 py-1 text-sm text-foreground placeholder:text-neutral-500 focus:border-foreground focus:outline-none resize-none leading-normal"
              />
            </div>

            {/* Advanced options (RAM + Disk) */}
            <div className="mb-3 pt-3 border-t border-neutral-200">
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="text-neutral-400 hover:text-neutral-600 text-[11px] cursor-pointer"
              >
                {showAdvanced ? "\u25BE" : "\u25B8"} Advanced
                {!showAdvanced && <span className="ml-2 text-neutral-500">{memSizeMib >= 1024 ? `${(memSizeMib / 1024).toFixed(memSizeMib % 1024 ? 2 : 0)} GB` : `${memSizeMib} MB`} RAM, {diskSizeGib} GB disk{selectedImage !== "alpine" ? `, ${selectedImage}` : ""}</span>}
              </button>
              {showAdvanced && (
                <div className="mt-3 space-y-4">
                  <div>
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
                      {(ramQuota?.valid_mem_sizes || [256]).map((size) => {
                        const exceedsQuota = ramQuota ? ramQuota.used_mib + size > ramQuota.max_mib : false;
                        const label = size >= 1024 ? `${(size / 1024).toFixed(size % 1024 ? 2 : 0)} GB` : `${size} MB`;
                        return (
                          <button
                            key={size}
                            type="button"
                            disabled={exceedsQuota}
                            onClick={() => setMemSizeMib(size)}
                            title={exceedsQuota ? "Exceeds quota" : undefined}
                            className={`flex-1 py-1.5 text-xs border transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed ${
                              memSizeMib === size
                                ? "border-foreground bg-surface font-medium"
                                : "border-neutral-200 bg-neutral-100 hover:border-neutral-300"
                            }`}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-xs text-neutral-600">Disk</label>
                      {ramQuota && (
                        <span className="text-[10px] text-neutral-400">
                          {ramQuota.disk_used_gib} / {ramQuota.disk_max_gib} GB used
                        </span>
                      )}
                    </div>
                    <div className="flex gap-1.5">
                      {(ramQuota?.valid_disk_sizes || [1]).map((size) => {
                        const exceedsQuota = ramQuota ? ramQuota.disk_used_gib + size > ramQuota.disk_max_gib : false;
                        return (
                          <button
                            key={size}
                            type="button"
                            disabled={exceedsQuota}
                            onClick={() => setDiskSizeGib(size)}
                            title={exceedsQuota ? "Exceeds disk quota" : undefined}
                            className={`flex-1 py-1.5 text-xs border transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed ${
                              diskSizeGib === size
                                ? "border-foreground bg-surface font-medium"
                                : "border-neutral-200 bg-neutral-100 hover:border-neutral-300"
                            }`}
                          >
                            {size} GB
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  {availableImages.length > 1 && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-xs text-neutral-600">Image</label>
                      </div>
                      <div className="flex gap-1.5">
                        {availableImages.map((img) => (
                          <button
                            key={img.distro}
                            type="button"
                            onClick={() => setSelectedImage(img.distro)}
                            className={`flex-1 py-1.5 text-xs border transition-colors cursor-pointer ${
                              selectedImage === img.distro
                                ? "border-foreground bg-surface font-medium"
                                : "border-neutral-200 bg-neutral-100 hover:border-neutral-300"
                            }`}
                          >
                            {img.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Repo picker — only when GitHub is connected */}
            {githubStatus?.connected && (
              <div className="mb-3 pt-3 border-t border-neutral-200">
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
                        className="accent-foreground w-3 h-3"
                      />
                      <span className="text-foreground">
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
                      className="w-full border-0 border-b border-neutral-300 bg-transparent px-0 py-1 text-sm text-foreground placeholder:text-neutral-500 focus:border-foreground focus:outline-none mb-2"
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
                                ? "border-foreground bg-surface"
                                : "border-neutral-200 bg-neutral-100 hover:border-neutral-300"
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
                          className="text-xs underline underline-offset-4 text-neutral-500 hover:text-foreground transition-colors cursor-pointer py-1 disabled:opacity-30"
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
                        className="w-full border-0 border-b border-neutral-300 bg-transparent px-0 py-1 text-sm text-foreground placeholder:text-neutral-500 focus:border-foreground focus:outline-none"
                      />
                    </div>
                    <label className="flex items-center gap-1.5 text-xs text-neutral-600 cursor-pointer shrink-0 pb-1">
                      <input
                        type="checkbox"
                        checked={newRepoPrivate}
                        onChange={(e) => setNewRepoPrivate(e.target.checked)}
                        className="accent-foreground w-3 h-3"
                      />
                      Private
                    </label>
                  </div>
                )}
              </div>
            )}

            {/* Dialog footer */}
            <div className="flex justify-end gap-3 pt-4 border-t border-neutral-200">
              <button
                type="button"
                onClick={() => { setShowCreate(false); resetRepoState(); }}
                className="text-xs text-neutral-500 hover:text-foreground transition-colors cursor-pointer px-3 py-1.5"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={creating || !canCreate()}
                className="text-xs bg-foreground text-surface px-4 py-1.5 transition-opacity hover:opacity-80 disabled:opacity-30 cursor-pointer"
              >
                {creating ? "Creating..." : "Create"}
              </button>
            </div>
          </form>
        </div>
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
            const isDeleting = deletingIds.has(vm.id);
            const isBusy = isPausing || isDeleting;
            return (
            <div
              key={vm.id}
              onClick={() => !isBusy && navigate(`/vm/${vm.id}`)}
              className={`bg-panel-chat border border-neutral-200 p-5 transition-opacity cursor-pointer ${isBusy ? "opacity-60" : "hover:opacity-80"}`}
            >
              <div className="flex items-center gap-2 mb-2">
                <span
                  className={`w-1.5 h-1.5 rounded-full ${isDeleting ? "bg-red-500 animate-pulse" : isPausing ? "bg-yellow-500 animate-pulse" : statusColors[vm.status] || "bg-neutral-400"}`}
                />
                <span className="text-sm font-semibold truncate flex-1">{vm.name}</span>
                <VMCardMenu
                  vm={vm}
                  onDelete={() => handleDelete(vm)}
                  onClone={() => handleClone(vm)}
                  onPause={() => handlePause(vm)}
                />
              </div>
              <p className="text-xs text-neutral-500 mb-3 truncate">{new URL(vm.url).hostname}</p>
              <div className="flex items-center justify-between text-xs text-neutral-500">
                <span className="capitalize">{isDeleting ? "Deleting..." : isPausing ? "Pausing..." : vm.role}</span>
                <span>
                  {vm.region && <>{vm.region} &middot; </>}
                  {vm.image !== "alpine" && <>{vm.image} &middot; </>}
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

      {/* LLM credits — shown when lifecycle hook provides usage */}
      {ramQuota && vms.length > 0 && ramQuota.llm_budget != null && (
        (ramQuota.llm_used_pct ?? 0) >= 80 ? (
          <div className={`mt-4 px-4 py-2.5 border text-[11px] ${(ramQuota.llm_used_pct ?? 0) >= 100 ? "border-red-200 bg-red-50 text-red-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}>
            {(ramQuota.llm_used_pct ?? 0) >= 100
              ? `LLM credit limit reached ($${(ramQuota.llm_spend ?? 0).toFixed(2)} / $${ramQuota.llm_budget.toFixed(2)}).`
              : `$${(ramQuota.llm_spend ?? 0).toFixed(2)} / $${ramQuota.llm_budget.toFixed(2)} LLM credits used.`}
          </div>
        ) : (
          <p className="mt-4 text-[10px] text-neutral-400 text-right">
            LLM: ${(ramQuota.llm_spend ?? 0).toFixed(2)} / ${ramQuota.llm_budget.toFixed(2)}
          </p>
        )
      )}

      {/* Data transfer — subtle inline, only prominent when near/over limit */}
      {ramQuota && vms.length > 0 && ramQuota.data_max_bytes > 0 && (
        ramQuota.data_used_pct >= 80 ? (
          <div className={`mt-4 px-4 py-2.5 border text-[11px] ${ramQuota.data_used_pct >= 100 ? "border-red-200 bg-red-50 text-red-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}>
            {ramQuota.data_used_pct >= 100
              ? `Monthly data limit reached (${formatBytes(ramQuota.data_used_bytes)} / ${formatBytes(ramQuota.data_max_bytes)}). VMs paused until next month.`
              : `${formatBytes(ramQuota.data_used_bytes)} / ${formatBytes(ramQuota.data_max_bytes)} data transfer used this month.`}
          </div>
        ) : (
          <p className="mt-4 text-[10px] text-neutral-400 text-right">
            Data: {formatBytes(ramQuota.data_used_bytes)} / {formatBytes(ramQuota.data_max_bytes)}
          </p>
        )
      )}
    </div>
  );
}
