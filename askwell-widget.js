(function () {
  const config = window.AskWellConfig || {};
  const brand = String(config.brand || "AskWell").trim().slice(0, 80) || "AskWell";
  const accent = /^#[0-9a-f]{6}$/i.test(String(config.accent || ""))
    ? String(config.accent)
    : "#ef7d62";

  const launcher = document.createElement("button");
  launcher.setAttribute("aria-label", `Open ${brand} chat`);
  launcher.textContent = "?";
  launcher.style.cssText = `
    position: fixed;
    right: 20px;
    bottom: 20px;
    z-index: 99998;
    width: 58px;
    height: 58px;
    border: 1px solid #111;
    border-radius: 8px;
    background: ${accent};
    color: #111;
    box-shadow: 5px 5px 0 #111;
    font: 900 24px system-ui, sans-serif;
    cursor: pointer;
  `;

  const panel = document.createElement("section");
  panel.setAttribute("aria-label", `${brand} chat`);
  panel.hidden = true;
  panel.style.cssText = `
    position: fixed;
    right: 20px;
    bottom: 92px;
    z-index: 99999;
    width: min(340px, calc(100vw - 40px));
    height: 430px;
    border: 1px solid #111;
    border-radius: 8px;
    background: #fff;
    box-shadow: 8px 8px 0 #111;
    overflow: hidden;
    font: 14px system-ui, sans-serif;
  `;

  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px;background:#22201d;color:white;">
      <strong data-title></strong>
      <button data-close style="border:0;background:transparent;color:white;font:inherit;cursor:pointer;">Close</button>
    </div>
    <div data-log style="height:300px;overflow:auto;padding:14px;background:#f8f4ee;">
      <p style="max-width:88%;padding:10px 11px;border:1px solid #e2dad1;border-radius:8px;background:white;line-height:1.42;">
        Hi, I can answer common support questions from this starter widget.
      </p>
    </div>
    <form data-form style="display:grid;grid-template-columns:1fr 42px;gap:8px;padding:10px;border-top:1px solid #e2dad1;">
      <input data-input placeholder="Ask a question" style="min-width:0;height:42px;border:1px solid #ded8cf;border-radius:8px;padding:0 10px;font:inherit;" />
      <button aria-label="Send" style="border:0;border-radius:8px;background:${accent};font:900 18px system-ui;cursor:pointer;">→</button>
    </form>
  `;

  const log = panel.querySelector("[data-log]");
  const input = panel.querySelector("[data-input]");
  const form = panel.querySelector("[data-form]");
  const close = panel.querySelector("[data-close]");
  const title = panel.querySelector("[data-title]");
  title.textContent = `${brand} Support`;

  const answers = [
    {
      terms: ["trial", "free", "card"],
      answer: "The starter is free to run. A production AI provider or hosted database may add usage costs later.",
    },
    {
      terms: ["install", "widget", "script"],
      answer: "Paste the widget script before your closing body tag and configure the brand name in window.AskWellConfig.",
    },
    {
      terms: ["ai", "model", "openai", "ollama"],
      answer: "This widget ships with simple local answers. For real AI, connect it to a server route that calls your model.",
    },
  ];

  function bubble(text, role) {
    const item = document.createElement("p");
    item.textContent = text;
    item.style.cssText = `
      max-width: 88%;
      margin: 0 0 10px;
      margin-left: ${role === "user" ? "auto" : "0"};
      padding: 10px 11px;
      border-radius: 8px;
      background: ${role === "user" ? "#1f7a62" : "#fff"};
      color: ${role === "user" ? "#fff" : "#22201d"};
      border: ${role === "user" ? "0" : "1px solid #e2dad1"};
      line-height: 1.42;
    `;
    log.appendChild(item);
    log.scrollTop = log.scrollHeight;
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const question = input.value.trim();
    if (!question) return;
    input.value = "";
    bubble(question, "user");

    const words = question.toLowerCase().split(/\W+/);
    const match = answers.find((item) => item.terms.some((term) => words.includes(term)));
    bubble(
      match?.answer ||
        "I do not know that yet. Add this topic to the knowledge base in the AskWell Lite repo.",
      "bot",
    );
  });

  launcher.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) input.focus();
  });

  close.addEventListener("click", () => {
    panel.hidden = true;
  });

  document.body.append(panel, launcher);
})();
