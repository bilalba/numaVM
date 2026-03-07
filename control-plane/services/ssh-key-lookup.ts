import ssh2 from "ssh2";
import { createHash } from "node:crypto";
import { findAllUsersWithSshKeys } from "../db/client.js";

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
  const users = findAllUsersWithSshKeys();
  const entries: KeyEntry[] = [];

  for (const user of users) {
    const sshUser: SshUser = {
      userId: user.id,
      email: user.email,
      name: user.name,
      githubUsername: user.github_username,
      plan: user.plan,
    };

    for (const line of user.ssh_public_keys.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const parsed = utils.parseKey(trimmed);
      if (parsed instanceof Error) continue;

      const keys = Array.isArray(parsed) ? parsed : [parsed];
      for (const k of keys) {
        const pub = k.getPublicSSH();
        if (pub) {
          entries.push({ user: sshUser, publicKeyData: pub });
        }
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
