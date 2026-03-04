import "dotenv/config";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { registerGithubRoutes } from "./oauth/github.js";
import { registerGoogleRoutes } from "./oauth/google.js";
import { registerEmailRoutes } from "./oauth/email.js";
import { registerVerifyRoute } from "./verify.js";
import {
  getSessionFromRequest,
  clearSessionCookie,
} from "./session.js";
import { findUserById } from "./db/client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let deployVersion: Record<string, string> = {};
try {
  deployVersion = JSON.parse(
    readFileSync(join(__dirname, "..", "version.json"), "utf-8")
  );
} catch {}

const app = Fastify({ logger: true });

await app.register(cookie);
await app.register(formbody);

// Login page
const loginHtml = readFileSync(
  join(__dirname, "views", "login.html"),
  "utf-8"
);

app.get("/login", async (request, reply) => {
  const redirect = (request.query as Record<string, string>).redirect || "/";
  const redirectParam =
    redirect !== "/" ? `?redirect=${encodeURIComponent(redirect)}` : "";

  const html = loginHtml.replace(/__REDIRECT_PARAM__/g, redirectParam);
  reply.type("text/html").send(html);
});

// Current user
app.get("/me", async (request, reply) => {
  const session = await getSessionFromRequest(request);
  if (!session) {
    return reply.status(401).send({ error: "Not authenticated" });
  }
  const user = findUserById(session.sub);
  if (!user) {
    return reply.status(401).send({ error: "User not found" });
  }
  return reply.send({
    id: user.id,
    email: user.email,
    name: user.name,
    avatar_url: user.avatar_url,
  });
});

// Logout
app.get("/logout", async (_request, reply) => {
  clearSessionCookie(reply);
  return reply.redirect("/login");
});

// Health check
app.get("/health", async () => ({ status: "ok", version: deployVersion }));

// Register route modules
registerGithubRoutes(app);
registerGoogleRoutes(app);
registerEmailRoutes(app);
registerVerifyRoute(app);

// Start
const port = parseInt(process.env.AUTH_PORT || "4000", 10);
await app.listen({ port, host: "0.0.0.0" });
console.log(`Auth service listening on http://localhost:${port}`);
if (deployVersion.commit) {
  console.log(`Version: ${deployVersion.commit} (${deployVersion.branch}) deployed ${deployVersion.timestamp}`);
}
