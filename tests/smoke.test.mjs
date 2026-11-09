import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  atomicWriteJson,
  createServer,
  ensureWorkspace,
  sanitizeWorkspace,
  writeWorkspace,
} from "../server.mjs";
import { createMemoryHostedStore } from "../src/hosted/storage-contract.mjs";
import { answerFromRetrieval, retrieveWithPrefilter } from "../src/hosted/retrieval.mjs";

const frontendSources = [
  "src/utils/escape.js",
  "src/utils/validation.js",
  "src/retrieval.js",
  "src/hosted/browser-embeddings.js",
  "src/api.js",
  "src/state.js",
  "src/render/overview.js",
  "src/render/knowledge.js",
  "src/render/inbox.js",
  "src/render/agents.js",
  "src/render/install.js",
  "src/app.js",
].map((path) => ({
  path,
  source: readFileSync(new URL(`../${path}`, import.meta.url), "utf8"),
}));
const widgetSource = readFileSync(
  new URL("../askwell-widget.js", import.meta.url),
  "utf8",
);
const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const cssSource = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

class FakeElement {
  constructor(name = "element") {
    this.name = name;
    this.dataset = {};
    this.hidden = false;
    this.listeners = {};
    this.children = [];
    this.attributes = {};
    this.style = {};
    this.value = "";
    this.textContent = "";
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this._innerHTML = "";
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set style(value) {
    this._style = value;
  }

  get style() {
    return this._style;
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  append(...children) {
    this.children.push(...children);
  }

  addEventListener(type, callback) {
    this.listeners[type] = callback;
  }

  querySelector(selector) {
    if (!this._childrenBySelector) this._childrenBySelector = new Map();
    if (!this._childrenBySelector.has(selector)) {
      this._childrenBySelector.set(selector, new FakeElement(selector));
    }
    return this._childrenBySelector.get(selector);
  }

  focus() {
    this.focused = true;
  }

  click() {
    this.clicked = true;
  }

  reset() {
    this.resetCalled = true;
  }
}

function createLocalStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    dump() {
      return Object.fromEntries(store);
    },
  };
}

function createAppContext(options = {}) {
  const app = new FakeElement("app");
  const listeners = [];
  const document = {
    querySelector(selector) {
      if (selector === "#app") return app;
      return new FakeElement(selector);
    },
    querySelectorAll(selector) {
      if (selector === "[data-tab]") {
        return ["overview", "knowledge", "inbox", "agents", "install"].map((tab) => {
          const element = new FakeElement(`tab-${tab}`);
          element.dataset.tab = tab;
          listeners.push(element);
          return element;
        });
      }

      const deletes = [...app.innerHTML.matchAll(/data-delete="([^"]+)"/g)];
      if (selector === "[data-delete]") {
        return deletes.map((match) => {
          const element = new FakeElement("delete");
          element.dataset.delete = match[1];
          listeners.push(element);
          return element;
        });
      }

      const documentDeletes = [...app.innerHTML.matchAll(/data-delete-document="([^"]+)"/g)];
      if (selector === "[data-delete-document]") {
        return documentDeletes.map((match) => {
          const element = new FakeElement("delete-document");
          element.dataset.deleteDocument = match[1];
          listeners.push(element);
          return element;
        });
      }

      return [];
    },
    createElement(tag) {
      return new FakeElement(tag);
    },
  };

  class FakeFormData {
    constructor(form) {
      this.form = form;
    }

    get(name) {
      return this.form.fields?.[name] ?? "";
    }
  }

  const objectUrls = [];
  const revokedUrls = [];
  class FakeBlob {
    constructor(parts, options) {
      this.parts = parts;
      this.options = options;
    }
  }

  const context = {
    console,
    Blob: FakeBlob,
    Date,
    FormData: FakeFormData,
    Math,
    TextEncoder,
    URL: {
      createObjectURL(blob) {
        objectUrls.push(blob);
        return `blob:test-${objectUrls.length}`;
      },
      revokeObjectURL(url) {
        revokedUrls.push(url);
      },
    },
    crypto: {
      subtle: webcrypto.subtle,
      randomUUID: () => `id-${Math.random().toString(16).slice(2)}`,
    },
    self: {
      crypto: {
        randomUUID: () => `id-${Math.random().toString(16).slice(2)}`,
      },
    },
    document,
    localStorage: createLocalStorage(options.localStorage),
    location: options.location,
    fetch: options.fetch,
    confirm: options.confirm,
    setTimeout: options.setTimeout,
    clearTimeout: options.clearTimeout,
    __objectUrls: objectUrls,
    __revokedUrls: revokedUrls,
  };

  vm.createContext(context);
  for (const { path, source } of frontendSources) {
    vm.runInContext(source, context, { filename: path });
  }
  return { app, context, listeners };
}

function articleCount(html) {
  return (html.match(/<article class="article">/g) || []).length;
}

async function withTempWorkspace(callback) {
  const directory = await mkdtemp(join(repoRoot, ".tmp-askwell-"));
  const workspacePath = join(directory, "workspace.json");
  try {
    await callback({ directory, workspacePath });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function flushAsyncWork() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

function tokenHashVector384(text) {
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
}

async function withServer(env, callback) {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    ASKWELL_ADMIN_TOKEN: process.env.ASKWELL_ADMIN_TOKEN,
  };
  process.env.NODE_ENV = env.NODE_ENV;
  if (env.ASKWELL_ADMIN_TOKEN) {
    process.env.ASKWELL_ADMIN_TOKEN = env.ASKWELL_ADMIN_TOKEN;
  } else {
    delete process.env.ASKWELL_ADMIN_TOKEN;
  }

  const server = createServer(env.serverOptions || {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function request(path, options = {}) {
    try {
      return await fetch(`${baseUrl}${path}`, options);
    } catch (error) {
      if (error.cause?.code !== "EACCES") throw error;
      return dispatchInProcess(server, path, options);
    }
  }

  try {
    await callback({ baseUrl, request });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    if (previous.NODE_ENV === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previous.NODE_ENV;
    }
    if (previous.ASKWELL_ADMIN_TOKEN === undefined) {
      delete process.env.ASKWELL_ADMIN_TOKEN;
    } else {
      process.env.ASKWELL_ADMIN_TOKEN = previous.ASKWELL_ADMIN_TOKEN;
    }
  }
}

function dispatchInProcess(server, path, options = {}) {
  return new Promise((resolve) => {
    const body = options.body ? Buffer.from(String(options.body)) : null;
    const headers = {};
    for (const [key, value] of Object.entries(options.headers || {})) {
      headers[key.toLowerCase()] = value;
    }

    const req = new Readable({
      read() {
        if (body) this.push(body);
        this.push(null);
      },
    });
    req.method = options.method || "GET";
    req.url = path;
    req.headers = headers;
    req.socket = { remoteAddress: "127.0.0.1" };

    const chunks = [];
    const responseHeaders = new Map();
    const res = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });

    res.writeHead = (status, headersObject = {}) => {
      res.statusCode = status;
      for (const [key, value] of Object.entries(headersObject)) {
        responseHeaders.set(key.toLowerCase(), String(value));
      }
    };
    res.end = (chunk) => {
      if (chunk) chunks.push(Buffer.from(chunk));
      resolve({
        status: res.statusCode || 200,
        headers: {
          get(name) {
            return responseHeaders.get(name.toLowerCase()) || null;
          },
        },
        async text() {
          return Buffer.concat(chunks).toString("utf8");
        },
        async json() {
          return JSON.parse(Buffer.concat(chunks).toString("utf8"));
        },
      });
    };

    server.emit("request", req, res);
  });
}

test("index points to cache-busted local assets", () => {
  assert.match(indexHtml, /styles\.css\?v=9/);
  for (const { path } of frontendSources) {
    assert.match(indexHtml, new RegExp(`${path.replace("/", "\\/")}\\?v=9`));
  }
  assert.match(indexHtml, /<div id="app" class="app-shell"><\/div>/);
});

test("overview page renders launch metrics and export action", () => {
  const { app } = createAppContext();
  assert.match(app.innerHTML, /Support cockpit/);
  assert.match(app.innerHTML, /Launch Score/);
  assert.match(app.innerHTML, /Launch checks/);
  assert.match(app.innerHTML, /data-export/);
});

test("dashboard navigation buttons switch rendered pages", () => {
  const { app, listeners } = createAppContext();
  const knowledgeButton = listeners.find((element) => element.dataset.tab === "knowledge");
  knowledgeButton.listeners.click();
  assert.match(app.innerHTML, /Knowledge base/);

  const inboxButton = listeners.find((element) => element.dataset.tab === "inbox");
  inboxButton.listeners.click();
  assert.match(app.innerHTML, /Recent questions/);
});

test("knowledge page renders articles with the icon delete control", () => {
  const { app, context } = createAppContext();
  context.setTab("knowledge");
  assert.match(app.innerHTML, /Knowledge base/);
  assert.equal(articleCount(app.innerHTML), 4);
  assert.match(app.innerHTML, /class="icon-button danger"/);
  assert.doesNotMatch(app.innerHTML, />Delete<\/button>/);
});

test("article add, delete, and reset flows update rendered state", () => {
  const { app, context } = createAppContext();
  context.setTab("knowledge");
  const initialCount = articleCount(app.innerHTML);

  const form = new FakeElement("article-form");
  form.fields = {
    title: "Refund & <script>alert(1)</script>",
    tags: "billing, refunds",
    content: "Refunds are reviewed in 3 business days.",
  };

  context.addArticle({
    preventDefault() {},
    currentTarget: form,
  });

  assert.equal(articleCount(app.innerHTML), initialCount + 1);
  assert.match(app.innerHTML, /Refund &amp; &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(form.resetCalled, true);

  const firstDeleteId = app.innerHTML.match(/data-delete="([^"]+)"/)[1];
  context.deleteArticle(firstDeleteId);
  assert.equal(articleCount(app.innerHTML), initialCount);

  context.resetDemo();
  context.setTab("knowledge");
  assert.equal(articleCount(app.innerHTML), 4);
});

test("knowledge page shows index status and deletes from AI index before workspace removal", async () => {
  let deleteCalls = 0;
  const { app, context } = createAppContext({
    location: { protocol: "http:" },
    confirm: () => true,
    setTimeout(callback) {
      callback();
      return 1;
    },
    clearTimeout() {},
    fetch: async (url, options = {}) => {
      if (String(url).includes("/api/workspace")) {
        if (options.method) {
          const payload = JSON.parse(options.body || "{}");
          return {
            ok: true,
            async json() {
              return {
                version: 2,
                settings: payload.settings,
                articles: payload.articles,
                conversations: payload.conversations,
              };
            },
          };
        }
        return {
          ok: true,
          async json() {
            return {
              version: 1,
              settings: { brand: "Remote", accent: "#ef7d62", welcome: "Hi" },
              articles: [{ id: "remote", title: "Remote", tags: [], content: "Remote body" }],
              conversations: [],
            };
          },
        };
      }
      if (String(url).includes("/api/ai/documents") && options.method === "DELETE") {
        deleteCalls += 1;
        return {
          ok: true,
          async json() {
            return { document_id: "remote", deleted: true, chunks_deleted: 1, status: "deleted" };
          },
        };
      }
      if (String(url).includes("/api/ai/documents")) {
        return {
          ok: true,
          async json() {
            return [{ id: "remote", title: "Remote", source_type: "article", chunk_count: 1 }];
          },
        };
      }
      return {
        ok: true,
        async json() {
          return { status: "ok", document_statuses: [{ id: "remote", status: "unchanged" }] };
        },
      };
    },
  });

  await flushAsyncWork();
  await context.AskWellState.refreshDocuments();
  await flushAsyncWork();
  context.setTab("knowledge");
  assert.match(app.innerHTML, /Indexed/);
  assert.match(app.innerHTML, /1 chunk/);
  await context.deleteArticle("remote");
  await flushAsyncWork();

  assert.equal(deleteCalls, 1);
  assert.equal(articleCount(app.innerHTML), 0);
});

test("knowledge page renders document details and empty index states", async () => {
  const emptyState = {
    version: 1,
    tab: "knowledge",
    settings: { brand: "Empty", accent: "#ef7d62", welcome: "Hi" },
    articles: [],
    conversations: [],
    messages: [],
    documentStatus: { state: "saved", message: "0 indexed documents", documents: [] },
  };
  const empty = createAppContext({
    localStorage: { "askwell-lite-state": JSON.stringify(emptyState) },
  });
  assert.match(empty.app.innerHTML, /No articles yet/);
  assert.match(empty.app.innerHTML, /No indexed documents yet/);

  const { app, context } = createAppContext({
    location: { protocol: "http:" },
    fetch: async (url) => {
      if (String(url).includes("/api/workspace")) {
        return {
          ok: true,
          async json() {
            return {
              version: 1,
              settings: { brand: "Remote", accent: "#ef7d62", welcome: "Hi" },
              articles: [{ id: "remote", title: "Remote", tags: ["ops"], content: "Remote body" }],
              conversations: [],
            };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return [
            {
              id: "remote",
              title: "Remote",
              source_type: "article",
              content_hash: "abcdef1234567890",
              chunk_count: 2,
              updated_at: "2026-11-08T10:00:00.000Z",
              metadata: { tags: ["ops"] },
            },
          ];
        },
      };
    },
  });

  await flushAsyncWork();
  await context.AskWellState.refreshDocuments();
  context.setTab("knowledge");

  assert.match(app.innerHTML, /Document management/);
  assert.match(app.innerHTML, /remote/);
  assert.match(app.innerHTML, /2 chunks/);
  assert.match(app.innerHTML, /abcdef1234/);
  assert.match(app.innerHTML, /Update index/);
  assert.match(app.innerHTML, /Delete Document/);
});

test("bulk article indexing sends existing article ids and reports created and unchanged states", async () => {
  const calls = [];
  let documents = [];
  const initialState = {
    version: 1,
    tab: "knowledge",
    settings: { brand: "Bulk", accent: "#ef7d62", welcome: "Hi" },
    articles: [
      { id: "trial", title: "Trial", tags: ["billing"], content: "Trial content" },
      { id: "install", title: "Install", tags: ["setup"], content: "Install content" },
    ],
    conversations: [],
    messages: [],
    documentStatus: {
      state: "saved",
      message: "Knowledge index ready",
      documents: [],
      pendingIds: [],
      indexResults: {},
    },
  };
  const { app, context } = createAppContext({
    localStorage: { "askwell-lite-state": JSON.stringify(initialState) },
    location: { protocol: "http:" },
    fetch: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).includes("/api/ai/ingest")) {
        const body = JSON.parse(options.body || "{}");
        const incomingDocuments = body.documents || body.articles || [];
        documents = incomingDocuments.map((document, index) => ({
          id: document.id,
          title: document.title,
          source_type: document.source_type || "article",
          chunk_count: index + 1,
          updated_at: "2026-11-09T00:00:00.000Z",
        }));
        return {
          ok: true,
          async json() {
            return {
              status: "ok",
              document_statuses: [
                { id: "trial", status: "created", version: 1 },
                { id: "install", status: "unchanged", version: 1 },
              ],
            };
          },
        };
      }
      if (String(url).includes("/api/ai/documents")) {
        return {
          ok: true,
          async json() {
            return { documents };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return {
            version: 1,
            settings: initialState.settings,
            articles: initialState.articles,
            conversations: [],
          };
        },
      };
    },
  });

  await context.indexAllArticles();
  await flushAsyncWork();

  const ingestCall = calls.find((call) => call.url.includes("/api/ai/ingest"));
  const body = JSON.parse(ingestCall.options.body);
  const ingestedDocuments = body.documents || body.articles || [];
  assert.deepEqual(ingestedDocuments.map((document) => document.id), ["trial", "install"]);
  assert.equal(ingestedDocuments.some((document) => String(document.id).includes("synthetic")), false);
  assert.match(app.innerHTML, /1 created, 1 unchanged/);
  assert.match(app.innerHTML, /2 indexed/);
  assert.match(app.innerHTML, /Indexed/);
  assert.match(app.innerHTML, /2 chunks/);
});

