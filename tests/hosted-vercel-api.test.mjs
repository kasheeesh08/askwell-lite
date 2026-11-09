import assert from "node:assert/strict";
import test from "node:test";

import { createHostedVercelHandler } from "../src/hosted/vercel-api.mjs";
import {
  createHostedSession,
  resetHostedSessionRevocationsForTests,
} from "../src/hosted/session.mjs";
import {
  createMemoryHostedStore,
  HOSTED_LIMITS,
  SUPPORTED_EMBEDDING_PROFILE,
  SUPPORTED_INDEXING_PROFILE_WITH_KEY,
  sha256,
} from "../src/hosted/storage-contract.mjs";

const adminToken = "test-admin-token";

function vector(first = 1, second = 0) {
  const values = Array.from({ length: SUPPORTED_EMBEDDING_PROFILE.dimension }, () => 0);
  values[0] = first;
  values[1] = second;
  const norm = Math.sqrt(first * first + second * second);
  return values.map((value) => value / norm);
}

function documentPayload(overrides = {}) {
  const text = overrides.text || "A payment card is not required during the trial.";
  const id = overrides.id || "trial";
  return {
    id,
    title: overrides.title || "Trial",
    sourceType: "article",
    contentHash: sha256(text),
    metadata: {},
    chunks: [
      {
        id: `${id}:chunk-0`,
        position: 0,
        text,
        hash: sha256(text),
        metadata: {},
      },
    ],
    vectors: [overrides.vector || vector()],
    ...overrides.document,
  };
}

function ingestPayload(overrides = {}) {
  return {
    workspaceId: overrides.workspaceId || "default",
    embeddingProfile: {
      id: SUPPORTED_EMBEDDING_PROFILE.id,
      compatibilityKey: SUPPORTED_EMBEDDING_PROFILE.compatibilityKey,
    },
    indexingProfile: {
      id: SUPPORTED_INDEXING_PROFILE_WITH_KEY.id,
      compatibilityKey: SUPPORTED_INDEXING_PROFILE_WITH_KEY.compatibilityKey,
    },
    documents: [documentPayload(overrides)],
  };
}

function request({ method = "GET", url = "/api/hosted/health", body, headers = {} } = {}) {
  return {
    method,
    url,
    body,
    headers,
  };
}

function response() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(value) {
      this.body = value;
    },
    json() {
      return JSON.parse(this.body || "{}");
    },
  };
}

async function call(handler, req) {
  const res = response();
  await handler(req, res);
  return { status: res.statusCode, body: res.json(), headers: res.headers };
}

function makeRetrievalAdapter() {
  const store = createMemoryHostedStore();
  return {
    ...store,
    diagnostics(workspaceId = "default") {
      const snapshot = store.getRetrievalSnapshot(workspaceId);
      return {
        backend: "memory-hosted",
        schemaVersion: 0,
        integrityCheck: "ok",
        documentCount: store.listDocuments(workspaceId).length,
        chunkCount: snapshot.chunks.length,
        embeddingCount: snapshot.embeddings.length,
      };
    },
    getChunkIndex(workspaceId) {
      return store.getRetrievalSnapshot(workspaceId).chunks;
    },
  };
}

function sessionHeaders(env = { ASKWELL_ADMIN_TOKEN: adminToken, ASKWELL_SESSION_SECRET: "test-secret" }) {
  const session = createHostedSession(env);
  return {
    cookie: session.cookie.split(";")[0],
    "x-askwell-csrf-token": session.csrfToken,
  };
}

test.afterEach(() => {
  resetHostedSessionRevocationsForTests();
});

test("vercel handler fails safely when hosted database config is missing", async () => {
  const handler = createHostedVercelHandler({ env: { ASKWELL_ADMIN_TOKEN: adminToken } });
  const result = await call(
    handler,
    request({
      method: "GET",
      url: "/api/hosted/health",
      headers: { "x-askwell-admin-token": adminToken },
    }),
  );
  assert.equal(result.status, 500);
  assert.equal(result.body.code, "missing_turso_database_url");
});

