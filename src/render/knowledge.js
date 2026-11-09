(function attachKnowledgeRenderer(root) {
  const render = (root.AskWellRender = root.AskWellRender || {});

  function shortHash(value) {
    return value ? `${String(value).slice(0, 10)}...` : "Not available";
  }

  function formatDate(value) {
    if (!value) return "Not available";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Not available";
    return date.toLocaleString();
  }

  function tagsToText(tags) {
    return Array.isArray(tags) ? tags.join(", ") : "";
  }

  function knowledgePage(ctx) {
    const { state, escapeHtml, icons, pageHeader, shell, tokenize, runtimeConfig } = ctx;
    const query = tokenize(state.search || "");
    const visibleArticles = query.length
      ? state.articles.filter((article) => {
          const haystack = tokenize(
            `${article.title} ${article.tags.join(" ")} ${article.content}`,
          );
          return query.some((token) => haystack.includes(token));
        })
      : state.articles;
    const status = state.documentStatus || {};
    const documents = Array.isArray(status.documents) ? status.documents : [];
    const pendingDocumentIds = Array.isArray(status.pendingIds) ? status.pendingIds : [];
    const indexedById = new Map(documents.map((document) => [document.id, document]));
    const pendingIds = new Set(pendingDocumentIds);
    const diagnostics = status.diagnostics && typeof status.diagnostics === "object"
      ? status.diagnostics
      : null;
    const selectedDocument =
      documents.find((document) => document.id === status.selectedId) || documents[0] || null;
    const selectedArticle = selectedDocument
      ? state.articles.find((article) => article.id === selectedDocument.id)
      : null;
    const updateTags = selectedArticle?.tags || selectedDocument?.metadata?.tags || [];
    const privateDemoSignIn =
      runtimeConfig?.apiMode === "hosted" && !runtimeConfig.authenticated
        ? `
          <form class="private-demo-form" data-private-demo-login>
            <div>
              <strong>Private demo sign-in</strong>
              <span>Enter the access credential to start a secure HttpOnly browser session.</span>
            </div>
            <label class="field">
              <span>Access credential</span>
              <input class="input" name="accessCredential" type="password" autocomplete="current-password" placeholder="Private demo access" />
            </label>
            <button class="button" type="submit">${icons.check} Sign in</button>
          </form>
        `
        : runtimeConfig?.apiMode === "hosted"
          ? `<div class="private-demo-session"><strong>Private demo session active</strong><span>Requests use the secure session cookie.</span></div>`
          : "";

    const documentRows = documents
      .map((document) => {
        const selected = selectedDocument?.id === document.id;
        const pending = pendingIds.has(document.id);
        return `
          <button class="document-row ${selected ? "active" : ""}" data-select-document="${escapeHtml(document.id)}">
            <span>
              <strong>${escapeHtml(document.title)}</strong>
              <small>${escapeHtml(document.id)}</small>
            </span>
            <span class="tag">${escapeHtml(document.status || document.source_type || "document")}</span>
            <span>${document.chunk_count || 0} chunks</span>
            <span>${pending ? "Working" : escapeHtml(document.last_error || formatDate(document.updated_at))}</span>
          </button>
        `;
      })
      .join("");

    const retryable = documents.filter((document) => document.retryable);
    const diagnosticsPanel = `
      <section class="diagnostics-card ${escapeHtml(status.diagnosticsState || "idle")}">
        <div>
          <strong>${escapeHtml(status.diagnosticsMessage || "Diagnostics not checked")}</strong>
          <span>${diagnostics ? `${escapeHtml(diagnostics.backend || "unknown")} / ${escapeHtml(diagnostics.status || "unknown")}` : "Storage status unavailable"}</span>
        </div>
        <button class="button secondary" data-refresh-diagnostics>${icons.activity} Check</button>
        ${
          diagnostics
            ? `<dl>
                <div><dt>Documents</dt><dd>${diagnostics.document_count ?? documents.length}</dd></div>
                <div><dt>Chunks</dt><dd>${diagnostics.chunk_count ?? 0}</dd></div>
                <div><dt>Embeddings</dt><dd>${diagnostics.embedding_count ?? 0}</dd></div>
                <div><dt>Integrity</dt><dd>${escapeHtml(diagnostics.integrity_check || "unavailable")}</dd></div>
              </dl>`
            : ""
        }
        ${
          retryable.length
            ? `<div class="attention-list">${retryable
                .map(
                  (document) => `
                    <div class="attention-row">
                      <span>${escapeHtml(document.title || document.id)} needs attention</span>
                      <button class="button secondary" data-retry-document="${escapeHtml(document.id)}" ${pendingIds.has(document.id) ? "disabled" : ""}>
                        ${icons.reset} Retry
                      </button>
                    </div>
                  `,
                )
                .join("")}</div>`
            : ""
        }
      </section>
    `;

    const selectedDetails = selectedDocument
      ? `
        <div class="document-details">
          <dl>
            <div><dt>ID</dt><dd>${escapeHtml(selectedDocument.id)}</dd></div>
            <div><dt>Source</dt><dd>${escapeHtml(selectedDocument.source_type || "document")}</dd></div>
            <div><dt>Chunks</dt><dd>${selectedDocument.chunk_count || 0}</dd></div>
            <div><dt>Updated</dt><dd>${escapeHtml(formatDate(selectedDocument.updated_at))}</dd></div>
            <div><dt>Hash</dt><dd>${escapeHtml(shortHash(selectedDocument.content_hash))}</dd></div>
          </dl>
          <div class="action-row compact">
            <button class="button secondary" data-reindex-document="${escapeHtml(selectedDocument.id)}" ${pendingIds.has(selectedDocument.id) ? "disabled" : ""}>
              ${icons.reset} Re-index current
            </button>
            ${
              selectedDocument.retryable
                ? `<button class="button secondary" data-retry-document="${escapeHtml(selectedDocument.id)}" ${pendingIds.has(selectedDocument.id) ? "disabled" : ""}>${icons.reset} Retry</button>`
                : ""
            }
          </div>
          <form class="form document-update-form" data-document-update-form>
            <input type="hidden" name="id" value="${escapeHtml(selectedDocument.id)}" />
            <label class="field">
              <span>Title</span>
              <input class="input" name="title" value="${escapeHtml(selectedArticle?.title || selectedDocument.title)}" />
            </label>
            <label class="field">
              <span>Source type</span>
              <input class="input" name="sourceType" value="${escapeHtml(selectedDocument.source_type || "text")}" />
            </label>
            <label class="field">
              <span>Tags</span>
              <input class="input" name="tags" value="${escapeHtml(tagsToText(updateTags))}" />
            </label>
            <label class="field">
              <span>Replacement content</span>
              <textarea class="textarea" name="content" placeholder="Paste replacement content to update this document.">${escapeHtml(selectedArticle?.content || "")}</textarea>
            </label>
            <button class="button" type="submit" ${pendingIds.has(selectedDocument.id) ? "disabled" : ""}>${icons.check} Update index</button>
          </form>
        </div>
      `
      : `<div class="empty">No indexed documents yet. Add an article or run ingestion to populate this panel.</div>`;

    const articles = visibleArticles
      .map((article) => {
        const indexed = indexedById.get(article.id);
        const pending = pendingIds.has(article.id);
        return `
        <article class="article">
          <div class="article-top">
            <h3>${escapeHtml(article.title)}</h3>
            <button class="icon-button danger" data-delete="${escapeHtml(article.id)}" title="Delete article" aria-label="Delete ${escapeHtml(article.title)}" ${pending ? "disabled" : ""}>
              ${icons.trash}
            </button>
          </div>
          <p>${escapeHtml(article.content)}</p>
          <div class="article-meta">
            <span>${indexed ? `${indexed.chunk_count} indexed chunk${indexed.chunk_count === 1 ? "" : "s"}` : "Not indexed yet"}</span>
            <span>${pending ? "Working..." : escapeHtml(indexed?.source_type || "article")}</span>
            <span>${indexed ? `Updated ${escapeHtml(formatDate(indexed.updated_at))}` : `ID ${escapeHtml(article.id)}`}</span>
          </div>
          <div class="tag-row">
            ${article.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}
          </div>
        </article>
      `;
      })
      .join("");

    return shell(`
    ${pageHeader(
      "Knowledge base",
      "Add the answers your customer widget should know. The demo chatbot uses these articles immediately.",
      `<button class="button secondary" data-reset>${icons.reset} Reset demo</button>`,
    )}
    <section class="toolbar-panel">
      <label class="field">
        <span>Search articles</span>
        <input class="input" data-search value="${escapeHtml(state.search || "")}" placeholder="Search billing, widget, AI..." />
      </label>
      <div class="index-status ${escapeHtml(status.state || "idle")}">
        <strong>${escapeHtml(status.message || "Knowledge index ready")}</strong>
        <span>${documents.length} indexed</span>
      </div>
    </section>
    <div class="grid">
      <section class="panel">
        <div class="panel-header"><h2>Articles</h2><span class="tag">${visibleArticles.length}/${state.articles.length} shown</span></div>
        <div class="panel-body">
          <div class="article-list">${articles || `<div class="empty">No articles yet.</div>`}</div>
        </div>
      </section>
      <div class="side-stack">
        <section class="panel">
          <div class="panel-header"><h2>Document management</h2><span class="tag">${documents.length} indexed</span></div>
          <div class="panel-body">
            ${privateDemoSignIn}
            ${diagnosticsPanel}
            <div class="document-list ${status.state === "loading" ? "loading" : ""}">
              ${
                status.state === "loading"
                  ? `<div class="empty">Loading indexed documents...</div>`
                  : documentRows || `<div class="empty">No indexed documents yet.</div>`
              }
            </div>
            ${selectedDetails}
          </div>
        </section>
        <section class="panel">
          <div class="panel-header"><h2>New article</h2></div>
          <div class="panel-body">
            <form class="form" data-article-form>
              <label class="field">
                <span>Title</span>
                <input class="input" name="title" placeholder="Refund policy" />
              </label>
              <label class="field">
                <span>Tags</span>
                <input class="input" name="tags" placeholder="billing, refunds" />
              </label>
              <label class="field">
                <span>Answer</span>
                <textarea class="textarea" name="content" placeholder="Write the answer customers should receive."></textarea>
              </label>
              <button class="button" type="submit">${icons.plus} Add article</button>
            </form>
          </div>
        </section>
      </div>
    </div>
  `);
  }

  render.knowledgePage = knowledgePage;
})(globalThis);
