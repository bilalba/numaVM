import { db } from "../db/client.js";

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

interface EnvRoute {
  id: string;
  app_port: number;
  pages_port: number | null;
  status: string;
}

function getAllEnvs(): EnvRoute[] {
  return db
    .prepare("SELECT id, app_port, pages_port, status FROM envs WHERE status NOT IN ('error')")
    .all() as EnvRoute[];
}

function generateCaddyfile(envs: EnvRoute[]): string {
  const domain = getBaseDomain();
  const authPort = getAuthPort();
  const cpPort = getControlPlanePort();
  const dashPort = getDashboardPort();
  const authLoginUrl = `http://auth.${domain}/login`;

  let config = `{
    admin localhost:2019
}

# Auth service — no forward_auth (it IS the auth provider)
http://auth.${domain} {
    reverse_proxy localhost:${authPort}
}

# Control plane API — skip forward_auth for CORS preflight, auth the rest
http://api.${domain} {
    @options method OPTIONS
    handle @options {
        reverse_proxy localhost:${cpPort}
    }
    handle {
        forward_auth localhost:${authPort} {
            uri /verify
            copy_headers X-User-Id X-User-Email
        }
        reverse_proxy localhost:${cpPort}
    }
}

# Dashboard — forward_auth, redirects to login on failure
http://${domain} {
    forward_auth localhost:${authPort} {
        uri /verify
        copy_headers X-User-Id X-User-Email
        @unauthorized status 401 403
        handle_response @unauthorized {
            redir ${authLoginUrl}
        }
    }
    reverse_proxy localhost:${dashPort}
}
`;

  // Dynamic env routes — ALL envs get routes (not just running) so auth + status page work
  for (const env of envs) {
    const forwardAuth = `
    forward_auth localhost:${authPort} {
        uri /verify
        copy_headers X-User-Id X-User-Email
        @unauthorized status 401 403
        handle_response @unauthorized {
            redir ${authLoginUrl}
        }
    }`;

    if (env.status === "running") {
      // Running: proxy to VM with error fallback to status page
      config += `
# Environment: ${env.id}
http://${env.id}.${domain} {${forwardAuth}
    handle_errors {
        rewrite * /envs/${env.id}/status-page
        reverse_proxy localhost:${cpPort}
    }
    reverse_proxy localhost:${env.app_port}
}
`;
      if (env.pages_port) {
        config += `
# Pages: ${env.id}
http://${env.id}-pages.${domain} {${forwardAuth}
    handle_errors {
        rewrite * /envs/${env.id}/status-page
        reverse_proxy localhost:${cpPort}
    }
    reverse_proxy localhost:${env.pages_port}
}
`;
      }
    } else {
      // Not running: auth-gate then always show status page (triggers wake)
      config += `
# Environment: ${env.id} (${env.status})
http://${env.id}.${domain} {${forwardAuth}
    rewrite * /envs/${env.id}/status-page
    reverse_proxy localhost:${cpPort}
}
`;
      if (env.pages_port) {
        config += `
# Pages: ${env.id} (${env.status})
http://${env.id}-pages.${domain} {${forwardAuth}
    rewrite * /envs/${env.id}/status-page
    reverse_proxy localhost:${cpPort}
}
`;
      }
    }
  }

  return config;
}

/**
 * Regenerate the full Caddyfile from DB state and POST to Caddy's /load endpoint.
 * This replaces Caddy's entire config, ensuring all routes have forward_auth.
 */
export async function reloadCaddyConfig(): Promise<void> {
  const envs = getAllEnvs();
  const caddyfile = generateCaddyfile(envs);

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

  const running = envs.filter(e => e.status === "running").length;
  console.log(`[caddy] Config reloaded with ${envs.length} env route(s) (${running} running)`);
}

/**
 * Add a route for an env. Triggers a full Caddy config reload.
 * Kept for backward compatibility with existing callers.
 */
export async function addRoute(_slug: string, _appPort: number): Promise<void> {
  await reloadCaddyConfig();
}

/**
 * Remove a route for an env. Triggers a full Caddy config reload.
 * Kept for backward compatibility with existing callers.
 */
export async function removeRoute(_slug: string): Promise<void> {
  await reloadCaddyConfig();
}
