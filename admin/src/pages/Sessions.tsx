import { useState, useEffect } from "react";
import { adminApi, type AdminSession } from "../lib/api";
import { DataTable, type Column } from "../components/DataTable";
import { relativeTime } from "../lib/time";

const STATUS_DOTS: Record<string, string> = {
  idle: "bg-neutral-400",
  busy: "bg-green-500",
  error: "bg-red-500",
  archived: "bg-neutral-300",
};

const columns: Column<AdminSession>[] = [
  {
    key: "title",
    label: "Title",
    render: (row) => (
      <span className="font-medium truncate max-w-[200px] inline-block">
        {row.title || "Untitled"}
      </span>
    ),
  },
  {
    key: "vm_name",
    label: "VM",
    render: (row) => (
      <span className="text-neutral-500">{row.vm_name || row.vm_id}</span>
    ),
  },
  {
    key: "agent_type",
    label: "Agent",
    render: (row) => (
      <span className="px-1.5 py-0.5 bg-neutral-100 text-neutral-600 text-[10px] rounded">
        {row.agent_type}
      </span>
    ),
  },
  {
    key: "status",
    label: "Status",
    render: (row) => (
      <span className="flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOTS[row.status] || "bg-neutral-300"}`} />
        {row.status}
      </span>
    ),
  },
  {
    key: "message_count",
    label: "Messages",
  },
  {
    key: "updated_at",
    label: "Last Activity",
    render: (row) => (
      <span className="text-neutral-400">{relativeTime(row.updated_at)}</span>
    ),
  },
  {
    key: "created_at",
    label: "Created",
    render: (row) => (
      <span className="text-neutral-400">{relativeTime(row.created_at)}</span>
    ),
  },
];

export function Sessions() {
  const [sessions, setSessions] = useState<AdminSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    adminApi
      .getSessions()
      .then((res) => setSessions(res.sessions))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (error) return <div className="text-xs text-red-500">{error}</div>;
  if (loading) return <div className="text-xs text-neutral-400">Loading...</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-sm font-semibold">Agent Sessions</h1>
        <span className="text-xs text-neutral-400">{sessions.length} sessions</span>
      </div>
      <div className="border border-neutral-200 bg-panel-chat">
        <DataTable columns={columns} data={sessions} emptyMessage="No agent sessions" />
      </div>
    </div>
  );
}
