import {
  HOSTED_LIMITS,
  HostedContractError,
  structuredError,
  validateHostedAnswerRequest,
} from "./storage-contract.mjs";
import {
  answerFromRetrieval,
  bm25Search,
  RETRIEVAL_DEFAULTS,
  reciprocalRankFusion,
  semanticSearch,
} from "./retrieval.mjs";
import { enforceHostedAuth, validateHostedSessionConfig } from "./session.mjs";
import { createTursoAdapterFromEnv } from "./turso-adapter.mjs";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const AUTHENTICATED_PATHS = new Set([
  "/api/hosted/health",
  "/api/hosted/diagnostics",
  "/api/hosted/workspace",
  "/api/hosted/documents",
  "/api/hosted/ingest",
  "/api/hosted/delete-document",
  "/api/hosted/answer",
]);
const RATE_LIMITED_PATHS = new Set(["/api/hosted/answer", "/api/hosted/ingest"]);
const rateLimitBuckets = new Map();

export function createHostedVercelHandler(options = {}) {
  const env = options.env || process.env;
  validateHostedSessionConfig(env);
  const limits = options.limits || HOSTED_LIMITS;
  const retrievalSettings = options.retrievalSettings || RETRIEVAL_DEFAULTS;
  const rateLimiter = options.rateLimiter || createInstanceRateLimiter(env, options.rateLimits);
  const adapterFactory =
    options.adapterFactory ||
    (() =>
      createTursoAdapterFromEnv({
        env,
        limits,
        timeoutMs: options.databaseTimeoutMs,
      }));
  let adapterPromise;

  async function getAdapter() {
    if (!adapterPromise) {
      adapterPromise = Promise.resolve().then(adapterFactory);
    }
    try {
      return await adapterPromise;
    } catch (error) {
      adapterPromise = undefined;
      throw error;
    }
  }

  return async function hostedVercelHandler(req, res) {
    try {
      const method = String(req.method || "GET").toUpperCase();
      const route = normalizeRoute(req.url || "/");
      const workspaceId = readWorkspaceId(req, route);
      const context = { workspaceId };

      if (requiresAdminAuth(method, route.pathname)) {
        await enforceHostedAuth(req, env, {
          method,
          getRevocationStore: getAdapter,
        });
      }

      if (requiresRateLimit(method, route.pathname)) {
        enforceRateLimit(rateLimiter, req, route, context);
      }

      if (method === "GET" && route.pathname === "/api/hosted/health") {
        const adapter = await getAdapter();
        const diagnostics = await adapter.diagnostics(workspaceId);
        return sendJson(res, 200, { available: true, status: "ok", diagnostics });
      }

      if (method === "GET" && route.pathname === "/api/hosted/diagnostics") {
        const adapter = await getAdapter();
        const diagnostics = await adapter.diagnostics(workspaceId);
        const documents = await adapter.listDocuments(workspaceId);
        return sendJson(res, 200, {
          status: diagnostics.integrityCheck === "ok" || diagnostics.integrityCheck === "not-available"
            ? "healthy"
            : "warning",
          ...diagnostics,
          documents,
        });
      }

      if (method === "GET" && route.pathname === "/api/hosted/workspace") {
        const adapter = await getAdapter();
        return sendJson(res, 200, { workspace: await adapter.getWorkspace(workspaceId) });
      }

      if (method === "PUT" && route.pathname === "/api/hosted/workspace") {
        const body = await readJsonBody(req, limits.maxPayloadBytes);
        const adapter = await getAdapter();
        return sendJson(res, 200, { workspace: await adapter.saveWorkspace(body, context) });
      }

      if (method === "GET" && route.pathname === "/api/hosted/documents") {
        const adapter = await getAdapter();
        return sendJson(res, 200, { documents: await adapter.listDocuments(workspaceId) });
      }

      if (method === "POST" && route.pathname === "/api/hosted/ingest") {
        const body = await readJsonBody(req, limits.maxPayloadBytes);
        const adapter = await getAdapter();
        return sendJson(res, 200, await adapter.ingest(body, context));
      }

      if ((method === "POST" || method === "DELETE") && route.pathname === "/api/hosted/delete-document") {
        const body = await readJsonBody(req, limits.maxPayloadBytes);
        const adapter = await getAdapter();
        return sendJson(res, 200, await adapter.deleteDocument(body, context));
      }

      if (method === "POST" && route.pathname === "/api/hosted/answer") {
        const body = await readJsonBody(req, limits.maxPayloadBytes);
        const request = validateHostedAnswerRequest(body, context, limits);
        const adapter = await getAdapter();
        const chunkIndex = await adapter.getChunkIndex(request.workspaceId);
        const retrieval = await retrieveWithAsyncPrefilter({
          question: request.question,
          queryVector: request.queryVector,
          chunkIndex,
          vectorSnapshotForChunkIds: async (chunkIds) =>
            adapter.getRetrievalSnapshot(request.workspaceId, { chunkIds }),
          topK: request.topK,
          settings: retrievalSettings,
        });
        return sendJson(res, 200, {
          ...answerFromRetrieval({
            question: request.question,
            bm25: retrieval.bm25,
            semantic: retrieval.semantic,
            hybrid: retrieval.hybrid,
            settings: retrievalSettings,
          }),
          retrieval: {
            candidateChunkIds: retrieval.candidateChunkIds,
            vectorsLoaded: retrieval.vectorsLoaded,
            fallbackFullScan: retrieval.fallbackFullScan,
          },
        });
      }

      return sendJson(res, 404, { error: "Hosted API route not found", code: "not_found" });
    } catch (error) {
      const status = statusForError(error);
      return sendJson(res, status, structuredError(error));
    }
  };
}

