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
import { findEnvById, getAuthorizedUsersForEnv } from "../db/client.js";
import { ensureVMRunning, QuotaExceededError } from "./wake.js";
import { getInternalSshKeyPath, isVmRunning } from "./firecracker.js";
import { findUserByPublicKey, computeKeyFingerprint, type SshUser } from "./ssh-key-lookup.js";
import { dispatchSshCommand } from "../ssh-api/dispatcher.js";
import { showAuthenticatedTui, showUnauthenticatedTui } from "../ssh-api/tui.js";

function getDataDir() { return process.env.DATA_DIR || "/data/envs"; }

// --- Host key management ---

let hostKeyData: Buffer | null = null;

function getHostKey(): Buffer {
  if (hostKeyData) return hostKeyData;

  const keyDir = join(getDataDir(), ".ssh");
  const keyPath = join(keyDir, "ssh_proxy_host_ed25519");

  if (!existsSync(keyPath)) {
    mkdirSync(keyDir, { recursive: true });
    execSync(`ssh-keygen -t ed25519 -f "${keyPath}" -N "" -C "numavm-ssh-proxy"`, { stdio: "pipe" });
  }

  hostKeyData = readFileSync(keyPath);
  return hostKeyData;
}

function getSshProxyPort(): number {
  return parseInt(process.env.SSH_PROXY_PORT || "22", 10);
}

// --- Active listener ---

let sshServer: InstanceType<typeof Server> | null = null;

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

function handleConnection(client: Connection, _info: ClientInfo) {
  let env: ReturnType<typeof findEnvById> = undefined;
  let authenticatedUser: string | null = null;
  let apiMode = false;
  let apiUser: SshUser | null = null;
  let capturedKeyFingerprint: string | null = null;
  let capturedKeyAlgo: string | null = null;
  let capturedKeyData: Buffer | null = null;

  client.on("authentication", (ctx: AuthContext) => {
    if (ctx.method === "none") {
      return ctx.reject(["publickey"]);
    }

    if (ctx.method !== "publickey") {
      return ctx.reject(["publickey"]);
    }

    const username = ctx.username;
    const pkCtx = ctx as PublicKeyAuthContext;

    // Determine mode: env slug (starts with "env-") → env proxy, anything else → API mode
    if (username.startsWith("env-")) {
      // --- Env proxy mode (existing behavior) ---
      env = findEnvById(username);
      if (!env) {
        console.warn(`[ssh-proxy] No env found for slug "${username}"`);
        return ctx.reject(["publickey"]);
      }

      const authorizedKeys = getAuthorizedKeys(env.id);
      if (!isKeyAuthorized(pkCtx.key, authorizedKeys)) {
        return ctx.reject(["publickey"]);
      }

      if (!pkCtx.signature) {
        return ctx.accept();
      }

      authenticatedUser = pkCtx.username;
      ctx.accept();
    } else {
      // --- API mode: authenticate by reverse key lookup ---
      apiMode = true;

      // Capture key info for unauthenticated flow
      capturedKeyAlgo = pkCtx.key.algo;
      capturedKeyData = pkCtx.key.data;
      try {
        capturedKeyFingerprint = computeKeyFingerprint(pkCtx.key.data);
      } catch { /* ignore errors */ }

      // Try to find user by their SSH key
      const user = findUserByPublicKey(pkCtx.key);
      if (user) {
        apiUser = user;
        if (!pkCtx.signature) {
          return ctx.accept(); // Key probe — accept to proceed with signing
        }
        console.log(`[ssh-api] Authenticated user ${user.email} via SSH key`);
        ctx.accept();
      } else {
        // Unknown key — still accept for unauthenticated TUI
        if (!pkCtx.signature) {
          return ctx.accept();
        }
        console.log(`[ssh-api] Unauthenticated connection (unknown key)`);
        ctx.accept();
      }
    }
  });

  client.on("ready", () => {
    if (apiMode) {
      // --- API mode ---
      console.log(`[ssh-api] Client ready (user: ${apiUser?.email ?? "unauthenticated"})`);

      client.on("session", (accept, reject) => {
        const session = accept();

        session.on("pty", (accept) => {
          if (typeof accept === "function") accept();
        });

        session.on("env", (accept) => {
          if (typeof accept === "function") accept();
        });

        session.on("shell", (accept) => {
          const channel = accept();
          if (apiUser) {
            showAuthenticatedTui(channel, apiUser).catch(() => {
              channel.exit(1);
              channel.close();
            });
          } else {
            // Unauthenticated — show key linking menu
            const fingerprint = capturedKeyFingerprint || "unknown";
            showUnauthenticatedTui(
              channel,
              fingerprint,
              capturedKeyAlgo || undefined,
              capturedKeyData || undefined,
            ).catch(() => {
              channel.exit(1);
              channel.close();
            });
          }
        });

        session.on("exec", (accept, reject, info) => {
          const channel = accept();
          if (!apiUser) {
            channel.stderr.write("Error: SSH key not linked to an account. Run: ssh ssh.numavm.com\n");
            channel.exit(1);
            channel.close();
            return;
          }
          dispatchSshCommand(info.command, apiUser, channel).catch((err) => {
            channel.stderr.write(`Error: ${err.message}\n`);
            channel.exit(2);
            channel.close();
          });
        });
      });
      return;
    }

    // --- Env proxy mode (existing behavior) ---
    if (!env) { client.end(); return; }
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

        let retriedAfterSnapshot = false;

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
              // VM may have been snapshotted mid-connection — try waking once
              if (!needsWake && !retriedAfterSnapshot) {
                retriedAfterSnapshot = true;
                clientChan.stderr.write("Environment went to sleep, waking... ");
                ensureVMRunning(env.id)
                  .then(() => {
                    clientChan.stderr.write("ready.\r\n");
                    connectUpstream(env, clientChan, opts);
                  })
                  .catch((wakeErr) => {
                    if (wakeErr instanceof QuotaExceededError) {
                      clientChan.stderr.write(`\r\nRAM quota exceeded. Stop another environment or upgrade your plan.\r\n`);
                    } else {
                      clientChan.stderr.write(`failed: ${wakeErr.message}\r\n`);
                    }
                    clientChan.close();
                  });
                return;
              }
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
            if (err instanceof QuotaExceededError) {
              clientChan.stderr.write(`\r\nRAM quota exceeded. Stop another environment or upgrade your plan.\r\n`);
            } else {
              clientChan.stderr.write(`Wake failed: ${err.message}\r\n`);
            }
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
      console.warn(`[ssh-proxy] Client error: ${err.message}`);
    }
  });

  client.on("end", () => {
    // Normal disconnect
  });
}

// --- Public API ---

/**
 * Start the single SSH proxy listener.
 * Routes connections by username (env slug).
 */
export async function startSshProxy(): Promise<void> {
  const hostKey = getHostKey();
  const port = getSshProxyPort();

  const server = new Server({ hostKeys: [hostKey] }, (client, info) => {
    handleConnection(client, info);
  });

  server.on("error", (err: any) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[ssh-proxy] Port ${port} in use — cannot start SSH proxy`);
      return;
    }
    console.error(`[ssh-proxy] Server error: ${err.message}`);
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`[ssh-proxy] Listening on port ${port} (username = env slug)`);
  });

  sshServer = server;
}

/**
 * Stop the SSH proxy listener.
 */
export function stopSshProxy(): void {
  if (sshServer) {
    console.log(`[ssh-proxy] Stopping listener...`);
    sshServer.close();
    sshServer = null;
  }
}
