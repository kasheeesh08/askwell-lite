import {
  SUPPORTED_EMBEDDING_PROFILE,
  SUPPORTED_INDEXING_PROFILE_WITH_KEY,
} from "./storage-contract.mjs";
import { createHostedVercelHandler } from "./vercel-api.mjs";

const SECURITY_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
});

export function createHostedRoute({ hostedPath, methods, transformRequest } = {}) {
  const allowed = new Set(methods || ["GET"]);
  let handler;
  let handlerKey;
  return async function hostedRoute(req, res) {
    applyHeaders(res);
    if (!hostedModeEnabled(process.env)) {
      return sendJson(res, 503, {
        error: "Hosted mode is not enabled",
        code: "hosted_mode_disabled",
      });
    }

    const method = String(req.method || "GET").toUpperCase();
    if (!allowed.has(method)) {
      if (typeof res.setHeader === "function") {
        res.setHeader("allow", [...allowed].join(", "));
      }
      return sendJson(res, 405, {
        error: "Method not allowed",
        code: "method_not_allowed",
      });
    }

    const nextHandlerKey = `${process.env.TURSO_DATABASE_URL || ""}:${process.env.ASKWELL_ADMIN_TOKEN ? "auth" : "no-auth"}`;
    if (!handler || handlerKey !== nextHandlerKey) {
      handler = createHostedVercelHandler({ env: process.env });
      handlerKey = nextHandlerKey;
    }
    const mapped = transformRequest
      ? await transformRequest(req)
      : { ...req, url: withOriginalQuery(hostedPath, req.url) };
    return handler(mapped, res);
  };
}

export function hostedModeEnabled(env = process.env) {
  return env.ASKWELL_HOSTED_MODE === "1" || env.ASKWELL_DEPLOYMENT_MODE === "hosted";
}

export function hostedConfig() {
  const enabled = hostedModeEnabled(process.env);
  return {
    apiMode: enabled ? "hosted" : "local",
    hostedConfigured: enabled,
    embeddingProfile: publicProfile(SUPPORTED_EMBEDDING_PROFILE),
    indexingProfile: {
      id: SUPPORTED_INDEXING_PROFILE_WITH_KEY.id,
      compatibilityKey: SUPPORTED_INDEXING_PROFILE_WITH_KEY.compatibilityKey,
      chunkSize: SUPPORTED_INDEXING_PROFILE_WITH_KEY.chunkSize,
      chunkOverlap: SUPPORTED_INDEXING_PROFILE_WITH_KEY.chunkOverlap,
    },
  };
}

export async function documentDeleteRequest(req) {
  const route = new URL(req.url || "/", "http://localhost");
  const documentId = req.query?.id || decodeURIComponent(route.pathname.split("/").filter(Boolean).at(-1) || "");
  return {
    ...req,
    url: withOriginalQuery("/api/hosted/delete-document", req.url),
    body: {
      workspaceId: route.searchParams.get("workspaceId") || header(req, "x-askwell-workspace-id") || "default",
      documentId,
      expectedDocumentVersion: req.query?.expectedDocumentVersion
        ? Number(req.query.expectedDocumentVersion)
        : undefined,
    },
  };
}

export function sendPublicConfig(req, res) {
  applyHeaders(res);
  if (String(req.method || "GET").toUpperCase() !== "GET") {
    if (typeof res.setHeader === "function") res.setHeader("allow", "GET");
    return sendJson(res, 405, { error: "Method not allowed", code: "method_not_allowed" });
  }
  return sendJson(res, 200, hostedConfig());
}

function withOriginalQuery(path, originalUrl) {
  const original = new URL(originalUrl || "/", "http://localhost");
  return `${path}${original.search}`;
}

function applyHeaders(res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (typeof res.setHeader === "function") res.setHeader(name, value);
  }
}

function header(req, name) {
  const headers = req.headers || {};
  if (typeof headers.get === "function") return headers.get(name);
  return headers[name.toLowerCase()] || headers[name] || "";
}

function publicProfile(profile) {
  return {
    id: profile.id,
    compatibilityKey: profile.compatibilityKey,
    modelId: profile.modelId,
    targetModelId: profile.targetModelId,
    packageName: profile.packageName,
    packageVersion: profile.packageVersion,
    dimension: profile.dimension,
    normalized: profile.normalized,
    pooling: profile.pooling,
    quantized: profile.quantized,
  };
}

function sendJson(res, status, payload) {
  const json = JSON.stringify(payload);
  if (typeof res.status === "function" && typeof res.json === "function") {
    return res.status(status).json(payload);
  }
  res.statusCode = status;
  if (typeof res.setHeader === "function") {
    res.setHeader("content-type", "application/json; charset=utf-8");
  }
  if (typeof res.end === "function") res.end(json);
  return payload;
}
