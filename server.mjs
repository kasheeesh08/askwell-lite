import { createHash, randomUUID } from "node:crypto";
import { createReadStream, openSync, closeSync, fsyncSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const defaultDataDir = resolve(rootDir, "data");
const defaultWorkspacePath = resolve(defaultDataDir, "workspace.json");
const maxBodyBytes = 512 * 1024;
const defaultAiTimeoutMs = 8_000;
const minimumTokenLength = 16;
const publicAssets = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/styles.css", "styles.css"],
  ["/src/app.js", "src/app.js"],
  ["/src/api.js", "src/api.js"],
  ["/src/state.js", "src/state.js"],
  ["/src/retrieval.js", "src/retrieval.js"],
  ["/src/utils/escape.js", "src/utils/escape.js"],
  ["/src/utils/validation.js", "src/utils/validation.js"],
  ["/src/render/overview.js", "src/render/overview.js"],
  ["/src/render/knowledge.js", "src/render/knowledge.js"],
  ["/src/render/inbox.js", "src/render/inbox.js"],
  ["/src/render/agents.js", "src/render/agents.js"],
  ["/src/render/install.js", "src/render/install.js"],
  ["/askwell-widget.js", "askwell-widget.js"],
]);

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

const seedWorkspace = {
  settings: {
    brand: "AskWell",
    accent: "#ef7d62",
    welcome:
      "Hi, I am AskWell. Ask me about trials, billing, setup, or AI upgrades.",
  },
  articles: [
    {
      id: "seed-trial",
      title: "Start a free trial",
      tags: ["billing", "trial"],
      content:
        "New teams get a 14 day trial. A card is not required. Trial workspaces include one admin seat, the support widget, and up to 100 demo conversations.",
    },
    {
      id: "seed-widget",
      title: "Install the chat widget",
      tags: ["setup", "widget"],
      content:
        "Copy the widget script from the Install tab and paste it before the closing body tag on your website. The static starter uses local knowledge base answers.",
    },
    {
      id: "seed-cancel",
      title: "Cancel or downgrade",
      tags: ["billing", "account"],
      content:
        "Open billing settings, choose Cancel plan, and confirm the change. Free workspaces keep their knowledge base and can export conversations anytime.",
    },
    {
      id: "seed-model",
      title: "Connect a real AI model",
      tags: ["ai", "upgrade"],
      content:
        "The free version uses keyword retrieval in the browser. For production, connect an API route to OpenAI, Groq, Gemini, or a local Ollama server and keep keys on the server.",
    },
  ],
  conversations: [
    {
      id: "seed-conversation",
      status: "open",
      question: "Can I run this without paying for an AI API?",
      answer:
        "Yes. The starter answers from your saved knowledge base in the browser. You only need paid services when you want hosted AI, hosted auth, or managed storage.",
      sources: ["Connect a real AI model"],
      createdAt: new Date().toISOString(),
    },
  ],
};

const rateBuckets = new Map();
const writeQueues = new Map();

export class WorkspaceCorruptionError extends Error {
  constructor(path, cause) {
    super(`Workspace data is corrupted at ${path}. Restore from backup or repair the JSON file.`);
    this.name = "WorkspaceCorruptionError";
    this.path = path;
    this.cause = cause;
    this.status = 500;
  }
}

function json(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...securityHeaders(),
    ...extraHeaders,
  });
  res.end(body);
}

function securityHeaders() {
  return {
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "connect-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ].join("; "),
    "x-content-type-options": "nosniff",
    "x-frame-options": "SAMEORIGIN",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
  };
}

function clientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "local";
}

function rateLimit(req, limit = 120, windowMs = 60_000, namespace = "global") {
  const key = `${namespace}:${clientIp(req)}`;
  const now = Date.now();
  const bucket = rateBuckets.get(key) || { count: 0, resetAt: now + windowMs };

  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }

  bucket.count += 1;
  rateBuckets.set(key, bucket);
  return bucket.count <= limit;
}

function isDevelopment() {
  return process.env.NODE_ENV === "development";
}

function configuredAdminToken(options = {}) {
  return String(options.adminToken || process.env.ASKWELL_ADMIN_TOKEN || "");
}

function isAdminAllowed(req, options = {}) {
  const requiredToken = configuredAdminToken(options);
  if (isDevelopment()) return true;
  if (!requiredToken) return false;
  return req.headers["x-askwell-admin-token"] === requiredToken;
}

