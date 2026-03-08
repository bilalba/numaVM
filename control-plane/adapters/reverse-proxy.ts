/**
 * Reverse proxy adapter interface.
 *
 * OSS: Caddy with full Caddyfile generation + admin API reload
 * Enterprise: Nginx, HAProxy, cloud load balancers, etc.
 */
export interface IReverseProxy {
  /** Reload the entire proxy configuration from current state. */
  reloadConfig(): Promise<void>;

  /** Add a route for a specific VM. May trigger a full reload internally. */
  addRoute(vmId: string, appPort: number): Promise<void>;

  /** Remove a route for a specific VM. May trigger a full reload internally. */
  removeRoute(vmId: string): Promise<void>;
}
