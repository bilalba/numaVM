import { useState, useEffect } from "react";
import { adminApi, type AdminNode } from "../lib/api";

function formatGiB(mib: number): string {
  if (mib >= 1024) return `${(mib / 1024).toFixed(1)} GiB`;
  return `${mib} MiB`;
}

function heartbeatStatus(ts: string | null): { color: string; label: string } {
  if (!ts) return { color: "bg-neutral-300", label: "never" };
  const ago = Date.now() - new Date(ts + "Z").getTime();
  const secs = Math.floor(ago / 1000);
  if (secs < 120) return { color: "bg-green-500", label: `${secs}s ago` };
  const mins = Math.floor(secs / 60);
  if (mins < 10) return { color: "bg-amber-500", label: `${mins}m ago` };
  return { color: "bg-red-500", label: `${mins}m ago` };
}

function barColor(pct: number): string {
  if (pct > 85) return "bg-red-500";
  if (pct >= 70) return "bg-amber-500";
  return "bg-green-500";
}

function badgeColor(pct: number): string {
  if (pct > 85) return "bg-red-100 text-red-700";
  if (pct >= 70) return "bg-amber-100 text-amber-700";
  return "bg-green-100 text-green-700";
}

function ResourceBar({ used, capacity, secondaryUsed, label }: {
  used: number;
  capacity: number;
  secondaryUsed?: number;
  label: string;
}) {
  const pct = capacity > 0 ? (used / capacity) * 100 : 0;
  const secondaryPct = secondaryUsed && capacity > 0 ? (secondaryUsed / capacity) * 100 : 0;
  const displayPct = Math.min(pct, 100);
  const displaySecondary = Math.min(secondaryPct, 100 - displayPct);

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[10px] text-neutral-500">
        <span>{label}</span>
        <span className="tabular-nums">{formatGiB(used)} / {formatGiB(capacity)}</span>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1 h-2 bg-neutral-100 rounded-full overflow-hidden flex">
          <div className={`h-full ${barColor(pct)}`} style={{ width: `${displayPct}%` }} />
          {displaySecondary > 0 && (
            <div className="h-full bg-amber-300 opacity-60" style={{ width: `${displaySecondary}%` }} />
          )}
        </div>
        <span className={`px-1.5 py-0.5 text-[10px] rounded font-medium tabular-nums ${badgeColor(pct)}`}>
          {Math.round(pct)}%
        </span>
      </div>
    </div>
  );
}

function VMCountBadges({ node }: { node: AdminNode }) {
  const badges = [
    { count: node.running_count, label: "running", cls: "bg-green-100 text-green-700" },
    { count: node.snapshot_count, label: "snapshot", cls: "bg-yellow-100 text-yellow-700" },
    { count: node.creating_count, label: "creating", cls: "bg-blue-100 text-blue-700" },
    { count: node.stopped_count, label: "stopped", cls: "bg-neutral-100 text-neutral-600" },
    { count: node.error_count, label: "error", cls: "bg-red-100 text-red-700" },
  ];
  return (
    <div className="flex flex-wrap gap-1.5">
      {badges.filter((b) => b.count > 0).map((b) => (
        <span key={b.label} className={`px-1.5 py-0.5 text-[10px] rounded font-medium ${b.cls}`}>
          {b.count} {b.label}
        </span>
      ))}
    </div>
  );
}

