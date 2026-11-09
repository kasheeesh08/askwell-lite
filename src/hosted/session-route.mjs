import { HostedContractError, structuredError } from "./storage-contract.mjs";
import {
  clearHostedSessionCookie,
  createHostedSession,
  hasHostedSessionCookie,
  revokeHostedSession,
  validateAdminCredential,
  verifyHostedSessionWithStore,
} from "./session.mjs";
import { createTursoAdapterFromEnv } from "./turso-adapter.mjs";
import { hostedModeEnabled } from "./vercel-route.mjs";

const MAX_LOGIN_BYTES = 8 * 1024;
const loginRateBuckets = new Map();
let securityStorePromise;
let securityStoreUrl;

export async function sendHostedLogin(req, res, env = process.env) {
  applyHeaders(res);
  try {
    if (!hostedModeEnabled(env)) return sendHostedDisabled(res);
    enforceMethod(req, res, "POST");
    enforceLoginRateLimit(req, env);
    const body = await readJsonBody(req, MAX_LOGIN_BYTES);
    const credential = body.accessCredential || body.adminToken || body.password || body.token || "";
    validateAdminCredential(credential, env);
    const session = createHostedSession(env);
    res.setHeader?.("set-cookie", session.cookie);
    return sendJson(res, 200, {
      authenticated: true,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
    });
  } catch (error) {
    return sendError(res, error);
  }
}

export async function sendHostedLogout(req, res, env = process.env) {
  applyHeaders(res);
  try {
    if (!hostedModeEnabled(env)) return sendHostedDisabled(res);
    enforceMethod(req, res, "POST");
    if (hasHostedSessionCookie(req)) {
      await revokeHostedSession(req, env, { getRevocationStore: () => getSecurityStore(env) });
    }
    res.setHeader?.("set-cookie", clearHostedSessionCookie());
    return sendJson(res, 200, { authenticated: false });
  } catch (error) {
    res.setHeader?.("set-cookie", clearHostedSessionCookie());
    return sendError(res, error);
  }
}

export async function sendHostedSession(req, res, env = process.env) {
  applyHeaders(res);
  try {
    if (!hostedModeEnabled(env)) return sendHostedDisabled(res);
    enforceMethod(req, res, "GET");
    const session = await verifyHostedSessionWithStore(req, env, {
      getRevocationStore: () => getSecurityStore(env),
    });
    return sendJson(res, 200, {
      authenticated: true,
      csrfToken: session.csrf,
      expiresAt: new Date(session.exp).toISOString(),
    });
  } catch (error) {
    return sendError(res, error);
  }
}

async function getSecurityStore(env) {
  if (!securityStorePromise || securityStoreUrl !== env.TURSO_DATABASE_URL) {
    securityStoreUrl = env.TURSO_DATABASE_URL;
    securityStorePromise = createTursoAdapterFromEnv({ env });
  }
  return securityStorePromise;
}

function enforceMethod(req, res, allowed) {
  const method = String(req.method || "GET").toUpperCase();
  if (method === allowed) return;
  res.setHeader?.("allow", allowed);
  throw new HostedContractError("method_not_allowed", "Method not allowed", 405);
}

function enforceLoginRateLimit(req, env) {
  const max = positiveInteger(env.ASKWELL_HOSTED_LOGIN_RATE_LIMIT || 20, 20);
  const windowMs = positiveInteger(env.ASKWELL_HOSTED_LOGIN_RATE_WINDOW_MS || 60_000, 60_000);
  const key = clientAddress(req);
  const nowMs = Date.now();
  const existing = loginRateBuckets.get(key);
  if (!existing || existing.resetAt <= nowMs) {
    loginRateBuckets.set(key, { count: 1, resetAt: nowMs + windowMs });
    return;
  }
  if (existing.count >= max) {
    throw new HostedContractError("rate_limited", "Too many hosted login attempts", 429, {
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - nowMs) / 1000)),
      scope: "instance-local",
    });
  }
  existing.count += 1;
}

function clientAddress(req) {
  const forwarded = header(req, "x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return header(req, "x-real-ip") || req.socket?.remoteAddress || "unknown";
}

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

async function readJsonBody(req, maxBytes) {
  if (req.body !== undefined) {
    const text = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > maxBytes) {
      throw new HostedContractError("payload_too_large", "Login request payload is too large", 413);
    }
    return parseJson(text);
  }

  const length = Number(header(req, "content-length") || 0);
  if (length > maxBytes) {
    throw new HostedContractError("payload_too_large", "Login request payload is too large", 413);
  }

  const chunks = [];
  let receivedBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    receivedBytes += buffer.byteLength;
    if (receivedBytes > maxBytes) {
      throw new HostedContractError("payload_too_large", "Login request payload is too large", 413);
    }
    chunks.push(buffer);
  }
  return parseJson(Buffer.concat(chunks).toString("utf8"));
}

function parseJson(text) {
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw new HostedContractError("malformed_json", "Request body must be valid JSON", 400);
  }
}

function applyHeaders(res) {
  res.setHeader?.("cache-control", "no-store");
  res.setHeader?.("x-content-type-options", "nosniff");
  res.setHeader?.("referrer-policy", "strict-origin-when-cross-origin");
}

function sendHostedDisabled(res) {
  return sendJson(res, 503, {
    error: "Hosted mode is not enabled",
    code: "hosted_mode_disabled",
  });
}

function sendError(res, error) {
  const status = error instanceof HostedContractError ? error.status || 400 : 500;
  return sendJson(res, status, structuredError(error));
}

function header(req, name) {
  const headers = req.headers || {};
  if (typeof headers.get === "function") return headers.get(name);
  return headers[name.toLowerCase()] || headers[name] || "";
}

function sendJson(res, status, payload) {
  const json = JSON.stringify(payload);
  if (typeof res.status === "function" && typeof res.json === "function") {
    res.setHeader?.("content-type", "application/json; charset=utf-8");
    return res.status(status).json(payload);
  }
  res.statusCode = status;
  res.setHeader?.("content-type", "application/json; charset=utf-8");
  res.end?.(json);
  return payload;
}
