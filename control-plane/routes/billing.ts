import type { FastifyInstance } from "fastify";
import { getDatabase, getBilling, getPlanRegistry } from "../adapters/providers.js";

export function registerBillingRoutes(app: FastifyInstance) {
  const billing = getBilling();

  // Subscription status — always registered regardless of billing mode
  app.get("/billing/subscription", async (request) => {
    const plan = getDatabase().getUserPlan(request.userId);

    if (!billing.isEnabled()) {
      return {
        plan: plan.plan,
        plan_label: plan.label,
        trial_active: plan.trial_active,
        trial_expires_at: plan.trial_expires_at,
        stripe_subscription_id: null,
        stripe_status: null,
        current_period_end: null,
        cancel_at_period_end: false,
        billing_enabled: false,
      };
    }

    // Billing enabled — fetch subscription info from provider
    const sub = await billing.getSubscription(request.userId);

    if (sub?.stripe_subscription_id) {
      // Active Stripe subscription overrides DB plan
      const registry = getPlanRegistry();
      const limits = registry.getPlanLimits(sub.plan);
      return {
        plan: sub.plan,
        plan_label: limits?.label ?? sub.plan,
        trial_active: false,
        trial_expires_at: null,
        stripe_subscription_id: sub.stripe_subscription_id,
        stripe_status: sub.stripe_status,
        current_period_end: sub.current_period_end,
        cancel_at_period_end: sub.cancel_at_period_end,
        billing_enabled: true,
      };
    }

    return {
      plan: plan.plan,
      plan_label: plan.label,
      trial_active: plan.trial_active,
      trial_expires_at: plan.trial_expires_at,
      stripe_subscription_id: null,
      stripe_status: null,
      current_period_end: null,
      cancel_at_period_end: false,
      billing_enabled: true,
    };
  });

  // Only register mutation routes when billing is enabled
  if (!billing.isEnabled()) return;

  // Create Stripe Checkout session for upgrade
  app.post("/billing/checkout", async (request) => {
    return billing.createCheckoutSession(request.userId, request.userEmail);
  });

  // Create Stripe Customer Portal session
  app.post("/billing/portal", async (request, reply) => {
    try {
      return await billing.createPortalSession(request.userId);
    } catch (e: any) {
      return reply.status(400).send({ error: e.message });
    }
  });

  // Stripe webhook
  app.post("/billing/webhook", {
    config: { rawBody: true },
  }, async (request, reply) => {
    const sig = request.headers["stripe-signature"] as string;
    if (!sig) return reply.status(400).send({ error: "Missing stripe-signature header" });

    try {
      const result = await billing.handleWebhook(
        (request as any).rawBody || request.body,
        sig
      );

      if (result.action === "upgrade" && result.userId && result.plan) {
        getDatabase().updateUserPlan(result.userId, result.plan);
        request.log.info(`[billing] Upgraded user ${result.userId} to ${result.plan} plan`);
      } else if (result.action === "downgrade" && result.userId) {
        const defaultPlan = getPlanRegistry().getDefaultPlan();
        getDatabase().updateUserPlan(result.userId, result.plan ?? defaultPlan);
        request.log.info(`[billing] Downgraded user ${result.userId} to ${result.plan ?? defaultPlan} plan`);
      }

      return { received: true };
    } catch (err: any) {
      request.log.error(`Webhook error: ${err.message}`);
      return reply.status(400).send({ error: err.message });
    }
  });
}