test("article indexing prevents duplicate submissions while pending", async () => {
  const pendingState = {
    version: 1,
    tab: "knowledge",
    settings: { brand: "Pending", accent: "#ef7d62", welcome: "Hi" },
    articles: [{ id: "trial", title: "Trial", tags: [], content: "Trial content" }],
    conversations: [],
    messages: [],
    documentStatus: {
      state: "saving",
      message: "Indexing 1 article",
      documents: [],
      pendingIds: ["trial"],
      indexResults: {},
    },
  };
  const { app, context } = createAppContext({
    localStorage: { "askwell-lite-state": JSON.stringify(pendingState) },
    location: { protocol: "http:" },
    fetch: async () => {
      throw new Error("duplicate indexing should not call fetch");
    },
  });

  await context.indexAllArticles();
  await context.indexArticle("trial");
  assert.match(app.innerHTML, /Indexing/);
  assert.match(app.innerHTML, /disabled/);
});

test("article indexing surfaces partial failures and allows retry", async () => {
  const calls = [];
  let failTrial = true;
  let documents = [{ id: "install", title: "Install", source_type: "article", chunk_count: 1 }];
  const initialState = {
    version: 1,
    tab: "knowledge",
    settings: { brand: "Partial", accent: "#ef7d62", welcome: "Hi" },
    articles: [
      { id: "trial", title: "Trial", tags: ["billing"], content: "Trial content" },
      { id: "install", title: "Install", tags: ["setup"], content: "Install content" },
    ],
    conversations: [],
    messages: [],
    documentStatus: {
      state: "saved",
      message: "Knowledge index ready",
      documents,
      pendingIds: [],
      indexResults: {},
    },
  };
  const { app, context } = createAppContext({
    localStorage: { "askwell-lite-state": JSON.stringify(initialState) },
    location: { protocol: "http:" },
    fetch: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).includes("/api/ai/ingest")) {
        const body = JSON.parse(options.body || "{}");
        const incomingDocuments = body.documents || body.articles || [];
        if (incomingDocuments.some((document) => document.id === "trial") && failTrial) {
          return {
            ok: true,
            async json() {
              return {
                status: "partial",
                document_statuses: [
                  { id: "trial", status: "failed", error: "Embedding failed" },
                  { id: "install", status: "unchanged", version: 1 },
                ],
              };
            },
          };
        }
        documents = [
          ...documents.filter((document) => document.id !== "trial"),
          { id: "trial", title: "Trial", source_type: "article", chunk_count: 1 },
        ];
        return {
          ok: true,
          async json() {
            return { status: "ok", document_statuses: [{ id: "trial", status: "created", version: 1 }] };
          },
        };
      }
      if (String(url).includes("/api/ai/documents")) {
        return {
          ok: true,
          async json() {
            return { documents };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return {
            version: 1,
            settings: initialState.settings,
            articles: initialState.articles,
            conversations: [],
          };
        },
      };
    },
  });

  await context.indexAllArticles();
  await flushAsyncWork();
  assert.match(app.innerHTML, /1 unchanged, 1 failed/);
  assert.match(app.innerHTML, /Embedding failed/);
  assert.match(app.innerHTML, /Retry index/);

  failTrial = false;
  await context.indexArticle("trial");
  await flushAsyncWork();
  const retryCall = calls.filter((call) => call.url.includes("/api/ai/ingest")).at(-1);
  const retryBody = JSON.parse(retryCall.options.body);
  const retryDocuments = retryBody.documents || retryBody.articles || [];
  assert.deepEqual(retryDocuments.map((document) => document.id), ["trial"]);
  assert.match(app.innerHTML, /1 created/);
  assert.match(app.innerHTML, /2 indexed/);
});

test("document delete action confirms, removes indexed document, and refreshes diagnostics", async () => {
  const calls = [];
  const confirms = [];
  let documents = [
    { id: "remote", title: "Remote", source_type: "article", chunk_count: 2 },
    { id: "second", title: "Second", source_type: "article", chunk_count: 1 },
  ];
  const { app, context, listeners } = createAppContext({
    location: { protocol: "http:" },
    confirm(message) {
      confirms.push(message);
      return true;
    },
    fetch: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).includes("/api/workspace")) {
        return {
          ok: true,
          async json() {
            return {
              version: 1,
              settings: { brand: "Remote", accent: "#ef7d62", welcome: "Hi" },
              articles: [{ id: "remote", title: "Remote", tags: [], content: "Remote body" }],
              conversations: [],
            };
          },
        };
      }
      if (String(url).includes("/api/ai/diagnostics")) {
        return {
          ok: true,
          async json() {
            return {
              backend: "sqlite",
              status: "healthy",
              integrity_check: "ok",
              document_count: documents.length,
              chunk_count: documents.reduce((sum, document) => sum + document.chunk_count, 0),
              embedding_count: documents.reduce((sum, document) => sum + document.chunk_count, 0),
              documents,
            };
          },
        };
      }
      if (String(url).includes("/api/ai/documents/remote") && options.method === "DELETE") {
        documents = documents.filter((document) => document.id !== "remote");
        return {
          ok: true,
          async json() {
            return { document_id: "remote", deleted: true, chunks_deleted: 2, embeddings_deleted: 2 };
          },
        };
      }
      if (String(url).includes("/api/ai/documents")) {
        return {
          ok: true,
          async json() {
            return { documents };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return { status: "ok", document_statuses: [] };
        },
      };
    },
  });

  await flushAsyncWork();
  await context.AskWellState.refreshDocuments();
  context.setTab("knowledge");
  assert.match(app.innerHTML, /Delete Document/);

  const deleteButton = listeners.find((element) => element.dataset.deleteDocument === "remote");
  await deleteButton.listeners.click();
  await flushAsyncWork();

  const deleteCalls = calls.filter((call) => call.options.method === "DELETE");
  assert.equal(deleteCalls.length, 1);
  assert.match(confirms[0], /Remote/);
  assert.match(confirms[0], /remote/);
  assert.doesNotMatch(app.innerHTML, /data-select-document="remote"/);
  assert.match(app.innerHTML, /data-select-document="second"/);
  assert.match(app.innerHTML, /Deleted Remote from the index/);
  assert.match(app.innerHTML, /1 indexed/);
  assert.equal(context.AskWellState.getState().articles.length, 1);
});

test("document delete action respects cancellation and preserves the document", async () => {
  let deleteCalls = 0;
  const initialState = {
    version: 1,
    tab: "knowledge",
    settings: { brand: "Cancel", accent: "#ef7d62", welcome: "Hi" },
    articles: [],
    conversations: [],
    messages: [],
    documentStatus: {
      state: "saved",
      message: "1 indexed document",
      selectedId: "remote",
      documents: [{ id: "remote", title: "Remote", source_type: "article", chunk_count: 1 }],
    },
  };
  const { app, context } = createAppContext({
    localStorage: { "askwell-lite-state": JSON.stringify(initialState) },
    location: { protocol: "http:" },
    confirm: () => false,
    fetch: async (url, options = {}) => {
      if (String(url).includes("/api/ai/documents") && options.method === "DELETE") deleteCalls += 1;
      return {
        ok: true,
        async json() {
          return { documents: initialState.documentStatus.documents };
        },
      };
    },
  });

  await context.deleteIndexedDocument("remote");
  assert.equal(deleteCalls, 0);
  assert.match(app.innerHTML, /Remote/);
  assert.match(app.innerHTML, /Delete Document/);
});

