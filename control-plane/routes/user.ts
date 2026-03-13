import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import ssh2 from "ssh2";
import { createHash } from "node:crypto";
import { getDatabase } from "../adapters/providers.js";
import { listRepos, createRepo } from "../services/github.js";
import { invalidateKeyCache } from "../services/ssh-key-lookup.js";
import { getVMEngine } from "../adapters/providers.js";

const { utils } = ssh2;

// --- Pending SSH key linking ---
// In-memory store: token → { publicKey, fingerprint, email, confirmed, createdAt }
// Entries expire after 10 minutes.
interface PendingKey {
  publicKey: string;
  fingerprint: string;
  email: string;
  confirmed: boolean;
  createdAt: number;
}
const pendingKeys = new Map<string, PendingKey>();
const PENDING_KEY_TTL_MS = 10 * 60 * 1000;

// Cleanup expired keys periodically
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of pendingKeys) {
    if (now - entry.createdAt > PENDING_KEY_TTL_MS) {
      pendingKeys.delete(token);
    }
  }
}, 60_000);

export function registerPendingKey(token: string, publicKey: string, fingerprint: string, email: string): void {
  pendingKeys.set(token, { publicKey, fingerprint, email, confirmed: false, createdAt: Date.now() });
}

export function getPendingKey(token: string): PendingKey | undefined {
  const entry = pendingKeys.get(token);
  if (!entry) return undefined;
  if (Date.now() - entry.createdAt > PENDING_KEY_TTL_MS) {
    pendingKeys.delete(token);
    return undefined;
  }
  return entry;
}

export function deletePendingKey(token: string): void {
  pendingKeys.delete(token);
}

/** Parse an SSH public key line, compute fingerprint + extract fields. */
function parsePublicKey(keyLine: string): { keyType: string; fingerprint: string; comment: string | null } | null {
  const trimmed = keyLine.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) return null;
  const keyType = parts[0];
  const keyBase64 = parts[1];
  const comment = parts.length > 2 ? parts.slice(2).join(" ") : null;

  // Validate key format
  if (!keyType.startsWith("ssh-") && !keyType.startsWith("ecdsa-") && !keyType.startsWith("sk-")) {
    return null;
  }

  try {
    const keyBytes = Buffer.from(keyBase64, "base64");
    const hash = createHash("sha256").update(keyBytes).digest("base64").replace(/=+$/, "");
    return { keyType, fingerprint: `SHA256:${hash}`, comment };
  } catch {
    return null;
  }
}

/** Best-effort push a key to all running VMs the user has access to. */
function bestEffortPushKey(userId: string, keyData: string): void {
  const db = getDatabase();
  const engine = getVMEngine();
  const vms = db.findVMsByUser(userId);
  for (const vm of vms) {
    if (vm.status !== "running") continue;
    const keyIdentity = keyData.split(/\s+/).slice(0, 2).join(" ");
    const cmd = `grep -qF '${keyIdentity}' /home/dev/.ssh/authorized_keys 2>/dev/null || echo '${keyData}' >> /home/dev/.ssh/authorized_keys`;
    engine.exec(vm.id, ["sh", "-c", cmd]).catch(() => {});
  }
}

/** Best-effort remove a key from all running VMs the user has access to. */
function bestEffortRemoveKey(userId: string, keyData: string): void {
  const db = getDatabase();
  const engine = getVMEngine();
  const vms = db.findVMsByUser(userId);
  const keyIdentity = keyData.split(/\s+/).slice(0, 2).join(" ");
  const escaped = keyIdentity.replace(/[/\\&]/g, "\\$&");
  for (const vm of vms) {
    if (vm.status !== "running") continue;
    engine.exec(vm.id, ["sh", "-c", `sed -i '\\|${escaped}|d' /home/dev/.ssh/authorized_keys`]).catch(() => {});
  }
}

