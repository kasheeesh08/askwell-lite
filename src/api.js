(function attachApi(root) {
  const MODE_STORAGE_KEY = "askwell-api-mode";
  const hostedModeValues = new Set(["hosted", "vercel-hosted"]);
  const runtimeConfig = {
    apiMode: configuredMode() || "local",
    hostedConfigured: false,
    authenticated: false,
    csrfToken: "",
  };

  function remoteApiAvailable() {
    return (
      typeof root.fetch === "function" &&
      typeof root.location !== "undefined" &&
      root.location.protocol !== "file:"
    );
  }

  function isHostedMode() {
    return hostedModeValues.has(runtimeConfig.apiMode);
  }

  async function initializeConfig() {
    if (!remoteApiAvailable()) return runtimeConfig;
    try {
      const config = await requestJson("./api/config", { skipModeHeaders: true });
      if (config.apiMode && hostedModeValues.has(config.apiMode)) {
        runtimeConfig.apiMode = config.apiMode;
        runtimeConfig.hostedConfigured = Boolean(config.hostedConfigured);
        await refreshHostedSession({ optional: true });
      }
      return runtimeConfig;
    } catch {
      return runtimeConfig;
    }
  }

  async function parseJson(response) {
    return response.json().catch(() => ({}));
  }

  async function requestJson(url, options = {}) {
    const { skipModeHeaders, skipCsrf, ...fetchOptions } = options;
    const method = String(fetchOptions.method || "GET").toUpperCase();
    const response = await root.fetch(url, {
      ...fetchOptions,
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        ...(isHostedMode() && !skipModeHeaders ? { "x-askwell-runtime": "hosted" } : {}),
        ...(isHostedMode() && !skipCsrf ? csrfHeaders(method) : {}),
        ...(fetchOptions.headers || {}),
      },
    });
    const payload = await parseJson(response);

    if (!response.ok) {
      const error = new Error(payload.error || `Request failed (${response.status})`);
      error.status = response.status;
      error.payload = payload;
      if (isHostedAuthError(error)) clearHostedSessionState();
      throw error;
    }

    return payload;
  }

  function adminHeaders(adminToken) {
    return !isHostedMode() && adminToken ? { "x-askwell-admin-token": adminToken } : {};
  }

  function csrfHeaders(method) {
    const mutating = method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
    return mutating && runtimeConfig.csrfToken ? { "x-askwell-csrf-token": runtimeConfig.csrfToken } : {};
  }

  async function loginHosted(accessCredential) {
    const payload = await requestJson("./api/auth/login", {
      method: "POST",
      skipModeHeaders: true,
      skipCsrf: true,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ accessCredential }),
    });
    runtimeConfig.authenticated = true;
    runtimeConfig.csrfToken = payload.csrfToken || "";
    runtimeConfig.sessionExpiresAt = payload.expiresAt || "";
    return payload;
  }

  async function refreshHostedSession(options = {}) {
    if (!isHostedMode() || !remoteApiAvailable()) return runtimeConfig;
    try {
      const payload = await requestJson("./api/auth/session", {
        skipModeHeaders: true,
        skipCsrf: true,
      });
      runtimeConfig.authenticated = true;
      runtimeConfig.csrfToken = payload.csrfToken || "";
      runtimeConfig.sessionExpiresAt = payload.expiresAt || "";
    } catch (error) {
      clearHostedSessionState();
      if (!options.optional) throw error;
    }
    return runtimeConfig;
  }

  async function logoutHosted() {
    try {
      await requestJson("./api/auth/logout", {
        method: "POST",
        skipModeHeaders: true,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({}),
      });
    } finally {
      clearHostedSessionState();
    }
  }

  async function loadWorkspace(adminToken) {
    return requestJson("./api/workspace", {
      headers: adminHeaders(adminToken),
    });
  }

  async function saveWorkspace(workspace, adminToken) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json",
    };

    Object.assign(headers, adminHeaders(adminToken));

    return requestJson("./api/workspace", {
      method: "PUT",
      headers,
      body: JSON.stringify(workspace),
    });
  }

  async function answerWithAi(question, topK = 5) {
    if (isHostedMode()) {
      const embedding = await hostedEmbeddings().embedQuestion(question);
      return normalizeAnswer(
        await requestJson("./api/ai/answer", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ ...embedding, topK }),
        }),
      );
    }

    return requestJson("./api/ai/answer", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ question, topK }),
    });
  }

  async function ingestDocuments(payload, adminToken) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (!isHostedMode() && adminToken) headers["x-askwell-admin-token"] = adminToken;
    const body = isHostedMode() ? await hostedEmbeddings().buildIngestPayload(payload || {}) : payload || {};
    return normalizeIngestResponse(await requestJson("./api/ai/ingest", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }));
  }

  async function listDocuments() {
    const payload = await requestJson("./api/ai/documents", {
      headers: {},
    });
    return normalizeDocuments(payload);
  }

  async function getDiagnostics() {
    return normalizeDiagnostics(await requestJson("./api/ai/diagnostics", {
      headers: {},
    }));
  }

  async function deleteDocument(documentId, adminToken) {
    const headers = { accept: "application/json" };
    Object.assign(headers, adminHeaders(adminToken));
    return requestJson(`./api/ai/documents/${encodeURIComponent(documentId)}`, {
      method: "DELETE",
      headers,
    });
  }

  function configuredMode() {
    const globalMode = root.ASKWELL_API_MODE || root.AskWellConfig?.apiMode;
    if (hostedModeValues.has(globalMode)) return globalMode;
    const metaMode = root.document?.querySelector?.('meta[name="askwell-api-mode"]')?.content;
    if (hostedModeValues.has(metaMode)) return metaMode;
    const savedMode = root.localStorage?.getItem?.(MODE_STORAGE_KEY);
    return hostedModeValues.has(savedMode) ? savedMode : "";
  }

  function hostedEmbeddings() {
    if (!root.AskWellHostedEmbeddings) {
      throw new Error("Hosted browser embeddings are not available");
    }
    return root.AskWellHostedEmbeddings;
  }

  function clearHostedSessionState() {
    runtimeConfig.authenticated = false;
    runtimeConfig.csrfToken = "";
    runtimeConfig.sessionExpiresAt = "";
  }

  function isHostedAuthError(error) {
    const code = error?.payload?.code;
    return (
      isHostedMode() &&
      (error?.status === 401 || error?.status === 403) &&
      (
        code === "missing_admin_auth" ||
        code === "invalid_admin_auth" ||
        code === "session_expired" ||
        code === "session_invalidated" ||
        code === "invalid_session" ||
        code === "csrf_required" ||
        code === "csrf_origin_mismatch"
      )
    );
  }

  function hostedAuthMessage(error) {
    const code = error?.payload?.code;
    if (code === "session_expired") return "Private demo session expired. Sign in again.";
    if (code === "session_invalidated") return "Private demo session was signed out. Sign in again.";
    if (code === "invalid_session") return "Private demo session is invalid. Sign in again.";
    if (code === "invalid_admin_auth") return "Private demo access credential is incorrect.";
    if (code === "csrf_required" || code === "csrf_origin_mismatch") {
      return "Private demo session could not be verified. Sign in again.";
    }
    if (code === "missing_admin_auth") return "Private demo sign-in required.";
    return error?.payload?.error || error?.message || "Private demo authentication failed.";
  }

  function normalizeIngestResponse(payload) {
    return {
      ...payload,
      document_statuses: payload.document_statuses || payload.documentStatuses || [],
    };
  }

  function normalizeDocuments(payload) {
    const documents = Array.isArray(payload) ? payload : payload.documents || [];
    return documents.map((document) => ({
      ...document,
      source_type: document.source_type || document.sourceType || "document",
      chunk_count: document.chunk_count ?? document.chunkCount ?? 0,
      content_hash: document.content_hash || document.contentHash || "",
      updated_at: document.updated_at || document.updatedAt || "",
      created_at: document.created_at || document.createdAt || "",
    }));
  }

  function normalizeDiagnostics(payload) {
    const diagnostics = payload.diagnostics || payload;
    return {
      ...diagnostics,
      status: diagnostics.status || (diagnostics.integrityCheck === "ok" || diagnostics.integrity_check === "ok" ? "healthy" : "checked"),
      backend: diagnostics.backend || "hosted",
      document_count: diagnostics.document_count ?? diagnostics.documentCount ?? 0,
      chunk_count: diagnostics.chunk_count ?? diagnostics.chunkCount ?? 0,
      embedding_count: diagnostics.embedding_count ?? diagnostics.embeddingCount ?? 0,
      documents: Array.isArray(diagnostics.documents) ? normalizeDocuments(diagnostics.documents) : [],
    };
  }

  function normalizeAnswer(payload) {
    return {
      ...payload,
      insufficient_context: payload.insufficient_context ?? payload.insufficientContext,
      fallback_reason: payload.fallback_reason || payload.fallbackReason || null,
      citations: (payload.citations || []).map((citation) => ({
        ...citation,
        chunk_id: citation.chunk_id || citation.chunkId,
        document_id: citation.document_id || citation.documentId,
      })),
    };
  }

  root.AskWellApi = {
    remoteApiAvailable,
    initializeConfig,
    isHostedMode,
    runtimeConfig,
    requestJson,
    loginHosted,
    refreshHostedSession,
    logoutHosted,
    isHostedAuthError,
    hostedAuthMessage,
    loadWorkspace,
    saveWorkspace,
    answerWithAi,
    ingestDocuments,
    listDocuments,
    getDiagnostics,
    deleteDocument,
  };
})(globalThis);
