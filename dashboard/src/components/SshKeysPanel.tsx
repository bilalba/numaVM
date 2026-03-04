import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useToast } from "./Toast";

interface SshKeysPanelProps {
  /** If provided, shows sync button + SSH command for this env */
  envId?: string;
  sshCommand?: string;
}

export function SshKeysPanel({ envId, sshCommand }: SshKeysPanelProps) {
  const [keys, setKeys] = useState("");
  const [githubKeys, setGithubKeys] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    api
      .getSshKeys()
      .then((data) => {
        setKeys(data.keys || "");
        setGithubKeys(data.github_keys || "");
      })
      .catch((err) => toast(`Failed to load SSH keys: ${err.message}`, "error"))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.saveSshKeys(keys.trim());
      setDirty(false);
      toast("SSH keys saved", "success");
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setSaving(false);
    }
  };

  const handleSync = async () => {
    if (!envId) return;
    setSyncing(true);
    try {
      // Save first if there are unsaved changes
      if (dirty) {
        await api.saveSshKeys(keys.trim());
        setDirty(false);
      }
      await api.syncSshKeys(envId);
      toast("SSH keys synced to environment", "success");
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setSyncing(false);
    }
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    toast("Copied to clipboard", "success");
  };

  const keyCount =
    keys.split("\n").filter((l) => l.trim()).length +
    githubKeys.split("\n").filter((l) => l.trim()).length;

  if (loading) {
    return (
      <div className="text-neutral-500 text-xs py-4">Loading SSH keys...</div>
    );
  }

  return (
    <div className="max-w-2xl space-y-4">
      {/* SSH command (per-env only) */}
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

      {/* GitHub keys (read-only) */}
      {githubKeys && (
        <div className="bg-panel-chat border border-neutral-200 p-4">
          <h3 className="text-xs font-semibold mb-2">
            GitHub keys
            <span className="font-normal text-neutral-500 ml-2">
              (auto-imported)
            </span>
          </h3>
          <div className="text-xs text-neutral-600 font-mono space-y-1">
            {githubKeys
              .split("\n")
              .filter((l) => l.trim())
              .map((key, i) => (
                <div key={i} className="truncate bg-neutral-50 border border-neutral-100 px-2 py-1">
                  {key}
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Custom SSH keys */}
      <div className="bg-panel-chat border border-neutral-200 p-4">
        <h3 className="text-xs font-semibold mb-2">Custom SSH keys</h3>
        <textarea
          value={keys}
          onChange={(e) => {
            setKeys(e.target.value);
            setDirty(true);
          }}
          placeholder="Paste your public key (e.g. ssh-ed25519 AAAA... user@host)"
          rows={4}
          className="w-full border border-neutral-200 bg-white px-3 py-2 text-xs font-mono placeholder:text-neutral-400 focus:border-black focus:outline-none resize-y"
        />
        <p className="text-[10px] text-neutral-500 mt-1 mb-3">
          One key per line. Find yours with{" "}
          <code className="bg-neutral-100 px-1">cat ~/.ssh/id_ed25519.pub</code>
        </p>
        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            disabled={saving || !dirty}
            className="text-xs underline underline-offset-4 transition-opacity hover:opacity-60 disabled:opacity-30 cursor-pointer"
          >
            {saving ? "Saving..." : "Save"}
          </button>
          {envId && (
            <button
              onClick={handleSync}
              disabled={syncing}
              className="text-xs underline underline-offset-4 transition-opacity hover:opacity-60 disabled:opacity-30 cursor-pointer"
            >
              {syncing ? "Syncing..." : "Sync to this environment"}
            </button>
          )}
          {keyCount > 0 && (
            <span className="text-[10px] text-neutral-500 ml-auto">
              {keyCount} key{keyCount !== 1 ? "s" : ""} configured
            </span>
          )}
        </div>
      </div>

      {!envId && (
        <p className="text-[10px] text-neutral-500">
          Keys are injected into new environments automatically. For existing environments, use "Sync" from the environment's Access tab.
        </p>
      )}
    </div>
  );
}
