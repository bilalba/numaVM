import { getDatabase } from "../adapters/providers.js";

const caddyAdmin = process.env.CADDY_ADMIN_URL || "http://localhost:2019";

function getBaseDomain(): string {
  return process.env.BASE_DOMAIN || "localhost";
}
function getAuthPort(): string {
  return process.env.AUTH_PORT || "4000";
}
function getControlPlanePort(): string {
  return process.env.CONTROL_PLANE_PORT || "4001";
}
function getDashboardPort(): string {
  return process.env.DASHBOARD_PORT || "4002";
}
function getAdminPort(): string {
  return process.env.ADMIN_PORT || "4003";
}

interface VMRoute {
  id: string;
  app_port: number;
  status: string;
}

function getAllVMs(): VMRoute[] {
  return getDatabase().raw<VMRoute>("SELECT id, app_port, status FROM vms WHERE status NOT IN ('error')");
}

function generateCaddyfile(vms: VMRoute[]): string {
  const domain = getBaseDomain();
  const authPort = getAuthPort();
  const cpPort = getControlPlanePort();
  const dashPort = getDashboardPort();
  const adminPort = getAdminPort();
  const isLocal = domain === "localhost";
  // Caddy auto-provisions TLS for real domains; use http:// only for localhost
  const scheme = isLocal ? "http://" : "https://";
  // For Cloudflare-proxied domains, use the origin certificate
  const tlsDirective = isLocal ? "" : `\n    tls /etc/caddy/ssl/${domain}.pem /etc/caddy/ssl/${domain}.key`;
  const authLoginUrl = `${scheme}auth.${domain}/login`;

  let config = `{
    admin localhost:2019
}

# Auth service — no forward_auth (it IS the auth provider)
${scheme}auth.${domain} {${tlsDirective}
    reverse_proxy localhost:${authPort}
}

# Control plane API — skip forward_auth for CORS preflight + webhooks, auth the rest
${scheme}api.${domain} {${tlsDirective}
    @options method OPTIONS
    handle @options {
        reverse_proxy localhost:${cpPort}
    }
    @webhook path /billing/webhook
    handle @webhook {
        reverse_proxy localhost:${cpPort}
    }
    handle {
        forward_auth localhost:${authPort} {
            uri /verify
            copy_headers X-User-Id X-User-Email X-User-Admin
        }
        reverse_proxy localhost:${cpPort}
    }
}

# Dashboard — forward_auth, redirects to login on failure
${scheme}app.${domain} {${tlsDirective}
    forward_auth localhost:${authPort} {
        uri /verify
        copy_headers X-User-Id X-User-Email
        @unauthorized status 401 403
        handle_response @unauthorized {
            redir ${authLoginUrl}?redirect=${scheme}app.${domain}{http.request.uri}
        }
    }
    reverse_proxy localhost:${dashPort}
}

# Admin dashboard — forward_auth with admin header, redirects to login on failure
${scheme}admin.${domain} {${tlsDirective}
    forward_auth localhost:${authPort} {
        uri /verify
        copy_headers X-User-Id X-User-Email X-User-Admin
        @unauthorized status 401 403
        handle_response @unauthorized {
            redir ${authLoginUrl}?redirect=${scheme}admin.${domain}{http.request.uri}
        }
    }
    reverse_proxy localhost:${adminPort}
}
`;

  // Dynamic VM routes — ALL VMs get routes (not just running) so auth + status page work
  for (const vm of vms) {
    const forwardAuth = `
    forward_auth localhost:${authPort} {
        uri /verify
        copy_headers X-User-Id X-User-Email
        @unauthorized status 401 403
        handle_response @unauthorized {
            redir ${authLoginUrl}?redirect=${scheme}${vm.id}.${domain}{http.request.uri}
        }
    }`;

    if (vm.status === "running") {
      // Running: proxy to VM with error fallback to status page
      config += `
# VM: ${vm.id}
${scheme}${vm.id}.${domain} {${tlsDirective}${forwardAuth}
    handle_errors {
        rewrite * /vms/${vm.id}/status-page
        reverse_proxy localhost:${cpPort}
    }
    reverse_proxy localhost:${vm.app_port}
}
`;
    } else {
      // Not running: auth-gate then always show status page (triggers wake)
      config += `
# VM: ${vm.id} (${vm.status})
${scheme}${vm.id}.${domain} {${tlsDirective}${forwardAuth}
    rewrite * /vms/${vm.id}/status-page
    reverse_proxy localhost:${cpPort}
}
`;
    }
  }

  return config;
}

/**
 * Regenerate the full Caddyfile from DB state and POST to Caddy's /load endpoint.
 * This replaces Caddy's entire config, ensuring all routes have forward_auth.
 */
export async function reloadCaddyConfig(): Promise<void> {
  const vms = getAllVMs();
  const caddyfile = generateCaddyfile(vms);

  const res = await fetch(`${caddyAdmin}/load`, {
    method: "POST",
    headers: {
      "Content-Type": "text/caddyfile",
      "Origin": caddyAdmin,
    },
    body: caddyfile,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Caddy config reload failed (${res.status}): ${body}`);
  }

  const running = vms.filter(e => e.status === "running").length;
  console.log(`[caddy] Config reloaded with ${vms.length} VM route(s) (${running} running)`);
}

/**
 * Add a route for a VM. Triggers a full Caddy config reload.
 * Kept for backward compatibility with existing callers.
 */
export async function addRoute(_slug: string, _appPort: number): Promise<void> {
  await reloadCaddyConfig();
}

/**
 * Remove a route for a VM. Triggers a full Caddy config reload.
 * Kept for backward compatibility with existing callers.
 */
export async function removeRoute(_slug: string): Promise<void> {
  await reloadCaddyConfig();
}
