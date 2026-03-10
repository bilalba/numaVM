const API_BASE = import.meta.env.VITE_API_URL || "//api.localhost";

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    ...options?.headers as Record<string, string>,
  };
  if (options?.body) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers,
    ...options,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `API error: ${res.status}`);
  }

  return res.json();
}

export interface VMSummary {
  id: string;
  name: string;
  status: string;
  role: string;
  url: string;
  repo_url?: string;
  created_at: string;
  mem_size_mib: number;
  disk_size_gib: number;
  image: string;
  image_version: number;
  is_public: boolean;
}

export interface Quota {
  used_mib: number;
  max_mib: number;
  available_mib: number;
  disk_used_gib: number;
  disk_max_gib: number;
  disk_available_gib: number;
  valid_disk_sizes: number[];
  data_used_bytes: number;
  data_max_bytes: number;
  data_used_pct: number;
  plan: string;
  plan_label: string;
  valid_mem_sizes: number[];
  trial_active: boolean;
  trial_expires_at: string | null;
}

/** @deprecated Use Quota instead */
export type RamQuota = Quota;

export interface VMDetail {
  id: string;
  name: string;
  status: string;
  status_detail: string | null;
  url: string;
  repo_url?: string;
  ssh_command: string;
  ssh_port: number;
  app_port: number;
  opencode_port: number;
  vm_status: {
    running: boolean;
    status: string;
    startedAt: string | null;
    vsockCid: number;
  } | null;
  role: string;
  created_at: string;
  mem_size_mib: number;
  image: string;
  image_version: number;
  is_public: boolean;
  vm_ipv6?: string | null;
  quota_error?: {
    message: string;
    current_ram_mib: number;
    env_ram_mib: number;
    max_ram_mib: number;
    plan: string;
  };
  disk_quota_error?: {
    message: string;
    used_gib: number;
    vm_gib: number;
    max_gib: number;
    plan: string;
  };
  data_quota_error?: {
    message: string;
    data_used_bytes: number;
    data_max_bytes: number;
    plan: string;
  };
}

