import { useState, useCallback } from "react";
import { api, type FileEntry } from "../lib/api";

interface FileBrowserProps {
  envId: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

interface DirState {
  entries: FileEntry[];
  loading: boolean;
  expanded: boolean;
  error?: string;
}

export function FileBrowser({ envId, collapsed, onToggleCollapse }: FileBrowserProps) {
  const [dirs, setDirs] = useState<Map<string, DirState>>(new Map());
  const [rootLoaded, setRootLoaded] = useState(false);

  const ROOT = "/home/dev";

  const loadDir = useCallback(
    async (path: string) => {
      setDirs((prev) => {
        const next = new Map(prev);
        const existing = next.get(path);
        next.set(path, { entries: existing?.entries || [], loading: true, expanded: true });
        return next;
      });

      try {
        const data = await api.listFiles(envId, path);
        setDirs((prev) => {
          const next = new Map(prev);
          next.set(path, { entries: data.entries, loading: false, expanded: true });
          return next;
        });
      } catch (err: any) {
        setDirs((prev) => {
          const next = new Map(prev);
          next.set(path, { entries: [], loading: false, expanded: true, error: err.message });
          return next;
        });
      }
    },
    [envId]
  );

  const toggleDir = useCallback(
    (path: string) => {
      const existing = dirs.get(path);
      if (!existing || !existing.expanded) {
        loadDir(path);
      } else {
        setDirs((prev) => {
          const next = new Map(prev);
          next.set(path, { ...existing, expanded: false });
          return next;
        });
      }
    },
    [dirs, loadDir]
  );

  // Load root on first expand
  if (!collapsed && !rootLoaded) {
    setRootLoaded(true);
    loadDir(ROOT);
  }

  const refreshAll = () => {
    setDirs(new Map());
    loadDir(ROOT);
  };

  if (collapsed) {
    return (
      <div className="w-8 shrink-0 flex flex-col items-center">
        <button
          onClick={onToggleCollapse}
          className="mt-2 p-1 text-[#666] hover:text-[#e5e5e5] transition-colors cursor-pointer"
          title="Show file browser"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M1 3.5h14v-1H1v1zm0 5h14v-1H1v1zm0 5h14v-1H1v1z" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div className="w-64 shrink-0 bg-[#141414] border border-[#333] rounded-lg flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 border-b border-[#333] flex items-center justify-between">
        <span className="text-xs font-medium text-[#999] uppercase tracking-wide">Files</span>
        <div className="flex items-center gap-1">
          <button
            onClick={refreshAll}
            className="p-1 text-[#666] hover:text-[#e5e5e5] transition-colors cursor-pointer"
            title="Refresh"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M13.65 2.35A7.958 7.958 0 008 0C3.58 0 0 3.58 0 8s3.58 8 8 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 018 14c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L9 7h7V0l-2.35 2.35z" />
            </svg>
          </button>
          <button
            onClick={onToggleCollapse}
            className="p-1 text-[#666] hover:text-[#e5e5e5] transition-colors cursor-pointer"
            title="Hide file browser"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M11.354 1.646a.5.5 0 010 .708L5.707 8l5.647 5.646a.5.5 0 01-.708.708l-6-6a.5.5 0 010-.708l6-6a.5.5 0 01.708 0z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto text-xs font-mono">
        <DirContents
          parentPath={ROOT}
          dirs={dirs}
          onToggleDir={toggleDir}
          depth={0}
        />
      </div>
    </div>
  );
}

function DirContents({
  parentPath,
  dirs,
  onToggleDir,
  depth,
}: {
  parentPath: string;
  dirs: Map<string, DirState>;
  onToggleDir: (path: string) => void;
  depth: number;
}) {
  const dirState = dirs.get(parentPath);
  if (!dirState) return null;

  if (dirState.loading && dirState.entries.length === 0) {
    return (
      <div className="py-1" style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}>
        <span className="text-[#555]">Loading...</span>
      </div>
    );
  }

  if (dirState.error) {
    return (
      <div className="py-1" style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}>
        <span className="text-red-400 text-[10px]">{dirState.error}</span>
      </div>
    );
  }

  if (dirState.entries.length === 0) {
    return (
      <div className="py-1" style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}>
        <span className="text-[#555] italic">empty</span>
      </div>
    );
  }

  return (
    <>
      {dirState.entries.map((entry) => {
        const fullPath = `${parentPath}/${entry.name}`;
        const isDir = entry.type === "dir";
        const childState = dirs.get(fullPath);
        const isExpanded = childState?.expanded || false;

        return (
          <div key={entry.name}>
            <div
              className="flex items-center py-0.5 hover:bg-[#1a1a2e] cursor-pointer group"
              style={{ paddingLeft: `${depth * 12 + 8}px` }}
              onClick={() => isDir && onToggleDir(fullPath)}
            >
              {/* Expand arrow or spacer */}
              <span className="w-4 text-center shrink-0 text-[#555]">
                {isDir ? (isExpanded ? "v" : ">") : ""}
              </span>
              {/* Icon */}
              <span className="w-4 text-center shrink-0 mr-1">
                {isDir ? (
                  <span className="text-blue-400">{isExpanded ? "\u{1F4C2}" : "\u{1F4C1}"}</span>
                ) : entry.type === "symlink" ? (
                  <span className="text-purple-400">{"\u{1F517}"}</span>
                ) : (
                  <span className="text-[#888]">{"\u{1F4C4}"}</span>
                )}
              </span>
              {/* Name */}
              <span
                className={`truncate ${
                  isDir
                    ? "text-blue-300"
                    : entry.type === "symlink"
                      ? "text-purple-300"
                      : "text-[#ccc]"
                }`}
              >
                {entry.name}
              </span>
            </div>
            {/* Render children if expanded */}
            {isDir && isExpanded && (
              <DirContents
                parentPath={fullPath}
                dirs={dirs}
                onToggleDir={onToggleDir}
                depth={depth + 1}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
