import * as arctic from "arctic";
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { getAuthDatabase } from "../adapters/providers.js";
import {
  createSessionJWT,
  setSessionCookie,
  getSessionFromRequest,
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
    const query = request.query as Record<string, string>;
    const redirect = query.redirect || `https://app.${process.env.BASE_DOMAIN || "localhost:4002"}`;
    const email = request.cookies.login_email || "";
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
    if (email) {
      reply.setCookie("oauth_required_email", email, {
        path: "/",
        httpOnly: true,
        maxAge: 600,
        sameSite: "lax",
      });
    }

    const url = github.createAuthorizationURL(state, ["user:email"]);
    // GitHub doesn't support login_hint, but we validate email after callback
    return reply.redirect(url.toString());
  });

  // Step 2: Repo-scope OAuth (for users who want to grant repo access)
  app.get("/auth/github/repo", async (request, reply) => {
    const redirect = (request.query as Record<string, string>).redirect || `https://app.${process.env.BASE_DOMAIN || "localhost:4002"}`;
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
    reply.setCookie("oauth_flow", "repo", {
      path: "/",
      httpOnly: true,
      maxAge: 600,
      sameSite: "lax",
    });

    const url = github.createAuthorizationURL(state, ["user:email", "repo"]);
    return reply.redirect(url.toString());
  });

  app.get("/auth/github/callback", async (request, reply) => {
    const query = request.query as Record<string, string>;
    const code = query.code;
    const state = query.state;
    const storedState = request.cookies.oauth_state;
    const redirect = request.cookies.oauth_redirect || `https://app.${process.env.BASE_DOMAIN || "localhost:4002"}`;
    const flow = request.cookies.oauth_flow || "login";

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

    const requiredEmail = request.cookies.oauth_required_email || "";

    reply.clearCookie("oauth_state", { path: "/" });
    reply.clearCookie("oauth_redirect", { path: "/" });
    reply.clearCookie("oauth_flow", { path: "/" });
    reply.clearCookie("oauth_required_email", { path: "/" });
    reply.clearCookie("login_email", { path: "/" });

    // Enforce email match if required (e.g., SSH key linking flow)
    if (requiredEmail && email!.toLowerCase() !== requiredEmail.toLowerCase()) {
      // Re-set cookies for retry
      reply.setCookie("login_email", requiredEmail, { path: "/", httpOnly: true, maxAge: 600, sameSite: "lax" });
      const loginUrl = `/login?redirect=${encodeURIComponent(redirect)}&error=email_mismatch`;
      return reply.redirect(loginUrl);
    }

    const db = getAuthDatabase();

    if (flow === "repo") {
      // Repo-scope flow: save the token to the currently logged-in user
      // Try session cookie first (most reliable), then GitHub ID, then email
      const session = await getSessionFromRequest(request);
      const existingUser = session
        ? { id: session.sub }
        : (await db.findUserByGithubId(String(ghUser.id))) ?? (email ? await db.findUserByEmail(email) : null);
      if (existingUser) {
        await db.updateUserGithubToken(existingUser.id, accessToken);
      }
      // Redirect back to dashboard (user is already logged in)
      return reply.redirect(redirect);
    }

    // Normal login flow
    const user = await db.upsertUserFromGithub({
      id: nanoid(),
      email,
      name: ghUser.name || ghUser.login,
      githubId: String(ghUser.id),
      githubUsername: ghUser.login,
      avatarUrl: ghUser.avatar_url,
    });

    const jwt = await createSessionJWT(user.id, user.email);

    // CLI auth: redirect with token in query param instead of setting cookie
    if (isCliRedirect(redirect)) {
      return reply.redirect(buildCliRedirectUrl(redirect, jwt));
    }

    setSessionCookie(reply, jwt);
    return reply.redirect(redirect);
  });
}
