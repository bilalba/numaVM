// Shared types used by all adapter implementations

export interface VM {
  id: string;
  name: string;
  owner_id: string;
  gh_repo: string | null;
  gh_token: string | null;
  container_id: string | null;
  vm_ip: string | null;
  vsock_cid: number | null;
  vm_pid: number | null;
  snapshot_path: string | null;
  app_port: number;
  ssh_port: number;
  opencode_port: number;
  opencode_password: string | null;
  status: string;
  status_detail: string | null;
  created_at: string;
  mem_size_mib: number;
  disk_size_gib: number;
}

export interface VMWithRole extends VM {
  role: string;
}

export interface User {
  id: string;
  email: string;
  name: string | null;
  github_id: string | null;
  github_username: string | null;
  google_id: string | null;
  avatar_url: string | null;
  ssh_public_keys: string | null;
  github_token: string | null;
  is_admin: number;
  plan: string;
  trial_started_at: string | null;
  stripe_customer_id: string | null;
  created_at: string;
}

export interface UserPlan {
  plan: "free" | "base";
  label: string;
  max_ram_mib: number;
  max_data_bytes: number;
  valid_mem_sizes: number[];
  max_disk_gib: number;
  valid_disk_sizes: number[];
  trial_active: boolean;
  trial_expires_at: string | null;
}

export interface AgentSession {
  id: string;
  vm_id: string;
  agent_type: "codex" | "opencode";
  thread_id: string | null;
  title: string | null;
  cwd: string | null;
  status: "idle" | "busy" | "error" | "archived";
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
