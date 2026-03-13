import ssh2 from "ssh2";
import { createHash } from "node:crypto";
import { getDatabase } from "../adapters/providers.js";

const { utils } = ssh2;

export interface SshUser {
  userId: string;
  email: string;
  name: string | null;
  githubUsername: string | null;
  plan: string;
}

interface KeyEntry {
  user: SshUser;
  publicKeyData: Buffer;
}

let keyCache: KeyEntry[] | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 30_000; // 30 seconds

function buildCache(): KeyEntry[] {
  const db = getDatabase();
  // Get all users who have at least one key in user_ssh_keys
  const rows = db.raw<{ user_id: string; key_data: string }>(
    "SELECT user_id, key_data FROM user_ssh_keys"
  );

  // Collect unique user IDs
  const userIds = [...new Set(rows.map(r => r.user_id))];
  const userMap = new Map<string, SshUser>();
  for (const uid of userIds) {
    const user = db.findUserById(uid);
    if (user) {
      userMap.set(uid, {
        userId: user.id,
        email: user.email,
        name: user.name,
        githubUsername: user.github_username,
        plan: user.plan,
      });
    }
  }

  const entries: KeyEntry[] = [];
  for (const row of rows) {
    const sshUser = userMap.get(row.user_id);
    if (!sshUser) continue;

    const parsed = utils.parseKey(row.key_data);
    if (parsed instanceof Error) continue;

    const keys = Array.isArray(parsed) ? parsed : [parsed];
    for (const k of keys) {
      const pub = k.getPublicSSH();
      if (pub) {
        entries.push({ user: sshUser, publicKeyData: pub });
      }
    }
  }

  return entries;
}

function getCache(): KeyEntry[] {
  const now = Date.now();
  if (!keyCache || now - cacheTime > CACHE_TTL_MS) {
    keyCache = buildCache();
    cacheTime = now;
  }
  return keyCache;
}

/**
 * Given a client's public key from the SSH handshake, find the matching user.
 */
export function findUserByPublicKey(clientKey: { algo: string; data: Buffer }): SshUser | null {
  const entries = getCache();
  for (const entry of entries) {
    if (clientKey.data.equals(entry.publicKeyData)) {
      return entry.user;
    }
  }
  return null;
}

/**
 * Compute the SHA-256 fingerprint of an SSH public key.
 */
export function computeKeyFingerprint(keyData: Buffer): string {
  const hash = createHash("sha256").update(keyData).digest("base64").replace(/=+$/, "");
  return `SHA256:${hash}`;
}

/**
 * Invalidate the key cache (call after key updates).
 */
export function invalidateKeyCache(): void {
  keyCache = null;
}
