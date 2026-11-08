(function attachApi(root) {
  function remoteApiAvailable() {
    return (
      typeof root.fetch === "function" &&
      typeof root.location !== "undefined" &&
      root.location.protocol !== "file:"
    );
  }

  async function parseJson(response) {
    return response.json().catch(() => ({}));
  }

  async function requestJson(url, options = {}) {
    const response = await root.fetch(url, {
      headers: {
        accept: "application/json",
        ...(options.headers || {}),
      },
      ...options,
    });
    const payload = await parseJson(response);

    if (!response.ok) {
      const error = new Error(payload.error || `Request failed (${response.status})`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return payload;
  }

  function adminHeaders(adminToken) {
    return adminToken ? { "x-askwell-admin-token": adminToken } : {};
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
    if (adminToken) headers["x-askwell-admin-token"] = adminToken;
    return requestJson("./api/ai/ingest", {
      method: "POST",
      headers,
      body: JSON.stringify(payload || {}),
    });
  }

  async function listDocuments() {
    return requestJson("./api/ai/documents", {
      headers: adminHeaders(root.localStorage?.getItem?.("askwell-admin-token")),
    });
  }

  async function getDiagnostics() {
    return requestJson("./api/ai/diagnostics", {
      headers: adminHeaders(root.localStorage?.getItem?.("askwell-admin-token")),
    });
  }

  async function deleteDocument(documentId, adminToken) {
    const headers = { accept: "application/json" };
    Object.assign(headers, adminHeaders(adminToken));
    return requestJson(`./api/ai/documents/${encodeURIComponent(documentId)}`, {
      method: "DELETE",
      headers,
    });
  }

  root.AskWellApi = {
    remoteApiAvailable,
    requestJson,
    loadWorkspace,
    saveWorkspace,
    answerWithAi,
    ingestDocuments,
    listDocuments,
    getDiagnostics,
    deleteDocument,
  };
})(globalThis);
