import type { IReverseProxy } from "../reverse-proxy.js";
import {
  reloadCaddyConfig as _reloadCaddyConfig,
  addRoute as _addRoute,
  removeRoute as _removeRoute,
} from "../../services/caddy.js";

/**
 * Caddy implementation of IReverseProxy.
 * Delegates all calls to the existing services/caddy.ts functions.
 */
export class CaddyProxy implements IReverseProxy {
  async reloadConfig(): Promise<void> { return _reloadCaddyConfig(); }
  async addRoute(vmId: string, appPort: number): Promise<void> { return _addRoute(vmId, appPort); }
  async removeRoute(vmId: string): Promise<void> { return _removeRoute(vmId); }
}
