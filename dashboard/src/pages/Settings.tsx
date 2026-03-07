import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, githubConnectUrl } from "../lib/api";
import { useToast } from "../components/Toast";
import { SshKeysPanel } from "../components/SshKeysPanel";

export function Settings() {
  const [githubStatus, setGithubStatus] = useState<{ connected: boolean; username: string | null } | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    api.getGithubStatus().then(setGithubStatus).catch(() => {});
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

      <h1 className="text-lg font-medium text-neutral-900 mb-6">Settings</h1>

      {/* GitHub connection */}
      <section className="mb-8">
        <h2 className="text-sm font-medium text-neutral-900 mb-3">GitHub</h2>
        <div className="border border-neutral-200 rounded p-4">
          {githubStatus?.connected ? (
            <div className="flex items-center justify-between">
              <div>
                <span className="text-neutral-600">Connected as </span>
                <span className="font-medium text-neutral-900">{githubStatus.username}</span>
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
                className="px-3 py-1.5 bg-neutral-900 text-white rounded hover:bg-neutral-800"
              >
                Connect GitHub
              </a>
            </div>
          )}
        </div>
      </section>

      {/* SSH keys */}
      <section>
        <h2 className="text-sm font-medium text-neutral-900 mb-3">SSH Keys</h2>
        <SshKeysPanel />
      </section>
    </div>
  );
}
