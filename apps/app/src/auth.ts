import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

const SESSION_DURATION_SECONDS = 14 * 24 * 60 * 60;

function cookieName(secure: boolean): string {
  return secure ? "__Host-asterism_session" : "asterism_session";
}

interface SessionPayload {
  exp: number;
  passwordVersion: string;
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function passwordVersion(passwordHash: string): string {
  return createHash("sha256").update(passwordHash).digest("base64url").slice(0, 16);
}

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createSessionToken(passwordHash: string, secret: string): string {
  const payload: SessionPayload = {
    exp: Math.floor(Date.now() / 1000) + SESSION_DURATION_SECONDS,
    passwordVersion: passwordVersion(passwordHash),
  };
  const encodedPayload = encode(JSON.stringify(payload));
  return `${encodedPayload}.${signature(encodedPayload, secret)}`;
}

export function verifySessionToken(
  token: string | undefined,
  passwordHash: string,
  secret: string,
): boolean {
  if (!token) return false;
  const [encodedPayload, suppliedSignature, extra] = token.split(".");
  if (!encodedPayload || !suppliedSignature || extra) return false;

  const expectedSignature = signature(encodedPayload, secret);
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return false;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as Partial<SessionPayload>;
    return (
      typeof payload.exp === "number" &&
      payload.exp > Math.floor(Date.now() / 1000) &&
      payload.passwordVersion === passwordVersion(passwordHash)
    );
  } catch {
    return false;
  }
}

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  secure: boolean,
): void {
  reply.setCookie(cookieName(secure), token, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DURATION_SECONDS,
  });
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(cookieName(secure), {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
  });
}

export function hasSession(
  request: FastifyRequest,
  passwordHash: string,
  secret: string,
  secure = false,
): boolean {
  return verifySessionToken(
    request.cookies[cookieName(secure)],
    passwordHash,
    secret,
  );
}

export function safeTokenEqual(supplied: string | undefined, expected: string): boolean {
  if (!supplied) return false;
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  return (
    suppliedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(suppliedBuffer, expectedBuffer)
  );
}
