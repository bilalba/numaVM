import type { FastifyInstance } from "fastify";
import { findUserById, updateUserSshKeys, clearUserGithubToken } from "../db/client.js";
import { fetchSshKeys, listRepos, createRepo } from "../services/github.js";

export function registerUserRoutes(app: FastifyInstance) {
  // Get current user's SSH keys
  app.get("/me/ssh-keys", async (request) => {
    const user = findUserById(request.userId);
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
      updateUserSshKeys(request.userId, null);
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

    updateUserSshKeys(request.userId, lines.join("\n"));
    return { ok: true };
  });

  // GitHub repo access status
  app.get("/me/github", async (request) => {
    const user = findUserById(request.userId);
    return {
      connected: !!user?.github_token,
      username: user?.github_username || null,
    };
  });

  // Disconnect GitHub repo access (clear token)
  app.delete("/me/github", async (request) => {
    clearUserGithubToken(request.userId);
    return { ok: true };
  });

  // List user's GitHub repos
  app.get("/me/repos", async (request, reply) => {
    const user = findUserById(request.userId);
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
    const user = findUserById(request.userId);
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
}
