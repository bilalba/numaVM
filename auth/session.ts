import { SignJWT, jwtVerify } from "jose";
import type { FastifyRequest, FastifyReply } from "fastify";

const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || "change-me-to-a-random-string"
);
const BASE_DOMAIN = process.env.BASE_DOMAIN || "localhost";
const COOKIE_NAME = "__session";
const MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds

export interface SessionPayload {
  sub: string;
  email: string;
}

export async function createSessionJWT(
  userId: string,
  email: string
): Promise<string> {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE}s`)
    .sign(JWT_SECRET);
}

export async function verifySessionJWT(
  token: string
): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    if (!payload.sub || !payload.email) return null;
    return { sub: payload.sub, email: payload.email as string };
  } catch {
    return null;
  }
}

export function setSessionCookie(reply: FastifyReply, jwt: string): void {
  const isLocalhost = BASE_DOMAIN === "localhost";
  const secureCookies = process.env.SECURE_COOKIES !== "false" && !isLocalhost;
  reply.setCookie(COOKIE_NAME, jwt, {
    path: "/",
    httpOnly: true,
    secure: secureCookies,
    sameSite: "lax",
    maxAge: MAX_AGE,
    domain: isLocalhost ? "localhost" : `.${BASE_DOMAIN}`,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  const isLocalhost = BASE_DOMAIN === "localhost";
  reply.clearCookie(COOKIE_NAME, {
    path: "/",
    domain: isLocalhost ? "localhost" : `.${BASE_DOMAIN}`,
  });
}

export async function getSessionFromRequest(
  request: FastifyRequest
): Promise<SessionPayload | null> {
  const token = request.cookies[COOKIE_NAME];
  if (!token) return null;
  return verifySessionJWT(token);
}