test("document delete action preserves document and reports API failures", async () => {
  let deleteCalls = 0;
  const initialState = {
    version: 1,
    tab: "knowledge",
    settings: { brand: "Failure", accent: "#ef7d62", welcome: "Hi" },
    articles: [],
    conversations: [],
    messages: [],
    documentStatus: {
      state: "saved",
      message: "1 indexed document",
      selectedId: "remote",
      documents: [{ id: "remote", title: "Remote", source_type: "article", chunk_count: 1 }],
    },
  };
  const { app, context } = createAppContext({
    localStorage: { "askwell-lite-state": JSON.stringify(initialState) },
    location: { protocol: "http:" },
    confirm: () => true,
    fetch: async (url, options = {}) => {
      if (String(url).includes("/api/ai/documents/remote") && options.method === "DELETE") {
        deleteCalls += 1;
        return {
          ok: false,
          status: 503,
          async json() {
            return { error: "Storage delete failed" };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return { documents: initialState.documentStatus.documents };
        },
      };
    },
  });

  await context.deleteIndexedDocument("remote");
  assert.equal(deleteCalls, 1);
  assert.match(app.innerHTML, /Storage delete failed/);
  assert.match(app.innerHTML, /data-select-document="remote"/);
});

test("document delete action handles stale selection and duplicate submissions", async () => {
  let deleteCalls = 0;
  let resolveDelete;
  const deleteStarted = new Promise((resolve) => {
    resolveDelete = resolve;
  });
  const initialState = {
    version: 1,
    tab: "knowledge",
    settings: { brand: "Pending", accent: "#ef7d62", welcome: "Hi" },
    articles: [],
    conversations: [],
    messages: [],
    documentStatus: {
      state: "saved",
      message: "1 indexed document",
      selectedId: "remote",
      documents: [{ id: "remote", title: "Remote", source_type: "article", chunk_count: 1 }],
    },
  };
  const { app, context } = createAppContext({
    localStorage: { "askwell-lite-state": JSON.stringify(initialState) },
    location: { protocol: "http:" },
    confirm: () => true,
    fetch: async (url, options = {}) => {
      if (String(url).includes("/api/ai/documents/remote") && options.method === "DELETE") {
        deleteCalls += 1;
        await deleteStarted;
        return {
          ok: true,
          async json() {
            return { document_id: "remote", deleted: true };
          },
        };
      }
      if (String(url).includes("/api/ai/diagnostics")) {
        return {
          ok: true,
          async json() {
            return { backend: "sqlite", status: "healthy", integrity_check: "ok", documents: [] };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return { documents: [] };
        },
      };
    },
  });

  const firstDelete = context.deleteIndexedDocument("remote");
  await flushAsyncWork();
  await context.deleteIndexedDocument("remote");
  assert.equal(deleteCalls, 1);
  assert.match(app.innerHTML, /Delete Document/);
  assert.match(app.innerHTML, /disabled/);
  resolveDelete();
  await firstDelete;
  await flushAsyncWork();
  assert.doesNotMatch(app.innerHTML, /data-select-document="remote"/);

  await context.deleteIndexedDocument("missing");
  assert.match(app.innerHTML, /Selected document is no longer available/);
});

test("document update flow preserves stable id and reports updated or unchanged status", async () => {
  const calls = [];
  const { app, context } = createAppContext({
    location: { protocol: "http:" },
    confirm: () => true,
    setTimeout(callback) {
      callback();
      return 1;
    },
    clearTimeout() {},
    fetch: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).includes("/api/workspace")) {
        if (options.method) {
          const payload = JSON.parse(options.body || "{}");
          return {
            ok: true,
            async json() {
              return { ...payload, version: 2 };
            },
          };
        }
        return {
          ok: true,
          async json() {
            return {
              version: 1,
              settings: { brand: "Remote", accent: "#ef7d62", welcome: "Hi" },
              articles: [{ id: "remote", title: "Remote", tags: ["old"], content: "Old body" }],
              conversations: [],
            };
          },
        };
      }
      if (String(url).includes("/api/ai/ingest")) {
        return {
          ok: true,
          async json() {
            return { status: "ok", document_statuses: [{ id: "remote", status: "updated" }] };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return [
            {
              id: "remote",
              title: "Remote updated",
              source_type: "article",
              content_hash: "hash",
              chunk_count: 1,
              updated_at: "2026-11-08T10:00:00.000Z",
              metadata: { tags: ["new"] },
            },
          ];
        },
      };
    },
  });

  await flushAsyncWork();
  await context.AskWellState.refreshDocuments();
  context.setTab("knowledge");
  const form = new FakeElement("document-update-form");
  form.fields = {
    id: "remote",
    title: "Remote updated",
    sourceType: "article",
    tags: "new",
    content: "New body",
  };

  await context.updateDocument({ preventDefault() {}, currentTarget: form });
  await flushAsyncWork();

  const ingestCall = calls.find((call) => String(call.url).includes("/api/ai/ingest"));
  const saveCall = calls.find((call) => String(call.url).includes("/api/workspace") && call.options.method === "PUT");
  const ingestBody = JSON.parse(ingestCall.options.body);
  const saveBody = JSON.parse(saveCall.options.body);

  assert.equal(ingestBody.documents[0].id, "remote");
  assert.equal(ingestBody.documents[0].content, "New body");
  assert.equal(saveBody.articles[0].id, "remote");
  assert.equal(context.AskWellState.getState().articles[0].content, "New body");
  assert.match(app.innerHTML, /Document updated/);

  calls.length = 0;
  form.fields.content = "New body";
  const originalFetch = context.fetch;
  context.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("/api/ai/ingest")) {
      return {
        ok: true,
        async json() {
          return { status: "ok", document_statuses: [{ id: "remote", status: "unchanged" }] };
        },
      };
    }
    return originalFetch(url, options);
  };
  await context.updateDocument({ preventDefault() {}, currentTarget: form });
  await flushAsyncWork();
  assert.match(app.innerHTML, /Document unchanged; index already current/);
});

