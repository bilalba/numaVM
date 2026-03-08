import type { IBillingProvider, SubscriptionInfo, WebhookResult } from "../billing-provider.js";

/**
 * OSS default: billing is disabled. All mutation methods throw.
 */
export class NoBillingProvider implements IBillingProvider {
  isEnabled(): boolean {
    return false;
  }

  async createCheckoutSession(_userId: string, _email: string): Promise<{ url: string }> {
    throw new Error("Billing not enabled");
  }

  async createPortalSession(_userId: string): Promise<{ url: string }> {
    throw new Error("Billing not enabled");
  }

  async getSubscription(_userId: string): Promise<SubscriptionInfo | null> {
    return null;
  }

  async handleWebhook(_rawBody: Buffer | string, _signature: string): Promise<WebhookResult> {
    throw new Error("Billing not enabled");
  }
}