export function Nodes() {
  const [nodes, setNodes] = useState<AdminNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    adminApi.getNodes()
      .then((res) => setNodes(res.nodes))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (error) return <div className="text-xs text-red-500">{error}</div>;
  if (loading) return <div className="text-xs text-neutral-400">Loading...</div>;

  const activeCount = nodes.filter((n) => n.status === "active").length;
  const drainingCount = nodes.filter((n) => n.status === "draining").length;
  const totalRunningMem = nodes.reduce((s, n) => s + n.running_mem_mib, 0);
  const totalCapacityMem = nodes.reduce((s, n) => s + n.capacity_mem_mib, 0);
  const totalSnapshotMem = nodes.reduce((s, n) => s + n.snapshot_mem_mib, 0);
  const totalVMs = nodes.reduce((s, n) => s + n.vm_count, 0);
  const totalRunning = nodes.reduce((s, n) => s + n.running_count, 0);
  const totalSnapshotted = nodes.reduce((s, n) => s + n.snapshot_count, 0);

  return (
    <div className="space-y-6">
      <h1 className="text-sm font-semibold">Nodes</h1>

      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-4">
        <div className="border border-neutral-200 bg-panel-chat p-3">
          <div className="text-[10px] text-neutral-500 uppercase tracking-wider">Nodes</div>
          <div className="text-lg font-semibold tabular-nums mt-1">{nodes.length}</div>
          <div className="text-[10px] text-neutral-400 mt-0.5">{activeCount} active{drainingCount > 0 && `, ${drainingCount} draining`}</div>
        </div>
        <div className="border border-neutral-200 bg-panel-chat p-3">
          <div className="text-[10px] text-neutral-500 uppercase tracking-wider">Running RAM</div>
          <div className="text-lg font-semibold tabular-nums mt-1">{formatGiB(totalRunningMem)}</div>
          <div className="text-[10px] text-neutral-400 mt-0.5">of {formatGiB(totalCapacityMem)}</div>
        </div>
        <div className="border border-neutral-200 bg-panel-chat p-3">
          <div className="text-[10px] text-neutral-500 uppercase tracking-wider">Snapshot Memory</div>
          <div className="text-lg font-semibold tabular-nums mt-1">{formatGiB(totalSnapshotMem)}</div>
          <div className="text-[10px] text-neutral-400 mt-0.5">snapshot files on disk</div>
        </div>
        <div className="border border-neutral-200 bg-panel-chat p-3">
          <div className="text-[10px] text-neutral-500 uppercase tracking-wider">Total VMs</div>
          <div className="text-lg font-semibold tabular-nums mt-1">{totalVMs}</div>
          <div className="text-[10px] text-neutral-400 mt-0.5">{totalRunning} running, {totalSnapshotted} snapshotted</div>
        </div>
      </div>

      {/* Per-node cards */}
      {nodes.length === 0 ? (
        <div className="text-xs text-neutral-400">No nodes registered</div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {nodes.map((node) => {
            const hb = heartbeatStatus(node.last_heartbeat);
            const snapshotDiskMib = node.snapshot_mem_mib;
            return (
              <div key={node.id} className="border border-neutral-200 bg-panel-chat p-4 space-y-3">
                {/* Header */}
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm">{node.name}</span>
                  <span className={`px-1.5 py-0.5 text-[10px] rounded font-medium ${
                    node.status === "active" ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"
                  }`}>
                    {node.status}
                  </span>
                  <span className="px-1.5 py-0.5 text-[10px] rounded bg-neutral-100 text-neutral-600">
                    {node.region}
                  </span>
                  <div className="flex items-center gap-1 ml-auto">
                    <div className={`w-2 h-2 rounded-full ${hb.color}`} />
                    <span className="text-[10px] text-neutral-400">{hb.label}</span>
                  </div>
                </div>

                {/* Memory bar */}
                <ResourceBar
                  used={node.running_mem_mib}
                  capacity={node.capacity_mem_mib}
                  label="Memory (running)"
                />

                {/* Disk bar */}
                <ResourceBar
                  used={node.used_disk_gib * 1024}
                  capacity={node.capacity_disk_gib * 1024}
                  secondaryUsed={snapshotDiskMib}
                  label="Disk"
                />

                {/* Snapshot line */}
                {node.snapshot_count > 0 && (
                  <div className="text-[10px] text-neutral-500">
                    Snapshots: {formatGiB(node.snapshot_mem_mib)} across {node.snapshot_count} VM{node.snapshot_count !== 1 && "s"}
                  </div>
                )}

                {/* VM count badges */}
                <VMCountBadges node={node} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
