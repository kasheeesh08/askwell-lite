(function attachInboxRenderer(root) {
  const render = (root.AskWellRender = root.AskWellRender || {});

  function inboxPage(ctx) {
    const { state, escapeHtml, pageHeader, shell } = ctx;
    const openCount = state.conversations.filter(
      (conversation) => conversation.status !== "resolved",
    ).length;
    const conversations = state.conversations
      .map(
        (item) => `
        <article class="conversation">
          <div class="conversation-top">
            <p class="conversation-question">${escapeHtml(item.question)}</p>
            <span class="status ${item.status === "resolved" ? "resolved" : "open"}">${item.status || "open"}</span>
          </div>
          <p class="conversation-answer">${escapeHtml(item.answer)}</p>
          <div class="tag-row">
            ${(item.sources || []).map((source) => `<span class="tag">${escapeHtml(source)}</span>`).join("") || `<span class="tag">No source</span>`}
          </div>
          <button class="button secondary compact" data-toggle-conversation="${escapeHtml(item.id)}">
            ${item.status === "resolved" ? "Reopen" : "Resolve"}
          </button>
        </article>
      `,
      )
      .join("");

    return shell(`
    ${pageHeader(
      "Inbox",
      "Every widget question is saved locally so you can see what customers are asking.",
      `<span class="tag">${openCount} open</span>`,
    )}
    <section class="panel">
      <div class="panel-header"><h2>Recent questions</h2><span class="tag">${state.conversations.length} total</span></div>
      <div class="panel-body">
        <div class="inbox">${conversations || `<div class="empty">No conversations yet.</div>`}</div>
      </div>
    </section>
  `);
  }

  render.inboxPage = inboxPage;
})(globalThis);
