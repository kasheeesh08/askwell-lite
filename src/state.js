(function attachState(root) {
  const STORAGE_KEY = "askwell-lite-state";
  const ADMIN_TOKEN_KEY = "askwell-admin-token";
  const VISITOR_ID_KEY = "askwell-visitor-id";
  const { clone, makeId } = root.AskWellUtils;
  const { normalizeState, articleFromForm, documentUpdateFromForm, isValidArticle } = root.AskWellValidation;
  const { answerQuestion } = root.AskWellRetrieval;
  const api = root.AskWellApi;
  const listeners = new Set();

  const defaultSettings = {
    brand: "AskWell",
    accent: "#ef7d62",
    welcome: "Hi, I am AskWell. Ask me about trials, billing, setup, or AI upgrades.",
  };

  const sampleArticles = [
    {
      id: makeId(),
      title: "Start a free trial",
      tags: ["billing", "trial"],
      content:
        "New teams get a 14 day trial. A card is not required. Trial workspaces include one admin seat, the support widget, and up to 100 demo conversations.",
    },
    {
      id: makeId(),
      title: "Install the chat widget",
      tags: ["setup", "widget"],
      content:
        "Copy the widget script from the Install tab and paste it before the closing body tag on your website. The static starter uses local knowledge base answers.",
    },
    {
      id: makeId(),
      title: "Cancel or downgrade",
      tags: ["billing", "account"],
      content:
        "Open billing settings, choose Cancel plan, and confirm the change. Free workspaces keep their knowledge base and can export conversations anytime.",
    },
    {
      id: makeId(),
      title: "Connect a real AI model",
      tags: ["ai", "upgrade"],
      content:
        "The free version uses keyword retrieval in the browser. For production, connect an API route to OpenAI, Groq, Gemini, or a local Ollama server and keep keys on the server.",
    },
  ];

  const defaultState = {
    version: 1,
    tab: "overview",
    search: "",
    settings: defaultSettings,
    articles: sampleArticles,
    conversations: [
      {
        id: makeId(),
        status: "open",
        question: "Can I run this without paying for an AI API?",
        answer:
          "Yes. The starter answers from your saved knowledge base in the browser. You only need paid services when you want hosted AI, hosted auth, or managed storage.",
        sources: ["Connect a real AI model"],
        createdAt: new Date().toISOString(),
      },
    ],
    messages: [
      {
        role: "bot",
        text: "Hi, I am AskWell. Ask me about trials, billing, setup, or AI upgrades.",
      },
    ],
    documentStatus: {
      state: "idle",
      message: "Knowledge index ready",
      documents: [],
      pendingIds: [],
      indexResults: {},
      selectedId: "",
      diagnostics: null,
      diagnosticsState: "idle",
      diagnosticsMessage: "Diagnostics not checked",
    },
  };

  let state = loadState();
  let remoteSaveTimer;
  let diagnosticsRefreshPromise = null;
  let saveStatus = {
    state: api.remoteApiAvailable() ? "idle" : "local",
    message: api.remoteApiAvailable() ? "Ready" : "Local fallback",
  };

  function notify() {
    listeners.forEach((listener) => listener());
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function getState() {
    return state;
  }

  function getSaveStatus() {
    return saveStatus;
  }

  function getAdminToken() {
    if (api.isHostedMode()) return "";
    return root.localStorage.getItem(ADMIN_TOKEN_KEY);
  }

  function getVisitorId() {
    let visitorId = root.localStorage.getItem(VISITOR_ID_KEY);
    if (!visitorId) {
      visitorId = `anonymous-${makeId()}`;
      root.localStorage.setItem(VISITOR_ID_KEY, visitorId);
    }
    return visitorId;
  }

  function resetForm(formElement) {
    if (!formElement) return false;
    try {
      const reset = formElement.reset;
      if (typeof reset !== "function") return false;
      reset.call(formElement);
      return true;
    } catch (error) {
      root.console?.warn?.("AskWell skipped form reset after the form became unavailable.", error);
      return false;
    }
  }

  function hostedAuthRequired(error) {
    return typeof api.isHostedAuthError === "function" && api.isHostedAuthError(error);
  }

  function hostedAuthMessage(error) {
    return typeof api.hostedAuthMessage === "function"
      ? api.hostedAuthMessage(error)
      : error?.payload?.error || error?.message || "Private demo sign-in required.";
  }

  function setDocumentStatus(update) {
    const current = state.documentStatus || defaultState.documentStatus;
    const next = {
      ...current,
      ...update,
    };
    next.documents = Array.isArray(next.documents) ? next.documents : [];
    next.pendingIds = Array.isArray(next.pendingIds) ? next.pendingIds : [];
    next.indexResults = next.indexResults && typeof next.indexResults === "object" ? next.indexResults : {};
    next.selectedId = next.selectedId ? String(next.selectedId) : "";
    next.diagnostics = next.diagnostics && typeof next.diagnostics === "object" ? next.diagnostics : null;
    next.diagnosticsState = next.diagnosticsState || "idle";
    next.diagnosticsMessage = next.diagnosticsMessage || "";
    state = {
      ...state,
      documentStatus: next,
    };
    saveLocalState();
    notify();
  }

  function isDocumentPending(id) {
    const pendingIds = state.documentStatus?.pendingIds;
    return Array.isArray(pendingIds) && pendingIds.includes(id);
  }

  function setDocumentPending(id, pending) {
    const current = Array.isArray(state.documentStatus?.pendingIds)
      ? state.documentStatus.pendingIds
      : [];
    const pendingIds = pending
      ? Array.from(new Set([...current, id]))
      : current.filter((pendingId) => pendingId !== id);
    state = {
      ...state,
      documentStatus: {
        ...(state.documentStatus || defaultState.documentStatus),
        pendingIds,
      },
    };
    saveLocalState();
    notify();
  }

  function normalize(input = {}) {
    return normalizeState(input, defaultState);
  }

  function loadState() {
    try {
      const saved = JSON.parse(root.localStorage.getItem(STORAGE_KEY));
      if (saved && typeof saved === "object") {
        return normalizeState(saved, defaultState);
      }
    } catch {
      root.localStorage.removeItem(STORAGE_KEY);
    }
    return normalizeState(clone(defaultState), defaultState);
  }

  function saveLocalState() {
    root.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function saveState(options = {}) {
    saveLocalState();
    queueRemoteSave(options);
  }

  async function hydrateFromRemote() {
    if (!api.remoteApiAvailable()) return;

    try {
      const workspace = await api.loadWorkspace(getAdminToken());
      state = normalizeState({ ...state, ...workspace }, defaultState);
      saveStatus = { state: "saved", message: `Synced v${state.version}` };
      saveLocalState();
      notify();
      await refreshDocuments();
    } catch (error) {
      if (api.isHostedMode() && hostedAuthRequired(error)) {
        const message = hostedAuthMessage(error);
        saveStatus = { state: "failed", message };
        setDocumentStatus({
          state: "failed",
          message,
          diagnosticsState: "failed",
          diagnosticsMessage: message,
        });
        return;
      }
      saveStatus = { state: api.isHostedMode() ? "failed" : "local", message: api.isHostedMode() ? "Hosted sync unavailable" : "Local fallback" };
      notify();
    }
  }

  function queueRemoteSave(options = {}) {
    const syncIndex = options.syncIndex !== false;
    if (
      !api.remoteApiAvailable() ||
      typeof root.setTimeout !== "function" ||
      typeof root.clearTimeout !== "function"
    ) {
      return;
    }

    root.clearTimeout(remoteSaveTimer);
    saveStatus = { state: "saving", message: `Saving v${state.version}` };
    notify();
    remoteSaveTimer = root.setTimeout(async () => {
      try {
        const payload = await api.saveWorkspace(
          {
            expectedVersion: state.version,
            settings: state.settings,
            articles: state.articles,
            conversations: state.conversations,
          },
          getAdminToken(),
        );

        state = normalizeState({ ...state, ...payload, tab: state.tab }, defaultState);
        saveLocalState();
        saveStatus = { state: "saved", message: `Saved v${state.version}` };
        notify();
        if (syncIndex) ingestArticles(state.articles);
      } catch (error) {
        const payload = error.payload || {};
        if (api.isHostedMode() && hostedAuthRequired(error)) {
          saveStatus = {
            state: "failed",
            message: hostedAuthMessage(error),
          };
          notify();
          return;
        }
        if (error.status === 409) {
          if (payload.workspace) {
            state = normalizeState({ ...state, ...payload.workspace, tab: state.tab }, defaultState);
            saveLocalState();
          }
          saveStatus = {
            state: "conflict",
            message: `Conflict: reloaded v${payload.latestVersion || state.version}`,
          };
          notify();
          return;
        }

        saveStatus = {
          state: "failed",
          message: payload.error || error.message || "Save failed",
        };
        notify();
      }
    }, 250);
  }

  function setTab(tab) {
    state = { ...state, tab };
    saveLocalState();
    notify();
  }

  function addArticle(event) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const article = articleFromForm(new root.FormData(formElement), makeId);
    if (!isValidArticle(article)) return;

    state = { ...state, articles: [article, ...state.articles] };
    resetForm(formElement);
    saveState();
    notify();
  }

  async function ingestArticle(article) {
    return ingestArticles([article]);
  }

  function indexArticle(id) {
    const article = state.articles.find((candidate) => candidate.id === id);
    if (!article) {
      setDocumentStatus({
        state: "failed",
        message: "Article is no longer available",
      });
      return Promise.resolve();
    }
    return ingestArticle(article);
  }

  function indexAllArticles() {
    return ingestArticles(state.articles);
  }

  function summarizeIndexStatuses(statuses, fallback = "Knowledge index updated") {
    const counts = statuses.reduce((summary, status) => {
      const key = status.status || "updated";
      summary[key] = (summary[key] || 0) + 1;
      return summary;
    }, {});
    return [
      counts.created ? `${counts.created} created` : "",
      counts.updated ? `${counts.updated} updated` : "",
      counts.unchanged ? `${counts.unchanged} unchanged` : "",
      counts.failed ? `${counts.failed} failed` : "",
    ].filter(Boolean).join(", ") || fallback;
  }

  async function ingestArticles(articles) {
    if (!api.remoteApiAvailable()) return;
    const candidates = Array.isArray(articles)
      ? articles.filter((article) => isValidArticle(article) && !isDocumentPending(article.id))
      : [];
    if (!candidates.length) return;
    candidates.forEach((article) => setDocumentPending(article.id, true));
    setDocumentStatus({
      state: "saving",
      message: `Indexing ${candidates.length} article${candidates.length === 1 ? "" : "s"}`,
    });
    try {
      const result = await api.ingestDocuments({ articles: candidates }, getAdminToken());
      candidates.forEach((article) => setDocumentPending(article.id, false));
      const statuses = Array.isArray(result.document_statuses) ? result.document_statuses : [];
      const statusById = Object.fromEntries(
        statuses.map((status) => [
          status.id,
          {
            status: status.status || "updated",
            message: status.error || status.message || "",
            version: status.version,
            updatedAt: new Date().toISOString(),
          },
        ]),
      );
      setDocumentStatus({
        state: statuses.some((status) => status.status === "failed") ? "failed" : "saved",
        message: summarizeIndexStatuses(statuses),
        indexResults: {
          ...(state.documentStatus?.indexResults || {}),
          ...statusById,
        },
      });
      refreshDocuments({ preserveMessage: true });
    } catch (error) {
      candidates.forEach((article) => setDocumentPending(article.id, false));
      const message = hostedAuthRequired(error)
        ? hostedAuthMessage(error)
        : error.payload?.error || error.message || "Indexing failed";
      const failedResults = Object.fromEntries(
        candidates.map((article) => [
          article.id,
          {
            status: "failed",
            message,
            updatedAt: new Date().toISOString(),
          },
        ]),
      );
      setDocumentStatus({
        state: "failed",
        message,
        indexResults: {
          ...(state.documentStatus?.indexResults || {}),
          ...failedResults,
        },
      });
    }
  }

  async function refreshDocuments(options = {}) {
    if (!api.remoteApiAvailable()) return;
    const currentMessage = state.documentStatus?.message;
    if (!options.preserveMessage) {
      setDocumentStatus({ state: "loading", message: "Loading indexed documents" });
    }
    try {
      const documents = await api.listDocuments();
      const safeDocuments = Array.isArray(documents) ? documents : [];
      setDocumentStatus({
        state: "saved",
        message: options.preserveMessage
          ? currentMessage
          : `${safeDocuments.length} indexed document${safeDocuments.length === 1 ? "" : "s"}`,
        documents: safeDocuments,
      });
    } catch (error) {
      setDocumentStatus({
        state: "failed",
        message: hostedAuthRequired(error)
          ? hostedAuthMessage(error)
          : error.payload?.error || error.message || "Could not load index metadata",
      });
    }
  }

  async function refreshDiagnostics() {
    if (!api.remoteApiAvailable()) return;
    if (diagnosticsRefreshPromise) return diagnosticsRefreshPromise;
    diagnosticsRefreshPromise = (async () => {
      setDocumentStatus({
        diagnosticsState: "loading",
        diagnosticsMessage: "Checking storage diagnostics",
      });
      try {
        const diagnostics = await api.getDiagnostics();
        const stateName = diagnostics.status === "healthy" ? "saved" : "warning";
        setDocumentStatus({
          diagnostics,
          diagnosticsState: stateName,
          diagnosticsMessage: diagnostics.last_error || `Storage ${diagnostics.status || "checked"}`,
          documents: Array.isArray(diagnostics.documents)
            ? diagnostics.documents
            : state.documentStatus.documents,
        });
      } catch (error) {
        const message = hostedAuthRequired(error)
          ? hostedAuthMessage(error)
          : error.payload?.error || error.message || "Diagnostics unavailable";
        setDocumentStatus({
          diagnostics: {
            backend: api.isHostedMode() ? "hosted" : "unknown",
            status: "unavailable",
            last_error: message,
          },
          diagnosticsState: "failed",
          diagnosticsMessage: message,
        });
      } finally {
        diagnosticsRefreshPromise = null;
      }
    })();
    return diagnosticsRefreshPromise;
  }

  function selectDocument(id) {
    setDocumentStatus({ selectedId: id || "" });
  }

  async function reindexDocument(id) {
    if (isDocumentPending(id)) return;
    const article = state.articles.find((candidate) => candidate.id === id);
    if (!article) {
      setDocumentStatus({
        selectedId: id,
        state: "failed",
        message: "Paste replacement content to re-index this document",
      });
      return;
    }
    const confirmed =
      typeof root.confirm === "function"
        ? root.confirm(`Re-index "${article.title}" from the current article content?`)
        : true;
    if (!confirmed) return;
    await ingestArticle(article);
    selectDocument(id);
  }

  async function retryDocument(id) {
    if (isDocumentPending(id)) return;
    const article = state.articles.find((candidate) => candidate.id === id);
    if (!article) {
      setDocumentStatus({
        selectedId: id,
        state: "failed",
        message: "Recovery needs replacement content because original source content is unavailable",
      });
      return;
    }
    const confirmed =
      typeof root.confirm === "function"
        ? root.confirm(`Retry indexing "${article.title}" from the current article content?`)
        : true;
    if (!confirmed) return;
    await ingestArticle(article);
    await refreshDiagnostics();
  }

  async function deleteIndexedDocument(id) {
    if (!id || isDocumentPending(id)) return;
    const currentDocuments = Array.isArray(state.documentStatus?.documents)
      ? state.documentStatus.documents
      : [];
    const document = currentDocuments.find((candidate) => candidate.id === id);
    if (!document) {
      setDocumentStatus({
        selectedId: "",
        state: "failed",
        message: "Selected document is no longer available",
      });
      return;
    }
    const title = document.title || id;
    const confirmed =
      typeof root.confirm === "function"
        ? root.confirm(`Delete indexed document "${title}" (${id})? This removes its chunks and embeddings from the index.`)
        : true;
    if (!confirmed) return;

    setDocumentPending(id, true);
    setDocumentStatus({
      selectedId: id,
      state: "saving",
      message: `Deleting ${title}`,
    });
    try {
      await api.deleteDocument(id, getAdminToken());
      const remainingDocuments = currentDocuments.filter((candidate) => candidate.id !== id);
      setDocumentPending(id, false);
      setDocumentStatus({
        selectedId: remainingDocuments[0]?.id || "",
        state: "saved",
        message: `Deleted ${title} from the index`,
        documents: remainingDocuments,
      });
      await refreshDocuments({ preserveMessage: true });
      await refreshDiagnostics();
    } catch (error) {
      setDocumentPending(id, false);
      setDocumentStatus({
        selectedId: id,
        state: "failed",
        message: hostedAuthRequired(error)
          ? hostedAuthMessage(error)
          : error.payload?.error || error.message || "Delete failed",
      });
    }
  }

  async function updateDocument(event) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const update = documentUpdateFromForm(new root.FormData(formElement));
    if (!update.id || !update.title || !update.content) {
      setDocumentStatus({
        selectedId: update.id,
        state: "failed",
        message: "Document ID, title, and replacement content are required",
      });
      return;
    }
    if (isDocumentPending(update.id)) return;
    const confirmed =
      typeof root.confirm === "function"
        ? root.confirm(`Replace indexed content for "${update.title}"?`)
        : true;
    if (!confirmed) return;

    setDocumentPending(update.id, true);
    setDocumentStatus({
      selectedId: update.id,
      state: "saving",
      message: `Re-indexing ${update.title}`,
    });
    try {
      const result = await api.ingestDocuments(
        {
          documents: [
            {
              id: update.id,
              title: update.title,
              content: update.content,
              source_type: update.source_type,
              metadata: { tags: update.tags },
            },
          ],
        },
        getAdminToken(),
      );
      const status = Array.isArray(result.document_statuses)
        ? result.document_statuses.find((item) => item.id === update.id)
        : null;
      state = {
        ...state,
        articles: state.articles.map((article) =>
          article.id === update.id
            ? {
                ...article,
                title: update.title,
                tags: update.tags,
                content: update.content,
              }
            : article,
        ),
      };
      saveState({ syncIndex: false });
      setDocumentPending(update.id, false);
      setDocumentStatus({
        selectedId: update.id,
        state: "saved",
        message: status?.status === "unchanged"
          ? "Document unchanged; index already current"
          : `Document ${status?.status || "updated"}`,
      });
      refreshDocuments({ preserveMessage: true });
      resetForm(formElement);
    } catch (error) {
      setDocumentPending(update.id, false);
      setDocumentStatus({
        selectedId: update.id,
        state: "failed",
        message: hostedAuthRequired(error)
          ? hostedAuthMessage(error)
          : error.payload?.error || error.message || "Re-index failed",
      });
    }
  }

  async function deleteArticle(id) {
    if (isDocumentPending(id)) return;
    const article = state.articles.find((candidate) => candidate.id === id);
    if (!article) return;
    const confirmed =
      typeof root.confirm === "function"
        ? root.confirm(`Delete "${article.title}" from the workspace and AI index?`)
        : true;
    if (!confirmed) return;

    if (api.remoteApiAvailable()) {
      setDocumentPending(id, true);
      setDocumentStatus({ state: "saving", message: `Deleting ${article.title}` });
      try {
        await api.deleteDocument(id, getAdminToken());
      } catch (error) {
        setDocumentPending(id, false);
        setDocumentStatus({
          state: "failed",
          message: hostedAuthRequired(error)
            ? hostedAuthMessage(error)
            : error.payload?.error || error.message || "Delete failed",
        });
        return;
      }
      setDocumentPending(id, false);
      setDocumentStatus({ state: "saved", message: "Document deleted from index" });
      refreshDocuments({ preserveMessage: true });
    }

    state = {
      ...state,
      articles: state.articles.filter((article) => article.id !== id),
    };
    saveState();
    notify();
  }

  function setSearch(event) {
    state = { ...state, search: event.currentTarget.value };
    saveLocalState();
    notify();
  }

  function toggleConversation(id) {
    state = {
      ...state,
      conversations: state.conversations.map((conversation) =>
        conversation.id === id
          ? {
              ...conversation,
              status: conversation.status === "resolved" ? "open" : "resolved",
            }
          : conversation,
      ),
    };
    saveState();
    notify();
  }

  async function saveSettings(event) {
    event.preventDefault();
    const form = new root.FormData(event.currentTarget);
    const adminToken = form.get("adminToken")?.trim();
    if (adminToken) {
      if (api.isHostedMode()) {
        try {
          await api.loginHosted(adminToken);
          root.localStorage.removeItem(ADMIN_TOKEN_KEY);
          saveStatus = { state: "saved", message: "Private demo session active" };
        } catch (error) {
          saveStatus = {
            state: "failed",
            message: error.payload?.error || error.message || "Private demo login failed",
          };
          notify();
          return;
        }
      } else {
        root.localStorage.setItem(ADMIN_TOKEN_KEY, adminToken);
      }
    }
    const settings = {
      brand: form.get("brand").trim() || defaultSettings.brand,
      accent: form.get("accent") || defaultSettings.accent,
      welcome: form.get("welcome").trim() || defaultSettings.welcome,
    };
    state = {
      ...state,
      settings,
      messages: [{ role: "bot", text: settings.welcome }],
    };
    saveState();
    notify();
    hydrateFromRemote();
  }

  async function loginPrivateDemo(event) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new root.FormData(formElement);
    const accessCredential = form.get("accessCredential")?.trim();
    if (!accessCredential) {
      setDocumentStatus({
        state: "failed",
        message: "Private demo access credential is required",
        diagnosticsState: "failed",
        diagnosticsMessage: "Private demo access credential is required",
      });
      return;
    }

    saveStatus = { state: "saving", message: "Signing in" };
    setDocumentStatus({
      state: "loading",
      message: "Starting private demo session",
      diagnosticsState: "loading",
      diagnosticsMessage: "Starting private demo session",
    });
    try {
      await api.loginHosted(accessCredential);
      root.localStorage.removeItem(ADMIN_TOKEN_KEY);
      resetForm(formElement);
      saveStatus = { state: "saved", message: "Private demo session active" };
      setDocumentStatus({
        state: "saved",
        message: "Private demo session active",
        diagnosticsState: "idle",
        diagnosticsMessage: "Session active; checking storage",
      });
      await hydrateFromRemote();
      await refreshDiagnostics();
    } catch (error) {
      const message = hostedAuthMessage(error);
      saveStatus = { state: "failed", message };
      setDocumentStatus({
        state: "failed",
        message,
        diagnosticsState: "failed",
        diagnosticsMessage: message,
      });
    }
  }

  function localAnswer(question) {
    return answerQuestion(question, state.articles);
  }

  function pushConversation(question, result, status = "open") {
    const conversation = {
      id: makeId(),
      status,
      question,
      answer: result.answer,
      sources: result.sources,
      citations: result.citations || [],
      generation: result.generation || null,
      fallbackReason: result.fallbackReason || null,
      createdAt: new Date().toISOString(),
    };
    state = {
      ...state,
      messages: [
        ...state.messages,
        {
          role: "bot",
          text: result.answer,
          sources: result.sources,
          citations: result.citations || [],
          generation: result.generation || null,
          fallbackReason: result.fallbackReason || null,
          insufficientContext: Boolean(result.insufficientContext),
        },
      ].slice(-10),
      conversations: [
        conversation,
        ...state.conversations,
      ].slice(0, 20),
    };
    return conversation;
  }

  async function persistHostedConversation(question, result, status = "open") {
    if (!api.remoteApiAvailable() || !api.isHostedMode()) return;
    try {
      await api.createConversation({
        customerId: getVisitorId(),
        status,
        metadata: {
          source: "widget",
          fallbackReason: result.fallbackReason || null,
          insufficientContext: Boolean(result.insufficientContext),
          citations: result.citations || [],
        },
        messages: [
          {
            senderType: "customer",
            content: question,
            metadata: { source: "widget" },
          },
          {
            senderType: "assistant",
            content: result.answer,
            metadata: {
              sources: result.sources || [],
              citations: result.citations || [],
              generation: result.generation || null,
              fallbackReason: result.fallbackReason || null,
              insufficientContext: Boolean(result.insufficientContext),
            },
          },
        ],
      });
    } catch (error) {
      saveStatus = {
        state: "failed",
        message: error.payload?.error || error.message || "Conversation persistence failed",
      };
    }
  }

  function resetDemo() {
    state = normalizeState(clone(defaultState), defaultState);
    saveState();
    notify();
  }

  function runAgentAudit(qualityGates) {
    const gates = qualityGates(state);
    const missing = gates.filter((gate) => !gate.done).map((gate) => gate.label);
    state = {
      ...state,
      agentRun: {
        createdAt: new Date().toLocaleString(),
        summary: missing.length
          ? `${missing.length} launch checks still need attention.`
          : "All launch checks are green for a static MVP.",
        tasks: [
          {
            agent: "Lead Agent",
            status: "done",
            detail: "Mapped product surface into dashboard, widget, inbox, install, and repo checks.",
          },
          {
            agent: "Builder Agent",
            status: state.articles.length >= 4 ? "done" : "watch",
            detail: `${state.articles.length} knowledge articles are powering local answers.`,
          },
          {
            agent: "QA Agent",
            status: missing.length ? "watch" : "done",
            detail: missing.length
              ? `Next fixes: ${missing.join(", ")}.`
              : "Smoke tests, syntax checks, and GitHub Actions are ready.",
          },
        ],
      },
    };
    saveState();
    notify();
  }

  function exportWorkspace() {
    const payload = {
      exportedAt: new Date().toISOString(),
      settings: state.settings,
      articles: state.articles,
      conversations: state.conversations,
      version: state.version,
    };
    const blob = new root.Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = root.URL.createObjectURL(blob);
    const link = root.document.createElement("a");
    link.href = url;
    link.download = "askwell-workspace.json";
    link.click();
    root.URL.revokeObjectURL(url);
  }

  async function askWidget(event) {
    event.preventDefault();
    const input = event.currentTarget.querySelector("input");
    const question = input.value.trim();
    if (!question) return;

    state = {
      ...state,
      messages: [
        ...state.messages,
        { role: "user", text: question },
      ].slice(-10),
    };
    input.value = "";

    if (api.remoteApiAvailable()) {
      state = {
        ...state,
        messages: [...state.messages, { role: "bot", text: "Thinking..." }].slice(-10),
      };
      notify();
      try {
        const aiResult = await api.answerWithAi(question, 5);
        state = {
          ...state,
          messages: state.messages.slice(0, -1),
        };
        const result = {
          answer: aiResult.answer,
          sources: aiResult.sources || [],
          citations: aiResult.citations || [],
          generation: aiResult.generation || null,
          fallbackReason: aiResult.fallback_reason || null,
          insufficientContext: aiResult.insufficient_context,
        };
        pushConversation(question, result);
        await persistHostedConversation(question, result);
        saveState();
        notify();
        return;
      } catch (error) {
        state = {
          ...state,
          messages: state.messages.slice(0, -1),
        };
        const result = {
          ...localAnswer(question),
          sources: [`AI generation unavailable - local fallback (${error.message || "unknown error"})`],
          fallbackReason: "ai_generation_error",
        };
        pushConversation(question, result);
        await persistHostedConversation(question, result);
        saveState();
        notify();
        return;
      }
    }

    const result = localAnswer(question);
    pushConversation(question, result);
    saveState();
    notify();
  }

  root.AskWellState = {
    STORAGE_KEY,
    ADMIN_TOKEN_KEY,
    VISITOR_ID_KEY,
    defaultSettings,
    defaultState,
    normalize,
    getState,
    getSaveStatus,
    subscribe,
    saveLocalState,
    saveState,
    hydrateFromRemote,
    refreshDocuments,
    refreshDiagnostics,
    selectDocument,
    indexArticle,
    indexAllArticles,
    reindexDocument,
    retryDocument,
    deleteIndexedDocument,
    updateDocument,
    setTab,
    addArticle,
    deleteArticle,
    setSearch,
    toggleConversation,
    saveSettings,
    loginPrivateDemo,
    resetDemo,
    runAgentAudit,
    exportWorkspace,
    askWidget,
  };
})(globalThis);
