// Library entry point — used by commercial layer to import OSS components

export { createServer } from "./server.js";
export { initProviders } from "./adapters/providers.js";
export type { Providers } from "./adapters/providers.js";
export type { IPlanRegistry, PlanLimits, TrialConfig } from "./adapters/plan-registry.js";
export type { IBillingProvider, SubscriptionInfo, WebhookResult } from "./adapters/billing-provider.js";
