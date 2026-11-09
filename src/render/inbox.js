(function attachInboxRenderer(root) {
  const render = (root.AskWellRender = root.AskWellRender || {});

  function inboxPage(ctx) {
    const { state, escapeHtml, pageHeader, shell, runtimeConfig } = ctx;
    const hosted = runtimeConfig?.apiMode === "hosted" || runtimeConfig?.apiMode === "vercel-hosted";
    const inbox = state.inboxStatus || {};
    const sourceConversations = hosted ? inbox.conversations || [] : state.conversations || [];
    const openCount = sourceConversations.filter(
      (conversation) => conversation.status !== "resolved",
    ).length;

    return shell(`
    ${pageHeader(
      "Inbox",
      hosted
        ? "Persistent customer conversations for authenticated support agents."
        : "Every widget question is saved locally so you can see what customers are asking.",
      `<span class="tag">${openCount} open</span>`,
    )}
    <section class="panel">
      <div class="panel-header">
        <h2>${hosted ? "Customer conversations" : "Recent questions"}</h2>
        <span class="tag">${sourceConversations.length} total</span>
      </div>
      <div class="panel-body">
        ${hosted ? hostedInbox(ctx) : localInbox(ctx)}
      </div>
    </section>
  `);
  }

  function hostedInbox(ctx) {
    const { state, escapeHtml } = ctx;
    const inbox = state.inboxStatus || {};
    const conversations = Array.isArray(inbox.conversations) ? inbox.conversations : [];
    const filter = inbox.filter || "open";
    const visible = conversations.filter((conversation) => {
      if (filter === "all") return true;
      if (filter === "resolved") return conversation.status === "resolved";
      return conversation.status !== "resolved";
    });
    const selectedId = inbox.selectedId || visible[0]?.id || "";
    const selected = inbox.selectedConversation?.id === selectedId
      ? inbox.selectedConversation
      : conversations.find((conversation) => conversation.id === selectedId);
    const messages = inbox.selectedConversation?.id === selectedId ? inbox.messages || [] : [];
    const pending = new Set(inbox.pendingIds || []);
    const list = visible.map((conversation) =>
      conversationListItem({ conversation, selectedId, pending, escapeHtml }),
    ).join("");

    return `
      <div class="inbox-toolbar">
        <div class="segmented-control" role="group" aria-label="Conversation filter">
          ${filterButton("open", "Open", filter, escapeHtml)}
          ${filterButton("resolved", "Resolved", filter, escapeHtml)}
          ${filterButton("all", "All", filter, escapeHtml)}
        </div>
        <button class="button secondary compact" data-refresh-inbox ${inbox.state === "loading" ? "disabled" : ""}>Refresh</button>
      </div>
      ${statusLine(inbox, escapeHtml)}
      <div class="inbox-shell">
        <div class="inbox-list" aria-label="Conversation list">
          ${inbox.state === "loading" && !conversations.length ? `<div class="empty">Loading conversations...</div>` : ""}
          ${list || `<div class="empty">${filter === "all" ? "No conversations yet." : `No ${escapeHtml(filter)} conversations.`}</div>`}
        </div>
        <div class="inbox-detail">
          ${selected ? conversationDetail({ conversation: selected, messages, pending, escapeHtml }) : emptyDetail()}
        </div>
      </div>
    `;
  }

  function localInbox(ctx) {
    const { state, escapeHtml } = ctx;
    const conversations = (state.conversations || [])
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
    return `<div class="inbox">${conversations || `<div class="empty">No conversations yet.</div>`}</div>`;
  }

  function filterButton(value, label, current, escapeHtml) {
    return `
      <button class="${current === value ? "active" : ""}" data-inbox-filter="${escapeHtml(value)}">
        ${escapeHtml(label)}
      </button>
    `;
  }

  function statusLine(inbox, escapeHtml) {
    if (!inbox.message) return "";
    return `<div class="index-status ${escapeHtml(inbox.state || "idle")}"><span>Inbox</span><strong>${escapeHtml(inbox.message)}</strong></div>`;
  }

  function conversationListItem({ conversation, selectedId, pending, escapeHtml }) {
    const id = conversation.id || "";
    const status = conversation.status === "resolved" ? "resolved" : "open";
    const label = conversation.customerId || "anonymous";
    const preview = conversation.lastMessagePreview || "No messages yet.";
    return `
      <button class="conversation-row ${selectedId === id ? "active" : ""}" data-select-conversation="${escapeHtml(id)}">
        <span>
          <strong>${escapeHtml(label)}</strong>
          <small>${escapeHtml(preview)}</small>
        </span>
        <span class="status ${status}">${status}</span>
        <small>${escapeHtml(formatTime(conversation.lastMessageAt || conversation.updatedAt || conversation.createdAt))}</small>
        ${pending.has(id) ? `<small>Updating...</small>` : ""}
      </button>
    `;
  }

  function conversationDetail({ conversation, messages, pending, escapeHtml }) {
    const id = conversation.id || "";
    const status = conversation.status === "resolved" ? "resolved" : "open";
    const busy = pending.has(id);
    const transcript = messages.length
      ? messages.map((message) => `
          <div class="transcript-message ${escapeHtml(message.senderType || "customer")}">
            <div>
              <strong>${escapeHtml(senderLabel(message.senderType))}</strong>
              <small>${escapeHtml(formatTime(message.createdAt))}</small>
            </div>
            <p>${escapeHtml(message.content)}</p>
          </div>
        `).join("")
      : `<div class="empty">Select Refresh to load this conversation transcript.</div>`;

    return `
      <div class="conversation-detail-header">
        <div>
          <p class="eyebrow">${escapeHtml(conversation.customerId || "anonymous")}</p>
          <h3>${escapeHtml(id)}</h3>
          <p>${escapeHtml(conversation.messageCount || 0)} messages - ${escapeHtml(formatTime(conversation.lastMessageAt || conversation.updatedAt || conversation.createdAt))}</p>
        </div>
        <div class="action-row">
          <span class="status ${status}">${status}</span>
          <button
            class="button secondary compact"
            data-conversation-status="${status === "resolved" ? "open" : "resolved"}"
            data-conversation-id="${escapeHtml(id)}"
            ${busy ? "disabled" : ""}
          >
            ${status === "resolved" ? "Reopen" : "Resolve"}
          </button>
        </div>
      </div>
      <div class="transcript">${transcript}</div>
      <form class="agent-reply-form" data-agent-reply-form>
        <input type="hidden" name="conversationId" value="${escapeHtml(id)}" />
        <textarea name="content" class="input" rows="3" maxlength="4000" placeholder="Write an agent reply" ${busy ? "disabled" : ""}></textarea>
        <button class="button" ${busy ? "disabled" : ""}>Send reply</button>
      </form>
    `;
  }

  function emptyDetail() {
    return `<div class="empty">Select a conversation to inspect the full transcript.</div>`;
  }

  function senderLabel(senderType) {
    if (senderType === "assistant") return "Assistant";
    if (senderType === "agent") return "Agent";
    return "Customer";
  }

  function formatTime(value) {
    if (!value) return "No activity yet";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString();
  }

  render.inboxPage = inboxPage;
})(globalThis);