test("vercel handler requires admin auth for private hosted reads and writes", async () => {
  const store = createMemoryHostedStore();
  const handler = createHostedVercelHandler({
    env: { ASKWELL_ADMIN_TOKEN: adminToken },
    adapterFactory: () => store,
  });

  const read = await call(handler, request({ method: "GET", url: "/api/hosted/documents" }));
  assert.equal(read.status, 401);
  assert.equal(read.body.code, "missing_admin_auth");

  const badRead = await call(
    handler,
    request({
      method: "GET",
      url: "/api/hosted/documents",
      headers: { "x-askwell-admin-token": "wrong" },
    }),
  );
  assert.equal(badRead.status, 403);
  assert.equal(badRead.body.code, "invalid_admin_auth");

  const validRead = await call(
    handler,
    request({
      method: "GET",
      url: "/api/hosted/documents",
      headers: { "x-askwell-admin-token": adminToken },
    }),
  );
  assert.equal(validRead.status, 200);
  assert.deepEqual(validRead.body.documents, []);

  const missing = await call(
    handler,
    request({ method: "POST", url: "/api/hosted/ingest", body: ingestPayload() }),
  );
  assert.equal(missing.status, 401);
  assert.equal(missing.body.code, "missing_admin_auth");

  const wrong = await call(
    handler,
    request({
      method: "POST",
      url: "/api/hosted/ingest",
      body: ingestPayload(),
      headers: { "x-askwell-admin-token": "wrong" },
    }),
  );
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.code, "invalid_admin_auth");
});

test("vercel handler read-only checks do not create synthetic documents", async () => {
  const adapter = makeRetrievalAdapter();
  const handler = createHostedVercelHandler({
    env: { ASKWELL_ADMIN_TOKEN: adminToken },
    adapterFactory: () => adapter,
  });
  const headers = { "x-askwell-admin-token": adminToken };

  assert.deepEqual(adapter.listDocuments("default"), []);
  for (const url of [
    "/api/hosted/health",
    "/api/hosted/diagnostics",
    "/api/hosted/workspace",
    "/api/hosted/documents",
  ]) {
    const result = await call(handler, request({ method: "GET", url, headers }));
    assert.equal(result.status, 200);
    assert.deepEqual(adapter.listDocuments("default"), [], `${url} must stay read-only`);
  }

  const created = await call(
    handler,
    request({ method: "POST", url: "/api/hosted/ingest", body: ingestPayload({ id: "synthetic-validation" }), headers }),
  );
  assert.equal(created.status, 200);
  assert.equal(adapter.listDocuments("default").length, 1);
  assert.equal(adapter.listDocuments("default")[0].id, "synthetic-validation");
});

test("vercel handler accepts hosted sessions and rejects missing CSRF on writes", async () => {
  const store = createMemoryHostedStore();
  const env = { ASKWELL_ADMIN_TOKEN: adminToken, ASKWELL_SESSION_SECRET: "test-secret" };
  const handler = createHostedVercelHandler({
    env,
    adapterFactory: () => store,
  });
  const headers = sessionHeaders(env);

  const read = await call(
    handler,
    request({ method: "GET", url: "/api/hosted/documents", headers: { cookie: headers.cookie } }),
  );
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.documents, []);

  const missingCsrf = await call(
    handler,
    request({
      method: "POST",
      url: "/api/hosted/ingest",
      body: ingestPayload(),
      headers: { cookie: headers.cookie },
    }),
  );
  assert.equal(missingCsrf.status, 403);
  assert.equal(missingCsrf.body.code, "csrf_required");

  const created = await call(
    handler,
    request({ method: "POST", url: "/api/hosted/ingest", body: ingestPayload(), headers }),
  );
  assert.equal(created.status, 200);
  assert.equal(created.body.documentStatuses[0].status, "created");
});

test("vercel handler rejects cookie writes from the wrong origin", async () => {
  const store = createMemoryHostedStore();
  const env = { ASKWELL_ADMIN_TOKEN: adminToken, ASKWELL_SESSION_SECRET: "test-secret" };
  const handler = createHostedVercelHandler({
    env,
    adapterFactory: () => store,
  });
  const headers = {
    ...sessionHeaders(env),
    host: "askwell.example",
    "x-forwarded-proto": "https",
    origin: "https://evil.example",
  };

  const result = await call(
    handler,
    request({ method: "POST", url: "/api/hosted/ingest", body: ingestPayload(), headers }),
  );
  assert.equal(result.status, 403);
  assert.equal(result.body.code, "csrf_origin_mismatch");
});

test("vercel handler honors shared session revocation state", async () => {
  const env = { ASKWELL_ADMIN_TOKEN: adminToken, ASKWELL_SESSION_SECRET: "test-secret" };
  const session = createHostedSession(env);
  const revoked = new Set([session.sessionId]);
  const adapter = {
    ...createMemoryHostedStore(),
    async isSessionRevoked(sessionId) {
      return revoked.has(sessionId);
    },
  };
  const handler = createHostedVercelHandler({
    env,
    adapterFactory: () => adapter,
  });

  const result = await call(
    handler,
    request({
      method: "GET",
      url: "/api/hosted/documents",
      headers: { cookie: session.cookie.split(";")[0] },
    }),
  );
  assert.equal(result.status, 401);
  assert.equal(result.body.code, "session_invalidated");
});

