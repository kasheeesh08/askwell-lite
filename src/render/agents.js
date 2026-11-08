(function attachAgentsRenderer(root) {
  const render = (root.AskWellRender = root.AskWellRender || {});

  function agentsPage(ctx) {
    const { state, escapeHtml, icons, pageHeader, shell } = ctx;
    const run = state.agentRun || {
      createdAt: "Not run yet",
      summary: "Run a local agent audit to turn the project into a clearer build story.",
      tasks: [
        {
          agent: "Lead Agent",
          status: "idle",
          detail: "Plans the product surface and decides what belongs in the static MVP.",
        },
        {
          agent: "Builder Agent",
          status: "idle",
          detail: "Ships the dashboard, widget, and knowledge workflows.",
        },
        {
          agent: "QA Agent",
          status: "idle",
          detail: "Checks launch readiness and catches repo regressions.",
        },
      ],
    };

    return shell(`
    ${pageHeader(
      "Agent build room",
      "A free simulation of the multi-agent workflow from the video: plan, build, test, and package the SaaS.",
      `<button class="button" data-run-agents>${icons.agent} Run audit</button>`,
    )}
    <section class="panel">
      <div class="panel-header"><h2>Latest audit</h2><span class="tag">${escapeHtml(run.createdAt)}</span></div>
      <div class="panel-body">
        <p class="conversation-answer">${escapeHtml(run.summary)}</p>
        <div class="agent-board">
          ${run.tasks
            .map(
              (task) => `
                <article class="agent-card">
                  <span class="status ${task.status === "done" ? "resolved" : "open"}">${escapeHtml(task.status)}</span>
                  <h3>${escapeHtml(task.agent)}</h3>
                  <p>${escapeHtml(task.detail)}</p>
                </article>
              `,
            )
            .join("")}
        </div>
      </div>
    </section>
  `);
  }

  render.agentsPage = agentsPage;
})(globalThis);