test("document update flow reports failures and blocks duplicate pending submissions", async () => {
  let ingestCalls = 0;
  const { app, context } = createAppContext({
    location: { protocol: "http:" },
    confirm: () => true,
    fetch: async (url, options = {}) => {
      if (String(url).includes("/api/workspace")) {
        return {
          ok: true,
          async json() {
            return {
              version: 1,
              settings: { brand: "Remote", accent: "#ef7d62", welcome: "Hi" },
              articles: [{ id: "remote", title: "Remote", tags: [], content: "Old body" }],
              conversations: [],
            };
          },
        };
      }
      if (String(url).includes("/api/ai/ingest")) {
        ingestCalls += 1;
        return {
          ok: false,
          status: 503,
          async json() {
            return { error: "AI service unavailable" };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return [{ id: "remote", title: "Remote", source_type: "article", chunk_count: 1 }];
        },
      };
    },
  });

  await flushAsyncWork();
  await context.AskWellState.refreshDocuments();
  context.setTab("knowledge");
  const form = new FakeElement("document-update-form");
  form.fields = {
    id: "remote",
    title: "Remote",
    sourceType: "article",
    tags: "",
    content: "New body",
  };
  await context.updateDocument({ preventDefault() {}, currentTarget: form });

  assert.equal(ingestCalls, 1);
  assert.equal(context.AskWellState.getState().articles[0].content, "Old body");
  assert.match(app.innerHTML, /AI service unavailable/);

  const pendingState = {
    version: 1,
    tab: "knowledge",
    settings: { brand: "Pending", accent: "#ef7d62", welcome: "Hi" },
    articles: [{ id: "remote", title: "Remote", tags: [], content: "Old body" }],
    conversations: [],
    messages: [],
    documentStatus: {
      state: "saving",
      message: "Re-indexing Remote",
      pendingIds: ["remote"],
      selectedId: "remote",
      documents: [{ id: "remote", title: "Remote", source_type: "article", chunk_count: 1 }],
    },
  };
  const pending = createAppContext({
    localStorage: { "askwell-lite-state": JSON.stringify(pendingState) },
    location: { protocol: "http:" },
    fetch: async () => {
      throw new Error("duplicate submission should not call fetch");
    },
  });
  await pending.context.updateDocument({ preventDefault() {}, currentTarget: form });
  assert.match(pending.app.innerHTML, /Update index/);
  assert.match(pending.app.innerHTML, /disabled/);
});

test("diagnostics panel shows health, failures, and retries eligible documents", async () => {
  let ingestCalls = 0;
  const { app, context } = createAppContext({
    location: { protocol: "http:" },
    confirm: () => true,
    fetch: async (url, options = {}) => {
      if (String(url).includes("/api/workspace")) {
        return {
          ok: true,
          async json() {
            return {
              version: 1,
              settings: { brand: "Remote", accent: "#ef7d62", welcome: "Hi" },
              articles: [{ id: "remote", title: "Remote", tags: [], content: "Retry body" }],
              conversations: [],
            };
          },
        };
      }
      if (String(url).includes("/api/ai/diagnostics")) {
        return {
          ok: true,
          async json() {
            return {
              backend: "sqlite",
              status: "needs_attention",
              readable: true,
              writable: true,
              integrity_check: "ok",
              document_count: 1,
              chunk_count: 1,
              embedding_count: 1,
              vector_dimension: 64,
              dimension_consistent: true,
              manifest_compatible: true,
              last_error: "embedding failure",
              documents: [
                {
                  id: "remote",
                  title: "Remote",
                  source_type: "article",
                  chunk_count: 1,
                  status: "Needs attention",
                  indexed: true,
                  retryable: true,
                  last_error: "embedding failure",
                },
              ],
            };
          },
        };
      }
      if (String(url).includes("/api/ai/ingest")) {
        ingestCalls += 1;
        return {
          ok: true,
          async json() {
            return { status: "ok", document_statuses: [{ id: "remote", status: "updated" }] };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return [{ id: "remote", title: "Remote", source_type: "article", chunk_count: 1 }];
        },
      };
    },
  });

  await flushAsyncWork();
  context.setTab("knowledge");
  await context.AskWellState.refreshDiagnostics();
  await flushAsyncWork();

  assert.match(app.innerHTML, /sqlite \/ needs_attention/);
  assert.match(app.innerHTML, /embedding failure/);
  assert.match(app.innerHTML, /Retry/);

  await context.retryDocument("remote");
  assert.equal(ingestCalls, 1);
});

test("knowledge search filters article cards", () => {
  const { app, context } = createAppContext();
  context.setTab("knowledge");
  context.setSearch({ currentTarget: { value: "ollama" } });
  assert.equal(articleCount(app.innerHTML), 1);
  assert.match(app.innerHTML, /Connect a real AI model/);
});

test("state module centralizes tab and article updates", () => {
  const { app, context } = createAppContext();
  context.AskWellState.setTab("knowledge");
  assert.equal(context.AskWellState.getState().tab, "knowledge");
  assert.match(app.innerHTML, /Knowledge base/);

  const form = new FakeElement("article-form");
  form.fields = {
    title: "State Module",
    tags: "architecture",
    content: "State updates are routed through AskWellState.",
  };
  context.AskWellState.addArticle({ preventDefault() {}, currentTarget: form });

  assert.equal(context.AskWellState.getState().articles[0].title, "State Module");
  assert.match(app.innerHTML, /State Module/);
});

test("retrieval module preserves keyword matching and fallback behavior", () => {
  const { context } = createAppContext();
  const answer = context.AskWellRetrieval.answerQuestion("How do trials work?", [
    {
      title: "Trial terms",
      tags: ["billing", "trial"],
      content: "Trials last 14 days.",
    },
  ]);

  assert.equal(answer.answer, "Trials last 14 days.");
  assert.deepEqual(Array.from(answer.sources), ["Trial terms"]);

  const fallback = context.AskWellRetrieval.answerQuestion("unknown topic", []);
  assert.deepEqual(Array.from(fallback.sources), []);
  assert.match(fallback.answer, /knowledge base yet/);
});

test("api client rejects HTTP errors with status and payload", async () => {
  const { context } = createAppContext({
    location: { protocol: "http:" },
    fetch: async () => ({
      ok: false,
      status: 409,
      async json() {
        return { error: "Workspace version conflict", latestVersion: 3 };
      },
    }),
  });

  await assert.rejects(
    context.AskWellApi.saveWorkspace({ expectedVersion: 1 }, "token"),
    (error) =>
      error.status === 409 &&
      error.payload.latestVersion === 3 &&
      /Workspace version conflict/.test(error.message),
  );
});

test("api client can request AI answers through the Node bridge", async () => {
  const { context } = createAppContext({
    location: { protocol: "http:" },
    fetch: async (url) => {
      if (String(url).includes("/api/workspace")) {
        return {
          ok: true,
          async json() {
            return {
              version: 1,
              settings: { brand: "Remote", accent: "#ef7d62", welcome: "Hi" },
              articles: [],
              conversations: [],
            };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return {
            answer: "Grounded answer",
            sources: ["Trial"],
            citations: [{ document_id: "trial", chunk_id: "trial:chunk-0", title: "Trial" }],
          };
        },
      };
    },
  });

  const answer = await context.AskWellApi.answerWithAi("How long is the trial?");
  assert.equal(answer.answer, "Grounded answer");
  assert.equal(answer.citations[0].chunk_id, "trial:chunk-0");
});

test("api client lists, ingests, and deletes AI documents through Node", async () => {
  const calls = [];
  const { context } = createAppContext({
    location: { protocol: "http:" },
    fetch: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return {
        ok: true,
        async json() {
          if (String(url).includes("/api/ai/documents") && !options.method) {
            return [{ id: "doc", title: "Doc", chunk_count: 1 }];
          }
          return { status: "ok", document_id: "doc", deleted: true };
        },
      };
    },
  });

  const documents = await context.AskWellApi.listDocuments();
  await context.AskWellApi.ingestDocuments(
    { articles: [{ id: "doc", title: "Doc", content: "Body" }] },
    "token",
  );
  await context.AskWellApi.deleteDocument("doc", "token");

  assert.equal(documents[0].id, "doc");
  const ingestCall = calls.find((call) => call.options.method === "POST");
  const deleteCall = calls.find((call) => call.options.method === "DELETE");
  assert.equal(ingestCall.options.headers["x-askwell-admin-token"], "token");
  assert.equal(deleteCall.options.method, "DELETE");
});

test("api client fetches AI diagnostics through Node", async () => {
  const { context } = createAppContext({
    location: { protocol: "http:" },
    fetch: async (url) => ({
      ok: true,
      async json() {
        if (String(url).includes("/api/ai/diagnostics")) {
          return { backend: "turso-libsql-hosted", documentCount: 1, integrityCheck: "not-available" };
        }
        return { version: 1, settings: {}, articles: [], conversations: [] };
      },
    }),
  });

  const diagnostics = await context.AskWellApi.getDiagnostics();
  assert.equal(diagnostics.backend, "turso-libsql-hosted");
  assert.equal(diagnostics.status, "healthy");
  assert.equal(diagnostics.document_count, 1);
  assert.equal(diagnostics.integrity_check, "not-available");
});

test("api client selects hosted mode and sends browser-generated vectors", async () => {
  const calls = [];
  const hostedVector = Array.from({ length: 384 }, (_, index) => (index === 0 ? 1 : 0));
  const { context } = createAppContext({
    location: { protocol: "http:" },
    localStorage: { "askwell-api-mode": "hosted", "askwell-admin-token": "token" },
    fetch: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return {
        ok: true,
        async json() {
          if (String(url).includes("/api/ai/answer")) {
            return {
              answer: "Hosted answer",
              citations: [{ documentId: "trial", chunkId: "trial:chunk-0", title: "Trial" }],
              insufficientContext: false,
            };
          }
          if (String(url).includes("/api/ai/ingest")) {
            return { documentStatuses: [{ id: "trial", status: "created" }] };
          }
          return { apiMode: "hosted", hostedConfigured: true };
        },
      };
    },
  });
  context.AskWellHostedEmbeddings.__setEmbedderForTests(async () => hostedVector);
  context.AskWellApi.runtimeConfig.csrfToken = "csrf-token";

  const answer = await context.AskWellApi.answerWithAi("Do I need a card?");
  const ingest = await context.AskWellApi.ingestDocuments(
    { articles: [{ id: "trial", title: "Trial", content: "A card is not required." }] },
    "token",
  );

  const answerBody = JSON.parse(calls.find((call) => call.url.includes("/api/ai/answer")).options.body);
  const answerCall = calls.find((call) => call.url.includes("/api/ai/answer"));
  const ingestBody = JSON.parse(calls.find((call) => call.url.includes("/api/ai/ingest")).options.body);
  assert.equal(context.AskWellApi.isHostedMode(), true);
  assert.equal(answerCall.options.headers["x-askwell-admin-token"], undefined);
  assert.equal(answerCall.options.headers["x-askwell-csrf-token"], "csrf-token");
  assert.equal(answerBody.embeddingProfileId, "xenova-all-minilm-l6-v2-transformersjs-fp32-v1");
  assert.equal(answerBody.queryVector.length, 384);
  assert.equal(answer.citations[0].chunk_id, "trial:chunk-0");
  assert.equal(ingestBody.embeddingProfile.id, "xenova-all-minilm-l6-v2-transformersjs-fp32-v1");
  assert.equal(ingestBody.documents[0].chunks[0].id, "trial:chunk-0");
  assert.equal(ingestBody.documents[0].vectors[0].length, 384);
  assert.equal(ingest.document_statuses[0].status, "created");
  assert.equal(calls.some((call) => call.options.headers?.["x-askwell-admin-token"] === "token"), false);
});

test("api client reports hosted embedding model failures", async () => {
  const { context } = createAppContext({
    location: { protocol: "http:" },
    localStorage: { "askwell-api-mode": "hosted" },
    fetch: async () => ({ ok: true, async json() { return {}; } }),
  });
  context.AskWellHostedEmbeddings.__setEmbedderForTests(async () => {
    throw new Error("model unavailable");
  });

  await assert.rejects(
    () => context.AskWellApi.answerWithAi("Can I test hosted mode?"),
    /model unavailable/,
  );
});

test("chat questions create answers, sources, and inbox entries", () => {
  const { app, context } = createAppContext();
  const form = new FakeElement("chat-form");
  const input = new FakeElement("input");
  input.value = "How do I install the widget script?";
  form.querySelector = () => input;

  context.askWidget({
    preventDefault() {},
    currentTarget: form,
  });

  assert.equal(input.value, "");
  assert.match(app.innerHTML, /Copy the widget script/);
  assert.match(app.innerHTML, /Sources: Install the chat widget/);

  context.setTab("inbox");
  assert.match(app.innerHTML, /How do I install the widget script\?/);
  assert.match(app.innerHTML, /Recent questions/);
});

test("chat preview displays AI citations when the service responds", async () => {
  const { app, context } = createAppContext({
    location: { protocol: "http:" },
    fetch: async (url, options = {}) => {
      if (!options.method) {
        return {
          ok: true,
          async json() {
            return {
              version: 1,
              settings: { brand: "Remote", accent: "#ef7d62", welcome: "Hi" },
              articles: [],
              conversations: [],
            };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return {
            answer: "Trials last 14 days.",
            sources: ["Start a free trial"],
            citations: [
              {
                document_id: "trial",
                chunk_id: "trial:chunk-0",
                title: "Start a free trial",
              },
            ],
          };
        },
      };
    },
  });
  await flushAsyncWork();

  const form = new FakeElement("chat-form");
  const input = new FakeElement("input");
  input.value = "How long is the trial?";
  form.querySelector = () => input;

  await context.askWidget({ preventDefault() {}, currentTarget: form });

  assert.match(app.innerHTML, /Trials last 14 days/);
  assert.match(app.innerHTML, /Citations:/);
  assert.match(app.innerHTML, /trial:chunk-0/);
});

test("hosted widget answers from indexed articles and abstains without evidence", async () => {
  const store = createMemoryHostedStore();
  let workspace = {
    version: 1,
    settings: { brand: "Hosted", accent: "#ef7d62", welcome: "Hi" },
    articles: [
      {
        id: "trial-policy",
        title: "Trial policy",
        tags: ["billing"],
        content: "AskWell offers a 14 day trial. A payment card is not required during the trial.",
      },
      {
        id: "widget-install",
        title: "Widget install",
        tags: ["setup"],
        content: "Copy the widget script from the Install page and paste it before the closing body tag.",
      },
    ],
    conversations: [],
  };
  const requests = [];
  const jsonResponse = (payload, ok = true, status = ok ? 200 : 500) => ({
    ok,
    status,
    async json() {
      return payload;
    },
  });
  const retrievalSnapshotFor = (chunkIds) => {
    const snapshot = store.getRetrievalSnapshot("default");
    const allowed = new Set(chunkIds);
    return {
      chunks: snapshot.chunks.filter((chunk) => allowed.has(chunk.id || chunk.chunkId)),
      embeddings: snapshot.embeddings.filter((embedding) => allowed.has(embedding.chunkId)),
    };
  };

  const { app, context } = createAppContext({
    localStorage: {
      "askwell-api-mode": "hosted",
      "askwell-lite-state": JSON.stringify({ ...workspace, tab: "knowledge", messages: [] }),
    },
    location: { protocol: "https:" },
    fetch: async (url, options = {}) => {
      const path = String(url);
      const method = String(options.method || "GET").toUpperCase();
      requests.push({ path, method, body: options.body });
      if (path.includes("/api/config")) {
        return jsonResponse({ apiMode: "hosted", hostedConfigured: true });
      }
      if (path.includes("/api/auth/session")) {
        return jsonResponse({
          authenticated: true,
          csrfToken: "csrf-token",
          expiresAt: "2099-01-01T00:00:00.000Z",
        });
      }
      if (path.includes("/api/workspace") && method === "GET") {
        return jsonResponse({ ...workspace });
      }
      if (path.includes("/api/workspace") && method === "PUT") {
        const body = JSON.parse(options.body || "{}");
        workspace = { ...body, version: workspace.version + 1 };
        return jsonResponse({ ...workspace });
      }
      if (path.includes("/api/ai/ingest")) {
        return jsonResponse(store.ingest(JSON.parse(options.body || "{}"), { workspaceId: "default" }));
      }
      if (path.includes("/api/ai/documents")) {
        return jsonResponse({ documents: store.listDocuments("default") });
      }
      if (path.includes("/api/ai/diagnostics")) {
        const documents = store.listDocuments("default");
        const snapshot = store.getRetrievalSnapshot("default");
        return jsonResponse({
          diagnostics: {
            status: "healthy",
            backend: "hosted",
            integrity_check: "not-available",
            document_count: documents.length,
            chunk_count: snapshot.chunks.length,
            embedding_count: snapshot.embeddings.length,
            documents,
          },
        });
      }
      if (path.includes("/api/ai/answer")) {
        const body = JSON.parse(options.body || "{}");
        const snapshot = store.getRetrievalSnapshot("default");
        const retrieval = retrieveWithPrefilter({
          question: body.question,
          queryVector: body.queryVector,
          chunkIndex: snapshot.chunks,
          vectorSnapshotForChunkIds: retrievalSnapshotFor,
          topK: body.topK || 5,
        });
        return jsonResponse(answerFromRetrieval({ question: body.question, ...retrieval }));
      }
      if (path.includes("/api/conversations") && method === "POST") {
        const body = JSON.parse(options.body || "{}");
        return jsonResponse({
          conversation: {
            id: "conversation-1",
            workspaceId: "default",
            status: body.status || "open",
            customerId: body.customerId || "anonymous",
            messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
          },
          messages: body.messages || [],
        });
      }
      return jsonResponse({ error: "not found" }, false, 404);
    },
  });
  context.AskWellHostedEmbeddings.__setEmbedderForTests(async (text) => tokenHashVector384(text));

  await flushAsyncWork();
  await context.indexAllArticles();
  await flushAsyncWork();

  assert.match(app.innerHTML, /2 indexed/);
  assert.equal(requests.some((request) => request.path.includes("/api/ai/ingest")), true);

  const answerForm = new FakeElement("chat-form");
  const answerInput = new FakeElement("input");
  answerInput.value = "How long is the trial?";
  answerForm.querySelector = () => answerInput;
  await context.askWidget({ preventDefault() {}, currentTarget: answerForm });

  assert.match(app.innerHTML, /14 day trial/);
  assert.match(app.innerHTML, /Citations:/);
  assert.match(app.innerHTML, /trial-policy:chunk-0/);
  assert.equal(requests.some((request) => request.path.includes("/api/conversations") && request.method === "POST"), true);

  const fallbackForm = new FakeElement("chat-form");
  const fallbackInput = new FakeElement("input");
  fallbackInput.value = "Does AskWell support SAML SSO?";
  fallbackForm.querySelector = () => fallbackInput;
  await context.askWidget({ preventDefault() {}, currentTarget: fallbackForm });

  const messages = context.AskWellState.getState().messages;
  const latest = messages[messages.length - 1];
  assert.equal(latest.insufficientContext, true);
  assert.equal(latest.citations.length, 0);
  assert.equal(latest.fallbackReason, "missing_required_evidence");
  assert.match(app.innerHTML, /I do not have enough information/);
});

test("chat preview falls back locally when AI service is unavailable", async () => {
  const { app, context } = createAppContext({
    location: { protocol: "http:" },
    fetch: async (_url, options = {}) => {
      if (!options.method) {
        return {
          ok: true,
          async json() {
            return {
              version: 1,
              settings: { brand: "Remote", accent: "#ef7d62", welcome: "Hi" },
              articles: [
                {
                  id: "widget",
                  title: "Install the chat widget",
                  tags: ["setup", "widget"],
                  content: "Copy the widget script before the closing body tag.",
                },
              ],
              conversations: [],
            };
          },
        };
      }
      return {
        ok: false,
        status: 503,
        async json() {
          return { error: "AI service unavailable" };
        },
      };
    },
  });
  await flushAsyncWork();

  const form = new FakeElement("chat-form");
  const input = new FakeElement("input");
  input.value = "How do I install the widget?";
  form.querySelector = () => input;

  await context.askWidget({ preventDefault() {}, currentTarget: form });

  assert.match(app.innerHTML, /Copy the widget script/);
  assert.match(app.innerHTML, /AI generation unavailable - local fallback/);
  assert.match(app.innerHTML, /Fallback: ai_generation_error/);
});

test("inbox conversations can be resolved and reopened", () => {
  const { app, context } = createAppContext();
  context.setTab("inbox");
  const firstId = app.innerHTML.match(/data-toggle-conversation="([^"]+)"/)[1];
  assert.match(app.innerHTML, /class="status open"/);
  context.toggleConversation(firstId);
  assert.match(app.innerHTML, /class="status resolved"/);
  context.toggleConversation(firstId);
  assert.match(app.innerHTML, /class="status open"/);
});

test("hosted agent inbox loads transcripts, filters conversations, replies, and updates status", async () => {
  const calls = [];
  const conversations = [
    {
      id: "conversation-1",
      workspaceId: "default",
      customerId: "visitor-1",
      status: "open",
      messageCount: 2,
      lastMessagePreview: "No card is required.",
      createdAt: "2026-01-01T10:00:00.000Z",
      updatedAt: "2026-01-01T10:01:00.000Z",
      lastMessageAt: "2026-01-01T10:01:00.000Z",
    },
    {
      id: "conversation-2",
      workspaceId: "default",
      customerId: "visitor-2",
      status: "resolved",
      messageCount: 1,
      lastMessagePreview: "Thanks",
      createdAt: "2026-01-01T09:00:00.000Z",
      updatedAt: "2026-01-01T09:00:00.000Z",
      lastMessageAt: "2026-01-01T09:00:00.000Z",
    },
  ];
  const messages = [
    {
      id: "message-1",
      conversationId: "conversation-1",
      senderType: "customer",
      content: "Do I need a card?",
      position: 0,
      createdAt: "2026-01-01T10:00:00.000Z",
    },
    {
      id: "message-2",
      conversationId: "conversation-1",
      senderType: "assistant",
      content: "No card is required.",
      position: 1,
      createdAt: "2026-01-01T10:01:00.000Z",
    },
  ];

  const { app, context } = createAppContext({
    location: { protocol: "https:" },
    localStorage: { "askwell-api-mode": "hosted" },
    fetch: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        async json() {
          if (String(url).includes("/api/config")) {
            return { apiMode: "hosted", hostedConfigured: true };
          }
          if (String(url).includes("/api/auth/session")) {
            return { authenticated: true, csrfToken: "csrf-token", expiresAt: "2099-01-01T00:00:00.000Z" };
          }
          if (String(url).includes("/api/workspace")) {
            return { version: 1, settings: {}, articles: [], conversations: [] };
          }
          if (String(url).includes("/api/ai/documents")) {
            return { documents: [] };
          }
          if (String(url).includes("/api/conversations/conversation-1/messages")) {
            messages.push({
              id: "message-3",
              conversationId: "conversation-1",
              senderType: "agent",
              content: JSON.parse(options.body).content,
              position: 2,
              createdAt: "2026-01-01T10:02:00.000Z",
            });
            conversations[0].lastMessagePreview = JSON.parse(options.body).content;
            conversations[0].messageCount = 3;
            return { conversation: conversations[0], message: messages.at(-1) };
          }
          if (String(url).includes("/api/conversations/conversation-1/status")) {
            conversations[0].status = JSON.parse(options.body).status;
            return { conversation: conversations[0] };
          }
          if (String(url).includes("/api/conversations/conversation-1")) {
            return { conversation: conversations[0], messages };
          }
          if (String(url).endsWith("/api/conversations")) {
            return { conversations };
          }
          return {};
        },
      };
    },
  });

  await flushAsyncWork();
  context.setTab("inbox");
  await context.refreshInbox();
  await flushAsyncWork();

  assert.match(app.innerHTML, /visitor-1/);
  assert.match(app.innerHTML, /Do I need a card\?/);
  assert.match(app.innerHTML, /No card is required\./);
  assert.match(app.innerHTML, /Assistant/);
  assert.match(app.innerHTML, /data-conversation-status="resolved"/);

  context.setInboxFilter("resolved");
  assert.match(app.innerHTML, /visitor-2/);
  assert.doesNotMatch(app.innerHTML, /visitor-1[\s\S]*No card is required\./);

  await context.selectInboxConversation("conversation-1");
  const form = new FakeElement("agent-reply-form");
  form.fields = {
    conversationId: "conversation-1",
    content: "A support agent can help with billing.",
  };
  await context.sendAgentReply({ preventDefault() {}, currentTarget: form });
  assert.equal(form.resetCalled, true);
  assert.match(app.innerHTML, /A support agent can help with billing\./);
  const replyCall = calls.find((call) => call.url.includes("/api/conversations/conversation-1/messages"));
  assert.equal(JSON.parse(replyCall.options.body).senderType, "agent");
  assert.equal(replyCall.options.headers["x-askwell-csrf-token"], "csrf-token");

  await context.updateConversationStatus("conversation-1", "resolved");
  assert.equal(conversations[0].status, "resolved");
  const statusCall = calls.find((call) => call.url.includes("/api/conversations/conversation-1/status"));
  assert.equal(statusCall.options.method, "PUT");
  assert.equal(statusCall.options.headers["x-askwell-csrf-token"], "csrf-token");

  await context.updateConversationStatus("conversation-1", "open");
  assert.equal(conversations[0].status, "open");
});