test("vercel handler rejects expired and tampered hosted sessions", async () => {
  const store = createMemoryHostedStore();
  const env = {
    ASKWELL_ADMIN_TOKEN: adminToken,
    ASKWELL_SESSION_SECRET: "test-secret",
    ASKWELL_HOSTED_SESSION_TTL_SECONDS: "1",
  };
  const handler = createHostedVercelHandler({
    env,
    adapterFactory: () => store,
  });
  const expired = createHostedSession(env, { nowMs: Date.now() - 2_000 }).cookie.split(";")[0];
  const expiredResult = await call(
    handler,
    request({ method: "GET", url: "/api/hosted/documents", headers: { cookie: expired } }),
  );
  assert.equal(expiredResult.status, 401);
  assert.equal(expiredResult.body.code, "session_expired");

  const tampered = sessionHeaders(env).cookie.replace(/.$/, "x");
  const tamperedResult = await call(
    handler,
    request({ method: "GET", url: "/api/hosted/documents", headers: { cookie: tampered } }),
  );
  assert.equal(tamperedResult.status, 401);
  assert.equal(tamperedResult.body.code, "invalid_session");
});

test("vercel handler applies instance-local rate limits to expensive hosted operations", async () => {
  const adapter = makeRetrievalAdapter();
  adapter.ingest(ingestPayload(), { workspaceId: "default" });
  const handler = createHostedVercelHandler({
    env: { ASKWELL_ADMIN_TOKEN: adminToken },
    adapterFactory: () => adapter,
    rateLimits: { answerMax: 1, answerWindowMs: 60_000 },
  });
  const headers = { "x-askwell-admin-token": adminToken, "x-forwarded-for": "203.0.113.10" };
  const body = {
    workspaceId: "default",
    question: "Do I need a payment card during the trial?",
    queryVector: vector(),
    embeddingProfileId: SUPPORTED_EMBEDDING_PROFILE.id,
  };

  const first = await call(handler, request({ method: "POST", url: "/api/hosted/answer", headers, body }));
  assert.equal(first.status, 200);

  const limited = await call(handler, request({ method: "POST", url: "/api/hosted/answer", headers, body }));
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, "rate_limited");
  assert.equal(limited.body.details.scope, "instance-local");
});

test("vercel handler handles duplicate ingest, invalid vectors, and oversized bodies", async () => {
  const store = createMemoryHostedStore();
  const handler = createHostedVercelHandler({
    env: { ASKWELL_ADMIN_TOKEN: adminToken },
    adapterFactory: () => store,
    limits: { ...HOSTED_LIMITS, maxPayloadBytes: 5000 },
  });
  const headers = { "x-askwell-admin-token": adminToken };

  const created = await call(
    handler,
    request({ method: "POST", url: "/api/hosted/ingest", body: ingestPayload(), headers }),
  );
  assert.equal(created.status, 200);
  assert.equal(created.body.documentStatuses[0].status, "created");

  const unchanged = await call(
    handler,
    request({ method: "POST", url: "/api/hosted/ingest", body: ingestPayload(), headers }),
  );
  assert.equal(unchanged.status, 200);
  assert.equal(unchanged.body.documentStatuses[0].status, "unchanged");

  const invalid = await call(
    handler,
    request({
      method: "POST",
      url: "/api/hosted/ingest",
      body: ingestPayload({ id: "broken", vector: vector().slice(1) }),
      headers,
    }),
  );
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, "invalid_vector_dimension");

  const oversized = await call(
    handler,
    request({
      method: "POST",
      url: "/api/hosted/ingest",
      body: { workspaceId: "default", payload: "x".repeat(6000) },
      headers,
    }),
  );
  assert.equal(oversized.status, 413);
  assert.equal(oversized.body.code, "payload_too_large");
});

test("vercel handler preserves workspace isolation and optimistic workspace writes", async () => {
  const store = createMemoryHostedStore({
    workspaces: [
      { id: "default", version: 1 },
      { id: "support", version: 1 },
    ],
  });
  const handler = createHostedVercelHandler({
    env: { ASKWELL_ADMIN_TOKEN: adminToken },
    adapterFactory: () => store,
  });
  const headers = { "x-askwell-admin-token": adminToken };

  const saved = await call(
    handler,
    request({
      method: "PUT",
      url: "/api/hosted/workspace?workspaceId=default",
      body: {
        workspaceId: "default",
        expectedVersion: 1,
        settings: { brand: "AskWell" },
        articles: [],
        conversations: [],
      },
      headers,
    }),
  );
  assert.equal(saved.status, 200);
  assert.equal(saved.body.workspace.version, 2);

  const stale = await call(
    handler,
    request({
      method: "PUT",
      url: "/api/hosted/workspace?workspaceId=default",
      body: {
        workspaceId: "default",
        expectedVersion: 1,
        settings: {},
        articles: [],
        conversations: [],
      },
      headers,
    }),
  );
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "workspace_version_conflict");

  const isolated = await call(
    handler,
    request({
      method: "POST",
      url: "/api/hosted/ingest?workspaceId=default",
      body: { ...ingestPayload({ workspaceId: "support" }), workspaceId: "support" },
      headers,
    }),
  );
  assert.equal(isolated.status, 403);
  assert.equal(isolated.body.code, "workspace_context_mismatch");
});

