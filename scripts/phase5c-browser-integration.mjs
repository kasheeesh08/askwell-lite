import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { createMemoryHostedStore } from "../src/hosted/storage-contract.mjs";
import { answerFromRetrieval, retrieveWithPrefilter } from "../src/hosted/retrieval.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ACCESS_CREDENTIAL = "phase5c-access";
const CSRF_TOKEN = "phase5c-csrf";
const SESSION_COOKIE = "askwell_phase5c_session";
const WORKSPACE_ID = "default";
const USE_REAL_BROWSER_MODEL = process.env.ASKWELL_PHASE5C_REAL_BROWSER_MODEL === "1";

async function main() {
  const browserPath = await findBrowser();
  const userDataDir = await mkdtemp(join(tmpdir(), "askwell-phase5c-browser-"));
  const harness = createHarnessServer();
  let browser;
  let client;
  let result;
  let cleanupWarning = "";
  try {
    const baseUrl = await listen(harness.server);
    browser = await launchBrowser(browserPath, userDataDir);
    client = await connectToPage(browser.debuggingPort, baseUrl);
    result = await runBrowserFlow(client, baseUrl, browserPath, harness);
  } finally {
    client?.close?.();
    try {
      await browser?.close?.();
    } catch (error) {
      cleanupWarning = `Browser cleanup warning: ${error?.message || error}`;
    }
    await new Promise((resolveClose) => harness.server.close(resolveClose));
    try {
      await rm(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (error) {
      cleanupWarning = cleanupWarning || `Temporary profile cleanup warning: ${error?.message || error}`;
    }
  }
  if (cleanupWarning && result) result.cleanupWarning = cleanupWarning;
  if (result) console.log(JSON.stringify(result, null, 2));
}

function createHarnessServer() {
  const store = createMemoryHostedStore();
  let authenticated = false;
  let workspace = {
    version: 1,
    settings: { brand: "AskWell Phase 5C", accent: "#ef7d62", welcome: "Hi" },
    articles: [],
    conversations: [],
  };
  const conversations = new Map();
  const messages = new Map();
  const events = [];

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      events.push({ method: req.method, path: url.pathname });
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url, { store, events, conversations, messages, get workspace() { return workspace; }, set workspace(value) { workspace = value; }, get authenticated() { return authenticated; }, set authenticated(value) { authenticated = value; } });
        return;
      }
      await serveStatic(req, res, url);
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: error?.message || "Harness failure" }));
    }
  });

  return {
    server,
    events,
    diagnostics() {
      const documents = store.listDocuments(WORKSPACE_ID);
      const snapshot = store.getRetrievalSnapshot(WORKSPACE_ID);
      return {
        documentCount: documents.length,
        chunkCount: snapshot.chunks.length,
        embeddingCount: snapshot.embeddings.length,
      };
    },
  };
}

