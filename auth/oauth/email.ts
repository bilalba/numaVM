import { SignJWT, jwtVerify } from "jose";
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { upsertUserFromEmail } from "../db/client.js";
import {
  createSessionJWT,
  setSessionCookie,
  isCliRedirect,
  buildCliRedirectUrl,
} from "../session.js";

const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || "change-me-to-a-random-string"
);
const AUTH_ORIGIN = process.env.AUTH_ORIGIN || "http://localhost:4000";
const BASE_DOMAIN = process.env.BASE_DOMAIN || "localhost";
const RESEND_API_KEY = process.env.RESEND_API_KEY;

function getDashboardUrl(): string {
  if (BASE_DOMAIN === "localhost") return "http://localhost:4002";
  return `http://${BASE_DOMAIN}`;
}

async function createMagicLinkToken(email: string): Promise<string> {
  return new SignJWT({ email, purpose: "magic-link" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(JWT_SECRET);
}

async function verifyMagicLinkToken(
  token: string
): Promise<{ email: string } | null> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    if (payload.purpose !== "magic-link" || !payload.email) return null;
    return { email: payload.email as string };
  } catch {
    return null;
  }
}

async function sendMagicLinkEmail(
  email: string,
  link: string
): Promise<boolean> {
  if (!RESEND_API_KEY) {
    console.log(`[DEV] Magic link for ${email}: ${link}`);
    return true;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: "DeployMagi <noreply@auth.autodevice.io>",
      to: [email],
      subject: "Sign in to DeployMagi",
      html: `
        <p>Click the link below to sign in to DeployMagi:</p>
        <p><a href="${link}">Sign in</a></p>
        <p>This link expires in 15 minutes.</p>
        <p>If you didn't request this, you can safely ignore this email.</p>
      `,
    }),
  });

  return res.ok;
}

export function registerEmailRoutes(app: FastifyInstance) {
  app.post("/auth/email", async (request, reply) => {
    const { email, redirect } = request.body as {
      email?: string;
      redirect?: string;
    };

    if (!email || !email.includes("@")) {
      return reply.status(400).send("Valid email required");
    }

    const token = await createMagicLinkToken(email);
    const params = new URLSearchParams({ token });
    if (redirect) params.set("redirect", redirect);
    const link = `${AUTH_ORIGIN}/auth/email/verify?${params}`;

    const sent = await sendMagicLinkEmail(email, link);
    if (!sent) {
      return reply.status(500).send("Failed to send email");
    }

    return reply.send({ ok: true, message: "Check your email for a sign-in link" });
  });

  app.get("/auth/email/verify", async (request, reply) => {
    const query = request.query as Record<string, string>;
    const token = query.token;
    const redirect = query.redirect === "/" ? getDashboardUrl() : (query.redirect || getDashboardUrl());

    if (!token) {
      return reply.status(400).send("Missing token");
    }

    const result = await verifyMagicLinkToken(token);
    if (!result) {
      return reply.status(400).send("Invalid or expired token");
    }

    const user = upsertUserFromEmail({
      id: nanoid(),
      email: result.email,
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
