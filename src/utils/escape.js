(function attachEscapeUtils(root) {
  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function tokenize(value) {
    return String(value)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2);
  }

  function makeId() {
    const cryptoApi = root.crypto || root.self?.crypto;
    return (
      cryptoApi?.randomUUID?.() ??
      `id-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  root.AskWellUtils = {
    escapeHtml,
    tokenize,
    makeId,
    clone,
  };
})(globalThis);
