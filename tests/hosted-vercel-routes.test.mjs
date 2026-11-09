import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import configRoute from "../api/config.mjs";
import loginRoute from "../api/auth/login.mjs";
import logoutRoute from "../api/auth/logout.mjs";
import sessionRoute from "../api/auth/session.mjs";
import workspaceRoute from "../api/workspace.mjs";
import healthRoute from "../api/ai/health.mjs";
import diagnosticsRoute from "../api/ai/diagnostics.mjs";
import ingestRoute from "../api/ai/ingest.mjs";
import answerRoute from "../api/ai/answer.mjs";
import documentsRoute from "../api/ai/documents/index.mjs";
import deleteDocumentRoute from "../api/ai/documents/[id].mjs";
import { createHostedRoute } from "../src/hosted/vercel-route.mjs";
import { createHostedSession, resetHostedSessionRevocationsForTests } from "../src/hosted/session.mjs";
import {
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
      ...(overrides.embeddingProfile || {}),
    },
    indexingProfile: {
      id: SUPPORTED_INDEXING_PROFILE_WITH_KEY.id,
      compatibilityKey: SUPPORTED_INDEXING_PROFILE_WITH_KEY.compatibilityKey,
    },
    documents: [documentPayload(overrides)],
  };
}

function request({ method = "GET", url = "/api/config", body, headers = {}, query } = {}) {
  return { method, url, body, headers, query };
}

