import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { HostedContractError } from "./storage-contract.mjs";

export const HOSTED_SESSION_COOKIE = "askwell_hosted_session";
export const HOSTED_CSRF_HEADER = "x-askwell-csrf-token";

const DEFAULT_SESSION_TTL_SECONDS = 60 * 60;
const revokedSessions = new Map();

export function createHostedSession(env = process.env, options = {}) {
  requireServerSecret(env);
  const nowMs = options.nowMs ?? Date.now();
  const ttlSeconds = sessionTtlSeconds(env);
  const payload = {
    exp: nowMs + ttlSeconds * 1000,
    csrf: randomToken(),
    jti: randomToken(),
  };
  const value = signPayload(payload, signingSecret(env));
  return {
    cookie: serializeSessionCookie(value, ttlSeconds),
    csrfToken: payload.csrf,
    expiresAt: new Date(payload.exp).toISOString(),
    sessionId: payload.jti,
  };
}

export async function enforceHostedAuth(req, env = process.env, options = {}) {
  const method = String(options.method || req.method || "GET").toUpperCase();
  const serverToken = serverTokenFromRequest(req);
  if (serverToken) {
    validateAdminCredential(serverToken, env);
    return { type: "server-token" };
  }

  const session = verifyHostedSession(req, env, options);
  await enforceSharedRevocation(session, options);
  if (isMutatingMethod(method)) enforceCsrf(req, session, env);
  return { type: "session", session };
}

export function verifyHostedSession(req, env = process.env, options = {}) {
  requireServerSecret(env);
  const cookieValue = cookie(req, HOSTED_SESSION_COOKIE);
  if (!cookieValue) {
    throw new HostedContractError("missing_admin_auth", "Private demo session is required", 401);
  }

  const session = verifySignedPayload(cookieValue, signingSecret(env));
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isFinite(session.exp) || session.exp <= nowMs) {
    throw new HostedContractError("session_expired", "Private demo session has expired", 401);
  }
  cleanupRevokedSessions(nowMs);
  if (revokedSessions.has(session.jti)) {
    throw new HostedContractError("session_invalidated", "Private demo session has been logged out", 401);
  }
  if (!session.csrf || !session.jti) {
    throw new HostedContractError("invalid_session", "Private demo session is invalid", 401);
  }
  return session;
}

export function validateAdminCredential(received, env = process.env) {
  const configured = requireServerSecret(env);
  if (!received) {
    throw new HostedContractError("missing_admin_auth", "Admin credential is required", 401);
  }
  if (!safeEqual(String(received), String(configured))) {
    throw new HostedContractError("invalid_admin_auth", "Admin credential is invalid", 403);
  }
}

export async function verifyHostedSessionWithStore(req, env = process.env, options = {}) {
  const session = verifyHostedSession(req, env, options);
  await enforceSharedRevocation(session, options);
  return session;
}

export async function revokeHostedSession(req, env = process.env, options = {}) {
  const session = await verifyHostedSessionWithStore(req, env, options);
  enforceCsrf(req, session, env);
  await persistRevocation(session, options);
  cleanupRevokedSessions(options.nowMs ?? Date.now());
  return session;
}