async function handleApi(req, res, url, harness) {
  if (url.pathname === "/api/config" && req.method === "GET") {
    sendJson(res, { apiMode: "hosted", hostedConfigured: true });
    return;
  }

  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    const body = await readJson(req);
    if (body.accessCredential !== ACCESS_CREDENTIAL) {
      sendJson(res, { error: "Invalid access credential", code: "invalid_admin_auth" }, 403);
      return;
    }
    harness.authenticated = true;
    res.setHeader(
      "set-cookie",
      `${SESSION_COOKIE}=1; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`,
    );
    sendJson(res, { authenticated: true, csrfToken: CSRF_TOKEN, expiresAt: "2099-01-01T00:00:00.000Z" });
    return;
  }

  if (url.pathname === "/api/auth/session" && req.method === "GET") {
    if (!hasSession(req, harness)) {
      sendJson(res, { authenticated: false }, 200);
      return;
    }
    sendJson(res, { authenticated: true, csrfToken: CSRF_TOKEN, expiresAt: "2099-01-01T00:00:00.000Z" });
    return;
  }

  if (url.pathname === "/api/auth/logout" && req.method === "POST") {
    harness.authenticated = false;
    res.setHeader("set-cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    sendJson(res, { ok: true });
    return;
  }

  if (!hasSession(req, harness)) {
    sendJson(res, { error: "Private demo session is required", code: "missing_admin_auth" }, 401);
    return;
  }

  if (!["GET", "HEAD", "OPTIONS"].includes(req.method || "GET") && req.headers["x-askwell-csrf-token"] !== CSRF_TOKEN) {
    sendJson(res, { error: "CSRF token is required", code: "csrf_required" }, 403);
    return;
  }

  if (url.pathname === "/api/workspace" && req.method === "GET") {
    sendJson(res, harness.workspace);
    return;
  }

  if (url.pathname === "/api/workspace" && req.method === "PUT") {
    const body = await readJson(req);
    harness.workspace = {
      version: harness.workspace.version + 1,
      settings: body.settings || harness.workspace.settings,
      articles: Array.isArray(body.articles) ? body.articles : harness.workspace.articles,
      conversations: Array.isArray(body.conversations) ? body.conversations : harness.workspace.conversations,
    };
    sendJson(res, harness.workspace);
    return;
  }

  if (url.pathname === "/api/ai/ingest" && req.method === "POST") {
    sendJson(res, harness.store.ingest(await readJson(req), { workspaceId: WORKSPACE_ID }));
    return;
  }

  if (url.pathname === "/api/ai/documents" && req.method === "GET") {
    sendJson(res, { documents: harness.store.listDocuments(WORKSPACE_ID) });
    return;
  }

  if (url.pathname === "/api/ai/diagnostics" && req.method === "GET") {
    const documents = harness.store.listDocuments(WORKSPACE_ID);
    const snapshot = harness.store.getRetrievalSnapshot(WORKSPACE_ID);
    sendJson(res, {
      diagnostics: {
        status: "healthy",
        backend: "phase5c-local-browser-harness",
        integrity_check: "not-available",
        document_count: documents.length,
        chunk_count: snapshot.chunks.length,
        embedding_count: snapshot.embeddings.length,
        documents,
      },
    });
    return;
  }

  if (url.pathname === "/api/ai/answer" && req.method === "POST") {
    const body = await readJson(req);
    const snapshot = harness.store.getRetrievalSnapshot(WORKSPACE_ID);
    const retrieval = retrieveWithPrefilter({
      question: body.question,
      queryVector: body.queryVector,
      chunkIndex: snapshot.chunks,
      vectorSnapshotForChunkIds: (chunkIds) => filterSnapshot(harness.store.getRetrievalSnapshot(WORKSPACE_ID), chunkIds),
      topK: body.topK || 5,
    });
    sendJson(res, answerFromRetrieval({ question: body.question, ...retrieval }));
    return;
  }

  if (url.pathname === "/api/conversations" && req.method === "GET") {
    sendJson(res, { conversations: [...harness.conversations.values()] });
    return;
  }

  if (url.pathname === "/api/conversations" && req.method === "POST") {
    const body = await readJson(req);
    const id = body.id || `conversation-${harness.conversations.size + 1}`;
    const initialMessages = Array.isArray(body.messages) ? body.messages : [];
    const now = new Date().toISOString();
    const storedMessages = initialMessages.map((message, index) => ({
      id: message.id || `${id}-message-${index + 1}`,
      workspaceId: WORKSPACE_ID,
      conversationId: id,
      position: index,
      senderType: message.senderType || "customer",
      content: message.content || "",
      metadata: message.metadata || {},
      createdAt: now,
    }));
    harness.messages.set(id, storedMessages);
    const conversation = {
      id,
      workspaceId: WORKSPACE_ID,
      status: body.status || "open",
      customerId: body.customerId || "anonymous",
      metadata: body.metadata || {},
      messageCount: storedMessages.length,
      lastMessagePreview: storedMessages.at(-1)?.content || "",
      createdAt: now,
      updatedAt: now,
      lastMessageAt: storedMessages.length ? now : "",
    };
    harness.conversations.set(id, conversation);
    sendJson(res, { conversation, messages: storedMessages });
    return;
  }

  const conversationMessage = url.pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  if (conversationMessage && req.method === "POST") {
    const id = decodeURIComponent(conversationMessage[1]);
    const conversation = harness.conversations.get(id);
    if (!conversation) {
      sendJson(res, { error: "Conversation is not available in hosted storage", code: "unknown_conversation" }, 404);
      return;
    }
    const body = await readJson(req);
    const storedMessages = harness.messages.get(id) || [];
    const now = new Date().toISOString();
    const message = {
      id: body.id || `${id}-message-${storedMessages.length + 1}`,
      workspaceId: WORKSPACE_ID,
      conversationId: id,
      position: storedMessages.length,
      senderType: body.senderType || "customer",
      content: body.content || "",
      metadata: body.metadata || {},
      createdAt: now,
    };
    storedMessages.push(message);
    harness.messages.set(id, storedMessages);
    const updated = {
      ...conversation,
      messageCount: storedMessages.length,
      lastMessagePreview: message.content,
      updatedAt: now,
      lastMessageAt: now,
    };
    harness.conversations.set(id, updated);
    sendJson(res, { conversation: updated, message });
    return;
  }

  const conversationDetail = url.pathname.match(/^\/api\/conversations\/([^/]+)$/);
  if (conversationDetail && req.method === "GET") {
    const id = decodeURIComponent(conversationDetail[1]);
    const conversation = harness.conversations.get(id);
    if (!conversation) {
      sendJson(res, { error: "Conversation is not available in hosted storage", code: "unknown_conversation" }, 404);
      return;
    }
    sendJson(res, { conversation, messages: harness.messages.get(id) || [] });
    return;
  }

  const documentDelete = url.pathname.match(/^\/api\/ai\/documents\/([^/]+)$/);
  if (documentDelete && req.method === "DELETE") {
    sendJson(
      res,
      harness.store.deleteDocument(
        { workspaceId: WORKSPACE_ID, documentId: decodeURIComponent(documentDelete[1]) },
        { workspaceId: WORKSPACE_ID },
      ),
    );
    return;
  }

  sendJson(res, { error: "Not found" }, 404);
}

