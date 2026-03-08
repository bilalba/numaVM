import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type Subscription } from "../lib/api";
import { useToast } from "../components/Toast";

export function Plan() {
  const [sub, setSub] = useState<Subscription | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [searchParams] = useSearchParams();
  const { toast } = useToast();

  useEffect(() => {
    api.getSubscription()
      .then(setSub)
      .catch(() => toast("Failed to load subscription", "error"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (searchParams.get("success") === "true") {
      toast("Subscription activated! Welcome to the Base plan.", "success");
      // Refresh subscription data
      api.getSubscription().then(setSub).catch(() => {});
    }
    if (searchParams.get("canceled") === "true") {
      toast("Checkout canceled.", "error");
    }
  }, [searchParams]);

  async function handleUpgrade() {
    setActionLoading(true);
    try {
      const { url } = await api.createCheckoutSession();
      window.location.href = url;
    } catch (e: any) {
      toast(e.message || "Failed to start checkout", "error");
      setActionLoading(false);
    }
  }

  async function handleManageBilling() {
    setActionLoading(true);
    try {
      const { url } = await api.getPortalUrl();
      window.location.href = url;
    } catch (e: any) {
      toast(e.message || "Failed to open billing portal", "error");
      setActionLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-12 text-xs text-neutral-400">
        Loading...
      </div>
    );
  }

  const isBase = sub?.plan === "base";
  const hasStripe = !!sub?.stripe_subscription_id;
  const isPaidBase = isBase && !sub?.trial_active;
  const isTrial = isBase && sub?.trial_active;

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 text-xs">
      <div className="mb-6">
        <Link to="/" className="text-neutral-400 hover:text-neutral-600 hover:underline">
          &larr; Back
        </Link>
      </div>

      <h1 className="text-lg font-medium text-foreground mb-6">Plan</h1>

      {/* Current plan banner */}
      <div className="border border-neutral-200 rounded p-4 mb-8">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-foreground font-medium">
              {sub?.plan_label || "Free"} plan
            </div>
            {isTrial && sub?.trial_expires_at && (
              <div className="text-amber-600 mt-1">
                Trial expires {new Date(sub.trial_expires_at).toLocaleDateString()}
              </div>
            )}
            {hasStripe && sub?.current_period_end && (
              <div className="text-neutral-400 mt-1">
                {sub.cancel_at_period_end ? "Cancels" : "Renews"} {new Date(sub.current_period_end).toLocaleDateString()}
              </div>
            )}
          </div>
          {hasStripe && (
            <button
              onClick={handleManageBilling}
              disabled={actionLoading}
              className="px-3 py-1.5 border border-neutral-200 rounded hover:bg-neutral-100 text-neutral-600 disabled:opacity-50 cursor-pointer"
            >
              {actionLoading ? "..." : "Manage billing"}
            </button>
          )}
        </div>
      </div>

      {/* Plan comparison */}
      <div className="grid grid-cols-2 gap-4">
        {/* Free */}
        <div className={`border rounded p-4 ${!isBase ? "border-foreground" : "border-neutral-200"}`}>
          <div className="font-medium text-foreground mb-1">Free</div>
          <div className="text-neutral-400 mb-4">$0 / month</div>
          <ul className="space-y-2 text-neutral-600">
            <li>512 MB max RAM</li>
            <li>2 memory sizes</li>
            <li>Community support</li>
          </ul>
          {!isBase && (
            <div className="mt-4 text-center text-neutral-400 py-1.5">Current plan</div>
          )}
        </div>

        {/* Base */}
        <div className={`border rounded p-4 ${isBase ? "border-foreground" : "border-neutral-200"}`}>
          <div className="font-medium text-foreground mb-1">Base</div>
          <div className="text-neutral-400 mb-4">$8 / month</div>
          <ul className="space-y-2 text-neutral-600">
            <li>1536 MB max RAM</li>
            <li>6 memory sizes</li>
            <li>Priority support</li>
          </ul>
          {isPaidBase ? (
            <div className="mt-4 text-center text-neutral-400 py-1.5">Current plan</div>
          ) : (
            <button
              onClick={handleUpgrade}
              disabled={actionLoading}
              className="mt-4 w-full py-1.5 bg-foreground text-background rounded hover:opacity-80 disabled:opacity-50 cursor-pointer"
            >
              {actionLoading ? "..." : isTrial ? "Subscribe" : "Upgrade"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