test("vercel answer route uses stored evidence, citations, and abstention", async () => {
  const adapter = makeRetrievalAdapter();
  adapter.ingest(ingestPayload(), { workspaceId: "default" });
  const handler = createHostedVercelHandler({
    env: { ASKWELL_ADMIN_TOKEN: adminToken },
    adapterFactory: () => adapter,
  });

  const answerable = await call(
    handler,
    request({
      method: "POST",
      url: "/api/hosted/answer",
      body: {
        workspaceId: "default",
        question: "Do I need a payment card during the trial?",
        queryVector: vector(),
        embeddingProfileId: SUPPORTED_EMBEDDING_PROFILE.id,
      },
      headers: { "x-askwell-admin-token": adminToken },
    }),
  );
  assert.equal(answerable.status, 200);
  assert.equal(answerable.body.insufficientContext, false);
  assert.equal(answerable.body.citations[0].chunkId, "trial:chunk-0");

  const missing = await call(
    handler,
    request({
      method: "POST",
      url: "/api/hosted/answer",
      body: {
        workspaceId: "default",
        question: "Does AskWell support SAML single sign on?",
        queryVector: vector(),
        embeddingProfileId: SUPPORTED_EMBEDDING_PROFILE.id,
      },
      headers: { "x-askwell-admin-token": adminToken },
    }),
  );
  assert.equal(missing.status, 200);
  assert.equal(missing.body.insufficientContext, true);
  assert.ok(["missing_required_evidence", "insufficient_retrieval_evidence"].includes(missing.body.fallbackReason));
});

test("vercel answer route rejects missing and invalid admin tokens", async () => {
  const adapter = makeRetrievalAdapter();
  adapter.ingest(ingestPayload(), { workspaceId: "default" });
  const handler = createHostedVercelHandler({
    env: { ASKWELL_ADMIN_TOKEN: adminToken },
    adapterFactory: () => adapter,
  });
  const body = {
    workspaceId: "default",
    question: "Do I need a payment card during the trial?",
    queryVector: vector(),
    embeddingProfileId: SUPPORTED_EMBEDDING_PROFILE.id,
  };

  const missing = await call(handler, request({ method: "POST", url: "/api/hosted/answer", body }));
  assert.equal(missing.status, 401);
  assert.equal(missing.body.code, "missing_admin_auth");

  const invalid = await call(
    handler,
    request({
      method: "POST",
      url: "/api/hosted/answer",
      body,
      headers: { authorization: "Bearer wrong" },
    }),
  );
  assert.equal(invalid.status, 403);
  assert.equal(invalid.body.code, "invalid_admin_auth");
});

test("vercel handler models cold starts, adapter errors, timeouts, and malformed JSON", async () => {
  let factories = 0;
  const first = createHostedVercelHandler({
    env: { ASKWELL_ADMIN_TOKEN: adminToken },
    adapterFactory: () => {
      factories += 1;
      return makeRetrievalAdapter();
    },
  });
  const second = createHostedVercelHandler({
    env: { ASKWELL_ADMIN_TOKEN: adminToken },
    adapterFactory: () => {
      factories += 1;
      return makeRetrievalAdapter();
    },
  });
  const headers = { "x-askwell-admin-token": adminToken };
  assert.equal((await call(first, request({ url: "/api/hosted/health", headers }))).status, 200);
  assert.equal((await call(second, request({ url: "/api/hosted/health", headers }))).status, 200);
  assert.equal(factories, 2);

  const failing = createHostedVercelHandler({
    env: { ASKWELL_ADMIN_TOKEN: adminToken },
    adapterFactory: () => {
      throw new Error("connection refused");
    },
  });
  assert.equal((await call(failing, request({ url: "/api/hosted/health", headers }))).status, 500);

  const timeout = createHostedVercelHandler({
    env: { ASKWELL_ADMIN_TOKEN: adminToken },
    adapterFactory: () => ({
      diagnostics() {
        return Promise.reject(new Error("timeout"));
      },
    }),
  });
  assert.equal((await call(timeout, request({ url: "/api/hosted/health", headers }))).status, 500);

  const malformed = await call(
    first,
    request({
      method: "POST",
      url: "/api/hosted/ingest",
      body: "{not-json",
      headers: { "x-askwell-admin-token": adminToken },
    }),
  );
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.code, "malformed_json");
});
