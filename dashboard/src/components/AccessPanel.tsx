import { useEffect, useState } from "react";
import { api, type AccessEntry } from "../lib/api";
import { useToast } from "./Toast";
import { SshKeysPanel } from "./SshKeysPanel";

interface AccessPanelProps {
  vmId: string;
  currentUserRole: string;
  sshCommand?: string;
}

export function AccessPanel({ vmId, currentUserRole, sshCommand }: AccessPanelProps) {
  const [access, setAccess] = useState<AccessEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("editor");
  const [submitting, setSubmitting] = useState(false);
  const { toast } = useToast();
  const isOwner = currentUserRole === "owner";

  const loadAccess = () => {
    api
      .listAccess(vmId)
      .then((data) => setAccess(data.access))
      .catch((err) => toast(`Failed to load access list: ${err.message}`, "error"))
      .finally(() => setLoading(false));
  };

  useEffect(loadAccess, [vmId]);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setSubmitting(true);
    try {
      const res = await api.grantAccess(vmId, email.trim(), role);
      toast(res.message, "success");
      setEmail("");
      loadAccess();
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setSubmitting(false);
    }
  };

  const handleRevoke = async (entry: AccessEntry) => {
    try {
      const res = await api.revokeAccess(vmId, entry.email);
      toast(res.message, "success");
      loadAccess();
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  const handleRoleChange = async (entry: AccessEntry, newRole: string) => {
    try {
      const res = await api.grantAccess(vmId, entry.email, newRole);
      toast(res.message, "success");
      loadAccess();
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  if (loading) {
    return <div className="text-neutral-500 text-xs py-8 text-center">Loading access list...</div>;
  }

  return (
    <div className="max-w-2xl">
      {/* SSH access */}
      <div className="mb-6">
        <SshKeysPanel vmId={vmId} sshCommand={sshCommand} />
      </div>

      {/* Invite form (owner only) */}
      {isOwner && (
        <form onSubmit={handleInvite} className="mb-6 bg-panel-chat border border-neutral-200 p-4">
          <h3 className="text-xs font-semibold mb-3">Invite a collaborator</h3>
          <div className="flex gap-3 items-end">
            <div className="flex-1">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email address"
                className="w-full border-0 border-b border-neutral-300 bg-transparent px-0 py-1 text-sm text-black placeholder:text-neutral-500 focus:border-black focus:outline-none"
              />
            </div>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="border-0 border-b border-neutral-300 bg-transparent px-0 py-1 text-xs text-black focus:border-black focus:outline-none cursor-pointer"
            >
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
            </select>
            <button
              type="submit"
              disabled={submitting || !email.trim()}
              className="text-xs underline underline-offset-4 transition-opacity hover:opacity-60 disabled:opacity-30 cursor-pointer pb-1"
            >
              {submitting ? "Inviting..." : "Invite"}
            </button>
          </div>
          <p className="text-[10px] text-neutral-500 mt-2">User must have an account to be invited.</p>
        </form>
      )}

      {/* Access list */}
      <div className="bg-panel-chat border border-neutral-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-neutral-200">
          <h3 className="text-xs font-semibold">People with access</h3>
        </div>
        {access.length === 0 ? (
          <p className="text-xs text-neutral-500 p-4">No access entries found.</p>
        ) : (
          <div>
            {access.map((entry) => (
              <div
                key={entry.user_id}
                className="flex items-center justify-between px-4 py-3 border-b border-neutral-100 last:border-b-0"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-xs truncate">{entry.name || entry.email}</div>
                  {entry.name && (
                    <div className="text-[10px] text-neutral-500 truncate">{entry.email}</div>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0 ml-4">
                  <span className="text-xs text-neutral-500">
                    {entry.role}
                  </span>
                  {isOwner && entry.role !== "owner" && (
                    <>
                      <span className="text-neutral-400">|</span>
                      <select
                        value={entry.role}
                        onChange={(e) => handleRoleChange(entry, e.target.value)}
                        className="border-0 bg-transparent px-0 py-0 text-xs text-black focus:outline-none cursor-pointer"
                      >
                        <option value="editor">Editor</option>
                        <option value="viewer">Viewer</option>
                      </select>
                      <span className="text-neutral-400">|</span>
                      <button
                        onClick={() => handleRevoke(entry)}
                        className="text-xs underline underline-offset-4 opacity-60 transition-opacity hover:opacity-80 cursor-pointer"
                      >
                        Remove
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
