import { getApiUrl, getToken } from "./config.js";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const apiUrl = getApiUrl();
  const token = getToken();

  if (!token) {
    throw new ApiError(401, "Not authenticated. Run `numavm auth login` first.");
  }

  const url = `${apiUrl}${path}`;
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${token}`,
    ...(options.headers as Record<string, string> || {}),
  };

  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(url, { ...options, headers });

  if (!res.ok) {
    let message: string;
    try {
      const body = await res.json() as { error?: string };
      message = body.error || res.statusText;
    } catch {
      message = res.statusText;
    }
    if (res.status === 401) {
      throw new ApiError(401, "Session expired. Run `numavm auth login` to re-authenticate.");
    }
    throw new ApiError(res.status, message);
  }

  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}
