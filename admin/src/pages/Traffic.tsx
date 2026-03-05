import { useState, useEffect } from "react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { adminApi, type TrafficSummary, type TrafficPoint } from "../lib/api";
import { formatBytes } from "../lib/time";

const HOUR_OPTIONS = [1, 6, 12, 24, 48, 168];

function formatTime(dateStr: string): string {
  const d = new Date(dateStr.includes("T") || dateStr.includes("Z") ? dateStr : dateStr.replace(" ", "T") + "Z");
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function TrafficChart({ envId, hours }: { envId: string; hours: number }) {
  const [data, setData] = useState<TrafficPoint[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    adminApi
      .getTrafficHistory(envId, hours)
      .then((res) => setData(res.history))
      .catch(() => setData([]))
      .finally(() => setLoading(false));
  }, [envId, hours]);

  if (loading) return <div className="text-xs text-neutral-400 py-4">Loading...</div>;
  if (data.length === 0) return <div className="text-xs text-neutral-400 py-4">No traffic data</div>;

  const chartData = data.map((p) => ({
    time: formatTime(p.recorded_at),
    rx: p.rx_bytes,
    tx: p.tx_bytes,
    total: p.rx_bytes + p.tx_bytes,
  }));

  return (
    <ResponsiveContainer width="100%" height={160}>
      <AreaChart data={chartData}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e5e5" />
        <XAxis dataKey="time" tick={{ fontSize: 9 }} interval="preserveStartEnd" />
        <YAxis tick={{ fontSize: 9 }} tickFormatter={(v) => formatBytes(v)} width={60} />
        <Tooltip
          contentStyle={{ fontSize: 11, fontFamily: "Geist Mono" }}
          formatter={(value: number, name: string) => [formatBytes(value), name === "rx" ? "RX" : "TX"]}
          labelFormatter={(label) => `Time: ${label}`}
        />
        <Area type="monotone" dataKey="rx" stackId="1" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.3} name="rx" />
        <Area type="monotone" dataKey="tx" stackId="1" stroke="#22c55e" fill="#22c55e" fillOpacity={0.3} name="tx" />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function Traffic() {
  const [summary, setSummary] = useState<TrafficSummary[]>([]);
  const [hours, setHours] = useState(24);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    adminApi
      .getTrafficSummary(hours)
      .then((res) => setSummary(res.summary))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [hours]);

  if (error) return <div className="text-xs text-red-500">{error}</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-sm font-semibold">VM Traffic</h1>
        <div className="flex items-center gap-1.5">
          {HOUR_OPTIONS.map((h) => (
            <button
              key={h}
              onClick={() => setHours(h)}
              className={`px-2 py-1 text-[10px] rounded cursor-pointer transition-colors ${
                hours === h
                  ? "bg-neutral-900 text-white"
                  : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
              }`}
            >
              {h < 24 ? `${h}h` : `${h / 24}d`}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="text-xs text-neutral-400">Loading...</div>
      ) : summary.length === 0 ? (
        <div className="text-xs text-neutral-400 py-8 text-center border border-neutral-200 bg-panel-chat">
          No traffic data in the last {hours < 24 ? `${hours} hours` : `${hours / 24} days`}
        </div>
      ) : (
        <div className="space-y-3">
          {summary.map((s) => (
            <div key={s.env_id} className="border border-neutral-200 bg-panel-chat">
              <button
                onClick={() => setExpanded(expanded === s.env_id ? null : s.env_id)}
                className="w-full flex items-center justify-between px-4 py-3 text-xs cursor-pointer hover:bg-neutral-50 transition-colors"
              >
                <span className="font-medium">{s.env_id}</span>
                <div className="flex items-center gap-4">
                  <span className="text-neutral-500">
                    <span className="text-blue-500">RX</span> {formatBytes(s.total_rx)}
                  </span>
                  <span className="text-neutral-500">
                    <span className="text-green-500">TX</span> {formatBytes(s.total_tx)}
                  </span>
                  <span className="text-neutral-400">
                    {formatBytes(s.total_rx + s.total_tx)} total
                  </span>
                  <span className="text-neutral-300">{expanded === s.env_id ? "\u25B2" : "\u25BC"}</span>
                </div>
              </button>
              {expanded === s.env_id && (
                <div className="px-4 pb-4 border-t border-neutral-100">
                  <TrafficChart envId={s.env_id} hours={hours} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
