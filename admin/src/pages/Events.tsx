import { useState, useEffect } from "react";
import { adminApi, type AdminEvent } from "../lib/api";
import { relativeTime } from "../lib/time";

const EVENT_BADGES: Record<string, string> = {
  "vm.created": "bg-green-100 text-green-700",
  "vm.deleted": "bg-red-100 text-red-700",
  "vm.paused": "bg-yellow-100 text-yellow-700",
  "vm.idle_snapshotted": "bg-orange-100 text-orange-700",
  "vm.woke": "bg-blue-100 text-blue-700",
  "agent.session_created": "bg-purple-100 text-purple-700",
};

const EVENT_TYPES = [
  "vm.created",
  "vm.deleted",
  "vm.paused",
  "vm.idle_snapshotted",
  "vm.woke",
  "agent.session_created",
];

export function Events() {
  const [events, setEvents] = useState<AdminEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");

  useEffect(() => {
    setLoading(true);
    adminApi
      .getEvents(200, filter || undefined)
      .then((res) => setEvents(res.events))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [filter]);

  if (error) return <div className="text-xs text-red-500">{error}</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-sm font-semibold">Events</h1>
        <div className="flex items-center gap-2">
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="text-xs border-0 border-b border-neutral-300 bg-transparent py-1 px-0 focus:outline-none focus:border-neutral-500"
          >
            <option value="">All types</option>
            {EVENT_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <span className="text-xs text-neutral-400">{events.length} events</span>
        </div>
      </div>

      {loading ? (
        <div className="text-xs text-neutral-400">Loading...</div>
      ) : events.length === 0 ? (
        <div className="text-xs text-neutral-400 py-8 text-center border border-neutral-200 bg-panel-chat">
          No events{filter ? ` of type "${filter}"` : ""}
        </div>
      ) : (
        <div className="border border-neutral-200 bg-panel-chat divide-y divide-neutral-100">
          {events.map((event) => {
            let meta: Record<string, unknown> | null = null;
            try {
              if (event.metadata) meta = JSON.parse(event.metadata);
            } catch { /* ignore */ }

            return (
              <div key={event.id} className="flex items-start gap-3 px-4 py-3 text-xs">
                <span
                  className={`px-1.5 py-0.5 rounded text-[10px] font-medium whitespace-nowrap ${
                    EVENT_BADGES[event.type] || "bg-neutral-100 text-neutral-600"
                  }`}
                >
                  {event.type}
                </span>
                <div className="flex-1 min-w-0">
                  {event.env_id && (
                    <span className="text-neutral-600 font-medium">{event.env_id}</span>
                  )}
                  {event.user_id && (
                    <span className="text-neutral-400 ml-2">by {event.user_id}</span>
                  )}
                  {meta && (
                    <div className="text-neutral-400 mt-0.5 truncate">
                      {Object.entries(meta).map(([k, v]) => `${k}=${v}`).join(" ")}
                    </div>
                  )}
                </div>
                <span className="text-neutral-400 whitespace-nowrap">
                  {relativeTime(event.created_at)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
