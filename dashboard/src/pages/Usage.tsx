import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type RamQuota, type VMSummary } from "../lib/api";

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function formatMem(mib: number): string {
  return mib >= 1024
    ? `${(mib / 1024).toFixed(mib % 1024 ? 2 : 0)} GB`
    : `${mib} MB`;
}

function barColor(pct: number): string {
  if (pct >= 90) return "bg-red-500";
  if (pct >= 70) return "bg-amber-500";
  return "bg-green-500";
}

const statusColors: Record<string, string> = {
  running: "bg-green-500",
  creating: "bg-yellow-500",
  stopped: "bg-neutral-400",
  error: "bg-red-500",
  snapshotted: "bg-blue-500",
  paused: "bg-blue-500",
};

export function Usage() {
  const [quota, setQuota] = useState<RamQuota | null>(null);
  const [vms, setVMs] = useState<VMSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([api.getRamQuota(), api.listVMs()])
      .then(([q, v]) => { setQuota(q); setVMs(v.vms); })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-12 text-xs text-neutral-400">
        Loading...
      </div>
    );
  }

  if (!quota) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-12 text-xs text-neutral-400">
        Failed to load usage data.
      </div>
    );
  }

  const ramPct = quota.max_mib > 0 ? Math.round((quota.used_mib / quota.max_mib) * 100) : 0;
  const diskPct = quota.disk_max_gib > 0 ? Math.round((quota.disk_used_gib / quota.disk_max_gib) * 100) : 0;
  const dataPct = quota.data_used_pct;

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 text-xs">
      <div className="mb-6">
        <Link to="/" className="text-neutral-400 hover:text-neutral-600 hover:underline">
          &larr; Back
        </Link>
      </div>

      <h1 className="text-lg font-medium text-foreground mb-6">Usage</h1>

      {/* RAM */}
      <section className="mb-8">
        <div className="flex items-baseline justify-between mb-2">
          <span className="text-foreground font-medium">RAM</span>
          <span className="text-neutral-400">
            {quota.used_mib} / {quota.max_mib} MB ({ramPct}%)
          </span>
        </div>
        <div className="w-full h-1.5 bg-neutral-200 rounded-full overflow-hidden mb-4">
          <div
            className={`h-full rounded-full transition-all ${barColor(ramPct)}`}
            style={{ width: `${Math.min(ramPct, 100)}%` }}
          />
        </div>

        {vms.length > 0 && (
          <div className="border border-neutral-200 rounded overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-neutral-200 text-neutral-400">
                  <th className="text-left px-3 py-2 font-normal">VM</th>
                  <th className="text-left px-3 py-2 font-normal">Status</th>
                  <th className="text-right px-3 py-2 font-normal">RAM</th>
                  <th className="text-right px-3 py-2 font-normal">Disk</th>
                </tr>
              </thead>
              <tbody>
                {vms.map((vm) => (
                  <tr key={vm.id} className="border-b border-neutral-100 last:border-0">
                    <td className="px-3 py-2">
                      <Link to={`/vm/${vm.id}`} className="text-foreground hover:underline">
                        {vm.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-1.5">
                        <span className={`w-1.5 h-1.5 rounded-full ${statusColors[vm.status] || "bg-neutral-400"}`} />
                        <span className="text-neutral-500 capitalize">{vm.status}</span>
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right text-neutral-500">{formatMem(vm.mem_size_mib)}</td>
                    <td className="px-3 py-2 text-right text-neutral-500">{vm.disk_size_gib} GB</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Disk */}
      <section className="mb-8">
        <div className="flex items-baseline justify-between mb-2">
          <span className="text-foreground font-medium">Disk</span>
          <span className="text-neutral-400">
            {quota.disk_used_gib} / {quota.disk_max_gib} GB ({diskPct}%)
          </span>
        </div>
        <div className="w-full h-1.5 bg-neutral-200 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${barColor(diskPct)}`}
            style={{ width: `${Math.min(diskPct, 100)}%` }}
          />
        </div>
      </section>

      {/* Data Transfer */}
      {quota.data_max_bytes > 0 && (
        <section className="mb-8">
          <div className="flex items-baseline justify-between mb-2">
            <span className="text-foreground font-medium">Data Transfer</span>
            <span className="text-neutral-400">
              {formatBytes(quota.data_used_bytes)} / {formatBytes(quota.data_max_bytes)} ({Math.round(dataPct)}%)
            </span>
          </div>
          <div className="w-full h-1.5 bg-neutral-200 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${barColor(dataPct)}`}
              style={{ width: `${Math.min(dataPct, 100)}%` }}
            />
          </div>
        </section>
      )}

      {/* Plan */}
      <section className="border border-neutral-200 rounded p-4">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-foreground font-medium">{quota.plan_label} plan</span>
            {quota.trial_active && quota.trial_expires_at && (
              <span className="text-amber-600 ml-2">
                Trial expires {new Date(quota.trial_expires_at).toLocaleDateString()}
              </span>
            )}
          </div>
          <Link
            to="/plan"
            className="text-neutral-400 hover:text-foreground hover:underline"
          >
            {quota.plan === "free" ? "Upgrade" : "Manage"}
          </Link>
        </div>
      </section>
    </div>
  );
}
