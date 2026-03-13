import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, githubConnectUrl } from "../lib/api";
import { useToast } from "../components/Toast";
import { SshKeysPanel } from "../components/SshKeysPanel";

export function Settings() {
  const [githubStatus, setGithubStatus] = useState<{ connected: boolean; username: string | null } | null>(null);
  const [regions, setRegions] = useState<string[]>([]);
  const [userRegion, setUserRegion] = useState<string | null>(null);
  const [savingRegion, setSavingRegion] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    api.getGithubStatus().then(setGithubStatus).catch(() => {});
    api.getRegions().then((data) => setRegions(data.regions)).catch(() => {});
    api.getUser().then((user) => setUserRegion(user.default_region ?? null)).catch(() => {});
  }, []);

  const handleDisconnectGithub = async () => {
    try {
      await api.disconnectGithub();
      setGithubStatus({ connected: false, username: null });
      toast("GitHub disconnected", "success");
    } catch (e: any) {
      toast(e.message || "Failed to disconnect", "error");
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 text-xs">
      <div className="mb-6">
        <Link to="/" className="text-neutral-400 hover:text-neutral-600 hover:underline">
          &larr; Back
        </Link>
      </div>

      <h1 className="text-lg font-medium text-foreground mb-6">Settings</h1>

      {/* GitHub connection */}
      <section className="mb-8">
        <h2 className="text-sm font-medium text-foreground mb-3">GitHub</h2>
        <div className="border border-neutral-200 rounded p-4">
          {githubStatus?.connected ? (
            <div className="flex items-center justify-between">
              <div>
                <span className="text-neutral-600">Connected as </span>
                <span className="font-medium text-foreground">{githubStatus.username}</span>
              </div>
              <button
                onClick={handleDisconnectGithub}
                className="text-neutral-400 hover:text-neutral-600 underline cursor-pointer"
              >
                Disconnect
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <span className="text-neutral-500">Not connected</span>
              <a
                href={githubConnectUrl(window.location.href)}
                className="px-3 py-1.5 bg-foreground text-background rounded hover:opacity-80"
              >
                Connect GitHub
              </a>
            </div>
          )}
        </div>
      </section>

      {/* Default Region — only when regions exist */}
      {regions.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-medium text-foreground mb-3">Default Region</h2>
          <div className="border border-neutral-200 rounded p-4">
            <p className="text-xs text-neutral-500 mb-3">New VMs will be created in this region.</p>
            <div className="flex gap-1.5">
              <button
                onClick={async () => {
                  setSavingRegion(true);
                  try {
                    await api.setUserRegion(null);
                    setUserRegion(null);
                    toast("Region set to Auto", "success");
                  } catch (e: any) {
                    toast(e.message || "Failed to update", "error");
                  } finally {
                    setSavingRegion(false);
                  }
                }}
                disabled={savingRegion}
                className={`px-3 py-1.5 text-xs border transition-colors cursor-pointer disabled:opacity-30 ${
                  userRegion === null
                    ? "border-foreground bg-surface font-medium"
                    : "border-neutral-200 bg-neutral-100 hover:border-neutral-300"
                }`}
              >
                Auto
              </button>
              {regions.map((r) => (
                <button
                  key={r}
                  onClick={async () => {
                    setSavingRegion(true);
                    try {
                      await api.setUserRegion(r);
                      setUserRegion(r);
                      toast(`Region set to ${r}`, "success");
                    } catch (e: any) {
                      toast(e.message || "Failed to update", "error");
                    } finally {
                      setSavingRegion(false);
                    }
                  }}
                  disabled={savingRegion}
                  className={`px-3 py-1.5 text-xs border transition-colors cursor-pointer disabled:opacity-30 ${
                    userRegion === r
                      ? "border-foreground bg-surface font-medium"
                      : "border-neutral-200 bg-neutral-100 hover:border-neutral-300"
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* SSH keys */}
      <section>
        <h2 className="text-sm font-medium text-foreground mb-3">SSH Keys</h2>
        <SshKeysPanel />
      </section>
    </div>
  );
}
