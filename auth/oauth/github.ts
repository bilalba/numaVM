import * as arctic from "arctic";
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { upsertUserFromGithub } from "../db/client.js";
import {
  createSessionJWT,
  setSessionCookie,
  isCliRedirect,
  buildCliRedirectUrl,
} from "../session.js";

const github = new arctic.GitHub(
  process.env.GITHUB_CLIENT_ID!,
  process.env.GITHUB_CLIENT_SECRET!,
  `${process.env.AUTH_ORIGIN || "http://localhost:4000"}/auth/github/callback`
);

interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string;
}

interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

export function registerGithubRoutes(app: FastifyInstance) {
  app.get("/auth/github", async (request, reply) => {
    const redirect = (request.query as Record<string, string>).redirect || "/";
    const state = arctic.generateState();

    reply.setCookie("oauth_state", state, {
      path: "/",
      httpOnly: true,
      maxAge: 600,
      sameSite: "lax",
    });
    reply.setCookie("oauth_redirect", redirect, {
      path: "/",
      httpOnly: true,
      maxAge: 600,
      sameSite: "lax",
    });

    const url = github.createAuthorizationURL(state, ["user:email"]);
    return reply.redirect(url.toString());
  });

  app.get("/auth/github/callback", async (request, reply) => {
    const query = request.query as Record<string, string>;
    const code = query.code;
    const state = query.state;
    const storedState = request.cookies.oauth_state;
    const redirect = request.cookies.oauth_redirect || "/";

    if (!code || !state || state !== storedState) {
      return reply.status(400).send("Invalid OAuth state");
    }

    const tokens = await github.validateAuthorizationCode(code);
    const accessToken = tokens.accessToken();

    // Fetch user profile
    const userRes = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const ghUser = (await userRes.json()) as GitHubUser;

    // Fetch primary email if not on profile
    let email = ghUser.email;
    if (!email) {
      const emailsRes = await fetch("https://api.github.com/user/emails", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const emails = (await emailsRes.json()) as GitHubEmail[];
      const primary = emails.find((e) => e.primary && e.verified);
      email = primary?.email ?? emails[0]?.email ?? null;
    }

    if (!email) {
      return reply.status(400).send("Could not retrieve email from GitHub");
    }

    const user = upsertUserFromGithub({
      id: nanoid(),
      email,
      name: ghUser.name || ghUser.login,
      githubId: String(ghUser.id),
      githubUsername: ghUser.login,
      avatarUrl: ghUser.avatar_url,
    });

    const jwt = await createSessionJWT(user.id, user.email);

    reply.clearCookie("oauth_state", { path: "/" });
    reply.clearCookie("oauth_redirect", { path: "/" });

    // CLI auth: redirect with token in query param instead of setting cookie
    if (isCliRedirect(redirect)) {
      return reply.redirect(buildCliRedirectUrl(redirect, jwt));
    }

    setSessionCookie(reply, jwt);
    return reply.redirect(redirect);
  });
}
