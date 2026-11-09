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
    return {
      role: message.role === "user" ? "user" : "bot",
      text: String(message.text || ""),
      sources: Array.isArray(message.sources) ? message.sources : undefined,
      citations: Array.isArray(message.citations) ? message.citations : undefined,
      generation: message.generation && typeof message.generation === "object" ? message.generation : undefined,
      fallbackReason: message.fallbackReason ? String(message.fallbackReason) : undefined,
      insufficientContext: Boolean(message.insufficientContext),
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
      documentStatus,
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
