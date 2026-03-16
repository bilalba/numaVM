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

/** Direct node agent connection info (multi-node). */
export interface NodeConnection {
  /** HTTP base URL, e.g. "https://node1.numavm.com" */
  httpUrl: string;
  /** Connect token JWT for auth */
  token: string;
}

/** Fetch directly from a node agent using connect token auth. */
async function nodeFetch<T>(node: NodeConnection, path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    ...options?.headers as Record<string, string>,
    "Authorization": `Bearer ${node.token}`,
  };
  if (options?.body) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`${node.httpUrl}${path}`, {
    headers,
    ...options,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `API error: ${res.status}`);
  }

  return res.json();
}

/** Convert a WS URL (wss://node1.numavm.com) to HTTP (https://node1.numavm.com). */
export function wsUrlToHttp(wsUrl: string): string {
  return wsUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
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
  keep_alive: boolean;
  region?: string | null;
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
  keep_alive_ram_used?: number;
  keep_alive_ram_max?: number;
  llm_spend?: number;
  llm_budget?: number;
  llm_used_pct?: number;
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
  keep_alive: boolean;
  vm_ipv6?: string | null;
  host_id?: string | null;
  region?: string | null;
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
  model: string | null;
  provider: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  // Multi-node: present when VM is on a remote node
  connectToken?: string;
  agentWsUrl?: string;
  connectTokenExpiresAt?: string;
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
  default_region?: string | null;
  web_terminal_enabled?: boolean;
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

export interface SshKeyRecord {
  id: string;
  user_id: string;
  key_data: string;
  key_type: string;
  fingerprint: string;
  comment: string | null;
  source: string;
  created_at: string;
}

export interface SshKeyStatusRecord {
  id: string;
  fingerprint: string;
  key_type: string;
  comment: string | null;
  present: boolean;
  reason?: string;
}

export interface NodeInfo {
  id: string;
  name: string;
  region: string;
  endpoint: string;
  token: string;
  expiresAt: string;
  vmIds: string[];
}

export interface EventLogEntry {
  seq: number;
  type: string;
  data: Record<string, unknown>;
  created_at: string;
}

export const api = {
  checkNameAvailability: (name: string) =>
    apiFetch<{ available: boolean; reason?: string; message?: string }>(`/vms/check-name/${encodeURIComponent(name)}`),

  getUser: () => apiFetch<User>("/me"),

  listVMs: () => apiFetch<{ vms: VMSummary[] }>("/vms"),

  getVM: (id: string) => apiFetch<VMDetail>(`/vms/${id}`),

  createVM: (body: { name: string; gh_repo?: string; mem_size_mib?: number; disk_size_gib?: number; image?: string; initial_prompt?: string }) =>
    apiFetch<{
      id: string; name: string; url: string; repo_url?: string; ssh_command: string; ssh_port: number; status: string;
      status_detail: string | null; app_port: number; opencode_port: number; role: string; created_at: string;
      mem_size_mib: number; disk_size_gib: number; image: string; host_id: string | null;
      is_public: boolean; keep_alive: boolean; vm_ipv6: string | null;
      connectToken?: string; agentWsUrl?: string;
    }>(
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

  // OpenCode status
  getOpenCodeStatus: (vmId: string) =>
    apiFetch<{ vmId: string; opencode_status: string }>(`/vms/${vmId}/opencode-status`),

  // OpenCode providers
  getOpenCodeProviders: (vmId: string) =>
    apiFetch<{ connected: OpenCodeProvider[]; popular: OpenCodePopularProvider[]; default: Record<string, string> }>(
      `/vms/${vmId}/opencode/providers`
    ),

  // Agent session APIs
  createAgentSession: (vmId: string, agentType: "codex" | "opencode", opts?: { model?: string; providerID?: string; modelID?: string; cwd?: string; effort?: ReasoningEffort; approvalPolicy?: ApprovalPolicy; sandboxPolicy?: SandboxPolicy; prompt?: string }, node?: NodeConnection) => {
    const path = `/vms/${vmId}/agents/${agentType}/sessions`;
    const init = {
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
    };
    return node ? nodeFetch<AgentSession>(node, path, init) : apiFetch<AgentSession>(path, init);
  },

  listAgentSessions: (vmId: string, agentType: "codex" | "opencode") =>
    apiFetch<{ sessions: AgentSession[] }>(`/vms/${vmId}/agents/${agentType}/sessions`),

  getAgentSession: (vmId: string, sessionId: string) =>
    apiFetch<{ session: AgentSession; messages: AgentMessage[]; pendingApprovals?: { id: string; action: string; detail: unknown }[]; pendingQuestions?: { id: string; questions: { question: string; header: string; options: { label: string; description: string }[]; multiple?: boolean; custom?: boolean }[] }[]; todos?: { id: string; content: string; status: string; priority: string }[]; connectToken?: string; agentWsUrl?: string; connectTokenExpiresAt?: string }>(
      `/vms/${vmId}/sessions/${sessionId}`
    ),

  sendAgentMessage: (vmId: string, sessionId: string, text: string, opts?: { agent?: string; effort?: ReasoningEffort; approvalPolicy?: ApprovalPolicy; sandboxPolicy?: SandboxPolicy }, node?: NodeConnection) => {
    const path = `/vms/${vmId}/sessions/${sessionId}/message`;
    const init = {
      method: "POST",
      body: JSON.stringify({
        text,
        ...(opts?.agent ? { agent: opts.agent } : {}),
        ...(opts?.effort ? { effort: opts.effort } : {}),
        ...(opts?.approvalPolicy ? { approvalPolicy: opts.approvalPolicy } : {}),
        ...(opts?.sandboxPolicy ? { sandboxPolicy: opts.sandboxPolicy } : {}),
      }),
    };
    return node ? nodeFetch<{ ok: boolean }>(node, path, init) : apiFetch<{ ok: boolean }>(path, init);
  },

  stopAgent: (vmId: string, sessionId: string, node?: NodeConnection) => {
    const path = `/vms/${vmId}/sessions/${sessionId}/stop`;
    const init = { method: "POST", body: JSON.stringify({}) };
    return node ? nodeFetch<{ ok: boolean }>(node, path, init) : apiFetch<{ ok: boolean }>(path, init);
  },

  deleteAgentSession: (vmId: string, sessionId: string, node?: NodeConnection) => {
    const path = `/vms/${vmId}/sessions/${sessionId}`;
    const init = { method: "DELETE" as const };
    return node ? nodeFetch<{ ok: boolean }>(node, path, init) : apiFetch<{ ok: boolean }>(path, init);
  },

  revertMessage: (vmId: string, sessionId: string, messageId?: string, node?: NodeConnection) => {
    const path = `/vms/${vmId}/sessions/${sessionId}/revert`;
    const init = { method: "POST", body: JSON.stringify(messageId ? { messageId } : {}) };
    return node ? nodeFetch<{ ok: boolean }>(node, path, init) : apiFetch<{ ok: boolean }>(path, init);
  },

  unrevertSession: (vmId: string, sessionId: string, node?: NodeConnection) => {
    const path = `/vms/${vmId}/sessions/${sessionId}/unrevert`;
    const init = { method: "POST", body: JSON.stringify({}) };
    return node ? nodeFetch<{ ok: boolean }>(node, path, init) : apiFetch<{ ok: boolean }>(path, init);
  },

  respondToApproval: (vmId: string, sessionId: string, approvalId: string, decision: ApprovalDecision, node?: NodeConnection) => {
    const path = `/vms/${vmId}/sessions/${sessionId}/approval`;
    const init = { method: "POST", body: JSON.stringify({ approvalId, decision }) };
    return node ? nodeFetch<{ ok: boolean }>(node, path, init) : apiFetch<{ ok: boolean }>(path, init);
  },

  respondToQuestion: (vmId: string, sessionId: string, questionId: string, answers: string[][], node?: NodeConnection) => {
    const path = `/vms/${vmId}/sessions/${sessionId}/question`;
    const init = { method: "POST", body: JSON.stringify({ questionId, answers }) };
    return node ? nodeFetch<{ ok: boolean }>(node, path, init) : apiFetch<{ ok: boolean }>(path, init);
  },

  rejectQuestion: (vmId: string, sessionId: string, questionId: string, node?: NodeConnection) => {
    const path = `/vms/${vmId}/sessions/${sessionId}/question`;
    const init = { method: "POST", body: JSON.stringify({ questionId, reject: true }) };
    return node ? nodeFetch<{ ok: boolean }>(node, path, init) : apiFetch<{ ok: boolean }>(path, init);
  },

  // Connect token refresh (multi-node: for direct dashboard→node agent WS)
  refreshConnectToken: (vmId: string) =>
    apiFetch<{ connectToken: string; agentWsUrl: string; expiresAt: string }>(
      `/vms/${vmId}/agent-connect-token`,
      { method: "POST", body: JSON.stringify({}) }
    ),

  // Terminal connect token (multi-node: for direct dashboard→node terminal WS)
  getTerminalConnectToken: (vmId: string) =>
    apiFetch<{ connectToken: string; terminalWsUrl: string; expiresAt: string }>(
      `/vms/${vmId}/terminal-connect-token`,
      { method: "POST", body: JSON.stringify({}) }
    ),

  // Node discovery (multi-node: get node endpoints + tokens for direct communication)
  getMyNodes: () =>
    apiFetch<{ nodes: NodeInfo[] }>("/my-nodes"),

  // Long-poll events from node (recoverable streams)
  pollEvents: (node: NodeConnection, vmId: string, sessionId: string, afterSeq: number, timeout = 30) =>
    nodeFetch<{ events: EventLogEntry[]; lastSeq: number }>(
      node,
      `/vms/${vmId}/sessions/${sessionId}/events?after=${afterSeq}&timeout=${timeout}`
    ),

  // List user's VMs on a specific node
  getNodeUserVMs: (node: NodeConnection) =>
    nodeFetch<{ vms: any[] }>(node, "/user/vms"),

  // Get session with history directly from node
  getNodeAgentSession: (node: NodeConnection, vmId: string, sessionId: string) =>
    nodeFetch<{ session: AgentSession; messages: AgentMessage[]; pendingApprovals?: any[]; pendingQuestions?: any[]; todos?: any[] }>(
      node,
      `/vms/${vmId}/sessions/${sessionId}`
    ),

  // List agent sessions directly from node
  listNodeAgentSessions: (node: NodeConnection, vmId: string, agentType: "codex" | "opencode") =>
    nodeFetch<{ sessions: AgentSession[] }>(node, `/vms/${vmId}/agents/${agentType}/sessions`),

  // Codex auth status directly from node
  getNodeCodexAuthStatus: (node: NodeConnection, vmId: string, refresh = false) =>
    nodeFetch<{ authenticated: boolean; authMode?: string; account?: any; error?: string }>(
      node, `/vms/${vmId}/codex/auth/status${refresh ? "?refresh=true" : ""}`
    ),

  // Codex models directly from node
  getNodeCodexModels: (node: NodeConnection, vmId: string, includeHidden = false) =>
    nodeFetch<{ models: CodexModel[] }>(
      node, `/vms/${vmId}/codex/models${includeHidden ? "?includeHidden=true" : ""}`
    ),

  // OpenCode status directly from node
  getNodeOpenCodeStatus: (node: NodeConnection, vmId: string) =>
    nodeFetch<{ vmId: string; opencode_status: string }>(node, `/vms/${vmId}/opencode-status`),

  // OpenCode providers directly from node
  getNodeOpenCodeProviders: (node: NodeConnection, vmId: string) =>
    nodeFetch<{ connected: OpenCodeProvider[]; popular: OpenCodePopularProvider[]; default: Record<string, string> }>(
      node, `/vms/${vmId}/opencode/providers`
    ),

  // File browser directly from node
  listNodeFiles: (node: NodeConnection, vmId: string, path: string) =>
    nodeFetch<{ path: string; entries: FileEntry[] }>(node, `/vms/${vmId}/files?path=${encodeURIComponent(path)}`),

  readNodeFile: (node: NodeConnection, vmId: string, path: string) =>
    nodeFetch<FileContent>(node, `/vms/${vmId}/files/read?path=${encodeURIComponent(path)}`),

  getNodeFileDownloadUrl: (node: NodeConnection, vmId: string, path: string) => {
    // Returns an object with URL + auth header (can't use cookie auth for node)
    return { url: `${node.httpUrl}/vms/${vmId}/files/download?path=${encodeURIComponent(path)}`, token: node.token };
  },

  getNodeGitLog: (node: NodeConnection, vmId: string, limit = 20) =>
    nodeFetch<{ commits: GitCommit[] }>(node, `/vms/${vmId}/git/log?limit=${limit}`),

  // VM status directly from node (avoids CP round-trip for polling)
  getNodeVMStatus: (node: NodeConnection, vmId: string) =>
    nodeFetch<{ id: string; status: string; status_detail: string | null; vm_ipv6?: string | null }>(node, `/vms/${vmId}/status`),

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

  // SSH keys (per-key management)
  getSshKeys: () =>
    apiFetch<{ keys: SshKeyRecord[] }>("/me/ssh-keys"),

  addSshKey: (key: string) =>
    apiFetch<SshKeyRecord>("/me/ssh-keys", {
      method: "POST",
      body: JSON.stringify({ key }),
    }),

  removeSshKey: (id: string) =>
    apiFetch<{ ok: boolean }>(`/me/ssh-keys/${id}`, {
      method: "DELETE",
    }),

  getSshKeysStatus: (vmId: string) =>
    apiFetch<{ keys: SshKeyStatusRecord[] }>(`/vms/${vmId}/ssh-keys/status`),

  // VM-scoped SSH key management (reads from VM's authorized_keys)
  getVmSshKeys: (vmId: string) =>
    apiFetch<{ keys: { id: string; key_data: string; key_type: string; comment: string | null }[]; reason?: string }>(`/vms/${vmId}/ssh-keys`),

  addVmSshKey: (vmId: string, keyData: string) =>
    apiFetch<{ ok: boolean; verified?: boolean }>(`/vms/${vmId}/ssh-keys/add`, {
      method: "POST",
      body: JSON.stringify({ key_data: keyData }),
    }),

  removeVmSshKey: (vmId: string, keyIdentity: string) =>
    apiFetch<{ ok: boolean }>(`/vms/${vmId}/ssh-keys/remove`, {
      method: "POST",
      body: JSON.stringify({ key_identity: keyIdentity }),
    }),

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

  // Regions (commercial multi-node)
  getRegions: () => apiFetch<{ regions: string[] }>("/regions"),

  setUserRegion: (region: string | null) =>
    apiFetch<{ ok: boolean; default_region: string | null }>("/me/region", {
      method: "PATCH",
      body: JSON.stringify({ region }),
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

  setVMKeepAlive: (vmId: string, keepAlive: boolean) =>
    apiFetch<{ ok: boolean; keep_alive: boolean }>(`/vms/${vmId}/keep-alive`, {
      method: "POST",
      body: JSON.stringify({ keep_alive: keepAlive }),
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