function productionRequest({ method = "GET", url = "/api/config", body, headers = {}, query } = {}) {
  const req = { method, url, body, query };
  Object.defineProperty(req, "headers", {
    value: headers,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return req;
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

async function withHostedEnv(callback) {
  const previous = {
    ASKWELL_HOSTED_MODE: process.env.ASKWELL_HOSTED_MODE,
    ASKWELL_ADMIN_TOKEN: process.env.ASKWELL_ADMIN_TOKEN,
    ASKWELL_SESSION_SECRET: process.env.ASKWELL_SESSION_SECRET,
    ASKWELL_HOSTED_SESSION_TTL_SECONDS: process.env.ASKWELL_HOSTED_SESSION_TTL_SECONDS,
    ASKWELL_HOSTED_LOGIN_RATE_LIMIT: process.env.ASKWELL_HOSTED_LOGIN_RATE_LIMIT,
    ASKWELL_HOSTED_LOGIN_RATE_WINDOW_MS: process.env.ASKWELL_HOSTED_LOGIN_RATE_WINDOW_MS,
    TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL,
    TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN,
  };
  const directory = await mkdtemp(join(tmpdir(), "askwell-vercel-routes-"));
  process.env.ASKWELL_HOSTED_MODE = "1";
  process.env.ASKWELL_ADMIN_TOKEN = adminToken;
  process.env.ASKWELL_SESSION_SECRET = "test-session-secret";
  process.env.TURSO_DATABASE_URL = pathToFileURL(join(directory, "hosted.sqlite3")).href;
  delete process.env.TURSO_AUTH_TOKEN;

  try {
    await callback({ directory });
  } finally {
    restore(previous);
    resetHostedSessionRevocationsForTests();
    await sleep(25);
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (error) {
      if (error?.code !== "EBUSY") throw error;
    }
  }
}

async function loginSession() {
  const result = await call(
    loginRoute,
    request({
      method: "POST",
      url: "/api/auth/login",
      body: { accessCredential: adminToken },
    }),
  );
  assert.equal(result.status, 200);
  const cookie = result.headers["set-cookie"].split(";")[0];
  return {
    cookie,
    csrf: result.body.csrfToken,
    headers: {
      cookie,
      "x-askwell-csrf-token": result.body.csrfToken,
    },
  };
}

function restore(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("vercel deployment config keeps local runtimes out of hosted functions", async () => {
  const vercelConfig = JSON.parse(await readFile("vercel.json", "utf8"));
  const ignored = (await readFile(".vercelignore", "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  assert.equal(vercelConfig.framework, null);
  assert.equal(JSON.stringify(vercelConfig).includes("server.mjs"), false);
  assert.equal(JSON.stringify(vercelConfig).includes("ai-service"), false);

  assert.ok(ignored.includes("server.mjs"));
  assert.ok(ignored.includes("ai-service/"));
  assert.ok(ignored.includes("scripts/"));
  assert.ok(ignored.includes("tests/"));
  assert.ok(ignored.includes("docs/"));

  assert.equal(ignored.includes("api/"), false);
  assert.equal(ignored.includes("src/"), false);
  assert.equal(ignored.includes("index.html"), false);
  assert.equal(ignored.includes("styles.css"), false);
  assert.equal(ignored.includes("askwell-widget.js"), false);
});

test("frontend hosted API URLs have matching Vercel route files", async () => {
  const apiClient = await readFile("src/api.js", "utf8");
  const frontendRoutes = [
    ["./api/config", "api/config.mjs"],
    ["./api/auth/login", "api/auth/login.mjs"],
    ["./api/auth/session", "api/auth/session.mjs"],
    ["./api/auth/logout", "api/auth/logout.mjs"],
    ["./api/workspace", "api/workspace.mjs"],
    ["./api/ai/diagnostics", "api/ai/diagnostics.mjs"],
    ["./api/ai/documents", "api/ai/documents/index.mjs"],
    ["./api/ai/ingest", "api/ai/ingest.mjs"],
    ["./api/ai/answer", "api/ai/answer.mjs"],
    ["./api/ai/documents/", "api/ai/documents/[id].mjs"],
  ];
  const additionalHostedRoutes = ["api/ai/health.mjs"];

  for (const [frontendUrl, routeFile] of frontendRoutes) {
    assert.match(apiClient, new RegExp(frontendUrl.replace(/[./]/g, "\\$&")));
    await access(routeFile);
  }
  for (const routeFile of additionalHostedRoutes) {
    await access(routeFile);
  }
});

test("vercel config route exposes hosted mode without secrets", async () => {
  await withHostedEnv(async () => {
    const result = await call(configRoute, request({ url: "/api/config" }));
    assert.equal(result.status, 200);
    assert.equal(result.body.apiMode, "hosted");
    assert.equal(result.body.deployment.hostedMode, true);
    assert.equal(result.body.deployment.authConfigured, true);
    assert.equal(result.body.deployment.databaseConfigured, true);
    assert.equal(result.body.deployment.sessionSecretConfigured, true);
    assert.equal(result.body.embeddingProfile.modelId, "Xenova/all-MiniLM-L6-v2");
    assert.equal("TURSO_AUTH_TOKEN" in result.body, false);
    assert.equal("ASKWELL_ADMIN_TOKEN" in result.body, false);
    assert.equal(JSON.stringify(result.body).includes(adminToken), false);
  });
});

test("hosted auth routes issue HttpOnly sessions without exposing admin token", async () => {
  await withHostedEnv(async () => {
    const missing = await call(
      loginRoute,
      request({ method: "POST", url: "/api/auth/login", body: {} }),
    );
    assert.equal(missing.status, 401);
    assert.equal(missing.body.code, "missing_admin_auth");

    const invalid = await call(
      loginRoute,
      request({ method: "POST", url: "/api/auth/login", body: { accessCredential: "wrong" } }),
    );
    assert.equal(invalid.status, 403);
    assert.equal(invalid.body.code, "invalid_admin_auth");

    const login = await call(
      loginRoute,
      request({ method: "POST", url: "/api/auth/login", body: { accessCredential: adminToken } }),
    );
    assert.equal(login.status, 200);
    assert.equal(login.body.authenticated, true);
    assert.equal(typeof login.body.csrfToken, "string");
    assert.equal(JSON.stringify(login.body).includes(adminToken), false);
    assert.match(login.headers["set-cookie"], /HttpOnly/);
    assert.match(login.headers["set-cookie"], /Secure/);
    assert.match(login.headers["set-cookie"], /SameSite=Strict/);

    const cookie = login.headers["set-cookie"].split(";")[0];
    const session = await call(
      sessionRoute,
      request({ url: "/api/auth/session", headers: { cookie } }),
    );
    assert.equal(session.status, 200);
    assert.equal(session.body.authenticated, true);
    assert.equal(JSON.stringify(session.body).includes(adminToken), false);

    const logout = await call(
      logoutRoute,
      request({
        method: "POST",
        url: "/api/auth/logout",
        headers: { cookie, "x-askwell-csrf-token": login.body.csrfToken },
        body: {},
      }),
    );
    assert.equal(logout.status, 200);
    assert.match(logout.headers["set-cookie"], /Max-Age=0/);

    const reused = await call(
      sessionRoute,
      request({ url: "/api/auth/session", headers: { cookie } }),
    );
    assert.equal(reused.status, 401);
    assert.equal(reused.body.code, "session_invalidated");
  });
});

test("hosted routes accept the same non-enumerable cookie session confirmed by auth session", async () => {
  await withHostedEnv(async () => {
    const login = await call(
      loginRoute,
      productionRequest({
        method: "POST",
        url: "/api/auth/login",
        body: { accessCredential: adminToken },
      }),
    );
    assert.equal(login.status, 200);
    const cookie = login.headers["set-cookie"].split(";")[0];
    const headers = { cookie, "x-askwell-csrf-token": login.body.csrfToken };

    const session = await call(
      sessionRoute,
      productionRequest({ url: "/api/auth/session", headers }),
    );
    assert.equal(session.status, 200);
    assert.equal(session.body.authenticated, true);

    const workspace = await call(
      workspaceRoute,
      productionRequest({ url: "/api/workspace", headers }),
    );
    assert.equal(workspace.status, 200);
    assert.equal(workspace.body.workspace.version, 1);

    const diagnostics = await call(
      diagnosticsRoute,
      productionRequest({ url: "/api/ai/diagnostics", headers }),
    );
    assert.equal(diagnostics.status, 200);
    assert.equal(diagnostics.body.status, "healthy");
  });
});

test("hosted routes reject missing, expired, invalid-signature, and tampered cookie sessions", async () => {
  await withHostedEnv(async () => {
    const missing = await call(
      workspaceRoute,
      productionRequest({ url: "/api/workspace" }),
    );
    assert.equal(missing.status, 401);
    assert.equal(missing.body.code, "missing_admin_auth");

    process.env.ASKWELL_HOSTED_SESSION_TTL_SECONDS = "1";
    const expired = createHostedSession(process.env, { nowMs: Date.now() - 2_000 }).cookie.split(";")[0];
    delete process.env.ASKWELL_HOSTED_SESSION_TTL_SECONDS;
    const expiredResult = await call(
      workspaceRoute,
      productionRequest({ url: "/api/workspace", headers: { cookie: expired } }),
    );
    assert.equal(expiredResult.status, 401);
    assert.equal(expiredResult.body.code, "session_expired");

    const login = await loginSession();
    const invalidSignature = login.cookie.replace(/\.[^.]+$/, ".invalid-signature");
    const invalidResult = await call(
      workspaceRoute,
      productionRequest({ url: "/api/workspace", headers: { cookie: invalidSignature } }),
    );
    assert.equal(invalidResult.status, 401);
    assert.equal(invalidResult.body.code, "invalid_session");

    const tampered = login.cookie.replace(/.$/, login.cookie.endsWith("a") ? "b" : "a");
    const tamperedResult = await call(
      workspaceRoute,
      productionRequest({ url: "/api/workspace", headers: { cookie: tampered } }),
    );
    assert.equal(tamperedResult.status, 401);
    assert.equal(tamperedResult.body.code, "invalid_session");
  });
});

test("hosted browser assets and auth responses do not expose the admin token", async () => {
  await withHostedEnv(async () => {
    const sessionSecret = process.env.ASKWELL_SESSION_SECRET;
    const assets = await Promise.all([
      readFile("index.html", "utf8"),
      readFile("src/api.js", "utf8"),
      readFile("src/app.js", "utf8"),
      readFile("src/state.js", "utf8"),
      readFile("src/render/install.js", "utf8"),
    ]);
    assert.equal(assets.some((content) => content.includes(adminToken)), false);
    assert.equal(assets.some((content) => content.includes(sessionSecret)), false);

    const config = await call(configRoute, request({ url: "/api/config" }));
    assert.equal(JSON.stringify(config.body).includes(adminToken), false);
    assert.equal(JSON.stringify(config.body).includes(sessionSecret), false);

    const login = await call(
      loginRoute,
      request({ method: "POST", url: "/api/auth/login", body: { accessCredential: adminToken } }),
    );
    assert.equal(login.status, 200);
    assert.equal(JSON.stringify(login.body).includes(adminToken), false);
    assert.equal(JSON.stringify(login.body).includes(sessionSecret), false);

    const session = await call(
      sessionRoute,
      request({ url: "/api/auth/session", headers: { cookie: login.headers["set-cookie"].split(";")[0] } }),
    );
    assert.equal(session.status, 200);
    assert.equal(JSON.stringify(session.body).includes(adminToken), false);
    assert.equal(JSON.stringify(session.body).includes(sessionSecret), false);
  });
});

test("hosted login applies instance-local rate limiting", async () => {
  await withHostedEnv(async () => {
    process.env.ASKWELL_HOSTED_LOGIN_RATE_LIMIT = "1";
    process.env.ASKWELL_HOSTED_LOGIN_RATE_WINDOW_MS = "60000";
    const headers = { "x-forwarded-for": "203.0.113.80" };

    const first = await call(
      loginRoute,
      request({ method: "POST", url: "/api/auth/login", headers, body: { accessCredential: "wrong" } }),
    );
    assert.equal(first.status, 403);

    const limited = await call(
      loginRoute,
      request({ method: "POST", url: "/api/auth/login", headers, body: { accessCredential: adminToken } }),
    );
    assert.equal(limited.status, 429);
    assert.equal(limited.body.code, "rate_limited");
    assert.equal(limited.body.details.scope, "instance-local");
  });
});

test("hosted cookie-authenticated writes reject missing CSRF tokens", async () => {
  await withHostedEnv(async () => {
    const session = await loginSession();
    const withoutCsrf = await call(
      ingestRoute,
      request({
        method: "POST",
        url: "/api/ai/ingest",
        headers: { cookie: session.cookie },
        body: ingestPayload(),
      }),
    );
    assert.equal(withoutCsrf.status, 403);
    assert.equal(withoutCsrf.body.code, "csrf_required");

    const wrongCsrf = await call(
      workspaceRoute,
      request({
        method: "PUT",
        url: "/api/workspace",
        headers: { cookie: session.cookie, "x-askwell-csrf-token": "wrong" },
        body: {
          workspaceId: "default",
          expectedVersion: 1,
          settings: { brand: "Hosted" },
          articles: [],
          conversations: [],
        },
      }),
    );
    assert.equal(wrongCsrf.status, 403);
    assert.equal(wrongCsrf.body.code, "csrf_required");
  });
});

test("vercel route files cover workspace, health, diagnostics, ingest, answer, docs, and deletion", async () => {
  await withHostedEnv(async () => {
    const auth = (await loginSession()).headers;

    assert.equal((await call(healthRoute, request({ url: "/api/ai/health" }))).status, 401);
    assert.equal((await call(healthRoute, request({ url: "/api/ai/health", headers: auth }))).status, 200);
    assert.equal((await call(workspaceRoute, request({ url: "/api/workspace", headers: auth }))).body.workspace.version, 1);

    const saved = await call(
      workspaceRoute,
      request({
        method: "PUT",
        url: "/api/workspace",
        headers: auth,
        body: {
          workspaceId: "default",
          expectedVersion: 1,
          settings: { brand: "Hosted" },
          articles: [],
          conversations: [],
        },
      }),
    );
    assert.equal(saved.status, 200);
    assert.equal(saved.body.workspace.version, 2);

    const stale = await call(
      workspaceRoute,
      request({
        method: "PUT",
        url: "/api/workspace",
        headers: auth,
        body: {
          workspaceId: "default",
          expectedVersion: 1,
          settings: {},
          articles: [],
          conversations: [],
        },
      }),
    );
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "workspace_version_conflict");

    const created = await call(
      ingestRoute,
      request({ method: "POST", url: "/api/ai/ingest", headers: auth, body: ingestPayload() }),
    );
    assert.equal(created.status, 200);
    assert.equal(created.body.documentStatuses[0].status, "created");

    const documents = await call(documentsRoute, request({ url: "/api/ai/documents", headers: auth }));
    assert.equal(documents.status, 200);
    assert.equal(documents.body.documents[0].id, "trial");

    const answer = await call(
      answerRoute,
      request({
        method: "POST",
        url: "/api/ai/answer",
        headers: auth,
        body: {
          workspaceId: "default",
          question: "Do I need a payment card during the trial?",
          queryVector: vector(),
          embeddingProfileId: SUPPORTED_EMBEDDING_PROFILE.id,
        },
      }),
    );
    assert.equal(answer.status, 200);
    assert.equal(answer.body.insufficientContext, false);
    assert.equal(answer.body.citations[0].chunkId, "trial:chunk-0");

    const unanswerable = await call(
      answerRoute,
      request({
        method: "POST",
        url: "/api/ai/answer",
        headers: auth,
        body: {
          workspaceId: "default",
          question: "Does AskWell support SAML single sign on?",
          queryVector: vector(),
          embeddingProfileId: SUPPORTED_EMBEDDING_PROFILE.id,
        },
      }),
    );
    assert.equal(unanswerable.status, 200);
    assert.equal(unanswerable.body.insufficientContext, true);

    const reindexed = await call(
      ingestRoute,
      request({
        method: "POST",
        url: "/api/ai/ingest",
        headers: auth,
        body: ingestPayload({
          text: "A payment card is not required during the trial. The trial lasts 14 days.",
          document: { expectedVersion: 1 },
        }),
      }),
    );
    assert.equal(reindexed.status, 200);
    assert.equal(reindexed.body.documentStatuses[0].status, "updated");

    const diagnostics = await call(diagnosticsRoute, request({ url: "/api/ai/diagnostics", headers: auth }));
    assert.equal(diagnostics.status, 200);
    assert.equal(diagnostics.body.documentCount, 1);
    assert.equal(diagnostics.body.documents[0].id, "trial");

    const deleted = await call(
      deleteDocumentRoute,
      request({
        method: "DELETE",
        url: "/api/ai/documents/trial",
        headers: auth,
        query: { id: "trial" },
      }),
    );
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.deleted, true);
    assert.equal((await call(documentsRoute, request({ url: "/api/ai/documents", headers: auth }))).body.documents.length, 0);

    const logout = await call(
      logoutRoute,
      request({ method: "POST", url: "/api/auth/logout", headers: auth, body: {} }),
    );
    assert.equal(logout.status, 200);
    const rejectedAfterLogout = await call(healthRoute, request({ url: "/api/ai/health", headers: auth }));
    assert.equal(rejectedAfterLogout.status, 401);
    assert.equal(rejectedAfterLogout.body.code, "session_invalidated");
  });
});

test("vercel routes reject wrong methods, unauthorized writes, bad profiles, oversized requests, and missing config", async () => {
  await withHostedEnv(async () => {
    assert.equal(
      (await call(ingestRoute, request({ method: "GET", url: "/api/ai/ingest" }))).status,
      405,
    );

    assert.equal(
      (await call(ingestRoute, request({ method: "POST", url: "/api/ai/ingest", body: ingestPayload() }))).status,
      401,
    );

    assert.equal(
      (await call(documentsRoute, request({ method: "GET", url: "/api/ai/documents" }))).status,
      401,
    );

    assert.equal(
      (await call(documentsRoute, request({
        method: "GET",
        url: "/api/ai/documents",
        headers: { "x-askwell-admin-token": "wrong" },
      }))).status,
      403,
    );

    const auth = (await loginSession()).headers;
    const invalidProfile = await call(
      ingestRoute,
      request({
        method: "POST",
        url: "/api/ai/ingest",
        headers: auth,
        body: ingestPayload({ embeddingProfile: { compatibilityKey: "wrong" } }),
      }),
    );
    assert.equal(invalidProfile.status, 409);
    assert.equal(invalidProfile.body.code, "embedding_profile_mismatch");

    const oversized = await call(
      ingestRoute,
      request({
        method: "POST",
        url: "/api/ai/ingest",
        headers: auth,
        body: { workspaceId: "default", padding: "x".repeat(1024 * 1024 + 1) },
      }),
    );
    assert.equal(oversized.status, 413);
  });

  const previous = {
    ASKWELL_HOSTED_MODE: process.env.ASKWELL_HOSTED_MODE,
    TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL,
  };
  delete process.env.ASKWELL_HOSTED_MODE;
  delete process.env.TURSO_DATABASE_URL;
  try {
    const disabledRoute = createHostedRoute({ hostedPath: "/api/hosted/health", methods: ["GET"] });
    const disabled = await call(disabledRoute, request({ url: "/api/ai/health" }));
    assert.equal(disabled.status, 503);
    assert.equal(disabled.body.code, "hosted_mode_disabled");
  } finally {
    restore(previous);
  }
});
