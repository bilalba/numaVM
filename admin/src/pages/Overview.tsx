import { useState, useEffect } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { adminApi, type AdminStats } from "../lib/api";
import { StatsCard } from "../components/StatsCard";
import { relativeTime } from "../lib/time";

const STATUS_COLORS: Record<string, string> = {
  running: "#22c55e",
  snapshotted: "#eab308",
  creating: "#3b82f6",
  stopped: "#737373",
  paused: "#f97316",
  error: "#ef4444",
};

const EVENT_BADGES: Record<string, string> = {
  "vm.created": "bg-green-100 text-green-700",
  "vm.deleted": "bg-red-100 text-red-700",
  "vm.paused": "bg-yellow-100 text-yellow-700",
  "vm.idle_snapshotted": "bg-orange-100 text-orange-700",
  "vm.woke": "bg-blue-100 text-blue-700",
  "agent.session_created": "bg-purple-100 text-purple-700",
};

export function Overview() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    adminApi.getStats().then(setStats).catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="text-xs text-red-500">{error}</div>;
  if (!stats) return <div className="text-xs text-neutral-400">Loading...</div>;

  const chartData = Object.entries(stats.envsByStatus).map(([status, count]) => ({
    status,
    count,
    fill: STATUS_COLORS[status] || "#a3a3a3",
  }));

  const activeSessions = (stats.sessionCounts["idle"] || 0) + (stats.sessionCounts["busy"] || 0);

  return (
    <div className="space-y-6">
      <h1 className="text-sm font-semibold">Overview</h1>

      <div className="grid grid-cols-4 gap-4">
        <StatsCard label="Total Users" value={stats.userCount} />
        <StatsCard label="Total Environments" value={stats.totalEnvs} />
        <StatsCard
          label="Running VMs"
          value={stats.envsByStatus["running"] || 0}
          dot="bg-green-500"
        />
        <StatsCard
          label="Active Agent Sessions"
          value={activeSessions}
          subtitle={`${stats.messageCount} total messages`}
        />
      </div>

      <div className="grid grid-cols-2 gap-6">
        {/* VM Status Chart */}
        <div className="border border-neutral-200 bg-panel-chat p-4">
          <div className="text-xs text-neutral-500 mb-3">VM Status Distribution</div>
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={chartData}>
                <XAxis dataKey="status" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ fontSize: 11, fontFamily: "Geist Mono" }}
                />
                <Bar dataKey="count" radius={[2, 2, 0, 0]}>
                  {chartData.map((entry, i) => (
                    <Cell key={i} fill={entry.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="text-xs text-neutral-400 py-8 text-center">No environments</div>
          )}
        </div>

        {/* Recent Events */}
        <div className="border border-neutral-200 bg-panel-chat p-4">
          <div className="text-xs text-neutral-500 mb-3">Recent Events</div>
          {stats.recentEvents.length > 0 ? (
            <div className="space-y-2">
              {stats.recentEvents.map((event: any) => (
                <div key={event.id} className="flex items-center gap-2 text-xs">
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                      EVENT_BADGES[event.type] || "bg-neutral-100 text-neutral-600"
                    }`}
                  >
                    {event.type}
                  </span>
                  {event.env_id && (
                    <span className="text-neutral-500">{event.env_id}</span>
                  )}
                  <span className="text-neutral-400 ml-auto">
                    {relativeTime(event.created_at)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-neutral-400 py-8 text-center">No events yet</div>
          )}
        </div>
      </div>
    </div>
  );
}
