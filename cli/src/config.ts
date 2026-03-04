import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR = join(homedir(), ".numavm");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export interface Config {
  api_url: string;
  token?: string;
}

const DEFAULT_CONFIG: Config = {
  api_url: "https://deploymagi.com",
};

export function loadConfig(): Config {
  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
}

export function getToken(): string | undefined {
  return loadConfig().token;
}

export function setToken(token: string): void {
  const config = loadConfig();
  config.token = token;
  saveConfig(config);
}

export function clearToken(): void {
  const config = loadConfig();
  delete config.token;
  saveConfig(config);
}

// Runtime override for --api-url flag (not persisted)
let apiUrlOverride: string | undefined;

export function setApiUrlOverride(url: string): void {
  apiUrlOverride = url;
}

export function getApiUrl(): string {
  return apiUrlOverride || loadConfig().api_url;
}