export function clearHostedSessionCookie() {
  return `${HOSTED_SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

export function hasHostedSessionCookie(req) {
  return Boolean(cookie(req, HOSTED_SESSION_COOKIE));
}

export function serverTokenFromRequest(req) {
  const direct = header(req, "x-askwell-admin-token");
  if (direct) return direct;
  const auth = header(req, "authorization");
  const match = /^Bearer\s+(.+)$/i.exec(auth || "");
  return match?.[1] || "";
}

export function sessionTtlSeconds(env = process.env) {
  const ttl = Number(env.ASKWELL_HOSTED_SESSION_TTL_SECONDS || DEFAULT_SESSION_TTL_SECONDS);
  return Number.isInteger(ttl) && ttl > 0 ? ttl : DEFAULT_SESSION_TTL_SECONDS;
}

export function validateHostedSessionConfig(env = process.env) {
  requireServerSecret(env);
  sessionTtlSeconds(env);
}

export function resetHostedSessionRevocationsForTests() {
  revokedSessions.clear();
}

function requireServerSecret(env) {
  const configured = env.ASKWELL_ADMIN_TOKEN;
  if (!configured) {
    throw new HostedContractError(
      "missing_admin_token",
      "ASKWELL_ADMIN_TOKEN is required for hosted private demo access",
      500,
    );
  }
  return configured;
}

function enforceCsrf(req, session, env) {
  const received = header(req, HOSTED_CSRF_HEADER);
  if (!received || !safeEqual(String(received), String(session.csrf))) {
    throw new HostedContractError("csrf_required", "A valid CSRF token is required", 403);
  }
  enforceExpectedOrigin(req, env);
}

function isMutatingMethod(method) {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function signingSecret(env) {
  return String(env.ASKWELL_SESSION_SECRET || env.ASKWELL_ADMIN_TOKEN);
}

function signPayload(payload, secret) {
  const encoded = base64url(JSON.stringify(payload));
  const signature = hmac(encoded, secret);
  return `${encoded}.${signature}`;
}

function verifySignedPayload(value, secret) {
  const [encoded, signature, extra] = String(value).split(".");
  if (!encoded || !signature || extra !== undefined) {
    throw new HostedContractError("invalid_session", "Private demo session is invalid", 401);
  }
  const expected = hmac(encoded, secret);
  if (!safeEqual(signature, expected)) {
    throw new HostedContractError("invalid_session", "Private demo session is invalid", 401);
  }
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error("invalid session payload");
    return parsed;
  } catch {
    throw new HostedContractError("invalid_session", "Private demo session is invalid", 401);
  }
}

function hmac(value, secret) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function serializeSessionCookie(value, ttlSeconds) {
  return [
    `${HOSTED_SESSION_COOKIE}=${value}`,
    `Max-Age=${ttlSeconds}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
  ].join("; ");
}

function cleanupRevokedSessions(nowMs) {
  for (const [sessionId, expiresAt] of revokedSessions) {
    if (expiresAt <= nowMs) revokedSessions.delete(sessionId);
  }
}

async function enforceSharedRevocation(session, options) {
  const store = await resolveRevocationStore(options);
  if (store?.isSessionRevoked) {
    const revoked = await store.isSessionRevoked(session.jti, new Date(options.nowMs ?? Date.now()).toISOString());
    if (revoked) {
      throw new HostedContractError("session_invalidated", "Private demo session has been logged out", 401);
    }
    return;
  }
  if (revokedSessions.has(session.jti)) {
    throw new HostedContractError("session_invalidated", "Private demo session has been logged out", 401);
  }
}

async function persistRevocation(session, options) {
  const store = await resolveRevocationStore(options);
  if (store?.revokeSession) {
    await store.revokeSession(session.jti, new Date(session.exp).toISOString());
    return;
  }
  revokedSessions.set(session.jti, session.exp);
}

async function resolveRevocationStore(options = {}) {
  if (options.revocationStore) return options.revocationStore;
  if (options.getRevocationStore) return options.getRevocationStore();
  return null;
}

function enforceExpectedOrigin(req, env) {
  const origin = header(req, "origin");
  if (!origin) return;
  const expected = expectedOrigin(req, env);
  if (!expected || origin !== expected) {
    throw new HostedContractError("csrf_origin_mismatch", "Request origin is not allowed", 403);
  }
}

function expectedOrigin(req, env) {
  if (env.ASKWELL_HOSTED_ORIGIN) return env.ASKWELL_HOSTED_ORIGIN;
  const host = header(req, "x-forwarded-host") || header(req, "host");
  if (!host) return "";
  const proto = header(req, "x-forwarded-proto") || (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return `${proto}://${host}`;
}

function randomToken() {
  return randomBytes(32).toString("base64url");
}

function base64url(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function cookie(req, name) {
  const raw = header(req, "cookie");
  if (!raw) return "";
  for (const part of raw.split(";")) {
    const [cookieName, ...valueParts] = part.trim().split("=");
    if (cookieName === name) return valueParts.join("=");
  }
  return "";
}

function header(req, name) {
  const headers = req.headers || {};
  if (typeof headers.get === "function") return headers.get(name);
  return headers[name.toLowerCase()] || headers[name] || "";
}
