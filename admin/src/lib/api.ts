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

export interface AdminStats {
  vmsByStatus: Record<string, number>;
  totalVMs: number;
  userCount: number;
  recentVMs: Array<{
    id: string;
    name: string;
    status: string;
    created_at: string;
    owner_email: string;
  }>;
  recentEvents: AdminEvent[];
}

export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  github_username: string | null;
  avatar_url: string | null;
  is_admin: number;
  created_at: string;
  provider: string;
  vm_count: number;
}

export interface AdminVM {
  id: string;
  name: string;
  owner_id: string;
  gh_repo: string;
  status: string;
  vm_ip: string | null;
  app_port: number;
  ssh_port: number;
  opencode_port: number;
  created_at: string;
  owner_email: string;
  owner_name: string | null;
}

export interface AdminEvent {
  id: number;
  type: string;
  vm_id: string | null;
  user_id: string | null;
  metadata: string | null;
  created_at: string;
}

export interface TrafficSummary {
  vm_id: string;
  total_rx: number;
  total_tx: number;
  samples: number;
}

export interface TrafficPoint {
  rx_bytes: number;
  tx_bytes: number;
  recorded_at: string;
}

export const adminApi = {
  getStats: () => apiFetch<AdminStats>("/admin/stats"),
  getUsers: () => apiFetch<{ users: AdminUser[] }>("/admin/users"),
  getVMs: () => apiFetch<{ vms: AdminVM[] }>("/admin/vms"),
  getEvents: (limit = 100, type?: string) =>
    apiFetch<{ events: AdminEvent[] }>(`/admin/events?limit=${limit}${type ? `&type=${type}` : ""}`),
  getTraffic: () => apiFetch<{ traffic: Array<{ vmId: string; vmIp: string; rxBytes: number; txBytes: number; totalBytes: number }> }>("/admin/traffic"),
  getTrafficSummary: (hours = 24) => apiFetch<{ summary: TrafficSummary[]; hours: number }>(`/admin/traffic/summary?hours=${hours}`),
  getTrafficHistory: (vmId: string, hours = 24) => apiFetch<{ vmId: string; history: TrafficPoint[]; hours: number }>(`/admin/traffic/${vmId}/history?hours=${hours}`),
  getHealth: () => apiFetch<any>("/admin/health"),
};