async function serveStatic(_req, res, url) {
  const route = url.pathname === "/" ? "/index.html" : url.pathname;
  const absolute = normalize(resolve(ROOT, `.${route}`));
  if (!absolute.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  const content = await readFile(absolute);
  res.writeHead(200, {
    "content-type": mimeType(absolute),
    "cache-control": "no-store",
  });
  res.end(content);
}

async function runBrowserFlow(client, baseUrl, browserPath, harness) {
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  await waitFor(client, "Boolean(window.AskWellApp && window.AskWellHostedEmbeddings)");

  await evaluate(client, `
    localStorage.setItem("askwell-api-mode", "hosted");
    localStorage.setItem("askwell-lite-state", JSON.stringify({
      version: 1,
      tab: "knowledge",
      search: "",
      settings: { brand: "AskWell Phase 5C", accent: "#ef7d62", welcome: "Hi" },
      articles: [],
      conversations: [],
      messages: [],
      documentStatus: {
        state: "idle",
        message: "Knowledge index ready",
        documents: [],
        pendingIds: [],
        indexResults: {},
        selectedId: "",
        diagnostics: null,
        diagnosticsState: "idle",
        diagnosticsMessage: "Diagnostics not checked"
      }
    }));
  `);
  await client.send("Page.navigate", { url: baseUrl });

  await waitFor(client, "Boolean(window.AskWellApp)");
  await evaluate(client, "window.setTab('knowledge')");
  await waitFor(client, "Boolean(document.querySelector('[data-private-demo-login]'))");
  await installDeterministicEmbedder(client);
  const embeddingProfile = await evaluate(client, "window.AskWellHostedEmbeddings.EMBEDDING_PROFILE", { returnByValue: true });
  const embeddingProbe = await evaluate(client, `
    (async () => {
      const [vector] = await window.AskWellHostedEmbeddings.embedTexts(["Phase 5C embedding probe"]);
      const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
      return {
        dimension: vector.length,
        finite: vector.every(Number.isFinite),
        norm,
        modelId: window.AskWellHostedEmbeddings.EMBEDDING_PROFILE.modelId,
        quantized: window.AskWellHostedEmbeddings.EMBEDDING_PROFILE.quantized
      };
    })()
  `);

  await evaluate(client, `
    {
    const form = document.querySelector('[data-private-demo-login]');
    form.querySelector('[name="accessCredential"]').value = ${JSON.stringify(ACCESS_CREDENTIAL)};
    form.requestSubmit();
    }
  `);
  await waitFor(client, "document.body.innerText.includes('Private demo session active')");
  await evaluate(client, "window.setTab('knowledge')");
  await waitFor(client, "Boolean(document.querySelector('[data-article-form]'))");

  await evaluate(client, `
    {
    const form = document.querySelector('[data-article-form]');
    form.querySelector('[name="title"]').value = "Phase 5C trial policy";
    form.querySelector('[name="tags"]').value = "billing, trial";
    form.querySelector('[name="content"]').value = "Phase 5C customers get a 14 day trial. A payment card is not required during the trial.";
    form.requestSubmit();
    }
  `);
  await waitFor(client, "document.body.innerText.includes('Phase 5C trial policy')");

  await evaluate(client, "document.querySelector('[data-index-all]').click()");
  await waitFor(client, "document.body.innerText.includes('1 indexed')");
  await evaluate(client, "document.querySelector('[data-refresh-diagnostics]').click()");
  await waitFor(client, "document.body.innerText.includes('phase5c-local-browser-harness') && document.body.innerText.includes('1 indexed')");
  await delay(700);

  await askWidget(client, "How long is the trial?");
  await waitFor(client, "document.body.innerText.includes('14 day trial') && document.body.innerText.includes('Citations:')");

  await askWidget(client, "Does AskWell support SAML SSO?");
  await waitFor(client, "document.body.innerText.includes('I do not have enough information')");

  await evaluate(client, `
    (async () => {
      const conversationId = localStorage.getItem("askwell-conversation-id");
      const response = await fetch("./api/conversations/" + encodeURIComponent(conversationId) + "/messages", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "x-askwell-runtime": "hosted",
          "x-askwell-csrf-token": window.AskWellApi.runtimeConfig.csrfToken
        },
        body: JSON.stringify({
          senderType: "agent",
          content: "A human support agent can follow up in this same thread.",
          metadata: { source: "browser-harness" }
        })
      });
      if (!response.ok) {
        throw new Error("Agent message injection failed: " + response.status);
      }
      await window.loadWidgetConversation();
    })()
  `);
  const handoffMarkup = await evaluate(client, "document.body.innerHTML");
  if (!handoffMarkup.includes("Human agent") || !handoffMarkup.includes("same thread")) {
    const handoffMessages = await evaluate(client, "window.AskWellState.getState().messages", { returnByValue: true });
    throw new Error(`Agent handoff did not render: ${JSON.stringify(handoffMessages)}`);
  }
  await delay(700);

  await evaluate(client, "window.confirm = () => true; document.querySelector('[data-delete-document]').click()");
  await waitFor(client, "document.body.innerText.includes('Deleted Phase 5C trial policy')");
  await evaluate(client, "document.querySelector('[data-refresh-diagnostics]').click()");
  await waitFor(client, "document.body.innerText.includes('0 indexed')");

  const pageText = await evaluate(client, "document.body.innerText");
  const finalDiagnostics = harness.diagnostics();
  return {
    generatedAt: new Date().toISOString(),
    browser: {
      executable: browserPath,
      url: baseUrl,
      cdp: true,
    },
    embedding: {
      mode: USE_REAL_BROWSER_MODEL ? "real-browser-model" : "deterministic-test-embedder",
      modelId: embeddingProfile.modelId,
      quantized: embeddingProfile.quantized,
      dimension: embeddingProbe.dimension,
      normalized: Math.abs(embeddingProbe.norm - 1) <= 0.05,
      finite: embeddingProbe.finite,
      note: USE_REAL_BROWSER_MODEL
        ? "The browser loaded the configured Transformers.js model."
        : "The browser embedding interface was exercised with the test embedder to avoid model downloads; Phase 4.2C remains the real model parity evidence.",
    },
    checks: {
      appLoaded: pageText.includes("AskWell Lite"),
      navigationLoadedKnowledge: pageText.includes("Knowledge base"),
      hostedLoginConfirmed: pageText.includes("Private demo session active"),
      articleCreated: pageText.includes("Phase 5C trial policy") || finalDiagnostics.documentCount === 0,
      indexingCompletedBeforeDelete: harness.events.some((event) => event.path === "/api/ai/ingest"),
      answerRendered: harness.events.some((event) => event.path === "/api/ai/answer"),
      citationRenderedBeforeDelete: true,
      insufficientEvidenceFallbackRendered: pageText.includes("I do not have enough information"),
      conversationContinuityPersisted: harness.events.some((event) => event.path.includes("/api/conversations/") && event.path.endsWith("/messages")),
      agentMessageRendered: handoffMarkup.includes("Human agent") && handoffMarkup.includes("same thread"),
      deletionCompleted: finalDiagnostics.documentCount === 0 && finalDiagnostics.chunkCount === 0 && finalDiagnostics.embeddingCount === 0,
    },
    finalDiagnostics,
    apiEvents: harness.events,
  };
}

async function askWidget(client, question) {
  await evaluate(client, `
    {
    const form = document.querySelector('[data-chat-form]');
    form.querySelector('input').value = ${JSON.stringify(question)};
    form.requestSubmit();
    }
  `);
}

async function installDeterministicEmbedder(client) {
  if (USE_REAL_BROWSER_MODEL) return;
  await evaluate(client, `
    window.AskWellHostedEmbeddings.__setEmbedderForTests(async (text) => {
      const vector = Array.from({ length: 384 }, () => 0);
      const tokens = String(text || "").toLowerCase().match(/[a-z0-9]+/g) || [];
      for (const token of tokens) {
        let hash = 2166136261;
        for (let index = 0; index < token.length; index += 1) {
          hash ^= token.charCodeAt(index);
          hash = Math.imul(hash, 16777619) >>> 0;
        }
        vector[hash % vector.length] += 1;
      }
      const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
      return vector.map((value) => value / norm);
    });
  `);
}

function filterSnapshot(snapshot, chunkIds) {
  const selected = new Set(chunkIds);
  return {
    chunks: snapshot.chunks.filter((chunk) => selected.has(chunk.id || chunk.chunkId)),
    embeddings: snapshot.embeddings.filter((embedding) => selected.has(embedding.chunkId)),
  };
}

async function findBrowser() {
  const candidates = [
    process.env.ASKWELL_BROWSER_PATH,
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try the next browser candidate.
    }
  }
  throw new Error("No Chromium-family browser found. Set ASKWELL_BROWSER_PATH to run Phase 5C browser verification.");
}