export function registerUserRoutes(app: FastifyInstance) {
  // Get current user's SSH keys (per-key records)
  app.get("/me/ssh-keys", async (request) => {
    const keys = getDatabase().getUserSshKeys(request.userId);
    return { keys };
  });

  // Add a single SSH key
  app.post("/me/ssh-keys", async (request, reply) => {
    const body = request.body as { key?: string };
    const keyLine = body.key?.trim();
    if (!keyLine) {
      return reply.status(400).send({ error: "key is required" });
    }

    const parsed = parsePublicKey(keyLine);
    if (!parsed) {
      return reply.status(400).send({
        error: `Invalid SSH public key: must start with ssh-, ecdsa-, or sk-`,
      });
    }

    // Reject duplicate fingerprint
    const existing = getDatabase().findUserSshKeyByFingerprint(request.userId, parsed.fingerprint);
    if (existing) {
      return reply.status(409).send({ error: "Key already exists", key: existing });
    }

    const id = randomUUID();
    getDatabase().addUserSshKey(
      request.userId, id, keyLine, parsed.keyType, parsed.fingerprint, parsed.comment, "manual",
    );
    invalidateKeyCache();

    // Best-effort push to running VMs
    bestEffortPushKey(request.userId, keyLine);

    const record = getDatabase().findUserSshKeyByFingerprint(request.userId, parsed.fingerprint);
    return reply.status(201).send(record);
  });

  // Remove a single SSH key
  app.delete("/me/ssh-keys/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const keys = getDatabase().getUserSshKeys(request.userId);
    const key = keys.find(k => k.id === id);
    if (!key) {
      return reply.status(404).send({ error: "Key not found" });
    }

    getDatabase().removeUserSshKey(request.userId, id);
    invalidateKeyCache();

    // Best-effort remove from running VMs
    bestEffortRemoveKey(request.userId, key.key_data);

    return { ok: true };
  });

  // GitHub repo access status
  app.get("/me/github", async (request) => {
    const user = getDatabase().findUserById(request.userId);
    return {
      connected: !!user?.github_token,
      username: user?.github_username || null,
      dev_mode: process.env.DEV_MODE === "true",
    };
  });

  // Disconnect GitHub repo access (clear token)
  app.delete("/me/github", async (request) => {
    getDatabase().clearUserGithubToken(request.userId);
    return { ok: true };
  });

  // List user's GitHub repos
  app.get("/me/repos", async (request, reply) => {
    const user = getDatabase().findUserById(request.userId);
    if (!user?.github_token) {
      return reply.status(400).send({ error: "GitHub not connected" });
    }
    const { q, page } = request.query as { q?: string; page?: string };
    const result = await listRepos(user.github_token, {
      query: q || undefined,
      page: page ? parseInt(page, 10) : undefined,
    });
    return result;
  });

  // Create a new GitHub repo
  app.post("/me/repos", async (request, reply) => {
    const user = getDatabase().findUserById(request.userId);
    if (!user?.github_token) {
      return reply.status(400).send({ error: "GitHub not connected" });
    }
    const body = request.body as { name?: string; private?: boolean };
    if (!body.name?.trim()) {
      return reply.status(400).send({ error: "Repo name is required" });
    }
    const result = await createRepo(body.name.trim(), body.private ?? false, user.github_token);
    return result;
  });

  // --- SSH key linking (from SSH TUI) ---

  // Get pending key info by token (user must be logged in)
  app.get("/link-ssh/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    const pending = getPendingKey(token);
    if (!pending) {
      return reply.status(404).send({ error: "Link token expired or invalid" });
    }
    return {
      fingerprint: pending.fingerprint,
      email: pending.email,
    };
  });

  // Poll endpoint for the SSH TUI to check if key was confirmed
  // This is unauthenticated — the token is the secret
  app.get("/link-ssh/:token/status", async (request, reply) => {
    const { token } = request.params as { token: string };
    const pending = getPendingKey(token);
    if (!pending) {
      return reply.status(404).send({ error: "expired" });
    }
    return { confirmed: pending.confirmed };
  });

  // Confirm linking — adds the pending key to the authenticated user's account
  app.post("/link-ssh/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    const pending = getPendingKey(token);
    if (!pending) {
      return reply.status(404).send({ error: "Link token expired or invalid" });
    }

    // Check if this key is already linked (by fingerprint)
    const existing = getDatabase().findUserSshKeyByFingerprint(request.userId, pending.fingerprint);
    if (existing) {
      pending.confirmed = true;
      return { ok: true, message: "Key already linked to your account" };
    }

    // Parse and add the key as a proper record
    const parsed = parsePublicKey(pending.publicKey.trim());
    if (!parsed) {
      return reply.status(400).send({ error: "Invalid key format" });
    }

    const id = randomUUID();
    getDatabase().addUserSshKey(
      request.userId, id, pending.publicKey.trim(),
      parsed.keyType, parsed.fingerprint, parsed.comment, "linked",
    );
    invalidateKeyCache();
    pending.confirmed = true;

    // Best-effort push to running VMs
    bestEffortPushKey(request.userId, pending.publicKey.trim());

    return { ok: true, message: "SSH key linked to your account" };
  });
}
