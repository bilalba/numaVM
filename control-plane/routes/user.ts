import type { FastifyInstance } from "fastify";
import { getDatabase } from "../adapters/providers.js";
import { fetchSshKeys, listRepos, createRepo } from "../services/github.js";
import { invalidateKeyCache } from "../services/ssh-key-lookup.js";

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

export function registerUserRoutes(app: FastifyInstance) {
  // Get current user's SSH keys
  app.get("/me/ssh-keys", async (request) => {
    const user = getDatabase().findUserById(request.userId);
    const keys = user?.ssh_public_keys || "";

    // Also fetch GitHub keys for display
    let githubKeys = "";
    if (user?.github_username) {
      githubKeys = await fetchSshKeys(user.github_username);
    }

    return { keys, github_keys: githubKeys };
  });

  // Save custom SSH keys
  app.put("/me/ssh-keys", async (request, reply) => {
    const body = request.body as { keys?: string };
    const rawKeys = (body.keys ?? "").trim();

    if (!rawKeys) {
      getDatabase().updateUserSshKeys(request.userId, null);
      return { ok: true };
    }

    // Validate each non-empty line looks like an SSH public key
    const lines = rawKeys.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (
        !line.startsWith("ssh-") &&
        !line.startsWith("ecdsa-") &&
        !line.startsWith("sk-")
      ) {
        return reply.status(400).send({
          error: `Invalid SSH public key: line must start with ssh-, ecdsa-, or sk-. Got: "${line.slice(0, 40)}..."`,
        });
      }
    }

    getDatabase().updateUserSshKeys(request.userId, lines.join("\n"));
    return { ok: true };
  });

  // GitHub repo access status
  app.get("/me/github", async (request) => {
    const user = getDatabase().findUserById(request.userId);
    return {
      connected: !!user?.github_token,
      username: user?.github_username || null,
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

    // Check if this key is already in the user's keys
    const user = getDatabase().findUserById(request.userId);
    const existingKeys = user?.ssh_public_keys || "";
    if (existingKeys.includes(pending.publicKey.trim())) {
      pending.confirmed = true;
      return { ok: true, message: "Key already linked to your account" };
    }

    // Append the key
    getDatabase().appendUserSshKey(request.userId, pending.publicKey.trim());
    invalidateKeyCache();
    pending.confirmed = true;
    // Don't delete yet — the TUI needs to poll and see confirmed=true

    return { ok: true, message: "SSH key linked to your account" };
  });
}
