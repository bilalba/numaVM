// Billing provider adapter — abstracts payment/subscription management

export interface SubscriptionInfo {
  plan: string;
  stripe_subscription_id: string | null;
  stripe_status: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
}

export interface WebhookResult {
  action: "upgrade" | "downgrade" | "none";
  userId?: string;
  plan?: string;
}

export interface IBillingProvider {
  isEnabled(): boolean;
  createCheckoutSession(userId: string, email: string): Promise<{ url: string }>;
  createPortalSession(userId: string): Promise<{ url: string }>;
  getSubscription(userId: string): Promise<SubscriptionInfo | null>;
  handleWebhook(rawBody: Buffer | string, signature: string): Promise<WebhookResult>;
}