test("hosted agent inbox preserves the transcript when an agent reply fails", async () => {
  const { app, context } = createAppContext({
    location: { protocol: "https:" },
    localStorage: { "askwell-api-mode": "hosted" },
    fetch: async (url) => {
      const text = String(url);
      return {
        ok: !text.includes("/messages"),
        status: text.includes("/messages") ? 500 : 200,
        async json() {
          if (text.includes("/api/config")) {
            return { apiMode: "hosted", hostedConfigured: true };
          }
          if (text.includes("/api/auth/session")) {
            return { authenticated: true, csrfToken: "csrf-token", expiresAt: "2099-01-01T00:00:00.000Z" };
          }
          if (text.includes("/api/workspace")) {
            return { version: 1, settings: {}, articles: [], conversations: [] };
          }
          if (text.includes("/api/ai/documents")) {
            return { documents: [] };
          }
          if (text.includes("/messages")) {
            return { error: "Reply storage failed" };
          }
          if (text.includes("/api/conversations/conversation-1")) {
            return {
              conversation: {
                id: "conversation-1",
                workspaceId: "default",
                customerId: "visitor-1",
                status: "open",
                messageCount: 1,
                lastMessagePreview: "Hello",
              },
              messages: [
                {
                  id: "message-1",
                  conversationId: "conversation-1",
                  senderType: "customer",
                  content: "Hello",
                  position: 0,
                },
              ],
            };
          }
          if (text.endsWith("/api/conversations")) {
            return {
              conversations: [
                {
                  id: "conversation-1",
                  workspaceId: "default",
                  customerId: "visitor-1",
                  status: "open",
                  messageCount: 1,
                  lastMessagePreview: "Hello",
                },
              ],
            };
          }
          return {};
        },
      };
    },
  });

  await flushAsyncWork();
  context.setTab("inbox");
  await context.refreshInbox();
  const form = new FakeElement("agent-reply-form");
  form.fields = {
    conversationId: "conversation-1",
    content: "This will fail",
  };
  await context.sendAgentReply({ preventDefault() {}, currentTarget: form });

  assert.equal(form.resetCalled, undefined);
  assert.match(app.innerHTML, /Reply storage failed/);
  assert.match(app.innerHTML, /Hello/);
});

test("agent audit creates a multi-agent build summary", () => {
  const { app, context } = createAppContext();
  context.setTab("agents");
  assert.match(app.innerHTML, /Agent build room/);
  assert.match(app.innerHTML, /Not run yet/);
  context.runAgentAudit();
  assert.match(app.innerHTML, /Lead Agent/);
  assert.match(app.innerHTML, /Builder Agent/);
  assert.match(app.innerHTML, /QA Agent/);
});

test("install page escapes the embed snippet instead of executing it", () => {
  const { app, context } = createAppContext();
  context.setTab("install");
  assert.match(app.innerHTML, /Embed snippet/);
  assert.match(app.innerHTML, /&lt;script src=&quot;\.\/askwell-widget\.js&quot; defer&gt;&lt;\/script&gt;/);
});

test("widget settings update the install snippet and preview brand", () => {
  const { app, context } = createAppContext();
  const form = new FakeElement("settings-form");
  form.fields = {
    brand: "RepoPilot",
    accent: "#123456",
    welcome: "Welcome to RepoPilot support.",
    adminToken: "secret-token",
  };

  context.saveSettings({
    preventDefault() {},
    currentTarget: form,
  });

  context.setTab("install");
  assert.match(app.innerHTML, /RepoPilot/);
  assert.match(app.innerHTML, /#123456/);
  assert.match(app.innerHTML, /Welcome to RepoPilot support\./);
  assert.equal(context.localStorage.dump()["askwell-admin-token"], "secret-token");
  assert.doesNotMatch(app.innerHTML, /secret-token/);
});

test("hosted widget settings exchange access credential for a session without localStorage token", async () => {
  const calls = [];
  let loggedIn = false;
  const { context } = createAppContext({
    location: { protocol: "http:" },
    localStorage: { "askwell-api-mode": "hosted" },
    fetch: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return {
        ok: loggedIn || !String(url).includes("/api/auth/session"),
        status: loggedIn || !String(url).includes("/api/auth/session") ? 200 : 401,
        async json() {
          if (String(url).includes("/api/auth/session")) {
            return loggedIn
              ? { authenticated: true, csrfToken: "csrf-token", expiresAt: "2099-01-01T00:00:00.000Z" }
              : { error: "Private demo session is required", code: "missing_admin_auth" };
          }
          if (String(url).includes("/api/auth/login")) {
            loggedIn = true;
            return { authenticated: true, csrfToken: "csrf-token", expiresAt: "2099-01-01T00:00:00.000Z" };
          }
          return { version: 1, settings: {}, articles: [], conversations: [] };
        },
      };
    },
  });
  const form = new FakeElement("settings-form");
  form.fields = {
    brand: "Hosted Demo",
    accent: "#123456",
    welcome: "Welcome to the private demo.",
    adminToken: "secret-token",
  };

  await context.saveSettings({
    preventDefault() {},
    currentTarget: form,
  });

  const loginCall = calls.find((call) => call.url.includes("/api/auth/login"));
  assert.equal(JSON.parse(loginCall.options.body).accessCredential, "secret-token");
  assert.equal(context.localStorage.dump()["askwell-admin-token"], undefined);
  assert.equal(context.AskWellApi.runtimeConfig.csrfToken, "csrf-token");
  assert.equal(calls.some((call) => call.options.headers?.["x-askwell-admin-token"] === "secret-token"), false);
});

test("knowledge page offers private demo sign-in before hosted document requests are authorized", () => {
  const { app, context } = createAppContext({
    location: { protocol: "https:" },
    localStorage: { "askwell-api-mode": "hosted" },
    fetch: async (url) => ({
      ok: String(url).includes("/api/config"),
      status: String(url).includes("/api/config") ? 200 : 401,
      async json() {
        if (String(url).includes("/api/config")) {
          return { apiMode: "hosted", hostedConfigured: true };
        }
        return {
          error: "Private demo session is required",
          code: "missing_admin_auth",
          details: {},
        };
      },
    }),
  });

  context.setTab("knowledge");

  assert.match(app.innerHTML, /Private demo sign-in/);
  assert.match(app.innerHTML, /Access credential/);
  assert.doesNotMatch(app.innerHTML, /askwell-admin-token/);
});

test("knowledge page recovers with private demo sign-in when auth-required status is already rendered", () => {
  const persisted = {
    tab: "knowledge",
    settings: { brand: "AskWell", accent: "#ef7d62", welcome: "Hi" },
    articles: [],
    conversations: [],
    messages: [],
    documentStatus: {
      state: "failed",
      message: "Private demo session is required",
      documents: [],
      pendingIds: [],
      selectedId: "",
      diagnostics: null,
      diagnosticsState: "failed",
      diagnosticsMessage: "Private demo sign-in required.",
    },
  };
  const { app, context } = createAppContext({
    location: { protocol: "https:" },
    localStorage: { "askwell-lite-state": JSON.stringify(persisted) },
    fetch: async () => ({
      ok: false,
      status: 401,
      async json() {
        return { error: "Private demo session is required", code: "missing_admin_auth" };
      },
    }),
  });

  context.setTab("knowledge");

  assert.match(app.innerHTML, /Private demo session is required/);
  assert.match(app.innerHTML, /Private demo sign-in/);
  assert.match(app.innerHTML, /data-private-demo-login/);
  assert.match(app.innerHTML, /name="accessCredential"/);
  assert.equal(typeof context.loginPrivateDemo, "function");
  assert.doesNotMatch(app.innerHTML, /ASKWELL_ADMIN_TOKEN/);
});

test("knowledge private demo sign-in creates session and retries hosted diagnostics", async () => {
  const calls = [];
  let loggedIn = false;
  const { app, context } = createAppContext({
    location: { protocol: "https:" },
    localStorage: { "askwell-api-mode": "hosted", "askwell-admin-token": "old-local-token" },
    fetch: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return {
        ok: loggedIn || !String(url).includes("/api/auth/session"),
        status: loggedIn || !String(url).includes("/api/auth/session") ? 200 : 401,
        async json() {
          if (String(url).includes("/api/config")) {
            return { apiMode: "hosted", hostedConfigured: true };
          }
          if (String(url).includes("/api/auth/session")) {
            return loggedIn
              ? { authenticated: true, csrfToken: "csrf-token", expiresAt: "2099-01-01T00:00:00.000Z" }
              : { error: "Private demo session is required", code: "missing_admin_auth" };
          }
          if (String(url).includes("/api/auth/login")) {
            loggedIn = true;
            return { authenticated: true, csrfToken: "csrf-token", expiresAt: "2099-01-01T00:00:00.000Z" };
          }
          if (String(url).includes("/api/workspace")) {
            return { version: 2, settings: { brand: "Hosted Demo" }, articles: [], conversations: [] };
          }
          if (String(url).includes("/api/ai/documents")) {
            return { documents: [] };
          }
          if (String(url).includes("/api/ai/diagnostics")) {
            return {
              status: "healthy",
              backend: "hosted",
              documentCount: 0,
              chunkCount: 0,
              embeddingCount: 0,
              documents: [],
            };
          }
          return {};
        },
      };
    },
  });
  await flushAsyncWork();
  context.setTab("knowledge");

  const form = new FakeElement("private-demo-login");
  form.fields = { accessCredential: "private-demo-secret" };
  await context.loginPrivateDemo({
    preventDefault() {},
    currentTarget: form,
  });
  await flushAsyncWork();

  const loginCall = calls.find((call) => call.url.includes("/api/auth/login"));
  assert.equal(JSON.parse(loginCall.options.body).accessCredential, "private-demo-secret");
  assert.equal(context.AskWellApi.runtimeConfig.authenticated, true);
  assert.equal(context.AskWellApi.runtimeConfig.csrfToken, "csrf-token");
  assert.equal(context.localStorage.dump()["askwell-admin-token"], undefined);
  assert.equal(calls.some((call) => call.options.headers?.["x-askwell-admin-token"]), false);
  assert.ok(calls.some((call) => call.url.includes("/api/workspace")));
  assert.ok(calls.some((call) => call.url.includes("/api/ai/documents")));
  assert.ok(calls.some((call) => call.url.includes("/api/ai/diagnostics")));
  assert.match(app.innerHTML, /Private demo session active/);
  assert.match(app.innerHTML, /Storage healthy/);
});

