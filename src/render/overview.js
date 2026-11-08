(function attachOverviewRenderer(root) {
  const render = (root.AskWellRender = root.AskWellRender || {});

  function qualityGates(state) {
    return [
      {
        label: "Knowledge base has 4+ articles",
        done: state.articles.length >= 4,
      },
      {
        label: "Widget brand configured",
        done: state.settings.brand.trim().length > 1,
      },
      {
        label: "At least one conversation captured",
        done: state.conversations.length > 0,
      },
      {
        label: "GitHub test workflow included",
        done: true,
      },
    ];
  }

  function overviewPage(ctx) {
    const { state, escapeHtml, icons, pageHeader, shell } = ctx;
    const resolved = state.conversations.filter(
      (conversation) => conversation.status === "resolved",
    ).length;
    const accuracy = Math.round(
      (state.conversations.filter((conversation) => conversation.sources?.length).length /
        Math.max(state.conversations.length, 1)) *
        100,
    );
    const gates = qualityGates(state);
    const readiness = Math.round(
      (gates.filter((gate) => gate.done).length / gates.length) * 100,
    );
    const recent = state.conversations
      .slice(0, 3)
      .map(
        (conversation) => `
        <article class="mini-row">
          <strong>${escapeHtml(conversation.question)}</strong>
          <span>${escapeHtml(conversation.status || "open")}</span>
        </article>
      `,
      )
      .join("");

    return shell(`
    ${pageHeader(
      "Support cockpit",
      "A static SaaS control room: knowledge, inbox, widget install, launch checks, and an agent-style build audit.",
      `<button class="button secondary" data-export>${icons.download} Export JSON</button>`,
    )}
    <section class="stat-grid">
      <article class="stat-card"><span>Articles</span><strong>${state.articles.length}</strong><p>Knowledge entries powering the widget.</p></article>
      <article class="stat-card"><span>Conversations</span><strong>${state.conversations.length}</strong><p>${resolved} resolved locally.</p></article>
      <article class="stat-card"><span>Source Match</span><strong>${accuracy}%</strong><p>Answers with at least one source.</p></article>
      <article class="stat-card"><span>Launch Score</span><strong>${readiness}%</strong><p>Static MVP readiness.</p></article>
    </section>
    <div class="grid">
      <section class="panel">
        <div class="panel-header"><h2>Launch checks</h2><span class="tag">${gates.filter((gate) => gate.done).length}/${gates.length} ready</span></div>
        <div class="panel-body">
          <div class="check-list">
            ${gates
              .map(
                (gate) => `
                  <div class="check-item ${gate.done ? "done" : ""}">
                    <span>${gate.done ? icons.check : ""}</span>
                    <p>${gate.label}</p>
                  </div>
                `,
              )
              .join("")}
          </div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-header"><h2>Recent questions</h2></div>
        <div class="panel-body">
          <div class="mini-list">${recent || `<div class="empty">No questions yet.</div>`}</div>
        </div>
      </section>
    </div>
  `);
  }

  render.qualityGates = qualityGates;
  render.overviewPage = overviewPage;
})(globalThis);
