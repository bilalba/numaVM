import { useEffect, useState } from "react";
import { api, type SshKeyRecord, type SshKeyStatusRecord } from "../lib/api";
import { useToast } from "./Toast";

interface SshKeysPanelProps {
  /** If provided, shows per-key sync status for this VM */
  vmId?: string;
  sshCommand?: string;
}

export function SshKeysPanel({ vmId, sshCommand }: SshKeysPanelProps) {
  const [keys, setKeys] = useState<SshKeyRecord[]>([]);
  const [keyStatus, setKeyStatus] = useState<Map<string, SshKeyStatusRecord>>(new Map());
  const [newKey, setNewKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const { toast } = useToast();

  const loadKeys = () => {
    api
      .getSshKeys()
      .then((data) => setKeys(data.keys || []))
      .catch((err) => toast(`Failed to load SSH keys: ${err.message}`, "error"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadKeys();
  }, []);

  // Load per-key sync status for the VM
  useEffect(() => {
    if (!vmId) return;
    api
      .getSshKeysStatus(vmId)
      .then((data) => {
        const map = new Map<string, SshKeyStatusRecord>();
        for (const k of data.keys) {
          map.set(k.id, k);
        }
        setKeyStatus(map);
      })
      .catch(() => setKeyStatus(new Map()));
  }, [vmId, keys]);

  const handleAdd = async () => {
    const trimmed = newKey.trim();
    if (!trimmed) return;
    setAdding(true);
    try {
      await api.addSshKey(trimmed);
      setNewKey("");
      loadKeys();
      toast("SSH key added", "success");
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (id: string) => {
    setRemovingId(id);
    try {
      await api.removeSshKey(id);
      loadKeys();
      toast("SSH key removed", "success");
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setRemovingId(null);
    }
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    toast("Copied to clipboard", "success");
  };

  // Handle paste — detect full key line and auto-add
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && newKey.trim()) {
      e.preventDefault();
      handleAdd();
    }
  };

  /** Truncate key data for display: show type + first 12 chars of base64 + comment */
  const truncateKey = (keyData: string): string => {
    const parts = keyData.split(/\s+/);
    if (parts.length < 2) return keyData.slice(0, 40) + "...";
    const base64 = parts[1];
    const truncated = base64.length > 16 ? base64.slice(0, 16) + "..." : base64;
    return `${parts[0]} ${truncated}`;
  };

  if (loading) {
    return (
      <div className="text-neutral-500 text-xs py-4">Loading SSH keys...</div>
    );
  }

  return (
    <div className="max-w-2xl space-y-4">
      {/* SSH command (per-VM only) */}
      {sshCommand && (
        <div className="bg-panel-chat border border-neutral-200 p-4">
          <h3 className="text-xs font-semibold mb-2">SSH command</h3>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs bg-neutral-100 border border-neutral-200 px-3 py-2 font-mono select-all">
              {sshCommand}
            </code>
            <button
              onClick={() => handleCopy(sshCommand)}
              className="text-xs underline underline-offset-4 transition-opacity hover:opacity-60 cursor-pointer shrink-0"
            >
              Copy
            </button>
          </div>
          <p className="text-[10px] text-neutral-500 mt-2">
            Requires an SSH key configured below.
          </p>
        </div>
      )}

      {/* Key list */}
      <div className="bg-panel-chat border border-neutral-200 p-4">
        <h3 className="text-xs font-semibold mb-3">SSH keys</h3>

        {keys.length === 0 ? (
          <p className="text-xs text-neutral-500 mb-3">No SSH keys configured.</p>
        ) : (
          <div className="space-y-2 mb-3">
            {keys.map((key) => {
              const status = keyStatus.get(key.id);
              return (
                <div
                  key={key.id}
                  className="flex items-center gap-2 bg-neutral-100 border border-neutral-100 px-3 py-2"
                >
                  {/* Sync status dot (per-VM only) */}
                  {vmId && (
                    <span
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        status?.present ? "bg-green-500" : "bg-red-400"
                      }`}
                      title={status?.present ? "Present in VM" : "Not in VM"}
                    />
                  )}

                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-mono truncate" title={key.key_data}>
                      {truncateKey(key.key_data)}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] text-neutral-500">{key.key_type}</span>
                      {key.comment && (
                        <span className="text-[10px] text-neutral-500">{key.comment}</span>
                      )}
                      {key.source !== "manual" && (
                        <span className="text-[10px] bg-neutral-200 px-1 rounded">
                          {key.source}
                        </span>
                      )}
                    </div>
                  </div>

                  <button
                    onClick={() => handleRemove(key.id)}
                    disabled={removingId === key.id}
                    className="text-xs text-neutral-400 hover:text-red-500 transition-colors cursor-pointer shrink-0 disabled:opacity-30"
                    title="Remove key"
                  >
                    {removingId === key.id ? "..." : "\u00d7"}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Add key input */}
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="ssh-ed25519 AAAA... user@host"
            className="flex-1 border border-neutral-200 bg-surface px-3 py-2 text-xs font-mono placeholder:text-neutral-400 focus:border-foreground focus:outline-none"
          />
          <button
            onClick={handleAdd}
            disabled={adding || !newKey.trim()}
            className="text-xs underline underline-offset-4 transition-opacity hover:opacity-60 disabled:opacity-30 cursor-pointer shrink-0"
          >
            {adding ? "Adding..." : "Add"}
          </button>
        </div>
        <p className="text-[10px] text-neutral-500 mt-1">
          Paste your public key. Find yours with{" "}
          <code className="bg-neutral-100 px-1">cat ~/.ssh/id_ed25519.pub</code>
        </p>

        {keys.length > 0 && (
          <div className="flex items-center mt-3">
            <span className="text-[10px] text-neutral-500 ml-auto">
              {keys.length} key{keys.length !== 1 ? "s" : ""} configured
            </span>
          </div>
        )}
      </div>

      {!vmId && (
        <p className="text-[10px] text-neutral-500">
          Keys are automatically pushed to running VMs when added.
        </p>
      )}
    </div>
  );
}