test("knowledge private demo sign-in keeps the form when credentials are rejected", async () => {
  const calls = [];
  let phase = "startup";
  const { app, context } = createAppContext({
    localStorage: { "askwell-api-mode": "hosted" },
  });
  context.location = { protocol: "https:" };
  context.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), options, phase });
      const isLogin = String(url).includes("/api/auth/login");
      return {
        ok: !String(url).includes("/api/auth/session") && !isLogin,
        status: isLogin ? 403 : String(url).includes("/api/auth/session") ? 401 : 200,
        async json() {
          if (String(url).includes("/api/config")) {
            return { apiMode: "hosted", hostedConfigured: true };
          }
          if (isLogin) {
            return { error: "Admin credential is invalid", code: "invalid_admin_auth" };
          }
          if (String(url).includes("/api/auth/session")) {
            return { error: "Private demo session is required", code: "missing_admin_auth" };
          }
          return {};
        },
      };
    };
  await flushAsyncWork();
  context.setTab("knowledge");

  const form = new FakeElement("private-demo-login");
  form.fields = { accessCredential: "wrong-secret" };
  phase = "login";
  await context.loginPrivateDemo({
    preventDefault() {},
    currentTarget: form,
  });
  await flushAsyncWork();

  assert.equal(form.resetCalled, undefined);
  assert.equal(context.AskWellApi.runtimeConfig.authenticated, false);
  assert.equal(context.AskWellApi.runtimeConfig.csrfToken, "");
  const loginCalls = calls.filter((call) => call.phase === "login");
  assert.ok(loginCalls.some((call) => call.url.includes("/api/auth/login")));
  assert.equal(loginCalls.some((call) => call.url.includes("/api/workspace")), false);
  assert.equal(loginCalls.some((call) => call.url.includes("/api/ai/documents")), false);
  assert.equal(loginCalls.some((call) => call.url.includes("/api/ai/diagnostics")), false);
  assert.match(app.innerHTML, /Private demo access credential is incorrect/);
  assert.match(app.innerHTML, /Private demo sign-in/);
});

test("knowledge private demo sign-in reports when login succeeds but the session cookie is missing", async () => {
  const calls = [];
  let phase = "startup";
  const { app, context } = createAppContext({
    localStorage: { "askwell-api-mode": "hosted" },
  });
  context.location = { protocol: "https:" };
  context.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), options, phase });
      return {
        ok: !String(url).includes("/api/auth/session"),
        status: String(url).includes("/api/auth/session") ? 401 : 200,
        async json() {
          if (String(url).includes("/api/config")) {
            return { apiMode: "hosted", hostedConfigured: true };
          }
          if (String(url).includes("/api/auth/login")) {
            return { authenticated: true, csrfToken: "login-csrf", expiresAt: "2099-01-01T00:00:00.000Z" };
          }
          if (String(url).includes("/api/auth/session")) {
            return { error: "Private demo session is required", code: "missing_admin_auth" };
          }
          return {};
        },
      };
    };
  await flushAsyncWork();
  context.setTab("knowledge");

  const form = new FakeElement("private-demo-login");
  form.fields = { accessCredential: "private-demo-secret" };
  phase = "login";
  await context.loginPrivateDemo({
    preventDefault() {},
    currentTarget: form,
  });
  await flushAsyncWork();

  assert.equal(form.resetCalled, undefined);
  assert.equal(context.AskWellApi.runtimeConfig.authenticated, false);
  assert.equal(context.AskWellApi.runtimeConfig.csrfToken, "");
  const loginCalls = calls.filter((call) => call.phase === "login");
  assert.ok(loginCalls.some((call) => call.url.includes("/api/auth/login")));
  assert.ok(loginCalls.some((call) => call.url.includes("/api/auth/session")));
  assert.equal(loginCalls.some((call) => call.url.includes("/api/workspace")), false);
  assert.equal(loginCalls.some((call) => call.url.includes("/api/ai/documents")), false);
  assert.equal(loginCalls.some((call) => call.url.includes("/api/ai/diagnostics")), false);
  assert.match(app.innerHTML, /secure session cookie was not confirmed/);
  assert.match(app.innerHTML, /Private demo sign-in/);
});

test("knowledge private demo sign-in reports invalid confirmed sessions before protected requests", async () => {
  const calls = [];
  let loggedIn = false;
  let phase = "startup";
  const { app, context } = createAppContext({
    localStorage: { "askwell-api-mode": "hosted" },
  });
  context.location = { protocol: "https:" };
  context.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), options, phase });
      return {
        ok: !String(url).includes("/api/auth/session"),
        status: String(url).includes("/api/auth/session") ? 401 : 200,
        async json() {
          if (String(url).includes("/api/config")) {
            return { apiMode: "hosted", hostedConfigured: true };
          }
          if (String(url).includes("/api/auth/login")) {
            loggedIn = true;
            return { authenticated: true, csrfToken: "login-csrf", expiresAt: "2099-01-01T00:00:00.000Z" };
          }
          if (String(url).includes("/api/auth/session")) {
            return loggedIn
              ? { error: "Private demo session is invalid", code: "invalid_session" }
              : { error: "Private demo session is required", code: "missing_admin_auth" };
          }
          return {};
        },
      };
    };
  await flushAsyncWork();
  context.setTab("knowledge");

  const form = new FakeElement("private-demo-login");
  form.fields = { accessCredential: "private-demo-secret" };
  phase = "login";
  await context.loginPrivateDemo({
    preventDefault() {},
    currentTarget: form,
  });
  await flushAsyncWork();

  assert.equal(form.resetCalled, undefined);
  assert.equal(context.AskWellApi.runtimeConfig.authenticated, false);
  const loginCalls = calls.filter((call) => call.phase === "login");
  assert.ok(loginCalls.some((call) => call.url.includes("/api/auth/login")));
  assert.ok(loginCalls.some((call) => call.url.includes("/api/auth/session")));
  assert.equal(loginCalls.some((call) => call.url.includes("/api/workspace")), false);
  assert.match(app.innerHTML, /secure session cookie was not confirmed/);
  assert.match(app.innerHTML, /Private demo sign-in/);
});

test("knowledge private demo sign-in continues when browser clears event currentTarget", async () => {
  const calls = [];
  let loggedIn = false;
  const { app, context } = createAppContext({
    location: { protocol: "https:" },
    localStorage: { "askwell-api-mode": "hosted" },
    fetch: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return {
        ok: loggedIn || !String(url).includes("/api/auth/session"),
        status: loggedIn || !String(url).includes("/api/auth/session") ? 200 : 401,
        async json() {
          if (String(url).includes("/api/config")) {
            return { apiMode: "hosted", hostedConfigured: true };
          }
          if (String(url).includes("/api/auth/session")) {
            return loggedIn
              ? { authenticated: true, csrfToken: "csrf-token", expiresAt: "2099-01-01T00:00:00.000Z" }
              : { error: "Private demo session is required", code: "missing_admin_auth" };
          }
          if (String(url).includes("/api/auth/login")) {
            loggedIn = true;
            return { authenticated: true, csrfToken: "csrf-token", expiresAt: "2099-01-01T00:00:00.000Z" };
          }
          if (String(url).includes("/api/workspace")) {
            return { version: 3, settings: { brand: "Hosted Demo" }, articles: [], conversations: [] };
          }
          if (String(url).includes("/api/ai/documents")) {
            return { documents: [{ id: "doc-1", title: "Demo doc", status: "indexed", chunk_count: 1 }] };
          }
          if (String(url).includes("/api/ai/diagnostics")) {
            return {
              status: "healthy",
              backend: "hosted",
              documentCount: 1,
              chunkCount: 1,
              embeddingCount: 1,
              documents: [{ id: "doc-1", title: "Demo doc", status: "indexed", chunk_count: 1 }],
            };
          }
          return {};
        },
      };
    },
  });
  await flushAsyncWork();
  context.setTab("knowledge");

  const form = new FakeElement("private-demo-login");
  form.fields = { accessCredential: "private-demo-secret" };
  let currentTarget = form;
  await context.loginPrivateDemo({
    preventDefault() {},
    get currentTarget() {
      const value = currentTarget;
      currentTarget = null;
      return value;
    },
  });
  await flushAsyncWork();

  assert.equal(form.resetCalled, true);
  assert.ok(calls.some((call) => call.url.includes("/api/auth/login")));
  assert.ok(calls.some((call) => call.url.includes("/api/workspace")));
  assert.ok(calls.some((call) => call.url.includes("/api/ai/documents")));
  assert.ok(calls.some((call) => call.url.includes("/api/ai/diagnostics")));
  assert.match(app.innerHTML, /Private demo session active/);
  assert.match(app.innerHTML, /Storage healthy/);
  assert.match(app.innerHTML, /1 indexed/);
});

test("knowledge private demo sign-in keeps hydrating when a detached form reset fails", async () => {
  const calls = [];
  let loggedIn = false;
  let resetWarnings = 0;
  let submittedForm = null;
  const { app, context } = createAppContext({
    location: { protocol: "https:" },
    localStorage: { "askwell-api-mode": "hosted" },
    fetch: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return {
        ok: loggedIn || !String(url).includes("/api/auth/session"),
        status: loggedIn || !String(url).includes("/api/auth/session") ? 200 : 401,
        async json() {
          if (String(url).includes("/api/config")) {
            return { apiMode: "hosted", hostedConfigured: true };
          }
          if (String(url).includes("/api/auth/session")) {
            if (loggedIn && submittedForm) submittedForm.isConnected = false;
            return loggedIn
              ? { authenticated: true, csrfToken: "csrf-token", expiresAt: "2099-01-01T00:00:00.000Z" }
              : { error: "Private demo session is required", code: "missing_admin_auth" };
          }
          if (String(url).includes("/api/auth/login")) {
            loggedIn = true;
            return { authenticated: true, csrfToken: "csrf-token", expiresAt: "2099-01-01T00:00:00.000Z" };
          }
          if (String(url).includes("/api/workspace")) {
            return { version: 4, settings: { brand: "Hosted Demo" }, articles: [], conversations: [] };
          }
          if (String(url).includes("/api/ai/documents")) {
            return { documents: [{ id: "doc-1", title: "Demo doc", status: "indexed", chunk_count: 1 }] };
          }
          if (String(url).includes("/api/ai/diagnostics")) {
            return {
              status: "healthy",
              backend: "hosted",
              documentCount: 1,
              chunkCount: 1,
              embeddingCount: 1,
              documents: [{ id: "doc-1", title: "Demo doc", status: "indexed", chunk_count: 1 }],
            };
          }
          return {};
        },
      };
    },
  });
  context.console = {
    ...console,
    warn() {
      resetWarnings += 1;
    },
  };
  await flushAsyncWork();
  context.setTab("knowledge");

  const form = new FakeElement("private-demo-login");
  form.fields = { accessCredential: "private-demo-secret" };
  form.isConnected = true;
  Object.defineProperty(form, "reset", {
    configurable: true,
    get() {
      return () => {
        if (!form.isConnected) throw new TypeError("Cannot read properties of null (reading 'reset')");
        form.resetCalled = true;
      };
    },
  });

  submittedForm = form;
  await context.loginPrivateDemo({
    preventDefault() {},
    currentTarget: form,
  });
  await flushAsyncWork();

  assert.equal(resetWarnings, 1);
  assert.equal(context.AskWellApi.runtimeConfig.authenticated, true);
  assert.ok(calls.some((call) => call.url.includes("/api/workspace")));
  assert.ok(calls.some((call) => call.url.includes("/api/ai/documents")));
  assert.ok(calls.some((call) => call.url.includes("/api/ai/diagnostics")));
  assert.match(app.innerHTML, /Private demo session active/);
  assert.match(app.innerHTML, /Storage healthy/);
  assert.match(app.innerHTML, /1 indexed/);
  assert.doesNotMatch(app.innerHTML, /Cannot read properties of null/);
});

