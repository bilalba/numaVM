import type { FastifyInstance } from "fastify";
import Stripe from "stripe";
import { getDatabase } from "../adapters/providers.js";

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not configured");
  return new Stripe(key);
}

function getDashboardUrl(): string {
  const base = process.env.BASE_DOMAIN || "localhost";
  if (base === "localhost") return "http://localhost:4002";
  return `https://app.${base}`;
}

async function getOrCreateCustomer(stripe: Stripe, userId: string, email: string): Promise<string> {
  const user = getDatabase().findUserById(userId);
  if (user?.stripe_customer_id) return user.stripe_customer_id;

  // Check if customer already exists in Stripe by email
  const existing = await stripe.customers.list({ email, limit: 1 });
  if (existing.data.length > 0) {
    getDatabase().setStripeCustomerId(userId, existing.data[0].id);
    return existing.data[0].id;
  }

  const customer = await stripe.customers.create({
    email,
    metadata: { userId },
  });
  getDatabase().setStripeCustomerId(userId, customer.id);
  return customer.id;
}

export function registerBillingRoutes(app: FastifyInstance) {
  // Create Stripe Checkout session for upgrade
  app.post("/billing/checkout", async (request, reply) => {
    const priceId = process.env.STRIPE_BASE_PRICE_ID;
    if (!priceId) return reply.status(500).send({ error: "Stripe price not configured" });

    const stripe = getStripe();
    const customerId = await getOrCreateCustomer(stripe, request.userId, request.userEmail);

    // Prevent duplicate subscriptions
    const existing = await stripe.subscriptions.list({
      customer: customerId,
      status: "active",
      limit: 1,
    });
    if (existing.data.length > 0) {
      return reply.status(400).send({ error: "You already have an active subscription. Use 'Manage billing' to make changes." });
    }

    const dashboardUrl = getDashboardUrl();

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${dashboardUrl}/plan?success=true`,
      cancel_url: `${dashboardUrl}/plan?canceled=true`,
    });

    return { url: session.url };
  });

  // Create Stripe Customer Portal session
  app.post("/billing/portal", async (request, reply) => {
    const stripe = getStripe();
    const user = getDatabase().findUserById(request.userId);
    if (!user?.stripe_customer_id) {
      return reply.status(400).send({ error: "No billing account found" });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${getDashboardUrl()}/plan`,
    });

    return { url: session.url };
  });

  // Get subscription status
  app.get("/billing/subscription", async (request) => {
    const plan = getDatabase().getUserPlan(request.userId);
    const user = getDatabase().findUserById(request.userId);

    let stripeSubscriptionId: string | null = null;
    let stripeStatus: string | null = null;
    let currentPeriodEnd: string | null = null;
    let cancelAtPeriodEnd = false;

    if (user?.stripe_customer_id && process.env.STRIPE_SECRET_KEY) {
      try {
        const stripe = getStripe();
        const subs = await stripe.subscriptions.list({
          customer: user.stripe_customer_id,
          status: "active",
          limit: 1,
        });
        if (subs.data.length > 0) {
          const sub = subs.data[0];
          stripeSubscriptionId = sub.id;
          stripeStatus = sub.status;
          cancelAtPeriodEnd = sub.cancel_at_period_end || !!sub.cancel_at;
          // In Stripe v20+, current_period_end is on items, not subscription
          const item = sub.items?.data?.[0];
          if (item?.current_period_end) {
            currentPeriodEnd = new Date(item.current_period_end * 1000).toISOString();
          }
        }
      } catch {
        // Stripe not reachable or not configured — return plan data only
      }
    }

    // If Stripe shows an active subscription, override DB plan
    const effectivePlan = stripeSubscriptionId ? "base" : plan.plan;
    const effectiveLabel = stripeSubscriptionId ? "Base" : plan.label;

    return {
      plan: effectivePlan,
      plan_label: effectiveLabel,
      trial_active: stripeSubscriptionId ? false : plan.trial_active,
      trial_expires_at: stripeSubscriptionId ? null : plan.trial_expires_at,
      stripe_subscription_id: stripeSubscriptionId,
      stripe_status: stripeStatus,
      current_period_end: currentPeriodEnd,
      cancel_at_period_end: cancelAtPeriodEnd,
    };
  });

  // Stripe webhook
  app.post("/billing/webhook", {
    config: { rawBody: true },
  }, async (request, reply) => {
    const sig = request.headers["stripe-signature"] as string;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) return reply.status(500).send({ error: "Webhook secret not configured" });

    const stripe = getStripe();
    let event: Stripe.Event;

    try {
      event = stripe.webhooks.constructEvent(
        (request as any).rawBody || request.body,
        sig,
        webhookSecret
      );
    } catch (err: any) {
      request.log.error(`Webhook signature verification failed: ${err.message}`);
      return reply.status(400).send({ error: "Invalid signature" });
    }

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.customer) {
          const customerId = typeof session.customer === "string"
            ? session.customer
            : session.customer.id;
          const user = getDatabase().findUserByStripeCustomerId(customerId);
          if (user) {
            getDatabase().updateUserPlan(user.id, "base");
            request.log.info(`[billing] Upgraded user ${user.id} to base plan`);
          }
        }
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = typeof sub.customer === "string"
          ? sub.customer
          : sub.customer.id;
        const user = getDatabase().findUserByStripeCustomerId(customerId);
        if (user) {
          // Only downgrade if no other active subscriptions remain
          const remaining = await stripe.subscriptions.list({
            customer: customerId,
            status: "active",
            limit: 1,
          });
          if (remaining.data.length === 0) {
            getDatabase().updateUserPlan(user.id, "free");
            request.log.info(`[billing] Downgraded user ${user.id} to free plan`);
          } else {
            request.log.info(`[billing] Sub deleted for user ${user.id} but ${remaining.data.length} active sub(s) remain — not downgrading`);
          }
        }
        break;
      }
    }

    return { received: true };
  });
}
