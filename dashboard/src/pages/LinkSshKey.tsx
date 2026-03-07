import { useEffect, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { api } from "../lib/api";

function getAuthLoginUrl(linkToken: string, returnUrl: string): string {
  const apiHost = import.meta.env.VITE_API_URL?.replace(/^\/\//, "") || "api.localhost";
  const authHost = apiHost.replace(/^api\./, "auth.");
  const protocol = window.location.protocol;
  return `${protocol}//${authHost}/login?redirect=${encodeURIComponent(returnUrl)}&link_token=${encodeURIComponent(linkToken)}`;
}

export function LinkSshKey() {
  const [params] = useSearchParams();
  const token = params.get("token");
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);
  const [doneMessage, setDoneMessage] = useState("");
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  useEffect(() => {
    if (!token) {
      setError("No link token provided.");
      setLoading(false);
      return;
    }

    // First check if user is authenticated
    Promise.all([
      api.getUser().then(() => true).catch(() => false),
      api.getPendingKey(token),
    ]).then(([authed, pendingData]) => {
      setFingerprint(pendingData.fingerprint);
      setEmail(pendingData.email);
      setIsAuthenticated(authed);

      if (!authed) {
        // Redirect to login with the email locked, then back here
        const returnUrl = window.location.href;
        window.location.href = getAuthLoginUrl(token!, returnUrl);
        return;
      }

      setLoading(false);
    }).catch(() => {
      setError("This link has expired or is invalid. Please try again from your terminal.");
      setLoading(false);
    });
  }, [token]);

  const handleConfirm = async () => {
    if (!token) return;
    setConfirming(true);
    try {
      const result = await api.confirmLinkSshKey(token);
      setDone(true);
      setDoneMessage(result.message);
    } catch (e: any) {
      setError(e.message || "Failed to link key");
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="max-w-lg mx-auto px-4 py-16 text-xs">
      <div className="border border-neutral-200 rounded-lg p-6">
        {loading && (
          <div className="text-neutral-500 text-center py-8">Loading...</div>
        )}

        {error && (
          <div className="text-center py-4">
            <div className="text-red-600 mb-4">{error}</div>
            <Link to="/" className="text-neutral-400 hover:text-neutral-600 underline">
              Go to dashboard
            </Link>
          </div>
        )}

        {done && (
          <div className="text-center py-4">
            <div className="text-green-600 text-2xl mb-3">&#10003;</div>
            <div className="text-sm font-medium text-neutral-900 mb-2">SSH Key Linked</div>
            <div className="text-neutral-500 mb-6">{doneMessage}</div>
            <div className="text-neutral-400">
              You can close this page and return to your terminal.
            </div>
          </div>
        )}

        {!loading && !error && !done && fingerprint && (
          <>
            <h1 className="text-sm font-medium text-neutral-900 mb-4">
              Link SSH Key to Your Account
            </h1>

            <p className="text-neutral-600 mb-4">
              A terminal session is requesting to link an SSH key to your account.
              Only confirm if you initiated this request.
            </p>

            <div className="space-y-3 mb-6">
              <div className="flex justify-between items-start">
                <span className="text-neutral-400 w-24 shrink-0">Email</span>
                <span className="text-neutral-900 font-mono text-[11px]">{email}</span>
              </div>
              <div className="flex justify-between items-start">
                <span className="text-neutral-400 w-24 shrink-0">Fingerprint</span>
                <span className="text-neutral-600 font-mono text-[11px] break-all">{fingerprint}</span>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={handleConfirm}
                disabled={confirming}
                className="flex-1 px-4 py-2 bg-neutral-900 text-white rounded hover:bg-neutral-800 disabled:opacity-50 cursor-pointer"
              >
                {confirming ? "Linking..." : "Confirm"}
              </button>
              <Link
                to="/"
                className="flex-1 px-4 py-2 text-center border border-neutral-200 rounded text-neutral-600 hover:bg-neutral-50"
              >
                Deny
              </Link>
            </div>

            <p className="text-neutral-400 mt-4 text-[10px]">
              This link expires in 10 minutes. If you did not initiate this from a terminal, click Deny.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