test("diagnostics failures show the API error and repeated checks share the pending request", async () => {
  let diagnosticsCalls = 0;
  let resolveDiagnostics;
  const diagnosticsStarted = new Promise((resolve) => {
    resolveDiagnostics = resolve;
  });
  const { app, context } = createAppContext({
    location: { protocol: "https:" },
    localStorage: { "askwell-api-mode": "hosted" },
    fetch: async (url) => {
      if (String(url).includes("/api/config")) {
        return {
          ok: true,
          async json() {
            return { apiMode: "hosted", hostedConfigured: true };
          },
        };
      }
      if (String(url).includes("/api/auth/session")) {
        return {
          ok: true,
          async json() {
            return { authenticated: true, csrfToken: "csrf-token", expiresAt: "2099-01-01T00:00:00.000Z" };
          },
        };
      }
      if (String(url).includes("/api/workspace")) {
        return {
          ok: true,
          async json() {
            return { version: 1, settings: {}, articles: [], conversations: [] };
          },
        };
      }
      if (String(url).includes("/api/ai/documents")) {
        return {
          ok: true,
          async json() {
            return { documents: [] };
          },
        };
      }
      if (String(url).includes("/api/ai/diagnostics")) {
        diagnosticsCalls += 1;
        await diagnosticsStarted;
        return {
          ok: false,
          status: 503,
          async json() {
            return { error: "Hosted storage timeout", code: "storage_unavailable" };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return {};
        },
      };
    },
  });
  await flushAsyncWork();
  context.setTab("knowledge");

  const first = context.AskWellState.refreshDiagnostics();
  const second = context.AskWellState.refreshDiagnostics();
  await Promise.resolve();
  assert.equal(diagnosticsCalls, 1);
  resolveDiagnostics();
  await Promise.all([first, second]);
  await flushAsyncWork();

  assert.equal(diagnosticsCalls, 1);
  assert.match(app.innerHTML, /Hosted storage timeout/);
  assert.match(app.innerHTML, /hosted \/ unavailable/);
  assert.doesNotMatch(app.innerHTML, /Diagnostics unavailable/);
});

test("hosted expired sessions clear client state and show sign-in recovery", async () => {
  const { app, context } = createAppContext({
    location: { protocol: "https:" },
    localStorage: { "askwell-api-mode": "hosted" },
    fetch: async (url) => ({
      ok: !String(url).includes("/api/ai/documents"),
      status: String(url).includes("/api/ai/documents") ? 401 : 200,
      async json() {
        if (String(url).includes("/api/config")) {
          return { apiMode: "hosted", hostedConfigured: true };
        }
        if (String(url).includes("/api/auth/session")) {
          return { authenticated: true, csrfToken: "csrf-token", expiresAt: "2099-01-01T00:00:00.000Z" };
        }
        if (String(url).includes("/api/ai/documents")) {
          return { error: "Private demo session has expired", code: "session_expired" };
        }
        return { version: 1, settings: {}, articles: [], conversations: [] };
      },
    }),
  });
  await flushAsyncWork();
  context.AskWellApi.runtimeConfig.authenticated = true;
  context.AskWellApi.runtimeConfig.csrfToken = "csrf-token";
  context.setTab("knowledge");

  await context.AskWellState.refreshDocuments();

  assert.equal(context.AskWellApi.runtimeConfig.authenticated, false);
  assert.equal(context.AskWellApi.runtimeConfig.csrfToken, "");
  assert.match(app.innerHTML, /Private demo session expired\. Sign in again\./);
  assert.match(app.innerHTML, /Private demo sign-in/);
});

test("workspace export creates a JSON blob with current workspace data", () => {
  const { context } = createAppContext();
  context.exportWorkspace();

  assert.equal(context.__objectUrls.length, 1);
  assert.equal(context.__objectUrls[0].options.type, "application/json");
  assert.equal(context.__revokedUrls[0], "blob:test-1");

  const exported = JSON.parse(context.__objectUrls[0].parts[0]);
  assert.equal(exported.settings.brand, "AskWell");
  assert.equal(exported.articles.length, 4);
  assert.equal(exported.version, 1);
});

test("css includes responsive and delete-button safety rules", () => {
  assert.match(cssSource, /\.article-top/);
  assert.match(cssSource, /\.article \.button\.ghost\[data-delete\]/);
  assert.match(cssSource, /\.stat-grid/);
  assert.match(cssSource, /\.agent-board/);
  assert.match(cssSource, /@media \(max-width: 820px\)/);
  assert.match(cssSource, /@media \(max-width: 520px\)/);
});

test("embeddable widget boots, toggles, and answers known questions", () => {
  const created = [];
  const body = new FakeElement("body");
  const document = {
    body,
    createElement(tag) {
      const element = new FakeElement(tag);
      created.push(element);
      return element;
    },
  };
  const context = {
    document,
    window: {
      AskWellConfig: {
        brand: "TestWell",
        accent: "#123456",
      },
    },
  };

  vm.createContext(context);
  vm.runInContext(widgetSource, context, { filename: "askwell-widget.js" });

  assert.equal(body.children.length, 2);
  const [panel, launcher] = body.children;
  assert.equal(panel.hidden, true);
  assert.equal(launcher.textContent, "?");
  assert.equal(panel.querySelector("[data-title]").textContent, "TestWell Support");

  launcher.listeners.click();
  assert.equal(panel.hidden, false);

  const form = panel.querySelector("[data-form]");
  const input = panel.querySelector("[data-input]");
  const log = panel.querySelector("[data-log]");
  input.value = "Can I use a free trial without a card?";

  form.listeners.submit({ preventDefault() {} });

  assert.equal(input.value, "");
  assert.equal(log.children.length, 2);
  assert.equal(log.children[0].textContent, "Can I use a free trial without a card?");
  assert.match(log.children[1].textContent, /free to run/);
});

test("embeddable widget treats config values as untrusted", () => {
  const body = new FakeElement("body");
  const document = {
    body,
    createElement(tag) {
      return new FakeElement(tag);
    },
  };
  const context = {
    document,
    window: {
      AskWellConfig: {
        brand: `<img src=x onerror=alert(1)>`,
        accent: `red;background:url(javascript:alert(1))`,
      },
    },
  };

  vm.createContext(context);
  vm.runInContext(widgetSource, context, { filename: "askwell-widget.js" });

  const [panel, launcher] = body.children;
  assert.equal(
    panel.querySelector("[data-title]").textContent,
    "<img src=x onerror=alert(1)> Support",
  );
  assert.doesNotMatch(panel.innerHTML, /onerror/);
  assert.match(launcher.style.cssText, /background: #ef7d62/);
});

test("server workspace sanitizer keeps production data bounded", () => {
  const workspace = sanitizeWorkspace({
    settings: {
      brand: "  Production AskWell  ",
      accent: "not-a-color",
      welcome: "Hello".repeat(100),
    },
    articles: [
      {
        id: "article-1",
        title: "  Billing  ",
        tags: ["Billing", "", "Trial"],
        content: "Refund policy",
      },
      {
        id: "empty",
        title: "",
        content: "No title",
      },
    ],
    conversations: [
      {
        id: "conversation-1",
        status: "weird",
        question: "Can I export?",
        answer: "Yes",
        sources: ["Billing", ""],
      },
    ],
  });

  assert.equal(workspace.settings.brand, "Production AskWell");
  assert.equal(workspace.settings.accent, "#ef7d62");
  assert.equal(workspace.settings.welcome.length, 280);
  assert.equal(workspace.articles.length, 1);
  assert.deepEqual(workspace.articles[0].tags, ["billing", "trial"]);
  assert.equal(workspace.conversations[0].status, "open");
});

test("initial workspace creation seeds versioned data only when missing", async () => {
  await withTempWorkspace(async ({ workspacePath }) => {
    assert.equal(existsSync(workspacePath), false);
    const workspace = await ensureWorkspace({ workspacePath });
    assert.equal(workspace.version, 1);
    assert.equal(existsSync(workspacePath), true);

    const raw = JSON.parse(await readFile(workspacePath, "utf8"));
    assert.equal(raw.version, 1);
    assert.equal(raw.articles.length, 4);
  });
});

test("atomic writes replace the workspace and clean up temp files", async () => {
  await withTempWorkspace(async ({ directory, workspacePath }) => {
    await atomicWriteJson(workspacePath, { version: 1, ok: true });
    await atomicWriteJson(workspacePath, { version: 2, ok: true });

    const raw = JSON.parse(await readFile(workspacePath, "utf8"));
    assert.equal(raw.version, 2);
    const leftovers = (await readdir(directory)).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  });
});

test("failed atomic write preserves last valid workspace", async () => {
  await withTempWorkspace(async ({ directory, workspacePath }) => {
    await atomicWriteJson(workspacePath, { version: 1, ok: true });

    await assert.rejects(
      atomicWriteJson(workspacePath, { version: 2, ok: false }, { failBeforeRename: true }),
      /Injected atomic rename failure/,
    );

    const raw = JSON.parse(await readFile(workspacePath, "utf8"));
    assert.equal(raw.version, 1);
    const leftovers = (await readdir(directory)).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  });
});

test("corrupted workspace is preserved and reported", async () => {
  await withTempWorkspace(async ({ workspacePath }) => {
    await writeFile(workspacePath, "{ broken json", "utf8");

    await assert.rejects(
      ensureWorkspace({ workspacePath }),
      /Workspace data is corrupted/,
    );

    assert.equal(await readFile(workspacePath, "utf8"), "{ broken json");

    await withServer(
      { NODE_ENV: "development", serverOptions: { workspacePath } },
      async ({ request }) => {
        const response = await request("/api/workspace");
        assert.equal(response.status, 500);
        assert.match((await response.json()).error, /Workspace data is corrupted/);
      },
    );
  });
});

test("version mismatch rejects stale workspace updates", async () => {
  await withTempWorkspace(async ({ workspacePath }) => {
    const first = await writeWorkspace(
      {
        expectedVersion: 1,
        settings: { brand: "First", accent: "#ef7d62", welcome: "Hello" },
        articles: [{ id: "a", title: "A", tags: [], content: "A" }],
        conversations: [],
      },
      { workspacePath },
    );
    assert.equal(first.version, 2);

    await assert.rejects(
      writeWorkspace(
        {
          expectedVersion: 1,
          settings: { brand: "Stale", accent: "#ef7d62", welcome: "Hello" },
          articles: [{ id: "b", title: "B", tags: [], content: "B" }],
          conversations: [],
        },
        { workspacePath },
      ),
      (error) => error.status === 409 && error.latestVersion === 2,
    );
  });
});

test("concurrent updates allow one writer and reject stale writers", async () => {
  await withTempWorkspace(async ({ workspacePath }) => {
    await ensureWorkspace({ workspacePath });
    const updates = [1, 2].map((index) =>
      writeWorkspace(
        {
          expectedVersion: 1,
          settings: {
            brand: `Writer ${index}`,
            accent: "#ef7d62",
            welcome: "Hello",
          },
          articles: [
            {
              id: `writer-${index}`,
              title: `Writer ${index}`,
              tags: [],
              content: "Concurrent update",
            },
          ],
          conversations: [],
        },
        { workspacePath },
      ).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      ),
    );

    const results = await Promise.all(updates);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => result.error?.status === 409).length, 1);
    assert.equal((await ensureWorkspace({ workspacePath })).version, 2);
  });
});

test("frontend shows save failure when remote persistence fails", async () => {
  let calls = 0;
  const { app, context } = createAppContext({
    location: { protocol: "http:" },
    setTimeout(callback) {
      callback();
      return 1;
    },
    clearTimeout() {},
    fetch: async (url, options = {}) => {
      calls += 1;
      if (!options.method) {
        return {
          ok: true,
          async json() {
            return {
              version: 1,
              settings: { brand: "Remote", accent: "#ef7d62", welcome: "Hi" },
              articles: [{ id: "remote", title: "Remote", tags: [], content: "Remote" }],
              conversations: [],
            };
          },
        };
      }
      return {
        ok: false,
        status: 500,
        async json() {
          return { error: "Injected save failure" };
        },
      };
    },
  });

  await flushAsyncWork();
  context.setTab("knowledge");
  const form = new FakeElement("article-form");
  form.fields = {
    title: "Will fail",
    tags: "test",
    content: "Remote save should fail.",
  };
  context.addArticle({ preventDefault() {}, currentTarget: form });
  await flushAsyncWork();

  assert.ok(calls >= 2);
  assert.match(app.innerHTML, /Injected save failure/);
});

