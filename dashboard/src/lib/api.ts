const API_BASE = import.meta.env.VITE_API_URL || "//api.localhost";

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
    ...options,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `API error: ${res.status}`);
  }

  return res.json();
}

export interface EnvSummary {
  id: string;
  name: string;
  status: string;
  role: string;
  url: string;
  repo_url?: string;
  created_at: string;
}

export interface EnvDetail {
  id: string;
  name: string;
  status: string;
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
}

export interface ClaudeSession {
  id: string;
  title: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AgentSession {
  id: string;
  env_id: string;
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
}

export const api = {
  getUser: () => apiFetch<User>("/me"),

  listEnvs: () => apiFetch<{ envs: EnvSummary[] }>("/envs"),

  getEnv: (id: string) => apiFetch<EnvDetail>(`/envs/${id}`),

  createEnv: (body: { name: string; gh_repo?: string }) =>
    apiFetch<{ id: string; name: string; url: string; repo_url?: string; ssh_command: string; ssh_port: number; status: string }>(
      "/envs",
      { method: "POST", body: JSON.stringify(body) }
    ),

  deleteEnv: (id: string) =>
    apiFetch<{ ok: boolean }>(`/envs/${id}`, { method: "DELETE" }),

  getClaudeSessions: (envId: string) =>
    apiFetch<{ sessions: ClaudeSession[] }>(`/envs/${envId}/claude/sessions`),

  // File browser
  listFiles: (envId: string, path: string) =>
    apiFetch<{ path: string; entries: FileEntry[] }>(`/envs/${envId}/files?path=${encodeURIComponent(path)}`),

  // OpenCode providers
  getOpenCodeProviders: (envId: string) =>
    apiFetch<{ connected: OpenCodeProvider[]; popular: OpenCodePopularProvider[]; default: Record<string, string> }>(
      `/envs/${envId}/opencode/providers`
    ),

  // Agent session APIs
  createAgentSession: (envId: string, agentType: "codex" | "opencode", opts?: { model?: string; providerID?: string; modelID?: string; cwd?: string; effort?: ReasoningEffort; approvalPolicy?: ApprovalPolicy; sandboxPolicy?: SandboxPolicy }) =>
    apiFetch<AgentSession>(`/envs/${envId}/agents/${agentType}/sessions`, {
      method: "POST",
      body: JSON.stringify({
        ...(opts?.model ? { model: opts.model } : {}),
        ...(opts?.providerID && opts?.modelID ? { providerID: opts.providerID, modelID: opts.modelID } : {}),
        ...(opts?.cwd ? { cwd: opts.cwd } : {}),
        ...(opts?.effort ? { effort: opts.effort } : {}),
        ...(opts?.approvalPolicy ? { approvalPolicy: opts.approvalPolicy } : {}),
        ...(opts?.sandboxPolicy ? { sandboxPolicy: opts.sandboxPolicy } : {}),
      }),
    }),

  listAgentSessions: (envId: string, agentType: "codex" | "opencode") =>
    apiFetch<{ sessions: AgentSession[] }>(`/envs/${envId}/agents/${agentType}/sessions`),

  getAgentSession: (envId: string, sessionId: string) =>
    apiFetch<{ session: AgentSession; messages: AgentMessage[] }>(
      `/envs/${envId}/sessions/${sessionId}`
    ),

  sendAgentMessage: (envId: string, sessionId: string, text: string, opts?: { agent?: string; effort?: ReasoningEffort; approvalPolicy?: ApprovalPolicy; sandboxPolicy?: SandboxPolicy }) =>
    apiFetch<{ ok: boolean }>(`/envs/${envId}/sessions/${sessionId}/message`, {
      method: "POST",
      body: JSON.stringify({
        text,
        ...(opts?.agent ? { agent: opts.agent } : {}),
        ...(opts?.effort ? { effort: opts.effort } : {}),
        ...(opts?.approvalPolicy ? { approvalPolicy: opts.approvalPolicy } : {}),
        ...(opts?.sandboxPolicy ? { sandboxPolicy: opts.sandboxPolicy } : {}),
      }),
    }),

  stopAgent: (envId: string, sessionId: string) =>
    apiFetch<{ ok: boolean }>(`/envs/${envId}/sessions/${sessionId}/stop`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  deleteAgentSession: (envId: string, sessionId: string) =>
    apiFetch<{ ok: boolean }>(`/envs/${envId}/sessions/${sessionId}`, {
      method: "DELETE",
    }),

  revertMessage: (envId: string, sessionId: string, messageId?: string) =>
    apiFetch<{ ok: boolean }>(`/envs/${envId}/sessions/${sessionId}/revert`, {
      method: "POST",
      body: JSON.stringify(messageId ? { messageId } : {}),
    }),

  unrevertSession: (envId: string, sessionId: string) =>
    apiFetch<{ ok: boolean }>(`/envs/${envId}/sessions/${sessionId}/unrevert`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  respondToApproval: (envId: string, sessionId: string, approvalId: string, decision: ApprovalDecision) =>
    apiFetch<{ ok: boolean }>(`/envs/${envId}/sessions/${sessionId}/approval`, {
      method: "POST",
      body: JSON.stringify({ approvalId, decision }),
    }),

  // Codex models + threads
  getCodexModels: (envId: string, includeHidden = false) =>
    apiFetch<{ models: CodexModel[] }>(
      `/envs/${envId}/codex/models${includeHidden ? "?includeHidden=true" : ""}`
    ),

  getCodexThreads: (envId: string, cursor?: string, limit?: number) =>
    apiFetch<{ threads: CodexThread[]; nextCursor?: string }>(
      `/envs/${envId}/codex/threads${cursor || limit ? `?${cursor ? `cursor=${cursor}` : ""}${cursor && limit ? "&" : ""}${limit ? `limit=${limit}` : ""}` : ""}`
    ),

  // Codex auth
  getCodexAuthStatus: (envId: string, refresh = false) =>
    apiFetch<{ authenticated: boolean; authMode?: string; account?: any; error?: string }>(
      `/envs/${envId}/codex/auth/status${refresh ? "?refresh=true" : ""}`
    ),

  startCodexLogin: (envId: string, mode: "chatgpt" | "apikey" = "chatgpt", apiKey?: string) =>
    apiFetch<any>(`/envs/${envId}/codex/auth/login`, {
      method: "POST",
      body: JSON.stringify({ mode, ...(apiKey ? { apiKey } : {}) }),
    }),

  logoutCodex: (envId: string) =>
    apiFetch<{ ok: boolean }>(`/envs/${envId}/codex/auth/logout`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  // Terminal sessions
  listTerminalSessions: (envId: string) =>
    apiFetch<{ sessions: TerminalSession[] }>(`/envs/${envId}/terminal/sessions`),

  deleteTerminalSession: (envId: string, name: string) =>
    apiFetch<{ ok: boolean }>(`/envs/${envId}/terminal/sessions/${encodeURIComponent(name)}`, {
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

  syncSshKeys: (envId: string) =>
    apiFetch<{ ok: boolean; message: string }>(`/envs/${envId}/sync-ssh-keys`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  checkSshKeysStatus: (envId: string) =>
    apiFetch<{ synced: boolean; reason?: string }>(`/envs/${envId}/ssh-keys-status`),

  // Access control
  listAccess: (envId: string) =>
    apiFetch<{ access: AccessEntry[] }>(`/envs/${envId}/access`),

  grantAccess: (envId: string, email: string, role: string) =>
    apiFetch<{ ok: boolean; message: string }>(`/envs/${envId}/access`, {
      method: "POST",
      body: JSON.stringify({ email, role }),
    }),

  revokeAccess: (envId: string, email: string) =>
    apiFetch<{ ok: boolean; message: string }>(`/envs/${envId}/access`, {
      method: "POST",
      body: JSON.stringify({ email, role: null }),
    }),

  // File content + git log
  readFile: (envId: string, path: string) =>
    apiFetch<FileContent>(`/envs/${envId}/files/read?path=${encodeURIComponent(path)}`),

  getFileDownloadUrl: (envId: string, path: string) =>
    `${API_BASE}/envs/${envId}/files/download?path=${encodeURIComponent(path)}`,

  getGitLog: (envId: string, limit = 20) =>
    apiFetch<{ commits: GitCommit[] }>(`/envs/${envId}/git/log?limit=${limit}`),
};

export function terminalWsUrl(
  envId: string,
  cols: number,
  rows: number,
  session?: string
): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host =
    import.meta.env.VITE_API_URL?.replace(/^\/\//, "") || "api.localhost";
  let url = `${protocol}//${host}/envs/${envId}/terminal?cols=${cols}&rows=${rows}`;
  if (session) {
    url += `&session=${encodeURIComponent(session)}`;
  }
  return url;
}

export function agentWsUrl(envId: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host =
    import.meta.env.VITE_API_URL?.replace(/^\/\//, "") || "api.localhost";
  return `${protocol}//${host}/envs/${envId}/ws`;
}
