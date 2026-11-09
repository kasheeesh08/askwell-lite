(function attachValidation(root) {
  const tabs = ["overview", "knowledge", "inbox", "agents", "install"];

  function normalizeSettings(input = {}, defaults) {
    return {
      ...defaults,
      ...(input || {}),
    };
  }

  function normalizeConversation(conversation) {
    return {
      ...conversation,
      status: conversation.status === "resolved" ? "resolved" : "open",
      citations: Array.isArray(conversation.citations) ? conversation.citations : [],
    };
  }

  function normalizeMessage(message) {
    const role = ["user", "bot", "customer", "assistant", "agent", "status"].includes(message.role)
      ? message.role
      : "bot";
    return {
      ...message,
      role,
      text: String(message.text || ""),
      sources: Array.isArray(message.sources) ? message.sources : undefined,
      citations: Array.isArray(message.citations) ? message.citations : undefined,
      generation: message.generation && typeof message.generation === "object" ? message.generation : undefined,
      fallbackReason: message.fallbackReason ? String(message.fallbackReason) : undefined,
      insufficientContext: Boolean(message.insufficientContext),
      createdAt: message.createdAt ? String(message.createdAt) : undefined,
    };
  }

  function normalizeChatStatus(input = {}, defaults = {}) {
    const raw = input && typeof input === "object" ? input : defaults;
    return {
      ...defaults,
      ...raw,
      state: raw.state || defaults.state || "idle",
      message: raw.message || defaults.message || "",
      conversationId: raw.conversationId ? String(raw.conversationId) : "",
      isSending: Boolean(raw.isSending),
      error: raw.error ? String(raw.error) : "",
      lastLoadedAt: raw.lastLoadedAt ? String(raw.lastLoadedAt) : "",
    };
  }

  function normalizeInboxStatus(input = {}, defaults = {}) {
    const raw = input && typeof input === "object" ? input : defaults;
    return {
      ...defaults,
      ...raw,
      state: raw.state || defaults.state || "idle",
      message: raw.message || defaults.message || "",
      filter: ["open", "resolved", "all"].includes(raw.filter) ? raw.filter : defaults.filter || "open",
      conversations: Array.isArray(raw.conversations) ? raw.conversations : [],
      selectedId: raw.selectedId ? String(raw.selectedId) : "",
      selectedConversation:
        raw.selectedConversation && typeof raw.selectedConversation === "object"
          ? raw.selectedConversation
          : null,
      messages: Array.isArray(raw.messages) ? raw.messages : [],
      pendingIds: Array.isArray(raw.pendingIds) ? raw.pendingIds : [],
    };
  }

  function normalizeState(input = {}, defaults) {
    const rawDocumentStatus =
      input.documentStatus && typeof input.documentStatus === "object"
        ? input.documentStatus
        : defaults.documentStatus;
    const documentStatus = {
      ...defaults.documentStatus,
      ...rawDocumentStatus,
      documents: Array.isArray(rawDocumentStatus.documents) ? rawDocumentStatus.documents : [],
      pendingIds: Array.isArray(rawDocumentStatus.pendingIds) ? rawDocumentStatus.pendingIds : [],
      indexResults: rawDocumentStatus.indexResults && typeof rawDocumentStatus.indexResults === "object"
        ? rawDocumentStatus.indexResults
        : {},
      selectedId: rawDocumentStatus.selectedId ? String(rawDocumentStatus.selectedId) : "",
      diagnostics: rawDocumentStatus.diagnostics && typeof rawDocumentStatus.diagnostics === "object"
        ? rawDocumentStatus.diagnostics
        : null,
      diagnosticsState: rawDocumentStatus.diagnosticsState || defaults.documentStatus.diagnosticsState,
      diagnosticsMessage: rawDocumentStatus.diagnosticsMessage || defaults.documentStatus.diagnosticsMessage,
    };

    return {
      ...defaults,
      ...input,
      version: Number.isInteger(input.version) && input.version >= 1 ? input.version : 1,
      tab: tabs.includes(input.tab) ? input.tab : "overview",
      search: input.search || "",
      settings: normalizeSettings(input.settings, defaults.settings),
      articles: Array.isArray(input.articles) ? input.articles : defaults.articles,
      conversations: Array.isArray(input.conversations)
        ? input.conversations.map(normalizeConversation)
        : defaults.conversations,
      messages: input.messages?.length
        ? input.messages.map(normalizeMessage)
        : defaults.messages,
      chatStatus: normalizeChatStatus(input.chatStatus, defaults.chatStatus),
      documentStatus,
      inboxStatus: normalizeInboxStatus(input.inboxStatus, defaults.inboxStatus),
    };
  }

  function articleFromForm(formData, makeId) {
    return {
      id: makeId(),
      title: String(formData.get("title") || "").trim(),
      tags: String(formData.get("tags") || "")
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
      content: String(formData.get("content") || "").trim(),
    };
  }

  function documentUpdateFromForm(formData) {
    return {
      id: String(formData.get("id") || "").trim(),
      title: String(formData.get("title") || "").trim(),
      source_type: String(formData.get("sourceType") || "text").trim() || "text",
      tags: String(formData.get("tags") || "")
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
      content: String(formData.get("content") || "").trim(),
    };
  }

  function isValidArticle(article) {
    return Boolean(article.title && article.content);
  }

  root.AskWellValidation = {
    normalizeState,
    articleFromForm,
    documentUpdateFromForm,
    isValidArticle,
  };
})(globalThis);