test("frontend handles remote version conflicts explicitly", async () => {
  const { app, context } = createAppContext({
    location: { protocol: "http:" },
    setTimeout(callback) {
      callback();
      return 1;
    },
    clearTimeout() {},
    fetch: async (_url, options = {}) => {
      if (!options.method) {
        return {
          ok: true,
          async json() {
            return {
              version: 1,
              settings: { brand: "Remote", accent: "#ef7d62", welcome: "Hi" },
              articles: [{ id: "remote", title: "Remote", tags: [], content: "Remote" }],
              conversations: [],
            };
          },
        };
      }
      return {
        ok: false,
        status: 409,
        async json() {
          return {
            error: "Workspace version conflict",
            latestVersion: 2,
            workspace: {
              version: 2,
              settings: { brand: "Latest", accent: "#ef7d62", welcome: "Latest" },
              articles: [{ id: "latest", title: "Latest", tags: [], content: "Latest" }],
              conversations: [],
            },
          };
        },
      };
    },
  });

  await flushAsyncWork();
  context.setTab("knowledge");
  const form = new FakeElement("article-form");
  form.fields = {
    title: "Conflict",
    tags: "test",
    content: "This should be reloaded.",
  };
  context.addArticle({ preventDefault() {}, currentTarget: form });
  await flushAsyncWork();

  assert.match(app.innerHTML, /Conflict: reloaded v2/);
  assert.match(app.innerHTML, /Latest/);
});

test("server serves only allowlisted public assets and blocks private files", async () => {
  await withTempWorkspace(async ({ workspacePath }) => {
    await withServer(
      { NODE_ENV: "development", serverOptions: { workspacePath } },
      async ({ request }) => {
        const index = await request("/index.html");
        assert.equal(index.status, 200);
        assert.match(index.headers.get("content-security-policy"), /default-src 'self'/);

        const app = await request("/src/app.js");
        assert.equal(app.status, 200);

        const apiClient = await request("/src/api.js");
        assert.equal(apiClient.status, 200);

        const renderer = await request("/src/render/knowledge.js");
        assert.equal(renderer.status, 200);

        const blockedPaths = [
          "/server.mjs",
          "/package.json",
          "/tests/smoke.test.mjs",
          "/.github/workflows/test.yml",
          "/.git/config",
          "/data/workspace.json",
          "/%2e%2e/server.mjs",
          "/src/%2e%2e/server.mjs",
        ];

        for (const path of blockedPaths) {
          const response = await request(path);
          assert.notEqual(response.status, 200, `${path} should not be public`);
        }
      },
    );
  });
});

test("server AI bridge is optional, validates requests, and proxies answers", async () => {
  await withTempWorkspace(async ({ workspacePath }) => {
    await withServer(
      { NODE_ENV: "development", serverOptions: { workspacePath } },
      async ({ request }) => {
        const unavailable = await request("/api/ai/health");
        assert.equal(unavailable.status, 503);

        const invalid = await request("/api/ai/answer", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question: "" }),
        });
        assert.equal(invalid.status, 400);
      },
    );

    const calls = [];
    await withServer(
      {
        NODE_ENV: "development",
        serverOptions: {
          workspacePath,
          aiServiceUrl: "http://ai.local",
          aiFetch: async (url, options = {}) => {
            calls.push({ url, options });
            return {
              ok: true,
              status: 200,
              async text() {
                return JSON.stringify(
                  String(url).endsWith("/health")
                    ? { ok: true, chunks: 2 }
                    : {
                        answer: "RAG answer",
                        citations: [
                          {
                            document_id: "trial",
                            chunk_id: "trial:chunk-0",
                            title: "Trial",
                          },
                        ],
                      },
                );
              },
            };
          },
        },
      },
      async ({ request }) => {
        const health = await request("/api/ai/health");
        assert.equal(health.status, 200);
        assert.equal((await health.json()).available, true);

        const answer = await request("/api/ai/answer", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question: "How long is the trial?", topK: 3 }),
        });
        assert.equal(answer.status, 200);
        const payload = await answer.json();
        assert.equal(payload.answer, "RAG answer");
        assert.equal(calls.at(-1).options.body, JSON.stringify({ question: "How long is the trial?", top_k: 3 }));
      },
    );
  });
});

test("server AI document lifecycle routes proxy status and deletion safely", async () => {
  await withTempWorkspace(async ({ workspacePath }) => {
    const calls = [];
    await withServer(
      {
        NODE_ENV: "production",
        ASKWELL_ADMIN_TOKEN: "test-token-123456",
        serverOptions: {
          workspacePath,
          aiServiceUrl: "http://ai.local",
          aiFetch: async (url, options = {}) => {
            calls.push({ url: String(url), options });
            return {
              ok: !String(url).endsWith("/missing"),
              status: String(url).endsWith("/missing") ? 404 : 200,
              async text() {
                if (String(url).endsWith("/missing")) return JSON.stringify({ detail: "Document not found" });
                if (String(url).endsWith("/diagnostics")) {
                  return JSON.stringify({
                    backend: "sqlite",
                    status: "healthy",
                    readable: true,
                    writable: true,
                    integrity_check: "ok",
                    document_count: 1,
                    chunk_count: 1,
                    embedding_count: 1,
                  });
                }
                if (options.method === "DELETE") {
                  return JSON.stringify({ document_id: "doc", deleted: true, chunks_deleted: 1, status: "deleted" });
                }
                return JSON.stringify([{ id: "doc", title: "Doc", chunk_count: 1 }]);
              },
            };
          },
        },
      },
      async ({ request }) => {
        const listedUnauthorized = await request("/api/ai/documents");
        assert.equal(listedUnauthorized.status, 401);

        const listed = await request("/api/ai/documents", {
          headers: { "x-askwell-admin-token": "test-token-123456" },
        });
        assert.equal(listed.status, 200);
        assert.equal((await listed.json())[0].id, "doc");

        const diagnosticsUnauthorized = await request("/api/ai/diagnostics");
        assert.equal(diagnosticsUnauthorized.status, 401);

        const diagnostics = await request("/api/ai/diagnostics", {
          headers: { "x-askwell-admin-token": "test-token-123456" },
        });
        assert.equal(diagnostics.status, 200);
        assert.equal((await diagnostics.json()).backend, "sqlite");

        const unauthorized = await request("/api/ai/documents/doc", { method: "DELETE" });
        assert.equal(unauthorized.status, 401);

        const deleted = await request("/api/ai/documents/doc", {
          method: "DELETE",
          headers: { "x-askwell-admin-token": "test-token-123456" },
        });
        assert.equal(deleted.status, 200);
        assert.equal((await deleted.json()).chunks_deleted, 1);

        const missing = await request("/api/ai/documents/missing", {
          method: "DELETE",
          headers: { "x-askwell-admin-token": "test-token-123456" },
        });
        assert.equal(missing.status, 404);
        assert.match((await missing.json()).error, /Document not found/);
      },
    );
    assert.equal(calls.some((call) => call.options.method === "DELETE"), true);
  });
});

test("server AI ingest defaults to current workspace articles and stays protected", async () => {
  await withTempWorkspace(async ({ workspacePath }) => {
    const calls = [];
    await withServer(
      {
        NODE_ENV: "production",
        ASKWELL_ADMIN_TOKEN: "test-token-123456",
        serverOptions: {
          workspacePath,
          aiServiceUrl: "http://ai.local",
          aiFetch: async (_url, options = {}) => {
            calls.push(options);
            return {
              ok: true,
              status: 200,
              async text() {
                return JSON.stringify({
                  ingested_documents: 4,
                  chunks_indexed: 4,
                  duplicates_skipped: 0,
                  unchanged_skipped: 0,
                  status: "ok",
                });
              },
            };
          },
        },
      },
      async ({ request }) => {
        const unauthorized = await request("/api/ai/ingest", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        assert.equal(unauthorized.status, 401);

        const authorized = await request("/api/ai/ingest", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-askwell-admin-token": "test-token-123456",
          },
          body: JSON.stringify({}),
        });
        assert.equal(authorized.status, 200);
        assert.equal(JSON.parse(calls[0].body).articles.length, 4);
      },
    );
  });
});

test("server protects writes, validates JSON, and keeps API routes working", async () => {
  await withTempWorkspace(async ({ workspacePath }) => {
    await withServer(
      {
        NODE_ENV: "production",
        ASKWELL_ADMIN_TOKEN: "test-token-123456",
        serverOptions: { workspacePath },
      },
      async ({ request }) => {
      const health = await request("/api/health");
      assert.equal(health.status, 200);

      const unauthorized = await request("/api/workspace", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ articles: [] }),
      });
      assert.equal(unauthorized.status, 401);

      const malformed = await request("/api/workspace", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-askwell-admin-token": "test-token-123456",
        },
        body: "{not-json",
      });
      assert.equal(malformed.status, 400);

      const invalid = await request("/api/workspace", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-askwell-admin-token": "test-token-123456",
        },
        body: JSON.stringify(["not", "an", "object"]),
      });
      assert.equal(invalid.status, 400);

      const authorized = await request("/api/workspace", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-askwell-admin-token": "test-token-123456",
        },
        body: JSON.stringify({
          expectedVersion: 1,
          settings: {
            brand: "HTTP Test",
            accent: "#ef7d62",
            welcome: "Hello",
          },
          articles: [
            {
              id: "http-article",
              title: "HTTP Article",
              tags: ["test"],
              content: "Saved through the API.",
            },
          ],
          conversations: [],
        }),
      });
      assert.equal(authorized.status, 200);
      const saved = await authorized.json();
      assert.equal(saved.settings.brand, "HTTP Test");
      assert.equal(saved.version, 2);
      },
    );
  });
});

test("production server protects workspace reads, exports, and exposes only sanitized config", async () => {
  await withTempWorkspace(async ({ workspacePath }) => {
    await withServer(
      {
        NODE_ENV: "production",
        ASKWELL_ADMIN_TOKEN: "test-token-123456",
        serverOptions: { workspacePath, allowedHosts: ["127.0.0.1"] },
      },
      async ({ request }) => {
        const deniedWorkspace = await request("/api/workspace");
        assert.equal(deniedWorkspace.status, 401);

        const deniedExport = await request("/api/export");
        assert.equal(deniedExport.status, 401);

        const workspace = await request("/api/workspace", {
          headers: { "x-askwell-admin-token": "test-token-123456" },
        });
        assert.equal(workspace.status, 200);
        assert.equal((await workspace.json()).version, 1);

        const exported = await request("/api/export", {
          headers: { "x-askwell-admin-token": "test-token-123456" },
        });
        assert.equal(exported.status, 200);
        assert.equal((await exported.json()).settings.brand, "AskWell");

        const config = await request("/api/config");
        assert.equal(config.status, 200);
        const body = await config.json();
        assert.equal(body.authRequired, true);
        assert.equal(body.adminTokenConfigured, true);
        assert.equal(body.aiServiceTokenConfigured, false);
        assert.deepEqual(body.allowedHosts, ["127.0.0.1"]);
        assert.equal(JSON.stringify(body).includes("test-token-123456"), false);
      },
    );
  });
});

test("production server rejects disallowed host headers", async () => {
  await withTempWorkspace(async ({ workspacePath }) => {
    await withServer(
      {
        NODE_ENV: "production",
        ASKWELL_ADMIN_TOKEN: "test-token-123456",
        serverOptions: { workspacePath, allowedHosts: ["askwell.local"] },
      },
      async ({ request }) => {
        const response = await request("/api/health", {
          headers: { host: "evil.example" },
        });
        assert.equal(response.status, 421);
        assert.match((await response.json()).error, /Host is not allowed/);
      },
    );
  });
});

test("node AI proxy forwards the configured service token without exposing it in config", async () => {
  await withTempWorkspace(async ({ workspacePath }) => {
    const calls = [];
    await withServer(
      {
        NODE_ENV: "development",
        serverOptions: {
          workspacePath,
          aiServiceUrl: "http://ai.local",
          aiServiceToken: "service-token-123456",
          aiFetch: async (url, options = {}) => {
            calls.push({ url: String(url), options });
            return {
              ok: true,
              status: 200,
              async text() {
                return JSON.stringify({ ok: true, chunks: 0 });
              },
            };
          },
        },
      },
      async ({ request }) => {
        const health = await request("/api/ai/health");
        assert.equal(health.status, 200);
        assert.equal(calls[0].options.headers["x-askwell-ai-token"], "service-token-123456");

        const config = await request("/api/config");
        const body = await config.json();
        assert.equal(body.aiServiceTokenConfigured, true);
        assert.equal(JSON.stringify(body).includes("service-token-123456"), false);
      },
    );
  });
});

test("production CLI refuses to start without ASKWELL_ADMIN_TOKEN", async () => {
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["server.mjs"], {
      cwd: new URL("../", import.meta.url),
      env: {
        ...process.env,
        NODE_ENV: "production",
        ASKWELL_ADMIN_TOKEN: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => resolve({ code, stderr }));
  });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Refusing to start: ASKWELL_ADMIN_TOKEN must be at least 16 characters/);
});
