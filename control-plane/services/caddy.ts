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

interface RunningEnv {
  id: string;
  app_port: number;
}

function getRunningEnvs(): RunningEnv[] {
  return db
    .prepare("SELECT id, app_port FROM envs WHERE status = 'running'")
    .all() as RunningEnv[];
}

function generateCaddyfile(envs: RunningEnv[]): string {
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

  // Dynamic env routes — each with forward_auth
  for (const env of envs) {
    config += `
# Environment: ${env.id}
http://${env.id}.${domain} {
    forward_auth localhost:${authPort} {
        uri /verify
        copy_headers X-User-Id X-User-Email
        @unauthorized status 401 403
        handle_response @unauthorized {
            redir ${authLoginUrl}
        }
    }
    reverse_proxy localhost:${env.app_port}
}
`;
  }

  return config;
}

/**
 * Regenerate the full Caddyfile from DB state and POST to Caddy's /load endpoint.
 * This replaces Caddy's entire config, ensuring all routes have forward_auth.
 */
export async function reloadCaddyConfig(): Promise<void> {
  const envs = getRunningEnvs();
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

  console.log(`[caddy] Config reloaded with ${envs.length} env route(s)`);
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
