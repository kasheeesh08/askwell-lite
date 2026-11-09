(function attachApp(root) {
  const { escapeHtml, tokenize } = root.AskWellUtils;
  const store = root.AskWellState;
  const pages = root.AskWellRender;
  const app = root.document.querySelector("#app");

  const icons = {
    activity: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M22 12h-4l-3 8L9 4l-3 8H2"/></svg>`,
    book: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5z"/></svg>`,
    inbox: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="m5.45 5.11-3.2 6.4A2 2 0 0 0 2 12.4V20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-7.6a2 2 0 0 0-.21-.89l-3.2-6.4A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.75 1.11z"/></svg>`,
    agent: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 8V4"/><rect x="5" y="8" width="14" height="11" rx="3"/><path d="M9 13h.01"/><path d="M15 13h.01"/><path d="M10 17h4"/><path d="M3 13h2"/><path d="M19 13h2"/></svg>`,
    code: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/></svg>`,
    plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M5 12h14"/><path d="M12 5v14"/></svg>`,
    reset: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>`,
    trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>`,
    download: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>`,
    check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="m20 6-11 11-5-5"/></svg>`,
  };

  function navButton(id, label, icon) {
    const state = store.getState();
    return `
    <button class="nav-button ${state.tab === id ? "active" : ""}" data-tab="${id}">
      ${icon}
      <span>${label}</span>
    </button>
  `;
  }

  function preview() {
    const state = store.getState();
    const messages = state.messages
      .map(
        (message) => `
        <div class="message ${message.role === "user" ? "user" : "bot"}">
          ${escapeHtml(message.text)}
          ${
            message.sources?.length
              ? `<div class="source-list">Sources: ${message.sources.map(escapeHtml).join(", ")}</div>`
              : ""
          }
          ${
            message.citations?.length
              ? `<div class="source-list">Citations: ${message.citations
                  .map((citation) => `${escapeHtml(citation.title)} (${escapeHtml(citation.chunk_id || citation.chunkId || "")})`)
                  .join(", ")}</div>`
              : ""
          }
          ${
            message.generation
              ? `<div class="source-list">AI: ${escapeHtml(message.generation.provider)} / ${escapeHtml(message.generation.model)}</div>`
              : ""
          }
          ${
            message.fallbackReason
              ? `<div class="source-list">Fallback: ${escapeHtml(message.fallbackReason)}</div>`
              : ""
          }
        </div>
      `,
      )
      .join("");

    return `
    <aside class="preview">
      <div class="preview-header">
        <h2>Live widget</h2>
        <p>Ask a question and the browser-only support brain will answer from your articles.</p>
      </div>
      <div class="browser-frame">
        <div class="browser-bar">
          <span class="dot"></span><span class="dot"></span><span class="dot"></span>
        </div>
        <div class="browser-page">
          <div class="mock-product">
            <div class="mock-line"></div>
            <div class="mock-line short"></div>
            <div class="mock-card">
              <div class="mock-line"></div>
              <div class="mock-line"></div>
              <div class="mock-line short"></div>
            </div>
          </div>
          <section class="chat-window" aria-label="Support chat preview">
            <header class="chat-header">
              <div class="chat-avatar">A</div>
              <div>
                <p class="chat-title">${escapeHtml(state.settings.brand)} Support</p>
                <p class="chat-status">Answers from your knowledge base</p>
              </div>
            </header>
            <div class="messages">${messages}</div>
            <form class="chat-form" data-chat-form>
              <input class="input" name="question" placeholder="Ask about setup or billing" />
              <button class="send-button" title="Send" aria-label="Send">-&gt;</button>
            </form>
          </section>
        </div>
      </div>
    </aside>
  `;
  }

  function shell(content) {
    const state = store.getState();
    const saveStatus = store.getSaveStatus();
    const answered = state.conversations.length;
    const articles = state.articles.length;

    return `
    <div class="layout">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-mark">A</div>
          <div>
            <h1 class="brand-title">AskWell Lite</h1>
            <p class="brand-subtitle">Support SaaS starter</p>
          </div>
        </div>
        <nav class="nav" aria-label="Primary">
          ${navButton("overview", "Overview", icons.activity)}
          ${navButton("knowledge", "Knowledge", icons.book)}
          ${navButton("inbox", "Inbox", icons.inbox)}
          ${navButton("agents", "Agents", icons.agent)}
          ${navButton("install", "Install", icons.code)}
        </nav>
        <div class="sidebar-card">
          <div class="metric"><span>Articles</span><strong>${articles}</strong></div>
          <div class="metric"><span>Answers</span><strong>${answered}</strong></div>
          <div class="metric save-state ${saveStatus.state}"><span>Save</span><strong>${escapeHtml(saveStatus.message)}</strong></div>
          <div class="metric"><span>Monthly cost</span><strong>$0</strong></div>
        </div>
      </aside>
      <main class="main">${content}</main>
      ${preview()}
    </div>
  `;
  }

  function pageHeader(title, copy, action = "") {
    return `
    <div class="topbar">
      <div>
        <p class="eyebrow">Workspace</p>
        <h2 class="page-title">${title}</h2>
        <p class="page-copy">${copy}</p>
      </div>
      <div class="action-row">${action}</div>
    </div>
  `;
  }

  function context() {
    return {
      state: store.getState(),
      saveStatus: store.getSaveStatus(),
      escapeHtml,
      tokenize,
      icons,
      pageHeader,
      shell,
    };
  }

  function render() {
    const state = store.getState();
    const ctx = context();

    if (state.tab === "overview") {
      app.innerHTML = pages.overviewPage(ctx);
    } else if (state.tab === "inbox") {
      app.innerHTML = pages.inboxPage(ctx);
    } else if (state.tab === "agents") {
      app.innerHTML = pages.agentsPage(ctx);
    } else if (state.tab === "install") {
      app.innerHTML = pages.installPage(ctx);
    } else {
      app.innerHTML = pages.knowledgePage(ctx);
    }

    root.document.querySelectorAll("[data-tab]").forEach((button) => {
      button.addEventListener("click", () => store.setTab(button.dataset.tab));
    });

    root.document
      .querySelector("[data-article-form]")
      ?.addEventListener("submit", store.addArticle);

    root.document.querySelector("[data-chat-form]")?.addEventListener("submit", store.askWidget);
    root.document.querySelector("[data-search]")?.addEventListener("input", store.setSearch);
    root.document.querySelector("[data-settings-form]")?.addEventListener("submit", store.saveSettings);
    root.document
      .querySelector("[data-run-agents]")
      ?.addEventListener("click", () => store.runAgentAudit(pages.qualityGates));
    root.document.querySelector("[data-export]")?.addEventListener("click", store.exportWorkspace);

    root.document.querySelector("[data-reset]")?.addEventListener("click", store.resetDemo);

    root.document.querySelectorAll("[data-delete]").forEach((button) => {
      button.addEventListener("click", () => store.deleteArticle(button.dataset.delete));
    });

    root.document.querySelectorAll("[data-select-document]").forEach((button) => {
      button.addEventListener("click", () => store.selectDocument(button.dataset.selectDocument));
    });

    root.document.querySelectorAll("[data-reindex-document]").forEach((button) => {
      button.addEventListener("click", () => store.reindexDocument(button.dataset.reindexDocument));
    });

    root.document.querySelectorAll("[data-retry-document]").forEach((button) => {
      button.addEventListener("click", () => store.retryDocument(button.dataset.retryDocument));
    });

    root.document
      .querySelector("[data-refresh-diagnostics]")
      ?.addEventListener("click", store.refreshDiagnostics);

    root.document
      .querySelector("[data-document-update-form]")
      ?.addEventListener("submit", store.updateDocument);

    root.document.querySelectorAll("[data-toggle-conversation]").forEach((button) => {
      button.addEventListener("click", () =>
        store.toggleConversation(button.dataset.toggleConversation),
      );
    });
  }

  store.subscribe(render);
  render();
  root.AskWellApi.initializeConfig().finally(() => store.hydrateFromRemote());

  root.AskWellApp = {
    render,
    shell,
    pageHeader,
    preview,
    icons,
  };

  root.setTab = store.setTab;
  root.addArticle = store.addArticle;
  root.deleteArticle = store.deleteArticle;
  root.selectDocument = store.selectDocument;
  root.reindexDocument = store.reindexDocument;
  root.retryDocument = store.retryDocument;
  root.updateDocument = store.updateDocument;
  root.setSearch = store.setSearch;
  root.toggleConversation = store.toggleConversation;
  root.saveSettings = store.saveSettings;
  root.resetDemo = store.resetDemo;
  root.runAgentAudit = () => store.runAgentAudit(pages.qualityGates);
  root.exportWorkspace = store.exportWorkspace;
  root.askWidget = store.askWidget;
})(globalThis);
