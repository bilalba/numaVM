import { useState, useEffect } from "react";
import { adminApi, type LLMUsageResponse, type LLMUserUsage } from "../lib/api";
import { DataTable, type Column } from "../components/DataTable";

function formatUSD(n: number): string {
  return `$${n.toFixed(4)}`;
}

function usageBadge(pct: number) {
  if (pct >= 100) return "bg-red-100 text-red-700";
  if (pct >= 80) return "bg-amber-100 text-amber-700";
  if (pct > 0) return "bg-green-100 text-green-700";
  return "bg-neutral-100 text-neutral-500";
}

const columns: Column<LLMUserUsage>[] = [
  {
    key: "email",
    label: "User",
    render: (row) => (
      <span className="font-medium">{row.email}</span>
    ),
  },
  {
    key: "spend",
    label: "Spend",
    render: (row) => <span className="tabular-nums">{formatUSD(row.spend)}</span>,
  },
  {
    key: "budget",
    label: "Budget",
    render: (row) => <span className="tabular-nums">{formatUSD(row.budget)}</span>,
  },
  {
    key: "usage_pct",
    label: "Usage",
    render: (row) => (
      <div className="flex items-center gap-2">
        <div className="w-16 h-1.5 bg-neutral-100 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full ${row.usage_pct >= 100 ? "bg-red-500" : row.usage_pct >= 80 ? "bg-amber-500" : "bg-green-500"}`}
            style={{ width: `${Math.min(row.usage_pct, 100)}%` }}
          />
        </div>
        <span className={`px-1.5 py-0.5 text-[10px] rounded font-medium ${usageBadge(row.usage_pct)}`}>
          {row.usage_pct}%
        </span>
      </div>
    ),
  },
];

export function LLMUsage() {
  const [data, setData] = useState<LLMUsageResponse | null>(null);
  const [models, setModels] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([
      adminApi.getLLMUsage().catch((e) => { setError(e.message); return null; }),
      adminApi.getLLMModels().catch(() => null),
    ]).then(([usage, health]) => {
      if (usage) setData(usage);
      if (health) setModels(health);
    }).finally(() => setLoading(false));
  }, []);

  if (error) return <div className="text-xs text-red-500">{error}</div>;
  if (loading) return <div className="text-xs text-neutral-400">Loading...</div>;
  if (!data) return <div className="text-xs text-neutral-400">No data</div>;

  const healthyCount = models?.healthy_count ?? 0;
  const unhealthyCount = models?.unhealthy_count ?? 0;

  return (
    <div className="space-y-6">
      <h1 className="text-sm font-semibold">LLM Usage</h1>

      <div className="grid grid-cols-4 gap-4">
        <div className="border border-neutral-200 bg-panel-chat p-3">
          <div className="text-[10px] text-neutral-500 uppercase tracking-wider">Total Spend</div>
          <div className="text-lg font-semibold tabular-nums mt-1">{formatUSD(data.total_spend)}</div>
        </div>
        <div className="border border-neutral-200 bg-panel-chat p-3">
          <div className="text-[10px] text-neutral-500 uppercase tracking-wider">Total Budget</div>
          <div className="text-lg font-semibold tabular-nums mt-1">{formatUSD(data.total_budget)}</div>
        </div>
        <div className="border border-neutral-200 bg-panel-chat p-3">
          <div className="text-[10px] text-neutral-500 uppercase tracking-wider">Active Keys</div>
          <div className="text-lg font-semibold tabular-nums mt-1">{data.total_keys}</div>
        </div>
        <div className="border border-neutral-200 bg-panel-chat p-3">
          <div className="text-[10px] text-neutral-500 uppercase tracking-wider">Models</div>
          <div className="text-lg font-semibold mt-1">
            {healthyCount > 0 ? (
              <span className="text-green-600">{healthyCount} up</span>
            ) : (
              <span className="text-neutral-400">--</span>
            )}
            {unhealthyCount > 0 && (
              <span className="text-red-500 ml-1.5 text-sm">({unhealthyCount} down)</span>
            )}
          </div>
        </div>
      </div>

      <div className="border border-neutral-200 bg-panel-chat">
        <div className="px-4 py-2.5 border-b border-neutral-200">
          <span className="text-xs font-medium">Per-User Spend</span>
          <span className="text-xs text-neutral-400 ml-2">{data.users.length} users</span>
        </div>
        <DataTable columns={columns} data={data.users} emptyMessage="No LLM keys provisioned" />
      </div>
    </div>
  );
}
