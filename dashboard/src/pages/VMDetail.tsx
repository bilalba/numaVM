import { useEffect, useState, useRef } from "react";
import { useParams, Link, useNavigate, useSearchParams, useLocation } from "react-router-dom";
import { api, wsUrlToHttp, type VMDetail as VMDetailType, type Quota, type NodeConnection } from "../lib/api";
import { useToast } from "../components/Toast";
import { useUser } from "../components/UserProvider";
import { TerminalTab } from "../components/TerminalTab";
import { AgentTab } from "../components/AgentTab";
import { AccessPanel } from "../components/AccessPanel";
import { FilesTab } from "../components/FilesTab";
import { FirewallPanel } from "../components/FirewallPanel";

type TabId = "terminal" | "codex" | "opencode" | "files" | "access" | "firewall";

const statusColors: Record<string, string> = {
  running: "bg-green-500",
  creating: "bg-yellow-500",
  stopped: "bg-neutral-400",
  error: "bg-red-500",
  snapshotted: "bg-blue-500",
  paused: "bg-blue-500",
};

export function VMDetail() {
  const { slug } = useParams<{ slug: string }>();
  const [vm, setVM] = useState<VMDetailType | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const validTabs: TabId[] = ["terminal", "codex", "opencode", "files", "access", "firewall"];
  const tabParam = searchParams.get("tab") as TabId | null;
  const activeTab: TabId = tabParam && validTabs.includes(tabParam) ? tabParam : "opencode";
  const setActiveTab = (tab: TabId) => setSearchParams({ tab }, { replace: true });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pausing, setPausing] = useState(false);
  const [quota, setQuota] = useState<Quota | null>(null);
  const { toast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const pendingSession = !!(location.state as any)?.pendingSession;
  const { user } = useUser();
  const webTerminalEnabled = user?.web_terminal_enabled !== false;
  const nodeRef = useRef<NodeConnection | null>(null);

  useEffect(() => {
    if (!slug) return;
    const state = location.state as { vmData?: any } | null;

    // If navigating from create, use vmData from state (skip GET /vms/:id)
    if (state?.vmData) {
      const d = state.vmData;
      const vmDetail: VMDetailType = {
        id: d.id, name: d.name, status: d.status, status_detail: d.status_detail ?? null,
        url: d.url, ...(d.repo_url ? { repo_url: d.repo_url } : {}),
        ssh_command: d.ssh_command, ssh_port: d.ssh_port, app_port: d.app_port, opencode_port: d.opencode_port,
        vm_status: null, role: d.role || "owner", created_at: d.created_at,
        mem_size_mib: d.mem_size_mib, image: d.image, image_version: d.image_version ?? 1,
        is_public: !!d.is_public, keep_alive: !!d.keep_alive,
        vm_ipv6: d.vm_ipv6 || null, host_id: d.host_id || null,
      };
      setVM(vmDetail);
      setLoading(false);

      // Set nodeRef from connect token (skip agent-connect-token call)
      if (d.connectToken && d.agentWsUrl) {
        nodeRef.current = { httpUrl: wsUrlToHttp(d.agentWsUrl), token: d.connectToken };
      } else if (d.host_id) {
        api.refreshConnectToken(d.id).then((data) => {
          nodeRef.current = { httpUrl: wsUrlToHttp(data.agentWsUrl), token: data.connectToken };
        }).catch(() => {});
      }

      // Clear state so back/forward doesn't reuse stale data
      window.history.replaceState({ ...state, vmData: undefined }, "");
      return;
    }

    // Normal load (page refresh / direct URL)
    api
      .getVM(slug)
      .then((vmData) => {
        setVM(vmData);
        // Eagerly resolve node connection for remote VMs
        if (vmData.host_id) {
          api.refreshConnectToken(vmData.id).then((data) => {
            nodeRef.current = { httpUrl: wsUrlToHttp(data.agentWsUrl), token: data.connectToken };
          }).catch(() => {});
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [slug]);

  // Fetch quota for keep-alive RAM info on Access tab
  useEffect(() => {
    if (activeTab !== "access") return;
    api.getRamQuota().then(setQuota).catch(() => {});
  }, [activeTab]);

  // Poll for status updates when VM is snapshotted/paused (waking up)
  useEffect(() => {
    if (!slug || !vm) return;
    if (vm.quota_error || vm.disk_quota_error || vm.data_quota_error) return; // Don't poll if quota exceeded — wake won't proceed
    if (vm.status !== "snapshotted" && vm.status !== "paused" && vm.status !== "creating") return;

    const pollMs = vm.status === "creating" ? 1000 : 3000;
    const interval = setInterval(() => {
      const node = nodeRef.current;
      if (node) {
        // Poll status directly from node (avoids CP round-trip)
        api.getNodeVMStatus(node, vm.id).then((status) => {
          setVM((prev) => prev ? { ...prev, status: status.status, status_detail: status.status_detail, ...(status.vm_ipv6 ? { vm_ipv6: status.vm_ipv6 } : {}) } : prev);
          if (status.status === "running") clearInterval(interval);
        }).catch(() => {});
      } else {
        // Fallback to CP for non-remote VMs
        api.getVM(slug).then((updated) => {
          setVM(updated);
          if (updated.status === "running" || updated.quota_error || updated.disk_quota_error || updated.data_quota_error) clearInterval(interval);
        }).catch(() => {});
      }
    }, pollMs);

    return () => clearInterval(interval);
  }, [slug, vm?.status]);

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 text-neutral-500 text-xs">
        Loading VM...
      </div>
    );
  }

  if (error || !vm) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
        <div className="border border-neutral-300 p-4 text-sm text-red-600">
          {error || "VM not found"}
        </div>
        <Link to="/" className="text-xs underline underline-offset-4 transition-opacity hover:opacity-60 mt-4 inline-block">
          Back to VMs
        </Link>
      </div>
    );
  }

  const tabs: { id: TabId; label: string }[] = [
    { id: "opencode", label: "OpenCode" },
    { id: "codex", label: "Codex" },
    ...(webTerminalEnabled ? [{ id: "terminal" as TabId, label: "Terminal" }] : []),
    { id: "files", label: "Files" },
    { id: "access", label: "Access" },
    { id: "firewall", label: "IPv6" },
  ];

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 sm:py-8 flex flex-col h-[calc(100dvh-33px)]">
      {/* Header */}
      <div className="mb-4 sm:mb-6">
        <div className="flex items-center gap-3">
          <Link to="/" className="text-xs text-neutral-500 underline underline-offset-4 transition-opacity hover:opacity-60 shrink-0">
            &larr; VMs
          </Link>
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${statusColors[vm.status] || "bg-neutral-400"}`}
          />
          <h1 className="text-xl sm:text-2xl font-semibold truncate">{vm.name}</h1>
          <a
            href={vm.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs underline underline-offset-4 transition-opacity hover:opacity-60 shrink-0"
          >
            Visit
          </a>
          <div className="flex items-center gap-2 text-xs ml-auto shrink-0">
            {vm.repo_url && (
              <>
                <a
                  href={vm.repo_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-4 transition-opacity hover:opacity-60"
                >
                  GitHub
                </a>
                <span className="text-neutral-400">&middot;</span>
              </>
            )}
            <span className="text-neutral-500 capitalize">
              {vm.status} &middot;{" "}
              {vm.image && vm.image !== "alpine" ? `${vm.image} v${vm.image_version} \u00B7 ` : ""}
              {vm.mem_size_mib >= 1024
                ? `${(vm.mem_size_mib / 1024).toFixed(vm.mem_size_mib % 1024 ? 2 : 0)} GB`
                : `${vm.mem_size_mib} MB`} RAM
            </span>
            {vm.status === "running" && vm.role === "owner" && (
              <>
                <span className="text-neutral-400">|</span>
                <button
                  onClick={async () => {
                    if (!window.confirm(`Pause "${vm.name}"? The VM will be snapshotted and can be resumed later.`)) return;
                    navigate("/", { state: { pausingVmId: vm.id, pausingVmName: vm.name } });
                  }}
                  disabled={pausing}
                  className="underline underline-offset-4 transition-opacity hover:opacity-60 cursor-pointer disabled:opacity-30"
                >
                  {pausing ? "Pausing..." : "Pause"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Setting up banner */}
      {vm.status === "creating" && (
        <div className="mb-4 border border-neutral-200 px-4 py-3 flex items-center gap-3 bg-panel-chat">
          <div className="w-1.5 h-1.5 rounded-full bg-yellow-500 animate-[pulseDot_1s_ease-in-out_infinite]" />
          <span className="text-xs text-neutral-600">
            {vm.status_detail || "Setting up your VM..."}
          </span>
        </div>
      )}

      {/* RAM quota exceeded banner */}
      {vm.quota_error && (
        <div className="mb-4 border border-red-200 px-4 py-3 flex items-center gap-3 bg-red-50">
          <div className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
          <span className="text-xs text-red-700">
            This VM can't wake up — you've reached your plan's RAM limit ({vm.quota_error.current_ram_mib}/{vm.quota_error.max_ram_mib} MiB in use).{" "}
            Stop another VM or{" "}
            <Link to="/plan" className="underline font-medium">upgrade your plan</Link>.
          </span>
        </div>
      )}

      {/* Disk quota exceeded banner */}
      {vm.disk_quota_error && (
        <div className="mb-4 border border-red-200 px-4 py-3 flex items-center gap-3 bg-red-50">
          <div className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
          <span className="text-xs text-red-700">
            This VM can't wake up — you've reached your plan's disk limit ({vm.disk_quota_error.used_gib}/{vm.disk_quota_error.max_gib} GiB in use).{" "}
            Delete a VM or{" "}
            <Link to="/plan" className="underline font-medium">upgrade your plan</Link>.
          </span>
        </div>
      )}

      {/* Data quota exceeded banner */}
      {vm.data_quota_error && (
        <div className="mb-4 border border-red-200 px-4 py-3 flex items-center gap-3 bg-red-50">
          <div className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
          <span className="text-xs text-red-700">
            This VM can't wake up — you've reached your plan's monthly data transfer limit.{" "}
            <Link to="/plan" className="underline font-medium">Upgrade your plan</Link>{" "}
            or wait until next month.
          </span>
        </div>
      )}

      {/* Waking up banner */}
      {(vm.status === "snapshotted" || vm.status === "paused") && !vm.quota_error && !vm.disk_quota_error && !vm.data_quota_error && (
        <div className="mb-4 border border-neutral-200 px-4 py-3 flex items-center gap-3 bg-panel-chat">
          <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-[pulseDot_1s_ease-in-out_infinite]" />
          <span className="text-xs text-neutral-600">
            Your VM is waking up from sleep. This usually takes a few seconds.
          </span>
        </div>
      )}

      {/* Tab bar — scrollable on mobile */}
      <div className="flex border-b border-neutral-200 mb-4 sm:mb-6 overflow-x-auto overflow-y-hidden -mx-4 px-4 sm:mx-0 sm:px-0">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-3 sm:px-4 py-2 text-xs transition-opacity cursor-pointer -mb-px whitespace-nowrap shrink-0 ${
              activeTab === tab.id
                ? "font-semibold opacity-100 border-b border-black"
                : "opacity-60 hover:opacity-80"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0">
        {activeTab === "codex" && <AgentTab vmId={vm.id} agentType="codex" vmStatus={vm.status} hostId={vm.host_id} />}
        {activeTab === "opencode" && <AgentTab vmId={vm.id} agentType="opencode" vmName={vm.name} vmStatus={vm.status} pendingSession={pendingSession} hostId={vm.host_id} />}
        {activeTab === "terminal" && <TerminalTab vmId={vm.id} isRemote={!!vm.host_id} />}
        {activeTab === "files" && <FilesTab vmId={vm.id} hostId={vm.host_id} />}
        {activeTab === "access" && (
          <AccessPanel
            vmId={vm.id}
            currentUserRole={vm.role}
            sshCommand={vm.ssh_command}
            vmIpv6={vm.vm_ipv6}
            isPublic={vm.is_public}
            keepAlive={vm.keep_alive}
            vmUrl={vm.url}
            region={vm.region}
            plan={quota?.plan}
            keepAliveRamUsed={quota?.keep_alive_ram_used}
            keepAliveRamMax={quota?.keep_alive_ram_max}
            onPublicChange={(isPublic) => setVM((prev) => prev ? { ...prev, is_public: isPublic } : prev)}
            onKeepAliveChange={(keepAlive) => {
              setVM((prev) => prev ? { ...prev, keep_alive: keepAlive } : prev);
              // Refresh quota to update RAM usage
              api.getRamQuota().then(setQuota).catch(() => {});
            }}
          />
        )}
        {activeTab === "firewall" && (
          <FirewallPanel
            vmId={vm.id}
            currentUserRole={vm.role}
            vmIpv6={vm.vm_ipv6}
          />
        )}
      </div>
    </div>
  );
}
