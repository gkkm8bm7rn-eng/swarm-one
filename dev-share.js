const DEBUG_BUFFER_KEY = "swarm-dev-debug-buffer";

function getDebugEvents() {
  try {
    const raw = JSON.parse(localStorage.getItem(DEBUG_BUFFER_KEY) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function toast(text, ms = 3200) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

async function shareDiagnostics() {
  const events = getDebugEvents();
  const report = {
    format: "SWARM_DEV_DIAGNOSTICS",
    exportedAt: new Date().toISOString(),
    page: location.href,
    userAgent: navigator.userAgent,
    online: navigator.onLine,
    webgpu: "gpu" in navigator,
    eventCount: events.length,
    events,
  };
  const text = JSON.stringify(report, null, 2);
  const name = `SWARM_DEV_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const file = new File([text], name, { type: "application/json" });

  try {
    if (navigator.share && navigator.canShare?.({ files: [file] })) {
      await navigator.share({
        title: "SWARM DEV diagnostics",
        text: `SWARM DEV · ${events.length} событий`,
        files: [file],
      });
      return;
    }
    await navigator.clipboard.writeText(text);
    toast("Диагностика скопирована. Вставь её в чат.");
  } catch (err) {
    if (err?.name === "AbortError") return;
    try {
      await navigator.clipboard.writeText(text);
      toast("Диагностика скопирована. Вставь её в чат.");
    } catch {
      toast(`Не удалось поделиться диагностикой: ${err?.message || err}`, 5000);
    }
  }
}

function installButton() {
  const disconnect = document.getElementById("debugDisconnectButton");
  if (!disconnect || document.getElementById("debugShareButton")) return;
  const button = document.createElement("button");
  button.id = "debugShareButton";
  button.className = "ghost-button";
  button.type = "button";
  button.textContent = "Поделиться журналом";
  button.addEventListener("click", shareDiagnostics);
  disconnect.insertAdjacentElement("afterend", button);

  const note = document.getElementById("debugNote");
  if (note) note.textContent = "Технические события сохраняются локально; журнал можно отправить одним нажатием.";
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", installButton, { once: true });
} else {
  installButton();
}
