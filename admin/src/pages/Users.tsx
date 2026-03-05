import { useState, useEffect } from "react";
import { adminApi, type AdminUser } from "../lib/api";
import { DataTable, type Column } from "../components/DataTable";
import { relativeTime } from "../lib/time";

const columns: Column<AdminUser>[] = [
  {
    key: "email",
    label: "Email",
    render: (row) => (
      <span className="font-medium">
        {row.email}
        {row.is_admin ? (
          <span className="ml-1.5 px-1 py-0.5 bg-neutral-900 text-white text-[9px] rounded">
            admin
          </span>
        ) : null}
      </span>
    ),
  },
  {
    key: "name",
    label: "Name",
    render: (row) => <span className="text-neutral-600">{row.name || "\u2014"}</span>,
  },
  {
    key: "provider",
    label: "Provider",
    render: (row) => (
      <span className="px-1.5 py-0.5 bg-neutral-100 text-neutral-600 text-[10px] rounded">
        {row.provider}
      </span>
    ),
  },
  {
    key: "github_username",
    label: "GitHub",
    render: (row) => (
      <span className="text-neutral-500">{row.github_username || "\u2014"}</span>
    ),
  },
  {
    key: "env_count",
    label: "Envs",
    render: (row) => <span>{row.env_count}</span>,
  },
  {
    key: "created_at",
    label: "Joined",
    render: (row) => (
      <span className="text-neutral-400">{relativeTime(row.created_at)}</span>
    ),
  },
];

export function Users() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    adminApi
      .getUsers()
      .then((res) => setUsers(res.users))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (error) return <div className="text-xs text-red-500">{error}</div>;
  if (loading) return <div className="text-xs text-neutral-400">Loading...</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-sm font-semibold">Users</h1>
        <span className="text-xs text-neutral-400">{users.length} total</span>
      </div>
      <div className="border border-neutral-200 bg-panel-chat">
        <DataTable columns={columns} data={users} emptyMessage="No users" />
      </div>
    </div>
  );
}
