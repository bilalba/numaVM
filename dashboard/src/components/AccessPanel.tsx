import { useEffect, useState } from "react";
import { api, type AccessEntry } from "../lib/api";
import { useToast } from "./Toast";

interface AccessPanelProps {
  envId: string;
  currentUserRole: string;
}

const roleBadge: Record<string, string> = {
  owner: "bg-purple-900/40 text-purple-300 border-purple-700",
  editor: "bg-blue-900/40 text-blue-300 border-blue-700",
  viewer: "bg-gray-800/40 text-gray-400 border-gray-600",
};

export function AccessPanel({ envId, currentUserRole }: AccessPanelProps) {
  const [access, setAccess] = useState<AccessEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("editor");
  const [submitting, setSubmitting] = useState(false);
  const { toast } = useToast();
  const isOwner = currentUserRole === "owner";

  const loadAccess = () => {
    api
      .listAccess(envId)
      .then((data) => setAccess(data.access))
      .catch((err) => toast(`Failed to load access list: ${err.message}`, "error"))
      .finally(() => setLoading(false));
  };

  useEffect(loadAccess, [envId]);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setSubmitting(true);
    try {
      const res = await api.grantAccess(envId, email.trim(), role);
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
      const res = await api.revokeAccess(envId, entry.email);
      toast(res.message, "success");
      loadAccess();
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  const handleRoleChange = async (entry: AccessEntry, newRole: string) => {
    try {
      const res = await api.grantAccess(envId, entry.email, newRole);
      toast(res.message, "success");
      loadAccess();
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  if (loading) {
    return <div className="text-[#999] text-sm py-8 text-center">Loading access list...</div>;
  }

  return (
    <div className="max-w-2xl">
      {/* Invite form (owner only) */}
      {isOwner && (
        <form onSubmit={handleInvite} className="mb-6 bg-[#141414] border border-[#333] rounded-lg p-4">
          <h3 className="text-sm font-medium mb-3">Invite a collaborator</h3>
          <div className="flex gap-2">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email address"
              className="flex-1 bg-[#0a0a0a] border border-[#333] rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="bg-[#0a0a0a] border border-[#333] rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500 cursor-pointer"
            >
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
            </select>
            <button
              type="submit"
              disabled={submitting || !email.trim()}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded transition-colors cursor-pointer"
            >
              {submitting ? "Inviting..." : "Invite"}
            </button>
          </div>
          <p className="text-[10px] text-[#666] mt-2">User must have an account to be invited.</p>
        </form>
      )}

      {/* Access list */}
      <div className="bg-[#141414] border border-[#333] rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-[#333]">
          <h3 className="text-sm font-medium">People with access</h3>
        </div>
        {access.length === 0 ? (
          <p className="text-sm text-[#666] p-4">No access entries found.</p>
        ) : (
          <div>
            {access.map((entry) => (
              <div
                key={entry.user_id}
                className="flex items-center justify-between px-4 py-3 border-b border-[#222] last:border-b-0"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm truncate">{entry.name || entry.email}</div>
                  {entry.name && (
                    <div className="text-xs text-[#666] truncate">{entry.email}</div>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0 ml-4">
                  <span
                    className={`text-xs px-2 py-0.5 rounded border ${roleBadge[entry.role] || roleBadge.viewer}`}
                  >
                    {entry.role}
                  </span>
                  {isOwner && entry.role !== "owner" && (
                    <>
                      <select
                        value={entry.role}
                        onChange={(e) => handleRoleChange(entry, e.target.value)}
                        className="bg-[#0a0a0a] border border-[#333] rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-500 cursor-pointer"
                      >
                        <option value="editor">Editor</option>
                        <option value="viewer">Viewer</option>
                      </select>
                      <button
                        onClick={() => handleRevoke(entry)}
                        className="text-xs text-red-400 hover:text-red-300 cursor-pointer"
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
