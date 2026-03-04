import { useState, useCallback, useEffect } from "react";
import { api, type FileEntry, type FileContent, type GitCommit } from "../lib/api";

interface FilesTabProps {
  envId: string;
}

interface DirState {
  entries: FileEntry[];
  loading: boolean;
  expanded: boolean;
  error?: string;
}

const ROOT = "/home/dev";

export function FilesTab({ envId }: FilesTabProps) {
  const [dirs, setDirs] = useState<Map<string, DirState>>(new Map());
  const [selectedFile, setSelectedFile] = useState<FileContent | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [commits, setCommits] = useState<GitCommit[]>([]);

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

  // Load root + git log on mount
  useEffect(() => {
    loadDir(ROOT);
    api.getGitLog(envId, 20).then((data) => setCommits(data.commits)).catch(() => {});
  }, [envId, loadDir]);

  const handleFileClick = async (path: string) => {
    setFileLoading(true);
    setFileError(null);
    try {
      const data = await api.readFile(envId, path);
      setSelectedFile(data);
    } catch (err: any) {
      setFileError(err.message);
      setSelectedFile(null);
    } finally {
      setFileLoading(false);
    }
  };

  return (
    <div className="flex h-[calc(100vh-200px)] min-h-[400px] gap-4">
      {/* File tree (left panel) */}
      <div className="w-72 shrink-0 bg-panel-sidebar border border-neutral-200 flex flex-col overflow-hidden">
        <div className="px-3 py-2 border-b border-neutral-200 flex items-center justify-between">
          <span className="text-xs text-neutral-500 uppercase tracking-wide">Files</span>
          <button
            onClick={() => { setDirs(new Map()); loadDir(ROOT); }}
            className="text-xs text-neutral-500 transition-opacity hover:opacity-60 cursor-pointer"
            title="Refresh"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M13.65 2.35A7.958 7.958 0 008 0C3.58 0 0 3.58 0 8s3.58 8 8 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 018 14c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L9 7h7V0l-2.35 2.35z" />
            </svg>
          </button>
        </div>

        {/* Tree */}
        <div className="flex-1 overflow-y-auto text-xs">
          <TreeNode
            parentPath={ROOT}
            dirs={dirs}
            onToggleDir={toggleDir}
            onFileClick={handleFileClick}
            selectedPath={selectedFile?.path || null}
            depth={0}
          />
        </div>

        {/* Git log */}
        {commits.length > 0 && (
          <div className="border-t border-neutral-200">
            <div className="px-3 py-2 border-b border-neutral-100">
              <span className="text-xs text-neutral-500 uppercase tracking-wide">Git History</span>
            </div>
            <div className="max-h-48 overflow-y-auto">
              {commits.map((c) => (
                <div key={c.hash} className="px-3 py-1.5 border-b border-neutral-100 last:border-b-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-neutral-500 shrink-0">{c.hash.slice(0, 7)}</span>
                    <span className="text-[11px] truncate">{c.message}</span>
                  </div>
                  <div className="text-[10px] text-neutral-500">{c.author}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Content viewer (right panel) */}
      <div className="flex-1 bg-white border border-neutral-200 flex flex-col overflow-hidden">
        {fileLoading ? (
          <div className="flex-1 flex items-center justify-center text-neutral-500 text-xs">
            Loading file...
          </div>
        ) : fileError ? (
          <div className="flex-1 flex items-center justify-center text-red-600 text-xs">
            {fileError}
          </div>
        ) : !selectedFile ? (
          <div className="flex-1 flex items-center justify-center text-neutral-500 text-xs">
            Select a file to view its contents
          </div>
        ) : selectedFile.binary ? (
          <div className="flex-1 flex flex-col items-center justify-center text-neutral-500">
            <div className="text-xs mb-1">Binary file</div>
            <div className="text-[10px]">{selectedFile.mimeType} &middot; {formatSize(selectedFile.size)}</div>
          </div>
        ) : (
          <>
            {/* File header */}
            <div className="px-4 py-2 border-b border-neutral-200 flex items-center justify-between">
              <span className="text-xs text-neutral-500 truncate">{selectedFile.path}</span>
              <span className="text-[10px] text-neutral-500 shrink-0 ml-4">{formatSize(selectedFile.size)}</span>
            </div>
            {/* File content with line numbers */}
            <div className="flex-1 overflow-auto">
              <pre className="text-xs leading-5">
                <table className="w-full border-collapse">
                  <tbody>
                    {(selectedFile.content || "").split("\n").map((line, i) => (
                      <tr key={i} className="hover:bg-[#faf7f2]">
                        <td className="text-right pr-4 pl-4 text-neutral-400 select-none w-12 align-top border-r border-neutral-100">
                          {i + 1}
                        </td>
                        <td className="pl-4 pr-4 whitespace-pre-wrap break-all">
                          {line || "\u00A0"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </pre>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function TreeNode({
  parentPath,
  dirs,
  onToggleDir,
  onFileClick,
  selectedPath,
  depth,
}: {
  parentPath: string;
  dirs: Map<string, DirState>;
  onToggleDir: (path: string) => void;
  onFileClick: (path: string) => void;
  selectedPath: string | null;
  depth: number;
}) {
  const dirState = dirs.get(parentPath);
  if (!dirState) return null;

  if (dirState.loading && dirState.entries.length === 0) {
    return (
      <div className="py-1" style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}>
        <span className="text-neutral-500">Loading...</span>
      </div>
    );
  }

  if (dirState.error) {
    return (
      <div className="py-1" style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}>
        <span className="text-red-600 text-[10px]">{dirState.error}</span>
      </div>
    );
  }

  if (dirState.entries.length === 0) {
    return (
      <div className="py-1" style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}>
        <span className="text-neutral-500 italic">empty</span>
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
        const isSelected = fullPath === selectedPath;

        return (
          <div key={entry.name}>
            <div
              className={`flex items-center py-0.5 cursor-pointer transition-opacity ${
                isSelected ? "bg-panel-chat font-semibold" : "hover:opacity-60"
              }`}
              style={{ paddingLeft: `${depth * 12 + 8}px` }}
              onClick={() => (isDir ? onToggleDir(fullPath) : onFileClick(fullPath))}
            >
              <span className="w-4 text-center shrink-0 text-neutral-400">
                {isDir ? (isExpanded ? "\u25BE" : "\u25B8") : ""}
              </span>
              <span className="truncate">
                {entry.name}
              </span>
            </div>
            {isDir && isExpanded && (
              <TreeNode
                parentPath={fullPath}
                dirs={dirs}
                onToggleDir={onToggleDir}
                onFileClick={onFileClick}
                selectedPath={selectedPath}
                depth={depth + 1}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
