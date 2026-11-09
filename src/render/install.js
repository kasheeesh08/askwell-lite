(function attachInstallRenderer(root) {
  const render = (root.AskWellRender = root.AskWellRender || {});

  function installPage(ctx) {
    const { state, escapeHtml, pageHeader, shell } = ctx;
    const code = `<script src="./askwell-widget.js" defer></script>
<script>
  window.AskWellConfig = {
    brand: ${JSON.stringify(state.settings.brand)},
    accent: ${JSON.stringify(state.settings.accent)}
  };
</script>`;

    return shell(`
    ${pageHeader(
      "Install",
      "Drop the widget script into any static site. GitHub Pages can host this starter for free.",
    )}
    <section class="panel">
      <div class="panel-header"><h2>Embed snippet</h2></div>
      <div class="panel-body">
        <code class="install-code">${escapeHtml(code)}</code>
      </div>
    </section>
    <section class="panel stacked-panel">
      <div class="panel-header"><h2>Widget settings</h2></div>
      <div class="panel-body">
        <form class="form" data-settings-form>
          <label class="field">
            <span>Brand</span>
            <input class="input" name="brand" value="${escapeHtml(state.settings.brand)}" />
          </label>
          <label class="field">
            <span>Accent</span>
            <input class="input" name="accent" type="color" value="${escapeHtml(state.settings.accent)}" />
          </label>
          <label class="field">
            <span>Welcome message</span>
            <textarea class="textarea" name="welcome">${escapeHtml(state.settings.welcome)}</textarea>
          </label>
          <label class="field">
            <span>Private demo access</span>
            <input class="input" name="adminToken" type="password" placeholder="Creates a secure hosted session when hosted mode is active" autocomplete="off" />
          </label>
          <button class="button" type="submit">Save settings</button>
        </form>
      </div>
    </section>
  `);
  }

  render.installPage = installPage;
})(globalThis);