function requiresAdminAuth(method, pathname) {
  return AUTHENTICATED_PATHS.has(pathname) || WRITE_METHODS.has(method);
}

function requiresRateLimit(method, pathname) {
  return RATE_LIMITED_PATHS.has(pathname) && (method === "POST" || method === "PUT" || method === "PATCH");
}

async function retrieveWithAsyncPrefilter({
  question,
  queryVector,
  chunkIndex,
  vectorSnapshotForChunkIds,
  topK,
  settings,
}) {
  const config = { ...RETRIEVAL_DEFAULTS, ...settings };
  const bm25All = bm25Search(question, chunkIndex, Math.max(topK, config.lexicalCandidateLimit), config);
  const candidateIds = bm25All.slice(0, config.lexicalCandidateLimit).map((chunk) => chunk.chunkId);
  const fallback = candidateIds.length === 0 || chunkIndex.length <= config.fullScanFallbackChunkLimit;
  const selectedIds = fallback ? chunkIndex.map((chunk) => chunk.id || chunk.chunkId) : candidateIds;
  const snapshot = await vectorSnapshotForChunkIds(selectedIds);
  const bm25 = bm25All.slice(0, topK);
  const semantic = semanticSearch(queryVector, snapshot.chunks, snapshot.embeddings, topK);
  const hybrid = reciprocalRankFusion(bm25, semantic, topK, config.rrfConstant);
  return {
    bm25,
    semantic,
    hybrid,
    candidateChunkIds: selectedIds,
    vectorsLoaded: snapshot.embeddings.length,
    fallbackFullScan: fallback,
  };
}

