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
  repo_url: string;
  created_at: string;
}

export interface EnvDetail {
  id: string;
  name: string;
  status: string;
  url: string;
  repo_url: string;
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
  status: string;
  created_at: string;
  updated_at: string;
}

export interface AgentMessage {
  id: string;
  session_id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  metadata: string | null;
  created_at: string;
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

export const api = {
  listEnvs: () => apiFetch<{ envs: EnvSummary[] }>("/envs"),

  getEnv: (id: string) => apiFetch<EnvDetail>(`/envs/${id}`),

  createEnv: (body: { name: string; gh_repo?: string }) =>
    apiFetch<{ id: string; name: string; url: string; repo_url: string; ssh_command: string; ssh_port: number; status: string }>(
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

  // Agent session APIs
  createAgentSession: (envId: string, agentType: "codex" | "opencode", model?: string) =>
    apiFetch<AgentSession>(`/envs/${envId}/agents/${agentType}/sessions`, {
      method: "POST",
      body: JSON.stringify(model ? { model } : {}),
    }),

  listAgentSessions: (envId: string, agentType: "codex" | "opencode") =>
    apiFetch<{ sessions: AgentSession[] }>(`/envs/${envId}/agents/${agentType}/sessions`),

  getAgentSession: (envId: string, sessionId: string) =>
    apiFetch<{ session: AgentSession; messages: AgentMessage[] }>(
      `/envs/${envId}/sessions/${sessionId}`
    ),

  sendAgentMessage: (envId: string, sessionId: string, text: string) =>
    apiFetch<{ ok: boolean }>(`/envs/${envId}/sessions/${sessionId}/message`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),

  stopAgent: (envId: string, sessionId: string) =>
    apiFetch<{ ok: boolean }>(`/envs/${envId}/sessions/${sessionId}/stop`, {
      method: "POST",
    }),

  deleteAgentSession: (envId: string, sessionId: string) =>
    apiFetch<{ ok: boolean }>(`/envs/${envId}/sessions/${sessionId}`, {
      method: "DELETE",
    }),

  respondToApproval: (envId: string, sessionId: string, approvalId: string, decision: "accept" | "decline") =>
    apiFetch<{ ok: boolean }>(`/envs/${envId}/sessions/${sessionId}/approval`, {
      method: "POST",
      body: JSON.stringify({ approvalId, decision }),
    }),

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
    }),

  // Terminal sessions
  listTerminalSessions: (envId: string) =>
    apiFetch<{ sessions: TerminalSession[] }>(`/envs/${envId}/terminal/sessions`),

  deleteTerminalSession: (envId: string, name: string) =>
    apiFetch<{ ok: boolean }>(`/envs/${envId}/terminal/sessions/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),

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
