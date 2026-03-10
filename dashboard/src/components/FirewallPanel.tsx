import { useEffect, useState } from "react";
import { api, type FirewallRule } from "../lib/api";
import { useToast } from "./Toast";

interface FirewallPanelProps {
  vmId: string;
  currentUserRole: string;
  vmIpv6?: string | null;
}

export function FirewallPanel({ vmId, currentUserRole, vmIpv6 }: FirewallPanelProps) {
  const [rules, setRules] = useState<FirewallRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();
  const isOwner = currentUserRole === "owner";

  // Add-rule form state
  const [proto, setProto] = useState<"tcp" | "udp">("tcp");
  const [port, setPort] = useState("");
  const [source, setSource] = useState("::/0");
  const [description, setDescription] = useState("");

  const loadRules = () => {
    api
      .getFirewallRules(vmId)
      .then((data) => setRules(data.rules))
      .catch((err) => toast(`Failed to load firewall rules: ${err.message}`, "error"))
      .finally(() => setLoading(false));
  };

  useEffect(loadRules, [vmId]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const portNum = parseInt(port, 10);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      toast("Port must be 1-65535", "error");
      return;
    }

    const newRule: FirewallRule = {
      proto,
      port: portNum,
      source: source.trim() || "::/0",
      ...(description.trim() ? { description: description.trim() } : {}),
    };

    const newRules = [...rules, newRule];
    setSaving(true);
    try {
      await api.setFirewallRules(vmId, newRules);
      setRules(newRules);
      setPort("");
      setSource("::/0");
      setDescription("");
      toast("Rule added", "success");
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (index: number) => {
    const newRules = rules.filter((_, i) => i !== index);
    setSaving(true);
    try {
      await api.setFirewallRules(vmId, newRules);
      setRules(newRules);
      toast("Rule removed", "success");
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setSaving(false);
    }
  };

  if (!vmIpv6) {
    return (
      <div className="max-w-2xl">
        <div className="bg-panel-chat border border-neutral-200 p-4">
          <h3 className="text-xs font-semibold mb-2">Firewall</h3>
          <p className="text-xs text-neutral-500">
            IPv6 is not configured for this platform. Firewall rules require per-VM IPv6 addresses.
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return <div className="text-neutral-500 text-xs py-8 text-center">Loading firewall rules...</div>;
  }

  return (
    <div className="max-w-2xl">
      {/* IPv6 address */}
      <div className="mb-6 bg-panel-chat border border-neutral-200 p-4">
        <h3 className="text-xs font-semibold mb-1">IPv6 Address</h3>
        <code className="text-xs bg-neutral-100 border border-neutral-200 px-2 py-1 inline-block">{vmIpv6}</code>
        <p className="text-[10px] text-neutral-500 mt-2">
          Direct inbound IPv6 traffic is blocked by default. Add rules below to allow specific ports.
        </p>
      </div>

      {/* Add rule form (owner only) */}
      {isOwner && (
        <form onSubmit={handleAdd} className="mb-6 bg-panel-chat border border-neutral-200 p-4">
          <h3 className="text-xs font-semibold mb-3">Add inbound rule</h3>
          <div className="flex gap-3 items-end flex-wrap">
            <div>
              <label className="text-[10px] text-neutral-500 block mb-1">Protocol</label>
              <select
                value={proto}
                onChange={(e) => setProto(e.target.value as "tcp" | "udp")}
                className="border-0 border-b border-neutral-300 bg-transparent px-0 py-1 text-xs text-foreground focus:border-foreground focus:outline-none cursor-pointer"
              >
                <option value="tcp">TCP</option>
                <option value="udp">UDP</option>
              </select>
            </div>
            <div className="w-20">
              <label className="text-[10px] text-neutral-500 block mb-1">Port</label>
              <input
                type="number"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="80"
                min={1}
                max={65535}
                required
                className="w-full border-0 border-b border-neutral-300 bg-transparent px-0 py-1 text-xs text-foreground placeholder:text-neutral-400 focus:border-foreground focus:outline-none"
              />
            </div>
            <div className="flex-1 min-w-[120px]">
              <label className="text-[10px] text-neutral-500 block mb-1">Source CIDR</label>
              <input
                type="text"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="::/0"
                className="w-full border-0 border-b border-neutral-300 bg-transparent px-0 py-1 text-xs text-foreground placeholder:text-neutral-400 focus:border-foreground focus:outline-none"
              />
            </div>
            <div className="flex-1 min-w-[100px]">
              <label className="text-[10px] text-neutral-500 block mb-1">Description</label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional"
                className="w-full border-0 border-b border-neutral-300 bg-transparent px-0 py-1 text-xs text-foreground placeholder:text-neutral-400 focus:border-foreground focus:outline-none"
              />
            </div>
            <button
              type="submit"
              disabled={saving || !port}
              className="text-xs underline underline-offset-4 transition-opacity hover:opacity-60 disabled:opacity-30 cursor-pointer pb-1"
            >
              {saving ? "Adding..." : "Add"}
            </button>
          </div>
        </form>
      )}

      {/* Rules list */}
      <div className="bg-panel-chat border border-neutral-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-neutral-200">
          <h3 className="text-xs font-semibold">Inbound rules</h3>
        </div>
        {rules.length === 0 ? (
          <div className="p-4">
            <p className="text-xs text-neutral-500">No inbound rules. All IPv6 traffic is blocked (default deny).</p>
          </div>
        ) : (
          <div>
            {/* Header */}
            <div className="flex items-center px-4 py-2 border-b border-neutral-100 text-[10px] text-neutral-500 font-medium">
              <span className="w-12">Proto</span>
              <span className="w-16">Port</span>
              <span className="flex-1">Source</span>
              <span className="flex-1">Description</span>
              {isOwner && <span className="w-16" />}
            </div>
            {rules.map((rule, i) => (
              <div
                key={i}
                className="flex items-center px-4 py-2.5 border-b border-neutral-100 last:border-b-0"
              >
                <span className="w-12 text-xs uppercase">{rule.proto}</span>
                <span className="w-16 text-xs font-mono">{rule.port}</span>
                <span className="flex-1 text-xs font-mono text-neutral-600 truncate">{rule.source}</span>
                <span className="flex-1 text-xs text-neutral-500 truncate">{rule.description || "-"}</span>
                {isOwner && (
                  <span className="w-16 text-right">
                    <button
                      onClick={() => handleRemove(i)}
                      disabled={saving}
                      className="text-xs underline underline-offset-4 opacity-60 transition-opacity hover:opacity-80 cursor-pointer disabled:opacity-30"
                    >
                      Remove
                    </button>
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="px-4 py-2 border-t border-neutral-100">
          <p className="text-[10px] text-neutral-400">
            Default policy: deny all inbound IPv6. ICMPv6 and established connections are always allowed.
          </p>
        </div>
      </div>
    </div>
  );
}