function createInstanceRateLimiter(env, overrides = {}) {
  const limits = {
    "/api/hosted/answer": {
      max: positiveInteger(overrides.answerMax ?? env.ASKWELL_HOSTED_ANSWER_RATE_LIMIT ?? 60, 60),
      windowMs: positiveInteger(overrides.answerWindowMs ?? env.ASKWELL_HOSTED_ANSWER_RATE_WINDOW_MS ?? 60_000, 60_000),
    },
    "/api/hosted/ingest": {
      max: positiveInteger(overrides.ingestMax ?? env.ASKWELL_HOSTED_INGEST_RATE_LIMIT ?? 12, 12),
      windowMs: positiveInteger(overrides.ingestWindowMs ?? env.ASKWELL_HOSTED_INGEST_RATE_WINDOW_MS ?? 600_000, 600_000),
    },
  };

  return {
    check({ pathname, key, nowMs = Date.now() }) {
      const limit = limits[pathname];
      if (!limit) return { allowed: true };
      const bucketKey = `${pathname}:${key}`;
      const existing = rateLimitBuckets.get(bucketKey);
      if (!existing || existing.resetAt <= nowMs) {
        rateLimitBuckets.set(bucketKey, { count: 1, resetAt: nowMs + limit.windowMs });
        return { allowed: true, remaining: Math.max(limit.max - 1, 0), resetAt: nowMs + limit.windowMs };
      }
      if (existing.count >= limit.max) {
        return {
          allowed: false,
          remaining: 0,
          resetAt: existing.resetAt,
          retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - nowMs) / 1000)),
        };
      }
      existing.count += 1;
      return { allowed: true, remaining: Math.max(limit.max - existing.count, 0), resetAt: existing.resetAt };
    },
  };
}

function enforceRateLimit(rateLimiter, req, route, context) {
  const client = clientAddress(req);
  const result = rateLimiter.check({
    pathname: route.pathname,
    key: `${context.workspaceId}:${client}`,
  });
  if (!result.allowed) {
    throw new HostedContractError("rate_limited", "Too many hosted API requests", 429, {
      retryAfterSeconds: result.retryAfterSeconds,
      scope: "instance-local",
    });
  }
}

function clientAddress(req) {
  const forwarded = header(req, "x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return header(req, "x-real-ip") || req.socket?.remoteAddress || "unknown";
}

async function readJsonBody(req, maxBytes) {
  if (req.body !== undefined) {
    const bytes = Buffer.byteLength(
      typeof req.body === "string" ? req.body : JSON.stringify(req.body),
      "utf8",
    );
    if (bytes > maxBytes) {
      throw new HostedContractError("payload_too_large", "Hosted request payload is too large", 413, {
        limitBytes: maxBytes,
        receivedBytes: bytes,
      });
    }
    if (typeof req.body === "string") return parseJson(req.body);
    return req.body;
  }

  const length = Number(header(req, "content-length") || 0);
  if (length > maxBytes) {
    throw new HostedContractError("payload_too_large", "Hosted request payload is too large", 413, {
      limitBytes: maxBytes,
      receivedBytes: length,
    });
  }

  const chunks = [];
  let receivedBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    receivedBytes += buffer.byteLength;
    if (receivedBytes > maxBytes) {
      throw new HostedContractError("payload_too_large", "Hosted request payload is too large", 413, {
        limitBytes: maxBytes,
        receivedBytes,
      });
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

function normalizeRoute(url) {
  return new URL(url, "http://localhost");
}

function readWorkspaceId(req, route) {
  const headerWorkspace = header(req, "x-askwell-workspace-id");
  return route.searchParams.get("workspaceId") || headerWorkspace || "default";
}

function header(req, name) {
  const headers = req.headers || {};
  if (typeof headers.get === "function") return headers.get(name);
  const lower = name.toLowerCase();
  return headers[lower] || headers[name] || "";
}

function statusForError(error) {
  if (error instanceof HostedContractError) return error.status || 400;
  return 500;
}

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function sendJson(res, status, payload) {
  const json = JSON.stringify(payload);
  if (typeof res.status === "function" && typeof res.json === "function") {
    return res.status(status).json(payload);
  }
  res.statusCode = status;
  if (typeof res.setHeader === "function") {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
  }
  if (typeof res.end === "function") {
    res.end(json);
  }
  return payload;
}
