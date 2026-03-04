import { useRef, useState, useEffect, useCallback } from "react";
import { useTerminal } from "../hooks/useTerminal";
import { api, type TerminalSession } from "../lib/api";
import "@xterm/xterm/css/xterm.css";

interface TerminalTabProps {
  envId: string;
}

interface Tab {
  name: string;
}

function TerminalPane({
  envId,
  session,
  active,
}: {
  envId: string;
  session: string;
  active: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useTerminal({
    envId,
    containerRef,
    enabled: active,
    session,
  });

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{ display: active ? "block" : "none" }}
    />
  );
}

export function TerminalTab({ envId }: TerminalTabProps) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTab, setActiveTab] = useState<string>("main");
  const [loading, setLoading] = useState(true);
  const nextCounter = useRef(1);

  // Fetch existing tmux sessions on mount
  useEffect(() => {
    let cancelled = false;

    async function fetchSessions() {
      try {
        const { sessions } = await api.listTerminalSessions(envId);
        if (cancelled) return;

        if (sessions.length > 0) {
          const loadedTabs = sessions.map((s) => ({ name: s.name }));
          setTabs(loadedTabs);
          setActiveTab(loadedTabs[0].name);

          // Track counter so new tabs don't collide
          for (const s of sessions) {
            const match = s.name.match(/^term-(\d+)$/);
            if (match) {
              const n = parseInt(match[1], 10);
              if (n >= nextCounter.current) nextCounter.current = n + 1;
            }
          }
        } else {
          // No existing sessions — start with "main"
          setTabs([{ name: "main" }]);
          setActiveTab("main");
        }
      } catch {
        // API error (e.g. container not ready) — start with "main"
        setTabs([{ name: "main" }]);
        setActiveTab("main");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchSessions();
    return () => {
      cancelled = true;
    };
  }, [envId]);

  const addTab = useCallback(() => {
    const name = `term-${nextCounter.current++}`;
    setTabs((prev) => [...prev, { name }]);
    setActiveTab(name);
  }, []);

  const closeTab = useCallback(
    async (name: string, e: React.MouseEvent) => {
      e.stopPropagation();

      // Kill the tmux session in the container
      try {
        await api.deleteTerminalSession(envId, name);
      } catch {
        // Best-effort — session may already be gone
      }

      setTabs((prev) => {
        const next = prev.filter((t) => t.name !== name);
        if (next.length === 0) {
          // Always keep at least one tab
          const fallback = { name: "main" };
          setActiveTab("main");
          return [fallback];
        }
        // If we closed the active tab, switch to the nearest one
        setActiveTab((current) => {
          if (current === name) {
            const closedIdx = prev.findIndex((t) => t.name === name);
            const newIdx = Math.min(closedIdx, next.length - 1);
            return next[newIdx].name;
          }
          return current;
        });
        return next;
      });
    },
    [envId]
  );

  if (loading) {
    return (
      <div className="h-[calc(100vh-200px)] min-h-[400px] bg-[#0a0a0a] overflow-hidden border border-neutral-200 flex items-center justify-center">
        <span className="text-xs text-neutral-500">Loading terminal sessions...</span>
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-200px)] min-h-[400px] overflow-hidden border border-neutral-200 flex flex-col">
      {/* Tab bar */}
      <div className="flex items-center bg-panel-sidebar border-b border-neutral-200 shrink-0">
        <div className="flex overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.name}
              onClick={() => setActiveTab(tab.name)}
              className={`group flex items-center gap-1.5 px-3 py-1.5 text-xs border-r border-neutral-200 transition-opacity cursor-pointer shrink-0 ${
                activeTab === tab.name
                  ? "font-semibold opacity-100 bg-panel-chat"
                  : "opacity-60 hover:opacity-80"
              }`}
            >
              <span>{tab.name}</span>
              <span
                onClick={(e) => closeTab(tab.name, e)}
                className="opacity-0 group-hover:opacity-60 hover:opacity-100 text-neutral-500 transition-opacity ml-1 text-[10px]"
                title="Close session"
              >
                ×
              </span>
            </button>
          ))}
        </div>
        <button
          onClick={addTab}
          className="px-2.5 py-1.5 text-xs text-neutral-500 transition-opacity hover:opacity-60 cursor-pointer shrink-0"
          title="New terminal"
        >
          +
        </button>
      </div>

      {/* Terminal panes */}
      <div className="flex-1 min-h-0 bg-[#0a0a0a]">
        {tabs.map((tab) => (
          <TerminalPane
            key={tab.name}
            envId={envId}
            session={tab.name}
            active={activeTab === tab.name}
          />
        ))}
      </div>
    </div>
  );
}
