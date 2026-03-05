import { useState, useEffect } from "react";
import { adminApi, type AdminEnv } from "../lib/api";
import { DataTable, type Column } from "../components/DataTable";
import { relativeTime } from "../lib/time";

const STATUS_DOTS: Record<string, string> = {
  running: "bg-green-500",
  snapshotted: "bg-yellow-500",
  creating: "bg-blue-500",
  stopped: "bg-neutral-400",
  paused: "bg-orange-500",
  error: "bg-red-500",
};

const columns: Column<AdminEnv>[] = [
  {
    key: "id",
    label: "Slug",
    render: (row) => <span className="font-medium">{row.id}</span>,
  },
  {
    key: "name",
    label: "Name",
    render: (row) => <span className="text-neutral-600">{row.name}</span>,
  },
  {
    key: "owner_email",
    label: "Owner",
    render: (row) => <span className="text-neutral-500">{row.owner_email}</span>,
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
    key: "vm_ip",
    label: "VM IP",
    render: (row) => (
      <span className="text-neutral-400 font-mono">{row.vm_ip || "\u2014"}</span>
    ),
  },
  {
    key: "app_port",
    label: "Ports",
    render: (row) => (
      <span className="text-neutral-400 text-[10px]">
        app:{row.app_port} ssh:{row.ssh_port} oc:{row.opencode_port}
      </span>
    ),
    sortable: false,
  },
  {
    key: "created_at",
    label: "Created",
    render: (row) => (
      <span className="text-neutral-400">{relativeTime(row.created_at)}</span>
    ),
  },
];

export function Environments() {
  const [envs, setEnvs] = useState<AdminEnv[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    adminApi
      .getEnvs()
      .then((res) => setEnvs(res.envs))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (error) return <div className="text-xs text-red-500">{error}</div>;
  if (loading) return <div className="text-xs text-neutral-400">Loading...</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-sm font-semibold">Environments</h1>
        <span className="text-xs text-neutral-400">{envs.length} total</span>
      </div>
      <div className="border border-neutral-200 bg-panel-chat">
        <DataTable columns={columns} data={envs} emptyMessage="No environments" />
      </div>
    </div>
  );
}