export interface ClaudeSession {
  id: string;
  title: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AgentSession {
  id: string;
  vm_id: string;
  agent_type: "codex" | "opencode";
  thread_id: string | null;
  title: string | null;
  cwd: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface AgentMessage {
  id: string;
  session_id: string;
  role: "user" | "assistant" | "system" | "tool" | "reasoning";
  content: string;
  metadata: string | null;
  created_at: string;
}

export interface OpenCodeProvider {
  id: string;
  name: string;
  models: { id: string; name: string }[];
}

export interface OpenCodePopularProvider {
  id: string;
  name: string;
  env: string[];
}

export type ApprovalPolicy = "on-request" | "unless-allow-listed" | "never";
export type SandboxPolicy = "read-only" | "workspace-write" | "full-access";
export type ReasoningEffort = "low" | "medium" | "high";
export type ApprovalDecision = "accept" | "acceptForSession" | "always" | "decline";

export interface CodexModel {
  id: string;
  displayName: string;
  isDefault: boolean;
  reasoningEffort?: ReasoningEffort[];
  inputModalities?: string[];
  hidden?: boolean;
}

export interface CodexThread {
  id: string;
  title?: string;
  model?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface AccessEntry {
  user_id: string;
  role: string;
  email: string;
  name: string | null;
}

export interface FileEntry {
  name: string;
  type: "file" | "dir" | "symlink";
  size: number;
  modified: string;
}

export interface FileContent {
  path: string;
  binary: boolean;
  mimeType: string;
  size: number;
  content: string | null;
}

export interface GitCommit {
  hash: string;
  author: string;
  email: string;
  date: string;
  message: string;
}

export interface TerminalSession {
  name: string;
  windows: number;
  created: number;
  attached: boolean;
}

export interface User {
  id: string;
  email: string;
  name?: string;
  avatar_url?: string;
  github_username?: string;
  has_github_token?: boolean;
  plan?: string;
  plan_label?: string;
  trial_active?: boolean;
  trial_expires_at?: string | null;
  dev_mode?: boolean;
}

export interface Subscription {
  plan: string;
  plan_label: string;
  trial_active: boolean;
  trial_expires_at: string | null;
  stripe_subscription_id: string | null;
  stripe_status: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
}

export interface ImageInfo {
  distro: string;
  label: string;
  distro_version: string;
  node_version: string;
}

export interface FirewallRule {
  proto: "tcp" | "udp";
  port: number;
  source: string;
  description?: string;
}

export interface GitHubRepo {
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  updatedAt: string;
}

export const api = {
  getUser: () => apiFetch<User>("/me"),

  listVMs: () => apiFetch<{ vms: VMSummary[] }>("/vms"),

  getVM: (id: string) => apiFetch<VMDetail>(`/vms/${id}`),

  createVM: (body: { name: string; gh_repo?: string; mem_size_mib?: number; disk_size_gib?: number; image?: string; initial_prompt?: string }) =>
    apiFetch<{ id: string; name: string; url: string; repo_url?: string; ssh_command: string; ssh_port: number; status: string }>(
      "/vms",
      { method: "POST", body: JSON.stringify(body) }
    ),

  getRamQuota: () => apiFetch<Quota>("/vms/quota"),

  getImages: () => apiFetch<{ images: ImageInfo[]; default: string }>("/images"),

  deleteVM: (id: string) =>
    apiFetch<{ ok: boolean }>(`/vms/${id}`, { method: "DELETE" }),

  cloneVM: (id: string, name?: string) =>
    apiFetch<{ id: string; name: string; url: string; repo_url?: string; ssh_command: string; ssh_port: number; status: string }>(
      `/vms/${id}/clone`,
      { method: "POST", body: JSON.stringify(name ? { name } : {}) }
    ),

  pauseVM: (id: string) =>
    apiFetch<{ ok: boolean; message: string }>(`/vms/${id}/pause`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  getClaudeSessions: (vmId: string) =>
    apiFetch<{ sessions: ClaudeSession[] }>(`/vms/${vmId}/claude/sessions`),

  // File browser
  listFiles: (vmId: string, path: string) =>
    apiFetch<{ path: string; entries: FileEntry[] }>(`/vms/${vmId}/files?path=${encodeURIComponent(path)}`),

  // OpenCode providers
  getOpenCodeProviders: (vmId: string) =>
    apiFetch<{ connected: OpenCodeProvider[]; popular: OpenCodePopularProvider[]; default: Record<string, string> }>(
      `/vms/${vmId}/opencode/providers`
    ),

  // Agent session APIs
  createAgentSession: (vmId: string, agentType: "codex" | "opencode", opts?: { model?: string; providerID?: string; modelID?: string; cwd?: string; effort?: ReasoningEffort; approvalPolicy?: ApprovalPolicy; sandboxPolicy?: SandboxPolicy; prompt?: string }) =>
    apiFetch<AgentSession>(`/vms/${vmId}/agents/${agentType}/sessions`, {
      method: "POST",
      body: JSON.stringify({
        ...(opts?.model ? { model: opts.model } : {}),
        ...(opts?.providerID && opts?.modelID ? { providerID: opts.providerID, modelID: opts.modelID } : {}),
        ...(opts?.cwd ? { cwd: opts.cwd } : {}),
        ...(opts?.effort ? { effort: opts.effort } : {}),
        ...(opts?.approvalPolicy ? { approvalPolicy: opts.approvalPolicy } : {}),
        ...(opts?.sandboxPolicy ? { sandboxPolicy: opts.sandboxPolicy } : {}),
        ...(opts?.prompt ? { prompt: opts.prompt } : {}),
      }),
    }),

  listAgentSessions: (vmId: string, agentType: "codex" | "opencode") =>
    apiFetch<{ sessions: AgentSession[] }>(`/vms/${vmId}/agents/${agentType}/sessions`),

  getAgentSession: (vmId: string, sessionId: string) =>
    apiFetch<{ session: AgentSession; messages: AgentMessage[]; pendingApprovals?: { id: string; action: string; detail: unknown }[]; pendingQuestions?: { id: string; questions: { question: string; header: string; options: { label: string; description: string }[]; multiple?: boolean; custom?: boolean }[] }[]; todos?: { id: string; content: string; status: string; priority: string }[] }>(
      `/vms/${vmId}/sessions/${sessionId}`
    ),

  sendAgentMessage: (vmId: string, sessionId: string, text: string, opts?: { agent?: string; effort?: ReasoningEffort; approvalPolicy?: ApprovalPolicy; sandboxPolicy?: SandboxPolicy }) =>
    apiFetch<{ ok: boolean }>(`/vms/${vmId}/sessions/${sessionId}/message`, {
      method: "POST",
      body: JSON.stringify({
        text,
        ...(opts?.agent ? { agent: opts.agent } : {}),
        ...(opts?.effort ? { effort: opts.effort } : {}),
        ...(opts?.approvalPolicy ? { approvalPolicy: opts.approvalPolicy } : {}),
        ...(opts?.sandboxPolicy ? { sandboxPolicy: opts.sandboxPolicy } : {}),
      }),
    }),

  stopAgent: (vmId: string, sessionId: string) =>
    apiFetch<{ ok: boolean }>(`/vms/${vmId}/sessions/${sessionId}/stop`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  deleteAgentSession: (vmId: string, sessionId: string) =>
    apiFetch<{ ok: boolean }>(`/vms/${vmId}/sessions/${sessionId}`, {
      method: "DELETE",
    }),

  revertMessage: (vmId: string, sessionId: string, messageId?: string) =>
    apiFetch<{ ok: boolean }>(`/vms/${vmId}/sessions/${sessionId}/revert`, {
      method: "POST",
      body: JSON.stringify(messageId ? { messageId } : {}),
    }),

  unrevertSession: (vmId: string, sessionId: string) =>
    apiFetch<{ ok: boolean }>(`/vms/${vmId}/sessions/${sessionId}/unrevert`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  respondToApproval: (vmId: string, sessionId: string, approvalId: string, decision: ApprovalDecision) =>
    apiFetch<{ ok: boolean }>(`/vms/${vmId}/sessions/${sessionId}/approval`, {
      method: "POST",
      body: JSON.stringify({ approvalId, decision }),
    }),

  respondToQuestion: (vmId: string, sessionId: string, questionId: string, answers: string[][]) =>
    apiFetch<{ ok: boolean }>(`/vms/${vmId}/sessions/${sessionId}/question`, {
      method: "POST",
      body: JSON.stringify({ questionId, answers }),
    }),

  rejectQuestion: (vmId: string, sessionId: string, questionId: string) =>
    apiFetch<{ ok: boolean }>(`/vms/${vmId}/sessions/${sessionId}/question`, {
      method: "POST",
      body: JSON.stringify({ questionId, reject: true }),
    }),

  // Codex models + threads
  getCodexModels: (vmId: string, includeHidden = false) =>
    apiFetch<{ models: CodexModel[] }>(
      `/vms/${vmId}/codex/models${includeHidden ? "?includeHidden=true" : ""}`
    ),

  getCodexThreads: (vmId: string, cursor?: string, limit?: number) =>
    apiFetch<{ threads: CodexThread[]; nextCursor?: string }>(
      `/vms/${vmId}/codex/threads${cursor || limit ? `?${cursor ? `cursor=${cursor}` : ""}${cursor && limit ? "&" : ""}${limit ? `limit=${limit}` : ""}` : ""}`
    ),

  // Codex auth
  getCodexAuthStatus: (vmId: string, refresh = false) =>
    apiFetch<{ authenticated: boolean; authMode?: string; account?: any; error?: string }>(
      `/vms/${vmId}/codex/auth/status${refresh ? "?refresh=true" : ""}`
    ),

  startCodexLogin: (vmId: string, mode: "chatgpt" | "apikey" = "chatgpt", apiKey?: string) =>
    apiFetch<any>(`/vms/${vmId}/codex/auth/login`, {
      method: "POST",
      body: JSON.stringify({ mode, ...(apiKey ? { apiKey } : {}) }),
    }),

  logoutCodex: (vmId: string) =>
    apiFetch<{ ok: boolean }>(`/vms/${vmId}/codex/auth/logout`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  // Terminal sessions
  listTerminalSessions: (vmId: string) =>
    apiFetch<{ sessions: TerminalSession[] }>(`/vms/${vmId}/terminal/sessions`),

  deleteTerminalSession: (vmId: string, name: string) =>
    apiFetch<{ ok: boolean }>(`/vms/${vmId}/terminal/sessions/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),

  // SSH keys
  getSshKeys: () =>
    apiFetch<{ keys: string; github_keys: string }>("/me/ssh-keys"),

  saveSshKeys: (keys: string) =>
    apiFetch<{ ok: boolean }>("/me/ssh-keys", {
      method: "PUT",
      body: JSON.stringify({ keys }),
    }),

  syncSshKeys: (vmId: string) =>
    apiFetch<{ ok: boolean; message: string }>(`/vms/${vmId}/sync-ssh-keys`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  checkSshKeysStatus: (vmId: string) =>
    apiFetch<{ synced: boolean; reason?: string }>(`/vms/${vmId}/ssh-keys-status`),

  // GitHub repo access
  getGithubStatus: () =>
    apiFetch<{ connected: boolean; username: string | null }>("/me/github"),

  disconnectGithub: () =>
    apiFetch<{ ok: boolean }>("/me/github", { method: "DELETE" }),

  listGithubRepos: (query?: string, page?: number) => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (page) params.set("page", String(page));
    const qs = params.toString();
    return apiFetch<{ repos: GitHubRepo[]; hasMore: boolean }>(`/me/repos${qs ? `?${qs}` : ""}`);
  },

  createGithubRepo: (name: string, isPrivate: boolean) =>
    apiFetch<{ fullName: string; cloneUrl: string }>("/me/repos", {
      method: "POST",
      body: JSON.stringify({ name, private: isPrivate }),
    }),

  // SSH key linking
  getPendingKey: (token: string) =>
    apiFetch<{ fingerprint: string; email: string }>(`/link-ssh/${token}`),

  confirmLinkSshKey: (token: string) =>
    apiFetch<{ ok: boolean; message: string }>(`/link-ssh/${token}`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  // Billing
  getSubscription: () => apiFetch<Subscription>("/billing/subscription"),

  createCheckoutSession: () =>
    apiFetch<{ url: string }>("/billing/checkout", {
      method: "POST",
      body: JSON.stringify({}),
    }),

  getPortalUrl: () =>
    apiFetch<{ url: string }>("/billing/portal", {
      method: "POST",
      body: JSON.stringify({}),
    }),

  // Access control
  listAccess: (vmId: string) =>
    apiFetch<{ access: AccessEntry[] }>(`/vms/${vmId}/access`),

  grantAccess: (vmId: string, email: string, role: string) =>
    apiFetch<{ ok: boolean; message: string }>(`/vms/${vmId}/access`, {
      method: "POST",
      body: JSON.stringify({ email, role }),
    }),

  revokeAccess: (vmId: string, email: string) =>
    apiFetch<{ ok: boolean; message: string }>(`/vms/${vmId}/access`, {
      method: "POST",
      body: JSON.stringify({ email, role: null }),
    }),

  setVMPublic: (vmId: string, isPublic: boolean) =>
    apiFetch<{ ok: boolean; is_public: boolean }>(`/vms/${vmId}/public`, {
      method: "POST",
      body: JSON.stringify({ is_public: isPublic }),
    }),

  // Firewall rules
  getFirewallRules: (vmId: string) =>
    apiFetch<{ rules: FirewallRule[]; vm_ipv6: string | null }>(`/vms/${vmId}/firewall`),

  setFirewallRules: (vmId: string, rules: FirewallRule[]) =>
    apiFetch<{ ok: boolean; rules: FirewallRule[] }>(`/vms/${vmId}/firewall`, {
      method: "POST",
      body: JSON.stringify({ rules }),
    }),

  // File content + git log
  readFile: (vmId: string, path: string) =>
    apiFetch<FileContent>(`/vms/${vmId}/files/read?path=${encodeURIComponent(path)}`),

  getFileDownloadUrl: (vmId: string, path: string) =>
    `${API_BASE}/vms/${vmId}/files/download?path=${encodeURIComponent(path)}`,

  getGitLog: (vmId: string, limit = 20) =>
    apiFetch<{ commits: GitCommit[] }>(`/vms/${vmId}/git/log?limit=${limit}`),
};

export function githubConnectUrl(redirect: string): string {
  const apiHost = import.meta.env.VITE_API_URL?.replace(/^\/\//, "") || "api.localhost";
  // Derive auth origin from API host: api.numavm.com → auth.numavm.com
  const authHost = apiHost.replace(/^api\./, "auth.");
  const protocol = window.location.protocol;
  return `${protocol}//${authHost}/auth/github/repo?redirect=${encodeURIComponent(redirect)}`;
}

export function terminalWsUrl(
  vmId: string,
  cols: number,
  rows: number,
  session?: string
): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host =
    import.meta.env.VITE_API_URL?.replace(/^\/\//, "") || "api.localhost";
  let url = `${protocol}//${host}/vms/${vmId}/terminal?cols=${cols}&rows=${rows}`;
  if (session) {
    url += `&session=${encodeURIComponent(session)}`;
  }
  return url;
}

export function agentWsUrl(vmId: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host =
    import.meta.env.VITE_API_URL?.replace(/^\/\//, "") || "api.localhost";
  return `${protocol}//${host}/vms/${vmId}/ws`;
}