function requireAdmin(req, res, options = {}) {
  if (isAdminAllowed(req, options)) return true;
  json(res, 401, { error: "Missing or invalid admin token" });
  return false;
}

function adminReadRequired() {
  return !isDevelopment();
}

function parseAllowedHosts(value) {
  return String(value || "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

function allowedHosts(options = {}) {
  const configured = options.allowedHosts || process.env.ASKWELL_ALLOWED_HOSTS;
  const hosts = Array.isArray(configured) ? configured : parseAllowedHosts(configured);
  return hosts.length ? hosts : ["localhost", "127.0.0.1", "::1"];
}

function hostAllowed(req, options = {}) {
  if (isDevelopment()) return true;
  const host = String(req.headers.host || "").split(":")[0].replace(/^\[|\]$/g, "").toLowerCase();
  return allowedHosts(options).includes(host);
}

function sanitizedConfig(options = {}) {
  return {
    environment: process.env.NODE_ENV || "production",
    authRequired: !isDevelopment(),
    adminTokenConfigured: Boolean(configuredAdminToken(options)),
    aiServiceConfigured: Boolean(aiServiceBaseUrl(options)),
    aiServiceTokenConfigured: Boolean(options.aiServiceToken || process.env.ASKWELL_AI_SERVICE_TOKEN),
    allowedHosts: allowedHosts(options),
    maxBodyBytes,
    workspaceStorage: "json",
  };
}

export function validateProductionConfig(env = process.env) {
  if (env.NODE_ENV === "development") return [];
  const errors = [];
  const adminToken = String(env.ASKWELL_ADMIN_TOKEN || "");
  if (adminToken.length < minimumTokenLength || ["change-me", "changeme", "password"].includes(adminToken.toLowerCase())) {
    errors.push(`ASKWELL_ADMIN_TOKEN must be at least ${minimumTokenLength} characters and not a placeholder outside development mode.`);
  }
  if (env.ASKWELL_REQUIRE_AI_SERVICE === "1" && !env.ASKWELL_AI_SERVICE_URL) {
    errors.push("ASKWELL_AI_SERVICE_URL is required when ASKWELL_REQUIRE_AI_SERVICE=1.");
  }
  return errors;
}

async function readBody(req) {
  let size = 0;
  const chunks = [];

  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      const error = new Error("Payload too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonBody(req) {
  try {
    const raw = await readBody(req);
    return raw ? JSON.parse(raw) : {};
  } catch (error) {
    if (error.status) throw error;
    const malformed = new Error("Malformed JSON request body");
    malformed.status = 400;
    throw malformed;
  }
}

function cleanText(value, fallback = "") {
  return String(value ?? fallback).trim().slice(0, 4000);
}

function cleanColor(value) {
  const color = String(value || "#ef7d62").trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : "#ef7d62";
}

function cleanTags(value) {
  return Array.isArray(value)
    ? value.map((tag) => cleanText(tag).toLowerCase()).filter(Boolean).slice(0, 12)
    : [];
}

function cleanDocumentId(value) {
  const id = cleanText(value).slice(0, 120);
  return /^[a-zA-Z0-9._:-]+$/.test(id) ? id : "";
}

export function sanitizeWorkspace(input = {}) {
  const settings = input.settings || {};
  const articles = Array.isArray(input.articles) ? input.articles : [];
  const conversations = Array.isArray(input.conversations) ? input.conversations : [];

  const version = Number.isInteger(input.version) && input.version >= 1 ? input.version : 1;

  return {
    version,
    settings: {
      brand: cleanText(settings.brand, "AskWell").slice(0, 80) || "AskWell",
      accent: cleanColor(settings.accent),
      welcome:
        cleanText(settings.welcome, seedWorkspace.settings.welcome).slice(0, 280) ||
        seedWorkspace.settings.welcome,
    },
    articles: articles
      .map((article) => ({
        id: cleanText(article.id, randomUUID()).slice(0, 120) || randomUUID(),
        title: cleanText(article.title).slice(0, 160),
        tags: cleanTags(article.tags),
        content: cleanText(article.content).slice(0, 4000),
      }))
      .filter((article) => article.title && article.content)
      .slice(0, 200),
    conversations: conversations
      .map((conversation) => ({
        id: cleanText(conversation.id, randomUUID()).slice(0, 120) || randomUUID(),
        status: conversation.status === "resolved" ? "resolved" : "open",
        question: cleanText(conversation.question).slice(0, 600),
        answer: cleanText(conversation.answer).slice(0, 4000),
        sources: Array.isArray(conversation.sources)
          ? conversation.sources.map((source) => cleanText(source).slice(0, 160)).filter(Boolean).slice(0, 8)
          : [],
        createdAt: cleanText(conversation.createdAt, new Date().toISOString()).slice(0, 80),
      }))
      .filter((conversation) => conversation.question && conversation.answer)
      .slice(0, 500),
  };
}

function storagePaths(options = {}) {
  const workspacePath = resolve(options.workspacePath || defaultWorkspacePath);
  return {
    dataDir: dirname(workspacePath),
    workspacePath,
  };
}

async function readWorkspaceFile(workspacePath) {
  try {
    const raw = await readFile(workspacePath, "utf8");
    return sanitizeWorkspace(JSON.parse(raw));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new WorkspaceCorruptionError(workspacePath, error);
  }
}

async function fsyncDirectory(directoryPath) {
  try {
    const fd = openSync(directoryPath, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Directory fsync is best-effort and unsupported on some platforms.
  }
}

export async function atomicWriteJson(filePath, payload, options = {}) {
  const directoryPath = dirname(filePath);
  await mkdir(directoryPath, { recursive: true });
  const tempPath = resolve(
    directoryPath,
    `.${Date.now()}-${process.pid}-${randomUUID()}.tmp`,
  );
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  let handle;

  try {
    handle = await open(tempPath, "wx");
    if (options.failAfterOpen) {
      throw new Error("Injected atomic write failure");
    }
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    if (options.failBeforeRename) {
      throw new Error("Injected atomic rename failure");
    }
    await rename(tempPath, filePath);
    await fsyncDirectory(directoryPath);
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function ensureWorkspace(options = {}) {
  const { dataDir, workspacePath } = storagePaths(options);
  await mkdir(dataDir, { recursive: true });
  const existing = await readWorkspaceFile(workspacePath);
  if (existing) return existing;

  const workspace = sanitizeWorkspace({ ...seedWorkspace, version: 1 });
  await atomicWriteJson(workspacePath, workspace, options.writeOptions);
  return workspace;
}

export async function writeWorkspace(workspace, options = {}) {
  const { dataDir, workspacePath } = storagePaths(options);
  const queueKey = workspacePath;
  const previous = writeQueues.get(queueKey) || Promise.resolve();

  const next = previous.then(async () => {
    await mkdir(dataDir, { recursive: true });
    const current = await ensureWorkspace(options);
    const expectedVersion = Number(workspace.expectedVersion);

    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      const error = new Error("expectedVersion is required");
      error.status = 400;
      throw error;
    }

    if (expectedVersion !== current.version) {
      const error = new Error("Workspace version conflict");
      error.status = 409;
      error.latestVersion = current.version;
      error.workspace = current;
      throw error;
    }

    const sanitized = sanitizeWorkspace({
      ...workspace,
      version: current.version + 1,
    });
    await atomicWriteJson(workspacePath, sanitized, options.writeOptions);
    return sanitized;
  });

  const tracked = next.catch(() => {}).finally(() => {
    if (writeQueues.get(queueKey) === tracked) {
      writeQueues.delete(queueKey);
    }
  });
  writeQueues.set(queueKey, tracked);

  return next;
}

async function handleApi(req, res, pathname, options = {}) {
  if (!rateLimit(req)) {
    json(res, 429, { error: "Rate limit exceeded" });
    return;
  }

  if (pathname === "/api/ai/answer" && !rateLimit(req, 30, 60_000, "ai-answer")) {
    json(res, 429, { error: "AI answer rate limit exceeded" });
    return;
  }

  if (pathname === "/api/ai/ingest" && !rateLimit(req, 12, 60_000, "ai-ingest")) {
    json(res, 429, { error: "AI ingest rate limit exceeded" });
    return;
  }

  if (pathname === "/api/health") {
    json(res, 200, {
      ok: true,
      uptime: Math.round(process.uptime()),
      storage: "data/workspace.json",
    });
    return;
  }

  if (pathname === "/api/config" && req.method === "GET") {
    json(res, 200, sanitizedConfig(options));
    return;
  }

  if (pathname === "/api/ai/health" && req.method === "GET") {
    try {
      const payload = await callAiService("/health", { method: "GET" }, options);
      json(res, 200, { available: true, ...payload });
    } catch (error) {
      json(res, error.status || 503, {
        available: false,
        error: error.message || "AI service unavailable",
      });
    }
    return;
  }

  if (pathname === "/api/ai/ingest" && req.method === "POST") {
    if (!requireAdmin(req, res, options)) return;

    let parsed;
    try {
      parsed = await readJsonBody(req);
    } catch (error) {
      json(res, error.status || 400, { error: error.message });
      return;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      json(res, 400, { error: "Invalid AI ingest request body" });
      return;
    }

    if (
      !Array.isArray(parsed.articles) &&
      !Array.isArray(parsed.documents) &&
      !Array.isArray(parsed.encoded_documents)
    ) {
      const workspace = await ensureWorkspace(options);
      parsed = { articles: workspace.articles };
    }

    try {
      const payload = await callAiService(
        "/ingest",
        {
          method: "POST",
          body: parsed,
        },
        options,
      );
      json(res, 200, payload);
    } catch (error) {
      json(res, error.status || 503, {
        error: error.message || "AI service unavailable",
      });
    }
    return;
  }

  if (pathname === "/api/ai/documents" && req.method === "GET") {
    if (adminReadRequired() && !requireAdmin(req, res, options)) return;
    try {
      const payload = await callAiService("/documents", { method: "GET" }, options);
      json(res, 200, payload);
    } catch (error) {
      json(res, error.status || 503, {
        error: error.message || "AI service unavailable",
      });
    }
    return;
  }

  if (pathname === "/api/ai/diagnostics" && req.method === "GET") {
    if (adminReadRequired() && !requireAdmin(req, res, options)) return;
    try {
      const payload = await callAiService("/diagnostics", { method: "GET" }, options);
      json(res, 200, payload);
    } catch (error) {
      json(res, error.status || 503, {
        error: error.message || "AI service unavailable",
      });
    }
    return;
  }

  if (pathname.startsWith("/api/ai/documents/") && req.method === "DELETE") {
    if (!requireAdmin(req, res, options)) return;

    const documentId = cleanDocumentId(decodeURIComponent(pathname.slice("/api/ai/documents/".length)));
    if (!documentId) {
      json(res, 400, { error: "Invalid document id" });
      return;
    }

    try {
      const payload = await callAiService(`/documents/${encodeURIComponent(documentId)}`, { method: "DELETE" }, options);
      json(res, 200, payload);
    } catch (error) {
      json(res, error.status || 503, {
        error: error.message || "AI service unavailable",
      });
    }
    return;
  }

  if (pathname === "/api/ai/answer" && req.method === "POST") {
    let parsed;
    try {
      parsed = await readJsonBody(req);
    } catch (error) {
      json(res, error.status || 400, { error: error.message });
      return;
    }

    const question = cleanText(parsed?.question).slice(0, 800);
    const topK = Number(parsed?.topK || parsed?.top_k || 5);
    if (!question) {
      json(res, 400, { error: "question is required" });
      return;
    }

    try {
      const payload = await callAiService(
        "/answer",
        {
          method: "POST",
          body: {
            question,
            top_k: Number.isInteger(topK) && topK >= 1 && topK <= 12 ? topK : 5,
          },
        },
        options,
      );
      json(res, 200, payload);
    } catch (error) {
      json(res, error.status || 503, {
        error: error.message || "AI service unavailable",
      });
    }
    return;
  }

  if (pathname === "/api/workspace" && req.method === "GET") {
    if (adminReadRequired() && !requireAdmin(req, res, options)) return;
    const workspace = await ensureWorkspace(options);
    json(res, 200, workspace, {
      etag: `"${createHash("sha256").update(JSON.stringify(workspace)).digest("hex")}"`,
      "x-workspace-version": String(workspace.version),
    });
    return;
  }

  if (pathname === "/api/workspace" && req.method === "PUT") {
    if (!requireAdmin(req, res, options)) return;

    let parsed;
    try {
      parsed = await readJsonBody(req);
    } catch (error) {
      json(res, error.status || 400, {
        error: error.status ? error.message : "Malformed JSON request body",
      });
      return;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      json(res, 400, { error: "Invalid workspace request body" });
      return;
    }

    try {
      const saved = await writeWorkspace(parsed, options);
      json(res, 200, saved, {
        "x-workspace-version": String(saved.version),
      });
    } catch (error) {
      if (error.status === 409) {
        json(res, 409, {
          error: error.message,
          latestVersion: error.latestVersion,
          workspace: error.workspace,
        });
        return;
      }

      if (error.status === 400) {
        json(res, 400, { error: error.message });
        return;
      }

      throw error;
    }
    return;
  }

  if (pathname === "/api/export" && req.method === "GET") {
    if (adminReadRequired() && !requireAdmin(req, res, options)) return;
    const workspace = await ensureWorkspace(options);
    json(res, 200, {
      exportedAt: new Date().toISOString(),
      ...workspace,
    });
    return;
  }

  json(res, 404, { error: "Not found" });
}

function aiServiceBaseUrl(options = {}) {
  return String(options.aiServiceUrl || process.env.ASKWELL_AI_SERVICE_URL || "").replace(/\/+$/, "");
}

async function callAiService(pathname, requestOptions = {}, options = {}) {
  const baseUrl = aiServiceBaseUrl(options);
  if (!baseUrl) {
    const error = new Error("AI service is not configured");
    error.status = 503;
    throw error;
  }

  const timeoutMs = Number(options.aiTimeoutMs || process.env.ASKWELL_AI_TIMEOUT_MS || defaultAiTimeoutMs);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const aiFetch = options.aiFetch || fetch;

  try {
    const response = await aiFetch(`${baseUrl}${pathname}`, {
      method: requestOptions.method || "GET",
      headers: {
        accept: "application/json",
        ...(requestOptions.body ? { "content-type": "application/json" } : {}),
        ...((options.aiServiceToken || process.env.ASKWELL_AI_SERVICE_TOKEN)
          ? { "x-askwell-ai-token": String(options.aiServiceToken || process.env.ASKWELL_AI_SERVICE_TOKEN) }
          : {}),
      },
      body: requestOptions.body ? JSON.stringify(requestOptions.body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};

    if (!response.ok) {
      const error = new Error(payload.detail || payload.error || `AI service failed (${response.status})`);
      error.status = response.status;
      throw error;
    }

    return payload;
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("AI service timed out");
      timeoutError.status = 504;
      throw timeoutError;
    }
    if (error.status) throw error;
    const unavailable = new Error("AI service unavailable");
    unavailable.status = 503;
    throw unavailable;
  } finally {
    clearTimeout(timeout);
  }
}

function safeStaticPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  if (decoded.includes("\\") || decoded.split("/").includes("..")) {
    return null;
  }

  const asset = publicAssets.get(decoded);
  if (!asset) return null;
  return resolve(rootDir, asset);
}

async function serveStatic(req, res, pathname) {
  const filePath = safeStaticPath(pathname);
  if (!filePath) {
    res.writeHead(403, securityHeaders());
    res.end("Forbidden");
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("Not a file");

    res.writeHead(200, {
      "content-type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "cache-control": extname(filePath) === ".html" ? "no-store" : "public, max-age=60",
      ...securityHeaders(),
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, securityHeaders());
    res.end("Not found");
  }
}

export function createServer(options = {}) {
  return createHttpServer(async (req, res) => {
    try {
      if (!hostAllowed(req, options)) {
        json(res, 421, { error: "Host is not allowed" });
        return;
      }

      const url = new URL(req.url || "/", "http://localhost");

      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url.pathname, options);
        return;
      }

      if (!["GET", "HEAD"].includes(req.method || "GET")) {
        res.writeHead(405, securityHeaders());
        res.end("Method not allowed");
        return;
      }

      await serveStatic(req, res, url.pathname);
    } catch (error) {
      json(res, error.status || 500, {
        error: error.status ? error.message : "Internal server error",
      });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const configErrors = validateProductionConfig();
  if (configErrors.length) {
    console.error(`Refusing to start: ${configErrors.join(" ")}`);
    process.exit(1);
  }

  const port = Number(process.env.PORT || 4173);
  const server = createServer().listen(port, () => {
    console.log(`AskWell listening on http://127.0.0.1:${port}`);
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