async function launchBrowser(browserPath, userDataDir) {
  const browser = spawn(browserPath, [
    "--headless",
    "--disable-gpu",
    "--disable-crash-reporter",
    "--disable-breakpad",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ], { stdio: "ignore" });

  const portFile = join(userDataDir, "DevToolsActivePort");
  const started = performance.now();
  while (performance.now() - started < 10000) {
    try {
      const [port] = (await readFile(portFile, "utf8")).trim().split(/\r?\n/);
      return {
        process: browser,
        debuggingPort: Number(port),
        close: async () => {
          if (browser.exitCode !== null) return;
          browser.kill();
          await Promise.race([
            new Promise((resolveExit) => browser.once("exit", resolveExit)),
            delay(3000),
          ]);
        },
      };
    } catch {
      await delay(100);
    }
  }
  browser.kill();
  throw new Error("Browser did not expose a DevTools port in time");
}

async function connectToPage(port, url) {
  await fetchJson(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  const list = await fetchJson(`http://127.0.0.1:${port}/json/list`);
  const page =
    list.find((target) => target.type === "page" && target.url === url && target.webSocketDebuggerUrl) ||
    list.find((target) => target.type === "page" && target.url?.startsWith(url) && target.webSocketDebuggerUrl) ||
    list.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (!page) throw new Error("No browser page target found");
  return CdpClient.connect(page.webSocketDebuggerUrl);
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", async (event) => {
      const message = JSON.parse(await websocketText(event.data));
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve: resolvePending, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolvePending(message.result || {});
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolveOpen, rejectOpen) => {
      socket.addEventListener("open", resolveOpen, { once: true });
      socket.addEventListener("error", rejectOpen, { once: true });
    });
    return new CdpClient(socket);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveSend, rejectSend) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectSend(new Error(`Timed out waiting for CDP response to ${method}`));
      }, 15000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolveSend(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectSend(error);
        },
      });
    });
  }

  close() {
    this.socket.close();
  }
}

async function websocketText(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  if (typeof data?.arrayBuffer === "function") return Buffer.from(await data.arrayBuffer()).toString("utf8");
  return String(data);
}

async function evaluate(client, expression, options = {}) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: options.returnByValue !== false,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ||
        result.exceptionDetails.exception?.value ||
        result.exceptionDetails.text ||
        "Browser evaluation failed",
    );
  }
  return result.result?.value;
}

async function waitFor(client, expression, timeoutMs = 10000) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    if (await evaluate(client, expression)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for browser condition: ${expression}`);
}

async function listen(server) {
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address();
  return `http://127.0.0.1:${port}/`;
}

function hasSession(req, harness) {
  return harness.authenticated && String(req.headers.cookie || "").includes(`${SESSION_COOKIE}=1`);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
  return response.json();
}

function mimeType(path) {
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
  }[extname(path)] || "application/octet-stream";
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
