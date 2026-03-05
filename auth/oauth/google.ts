import * as arctic from "arctic";
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { upsertUserFromGoogle } from "../db/client.js";
import {
  createSessionJWT,
  setSessionCookie,
  isCliRedirect,
  buildCliRedirectUrl,
} from "../session.js";

const google = new arctic.Google(
  process.env.GOOGLE_CLIENT_ID!,
  process.env.GOOGLE_CLIENT_SECRET!,
  `${process.env.AUTH_ORIGIN || "http://localhost:4000"}/auth/google/callback`
);

export function registerGoogleRoutes(app: FastifyInstance) {
  app.get("/auth/google", async (request, reply) => {
    const redirect = (request.query as Record<string, string>).redirect || `https://app.${process.env.BASE_DOMAIN || "localhost:4002"}`;
    const state = arctic.generateState();
    const codeVerifier = arctic.generateCodeVerifier();

    reply.setCookie("oauth_state", state, {
      path: "/",
      httpOnly: true,
      maxAge: 600,
      sameSite: "lax",
    });
    reply.setCookie("oauth_code_verifier", codeVerifier, {
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

    const url = google.createAuthorizationURL(state, codeVerifier, [
      "openid",
      "email",
      "profile",
    ]);
    return reply.redirect(url.toString());
  });

  app.get("/auth/google/callback", async (request, reply) => {
    const query = request.query as Record<string, string>;
    const code = query.code;
    const state = query.state;
    const storedState = request.cookies.oauth_state;
    const codeVerifier = request.cookies.oauth_code_verifier;
    const redirect = request.cookies.oauth_redirect || `https://app.${process.env.BASE_DOMAIN || "localhost:4002"}`;

    if (!code || !state || state !== storedState || !codeVerifier) {
      return reply.status(400).send("Invalid OAuth state");
    }

    const tokens = await google.validateAuthorizationCode(code, codeVerifier);
    const idToken = tokens.idToken();
    const claims = arctic.decodeIdToken(idToken) as {
      sub: string;
      email: string;
      name?: string;
      picture?: string;
    };

    const user = upsertUserFromGoogle({
      id: nanoid(),
      email: claims.email,
      name: claims.name || null,
      googleId: claims.sub,
      avatarUrl: claims.picture || null,
    });

    const jwt = await createSessionJWT(user.id, user.email);

    reply.clearCookie("oauth_state", { path: "/" });
    reply.clearCookie("oauth_code_verifier", { path: "/" });
    reply.clearCookie("oauth_redirect", { path: "/" });

    // CLI auth: redirect with token in query param instead of setting cookie
    if (isCliRedirect(redirect)) {
      return reply.redirect(buildCliRedirectUrl(redirect, jwt));
    }

    setSessionCookie(reply, jwt);
    return reply.redirect(redirect);
  });
}
