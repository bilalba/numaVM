import ssh2 from "ssh2";
import type {
  Connection,
  ClientInfo,
  AuthContext,
  PublicKeyAuthContext,
  ServerChannel,
  ParsedKey,
} from "ssh2";

const { Server, Client, utils } = ssh2;
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { findEnvBySshPort, findAllEnvs, getAuthorizedUsersForEnv } from "../db/client.js";
import { ensureVMRunning } from "./wake.js";
import { getInternalSshKeyPath, isVmRunning } from "./firecracker.js";

// --- Config ---

function getDataDir() { return process.env.DATA_DIR || "/data/envs"; }

// --- Host key management ---

let hostKeyData: Buffer | null = null;

function getHostKey(): Buffer {
  if (hostKeyData) return hostKeyData;

  const keyDir = join(getDataDir(), ".ssh");
  const keyPath = join(keyDir, "ssh_proxy_host_ed25519");

  if (!existsSync(keyPath)) {
    mkdirSync(keyDir, { recursive: true });
    execSync(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -C "deploymagi-ssh-proxy"`, { stdio: "pipe" });
  }

  hostKeyData = readFileSync(keyPath);
  return hostKeyData;
}

// --- Active listeners ---

const listeners = new Map<number, InstanceType<typeof Server>>();

// --- Key matching ---

/**
 * Collect all authorized public keys for an env.
 * Returns parsed ssh2 keys ready for comparison.
 */
function getAuthorizedKeys(envId: string): ParsedKey[] {
  const users = getAuthorizedUsersForEnv(envId);
  const keys: ParsedKey[] = [];

  for (const user of users) {
    if (!user.ssh_public_keys) continue;

    // ssh_public_keys may contain multiple keys, one per line
    for (const line of user.ssh_public_keys.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const parsed = utils.parseKey(trimmed);
      if (parsed instanceof Error) continue;
      // parseKey can return an array for multi-key inputs
      if (Array.isArray(parsed)) {
        keys.push(...parsed);
      } else {
        keys.push(parsed);
      }
    }
  }

  return keys;
}

/**
 * Check if a client's public key matches any authorized key.
 */
function isKeyAuthorized(clientKey: { algo: string; data: Buffer }, authorizedKeys: ParsedKey[]): boolean {
  for (const ak of authorizedKeys) {
    // Compare the raw public key bytes
    const akPub = ak.getPublicSSH();
    if (akPub && clientKey.data.equals(akPub)) {
      return true;
    }
  }
  return false;
}

// --- Connection handler ---

function handleConnection(port: number, client: Connection, _info: ClientInfo) {
  const env = findEnvBySshPort(port);
  if (!env) {
    console.warn(`[ssh-proxy] No env found for port ${port}`);
    client.end();
    return;
  }

  let authenticatedUser: string | null = null;

  client.on("authentication", (ctx: AuthContext) => {
    if (ctx.method === "none") {
      return ctx.reject(["publickey"]);
    }

    if (ctx.method !== "publickey") {
      return ctx.reject(["publickey"]);
    }

    const pkCtx = ctx as PublicKeyAuthContext;
    const authorizedKeys = getAuthorizedKeys(env.id);

    if (!isKeyAuthorized(pkCtx.key, authorizedKeys)) {
      return ctx.reject(["publickey"]);
    }

    // Key is authorized
    if (!pkCtx.signature) {
      // This is a key probe — client is asking "would you accept this key?"
      // Accept the probe to let the client proceed with signing
      return ctx.accept();
    }

    // Signature present — ssh2 has already verified it, accept auth
    authenticatedUser = pkCtx.username;
    ctx.accept();
  });

  client.on("ready", () => {
    console.log(`[ssh-proxy] Client authenticated for ${env.id} (user: ${authenticatedUser})`);

    client.on("session", (accept, reject) => {
      const session = accept();

      // Collect session setup info before connecting upstream
      let ptyInfo: any = null;
      let subsystemName: string | null = null;
      let envVars: { key: string; val: string }[] = [];

      // These callbacks are set once we have an upstream channel
      let upstreamChannel: any = null;
      let clientChannel: ServerChannel | null = null;

      session.on("pty", (accept, _reject, info) => {
        ptyInfo = info;
        if (typeof accept === "function") accept();
      });

      session.on("env", (accept, _reject, info) => {
        envVars.push(info);
        if (typeof accept === "function") accept();
      });

      session.on("window-change", (accept, _reject, info) => {
        if (typeof accept === "function") accept();
        // Forward to upstream if connected
        if (upstreamChannel) {
          upstreamChannel.setWindow(info.rows, info.cols, info.height, info.width);
        }
      });

      session.on("signal", (accept, _reject, info) => {
        if (typeof accept === "function") accept();
        if (upstreamChannel) {
          upstreamChannel.signal(info.name);
        }
      });

      session.on("shell", (accept, reject) => {
        clientChannel = accept();
        connectUpstream(env, clientChannel, { ptyInfo, envVars, shell: true });
      });

      session.on("exec", (accept, reject, info) => {
        clientChannel = accept();
        connectUpstream(env, clientChannel, { ptyInfo, envVars, exec: info.command });
      });

      // Don't listen for "sftp" event — it returns an SFTPWrapper (not pipeable).
      // Instead, "subsystem" handles all subsystems including sftp as raw channels.
      session.on("subsystem", (accept, reject, info) => {
        subsystemName = info.name;
        clientChannel = accept();
        connectUpstream(env, clientChannel, { ptyInfo, envVars, subsystem: subsystemName });
      });

      /**
       * Connect to the upstream VM and bridge channels.
       */
      function connectUpstream(
        env: { id: string; vm_ip: string | null },
        clientChan: ServerChannel,
        opts: {
          ptyInfo?: any;
          envVars?: { key: string; val: string }[];
          shell?: boolean;
          exec?: string;
          subsystem?: string;
        },
      ) {
        const vmIp = env.vm_ip;
        if (!vmIp) {
          clientChan.stderr.write("Error: VM has no IP address\r\n");
          clientChan.close();
          return;
        }

        // Wake VM if needed — write status to stderr so it doesn't interfere with pipes/scp
        const needsWake = !isVmRunning(env.id);
        const wakePromise = needsWake
          ? (() => {
              clientChan.stderr.write("Waking environment... ");
              return ensureVMRunning(env.id).then(() => {
                clientChan.stderr.write("ready.\r\n");
              });
            })()
          : Promise.resolve();

        wakePromise
          .then(() => {
            const internalKeyPath = getInternalSshKeyPath();
            const internalKey = readFileSync(internalKeyPath);

            const upstream = new Client();

            upstream.on("ready", () => {
              // Set env vars on upstream
              if (opts.envVars) {
                for (const ev of opts.envVars) {
                  // ssh2 Client doesn't have a direct env method,
                  // but the exec/shell options can pass env
                }
              }

              if (opts.subsystem) {
                forwardViaSubsystem(upstream, clientChan, opts.subsystem, opts);
                return;
              }

              if (opts.exec) {
                const execOpts: any = {};
                if (opts.ptyInfo) {
                  execOpts.pty = {
                    rows: opts.ptyInfo.rows,
                    cols: opts.ptyInfo.cols,
                    height: opts.ptyInfo.height,
                    width: opts.ptyInfo.width,
                    modes: opts.ptyInfo.modes,
                  };
                }
                if (opts.envVars && opts.envVars.length > 0) {
                  execOpts.env = {};
                  for (const ev of opts.envVars) {
                    execOpts.env[ev.key] = ev.val;
                  }
                }

                upstream.exec(opts.exec, execOpts, (err, upChan) => {
                  if (err) {
                    clientChan.stderr.write(`Exec error: ${err.message}\r\n`);
                    clientChan.close();
                    upstream.end();
                    return;
                  }
                  bridgeChannels(clientChan, upChan, upstream);
                });
                return;
              }

              // Shell
              const shellOpts: any = {};
              if (opts.ptyInfo) {
                shellOpts.rows = opts.ptyInfo.rows;
                shellOpts.cols = opts.ptyInfo.cols;
                shellOpts.height = opts.ptyInfo.height;
                shellOpts.width = opts.ptyInfo.width;
                shellOpts.modes = opts.ptyInfo.modes;
              }
              if (opts.envVars && opts.envVars.length > 0) {
                shellOpts.env = {};
                for (const ev of opts.envVars) {
                  shellOpts.env[ev.key] = ev.val;
                }
              }

              const ptyOrFalse = opts.ptyInfo ? shellOpts : false;

              upstream.shell(ptyOrFalse, (err, upChan) => {
                if (err) {
                  clientChan.stderr.write(`Shell error: ${err.message}\r\n`);
                  clientChan.close();
                  upstream.end();
                  return;
                }
                bridgeChannels(clientChan, upChan, upstream);
              });
            });

            upstream.on("error", (err) => {
              console.error(`[ssh-proxy] Upstream error for ${env.id}: ${err.message}`);
              clientChan.stderr.write(`Connection error: ${err.message}\r\n`);
              clientChan.close();
            });

            upstream.connect({
              host: vmIp,
              port: 22,
              username: "dev",
              privateKey: internalKey,
              readyTimeout: 10000,
              hostVerifier: () => true,
            } as any);
          })
          .catch((err) => {
            clientChan.stderr.write(`Wake failed: ${err.message}\r\n`);
            clientChan.close();
          });
      }

      function forwardViaSubsystem(upstream: InstanceType<typeof Client>, clientChan: ServerChannel, name: string, opts: any) {
        upstream.subsys(name, (err: Error | undefined, upChan: any) => {
          if (err) {
            clientChan.stderr.write(`Subsystem error: ${err.message}\r\n`);
            clientChan.close();
            upstream.end();
            return;
          }
          bridgeChannels(clientChan, upChan, upstream);
        });
      }

      function bridgeChannels(clientChan: ServerChannel, upChan: any, upstream: InstanceType<typeof Client>) {
        upstreamChannel = upChan;

        // Pipe data bidirectionally
        clientChan.pipe(upChan);
        upChan.pipe(clientChan);

        // Forward stderr if available
        if (upChan.stderr) {
          upChan.stderr.pipe(clientChan.stderr);
        }

        // Forward exit status
        upChan.on("exit", (code: number | null, signal?: string) => {
          if (signal) {
            clientChan.exit(signal as any);
          } else {
            clientChan.exit(code ?? 0);
          }
          clientChan.close();
        });

        upChan.on("close", () => {
          clientChan.close();
          upstream.end();
        });

        clientChan.on("close", () => {
          upChan.close();
          upstream.end();
        });

        // Forward window-change events that arrive after connection
        clientChan.on("window-change" as any, (info: any) => {
          if (upChan.setWindow) {
            upChan.setWindow(info.rows, info.cols, info.height, info.width);
          }
        });
      }
    });
  });

  client.on("error", (err) => {
    // Client disconnected or protocol error — expected for rejected auth
    if (err.message !== "read ECONNRESET") {
      console.warn(`[ssh-proxy] Client error on port ${port}: ${err.message}`);
    }
  });

  client.on("end", () => {
    // Normal disconnect
  });
}

// --- Public API ---

/**
 * Start SSH proxy listeners for all existing envs.
 * Also cleans up legacy SSH DNAT rules.
 */
export async function startSshProxy(): Promise<void> {
  const hostKey = getHostKey();
  const envs = findAllEnvs();

  console.log(`[ssh-proxy] Starting SSH proxy for ${envs.length} env(s)...`);

  // Clean up legacy SSH DNAT rules (loop to handle duplicates — iptables -D only removes one at a time)
  const { removeDnat } = await import("./firecracker.js");
  for (const env of envs) {
    if (env.vm_ip && env.ssh_port) {
      for (let i = 0; i < 5; i++) {
        try {
          removeDnat(env.ssh_port, env.vm_ip, 22);
        } catch { break; /* no more matching rules */ }
      }
    }
  }

  // Start listeners
  for (const env of envs) {
    if (env.ssh_port) {
      createListener(env.ssh_port, hostKey);
    }
  }
}

/**
 * Stop all SSH proxy listeners.
 */
export function stopSshProxy(): void {
  console.log(`[ssh-proxy] Stopping ${listeners.size} listener(s)...`);
  for (const [port, server] of listeners) {
    try {
      server.close();
    } catch { /* ok */ }
  }
  listeners.clear();
}

/**
 * Add a listener for a newly created env.
 */
export function addSshProxyListener(envId: string, sshPort: number): void {
  if (listeners.has(sshPort)) return;
  const hostKey = getHostKey();
  createListener(sshPort, hostKey);
  console.log(`[ssh-proxy] Added listener for ${envId} on port ${sshPort}`);
}

/**
 * Remove a listener for a destroyed env.
 */
export function removeSshProxyListener(envId: string, sshPort: number): void {
  const server = listeners.get(sshPort);
  if (server) {
    server.close();
    listeners.delete(sshPort);
    console.log(`[ssh-proxy] Removed listener for ${envId} on port ${sshPort}`);
  }
}

// --- Internal ---

function createListener(port: number, hostKey: Buffer): void {
  if (listeners.has(port)) return;

  const server = new Server({ hostKeys: [hostKey] }, (client, info) => {
    handleConnection(port, client, info);
  });

  server.on("error", (err: any) => {
    if (err.code === "EADDRINUSE") {
      console.warn(`[ssh-proxy] Port ${port} in use, skipping`);
      return;
    }
    console.error(`[ssh-proxy] Server error on port ${port}: ${err.message}`);
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`[ssh-proxy] Listening on port ${port}`);
  });

  listeners.set(port, server);
}
