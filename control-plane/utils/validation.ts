/**
 * VM name validation rules.
 *
 * VM names are used as subdomain addresses and SSH usernames.
 * e.g. myapp → myapp.numavm.app, ssh myapp@ssh.numavm.app
 */

/** Subdomains used by the system or commonly reserved. */
export const RESERVED_NAMES = new Set([
  "dashboard", "admin", "app", "ssh", "api", "auth", "www", "mail",
  "ftp", "dns", "cdn", "static", "blog", "docs", "help", "support",
  "status", "login", "signup", "register", "account", "billing",
  "webhook", "proxy", "git", "staging", "prod", "dev", "test",
  "system", "root", "localhost", "numavm", "numa", "console",
  "monitor", "metrics", "health", "graphql", "ws", "socket", "pages",
  "internal", "assets", "smtp", "imap",
]);

const NAME_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const MIN_LENGTH = 4;
const MAX_LENGTH = 40;

export interface ValidationResult {
  valid: boolean;
  reason?: "too_short" | "too_long" | "invalid_chars" | "consecutive_hyphens" | "reserved";
  message?: string;
}

/**
 * Validate a VM name against format rules.
 * Does NOT check uniqueness (that requires a DB query).
 */
export function validateVMName(name: string): ValidationResult {
  if (name.length < MIN_LENGTH) {
    return { valid: false, reason: "too_short", message: `Name must be at least ${MIN_LENGTH} characters` };
  }
  if (name.length > MAX_LENGTH) {
    return { valid: false, reason: "too_long", message: `Name must be at most ${MAX_LENGTH} characters` };
  }
  if (!NAME_REGEX.test(name)) {
    return { valid: false, reason: "invalid_chars", message: "Only lowercase letters, numbers, and hyphens allowed. Must start and end with a letter or number." };
  }
  if (name.includes("--")) {
    return { valid: false, reason: "consecutive_hyphens", message: "Consecutive hyphens (--) are not allowed" };
  }
  if (RESERVED_NAMES.has(name)) {
    return { valid: false, reason: "reserved", message: "This name is reserved" };
  }
  return { valid: true };
}

/**
 * Normalize user input for the name field:
 * lowercase, strip characters outside [a-z0-9-].
 */
export function normalizeVMName(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9-]/g, "");
}
