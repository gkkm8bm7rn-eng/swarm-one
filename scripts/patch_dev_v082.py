from pathlib import Path


def replace_between(text: str, start: str, end: str, replacement: str) -> str:
    i = text.index(start)
    j = text.index(end, i)
    return text[:i] + replacement + text[j:]


# --- app.js ---
p = Path("app.js")
s = p.read_text(encoding="utf-8")
assert 'const APP_VERSION = "0.8.1";' in s
s = s.replace('const APP_VERSION = "0.8.1";', 'const APP_VERSION = "0.8.2";', 1)

anchor = 'const MAX_ATTACHMENT_CHARS = 8_000;\n'
assert anchor in s
s = s.replace(anchor, anchor + '''const DEV_MODE = true;\nconst DEBUG_TOPIC_KEY = "swarm-dev-debug-topic";\nconst DEBUG_BUFFER_KEY = "swarm-dev-debug-buffer";\nconst DEBUG_ENDPOINT = "https://ntfy.sh";\nconst MAX_DEBUG_BUFFER = 80;\n\n''', 1)

anchor = 'const visionRequests = new Map();\n'
assert anchor in s
s = s.replace(anchor, anchor + '''let debugTopic = "";\nlet debugSession = uid();\nlet debugSeq = 0;\nlet debugBuffer = [];\n\n''', 1)

old_els = '  statusDialog: $("statusDialog"), statusClose: $("statusClose"), statusDetails: $("statusDetails"),\n};'
new_els = '  statusDialog: $("statusDialog"), statusClose: $("statusClose"), statusDetails: $("statusDetails"),\n  debugReady: $("debugReady"), debugTopicInput: $("debugTopicInput"), debugConnectButton: $("debugConnectButton"),\n  debugDisconnectButton: $("debugDisconnectButton"), debugNote: $("debugNote"), composerFoot: $("composerFoot"), devBadge: $("devBadge"),\n};'
assert old_els in s
s = s.replace(old_els, new_els, 1)

insert_at = s.index('function openDB() {')
debug_helpers = r'''function cleanDebugValue(value, depth = 0) {
  if (depth > 3) return "[depth-limit]";
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, 900);
  if (Array.isArray(value)) return value.slice(0, 12).map((v) => cleanDebugValue(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 24)) {
      if (/token|secret|password|authorization|cookie/i.test(k)) continue;
      out[k] = cleanDebugValue(v, depth + 1);
    }
    return out;
  }
  return String(value).slice(0, 900);
}

function loadDebugBuffer() {
  try {
    const saved = JSON.parse(localStorage.getItem(DEBUG_BUFFER_KEY) || "[]");
    debugBuffer = Array.isArray(saved) ? saved.slice(-MAX_DEBUG_BUFFER) : [];
  } catch {
    debugBuffer = [];
  }
}

function storeDebugBuffer(payload) {
  debugBuffer.push(payload);
  debugBuffer = debugBuffer.slice(-MAX_DEBUG_BUFFER);
  try { localStorage.setItem(DEBUG_BUFFER_KEY, JSON.stringify(debugBuffer)); } catch {}
}

function bootstrapDebugBridge() {
  loadDebugBuffer();
  try {
    const params = new URLSearchParams(location.hash.replace(/^#/, ""));
    const fromHash = params.get("debug");
    if (fromHash && /^[A-Za-z0-9_-]{20,64}$/.test(fromHash)) {
      localStorage.setItem(DEBUG_TOPIC_KEY, fromHash);
      history.replaceState(null, "", location.pathname + location.search);
    }
    const saved = localStorage.getItem(DEBUG_TOPIC_KEY) || "";
    debugTopic = /^[A-Za-z0-9_-]{20,64}$/.test(saved) ? saved : "";
  } catch {
    debugTopic = "";
  }
}

async function debugEvent(stage, details = {}, level = "info") {
  if (!DEV_MODE) return;
  const payload = {
    type: "SWARM_DEV_EVENT",
    version: APP_VERSION,
    session: debugSession,
    seq: ++debugSeq,
    ts: nowIso(),
    level,
    stage,
    online: navigator.onLine,
    webgpu: "gpu" in navigator,
    modelReady,
    visionReady,
    visibility: document.visibilityState,
    memoryItems: state?.memory?.length || 0,
    ledgerItems: state?.ledger?.length || 0,
    ua: navigator.userAgent,
    details: cleanDebugValue(details),
  };
  storeDebugBuffer(payload);
  if (!debugTopic || !navigator.onLine) return;
  let body = JSON.stringify(payload);
  if (body.length > 3900) body = JSON.stringify({ ...payload, details: { truncated: true, preview: body.slice(0, 2600) } });
  try {
    const res = await fetch(`${DEBUG_ENDPOINT}/${debugTopic}`, {
      method: "POST",
      body,
      keepalive: true,
    });
    if (!res.ok) console.warn("Debug bridge publish failed", res.status);
  } catch (err) {
    console.warn("Debug bridge unavailable", err);
  }
}

function setDebugTopic(topic) {
  const value = String(topic || "").trim();
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(value)) throw new Error("Некорректный код DEV-канала");
  debugTopic = value;
  localStorage.setItem(DEBUG_TOPIC_KEY, value);
  if (els.debugTopicInput) els.debugTopicInput.value = value;
  updateStatus();
  updateDiagnostics();
  void debugEvent("debug_bridge_connected", { source: "settings" });
}

function clearDebugTopic() {
  void debugEvent("debug_bridge_disconnected", { source: "settings" });
  debugTopic = "";
  localStorage.removeItem(DEBUG_TOPIC_KEY);
  if (els.debugTopicInput) els.debugTopicInput.value = "";
  updateStatus();
  updateDiagnostics();
}

'''
s = s[:insert_at] + debug_helpers + s[insert_at:]

# Always load the current worker, not a stale service-worker cached copy.
s = s.replace('new Worker("./vision-worker.js?v=0.8.0", { type: "module" })', 'new Worker(`./vision-worker.js?v=${APP_VERSION}`, { type: "module" })')
s = s.replace('new Worker("./vision-worker.js?v=0.8.1", { type: "module" })', 'new Worker(`./vision-worker.js?v=${APP_VERSION}`, { type: "module" })')

# Add observability to the Vision worker bridge.
s = s.replace('  visionWorker = new Worker(`./vision-worker.js?v=${APP_VERSION}`, { type: "module" });\n', '  visionWorker = new Worker(`./vision-worker.js?v=${APP_VERSION}`, { type: "module" });\n  void debugEvent("vision_worker_created", { workerVersion: APP_VERSION });\n', 1)
s = s.replace('      visionLoading = true;\n      setRun("Vision: загружаю сенсор изображения", 12, 0, 3);', '      visionLoading = true;\n      void debugEvent("vision_load_stage", { phase: msg.phase || "loading", message: msg.data || "" });\n      setRun("Vision: загружаю сенсор изображения", 12, 0, 3);', 1)
s = s.replace('      toast("Vision готов");\n      return;', '      toast("Vision готов");\n      void debugEvent("vision_ready", { modelId: msg.modelId || VISION_MODEL_ID });\n      return;', 1)
s = s.replace('    if (msg.status === "error") {\n      const error = new Error(msg.data || "VISION_ERROR");', '    if (msg.status === "error") {\n      const error = new Error(msg.data || "VISION_ERROR");\n      void debugEvent("vision_worker_reported_error", { phase: msg.phase || "unknown", requestId: msg.requestId || null, message: error.message }, "error");', 1)
s = s.replace('    console.error("Vision worker error", event);\n    const error = new Error(event.message || "VISION_WORKER_ERROR");', '    console.error("Vision worker error", event);\n    const error = new Error(event.message || "VISION_WORKER_ERROR");\n    void debugEvent("vision_worker_crash", { message: error.message, filename: event.filename || "", line: event.lineno || 0, col: event.colno || 0 }, "error");', 1)

# Replace askVision with timed, remotely observable inference.
s = replace_between(s, 'async function askVision(prompt, blob) {', '\nasync function buildVisionEvidence', r'''async function askVision(prompt, blob) {
  await ensureVision();
  const image = await blobToDataURL(blob);
  const requestId = uid();
  const started = performance.now();
  void debugEvent("vision_inference_start", { requestId, imageBytes: blob?.size || 0, promptChars: String(prompt || "").length });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      visionRequests.delete(requestId);
      void debugEvent("vision_inference_timeout", { requestId, elapsedMs: Math.round(performance.now() - started) }, "error");
      reject(new Error("VISION_TIMEOUT"));
    }, 180000);
    visionRequests.set(requestId, {
      resolve: (value) => {
        void debugEvent("vision_inference_complete", { requestId, elapsedMs: Math.round(performance.now() - started), outputChars: String(value || "").length });
        resolve(value);
      },
      reject: (error) => {
        void debugEvent("vision_inference_rejected", { requestId, elapsedMs: Math.round(performance.now() - started), message: error?.message || String(error) }, "error");
        reject(error);
      },
      timeout,
    });
    getVisionWorker().postMessage({ type: "generate", data: { requestId, prompt, image } });
  });
}
''')

# Replace buildVisionEvidence and keep error phase explicit.
s = replace_between(s, 'async function buildVisionEvidence(task, imageItems) {', '\nfunction attachmentSummary()', r'''async function buildVisionEvidence(task, imageItems) {
  if (!imageItems.length) return "";
  try {
    await ensureVision();
  } catch (err) {
    void debugEvent("vision_load_failed", { message: err?.message || String(err), stack: err?.stack || "" }, "error");
    throw new Error(`VISION_LOAD_FAILED: ${err?.message || err}`);
  }
  const outputs = [];
  const selected = imageItems.slice(0, 2);
  for (let i = 0; i < selected.length; i++) {
    const item = selected[i];
    setRun(`Vision: анализ изображения ${i + 1}/${selected.length}`, 58 + i * 12, 1, 3);
    const prompt = `Act as a factual visual sensor. The user asks in Russian: ${escapeForPrompt(task, 900)}\nAnswer in Russian if possible; otherwise use simple English. Describe only visible evidence relevant to the question. Include objects, composition, colors, layout, and legible text when possible. If something is uncertain, say so. Do not invent context outside the image.`;
    let evidence;
    try {
      evidence = await askVision(prompt, item.blob);
    } catch (err) {
      void debugEvent("vision_inference_failed", { imageIndex: i, imageName: item.name, message: err?.message || String(err), stack: err?.stack || "" }, "error");
      throw new Error(`VISION_INFERENCE_FAILED: ${err?.message || err}`);
    }
    outputs.push(`[VISION ${i + 1}: ${item.name}]\n${evidence || "Vision не вернул надёжного описания."}`);
  }
  if (imageItems.length > 2) outputs.push(`[VISION LIMIT]\nПроанализированы первые 2 изображения из ${imageItems.length}, чтобы не перегружать память iPhone.`);
  return `ВИЗУАЛЬНЫЕ ДАННЫЕ ОТ ОТДЕЛЬНОГО VISION-СЕНСОРА:\n${outputs.join("\n\n")}`;
}
''')

# Replace submitPrompt. This also fixes the v0.8.1 block-scope bug for visionEvidence.
s = replace_between(s, 'async function submitPrompt(prefill) {', '\nfunction isTextFile', r'''async function submitPrompt(prefill) {
  const task = (prefill ?? els.promptInput.value).trim();
  if (!task || modelLoading || visionLoading) return;
  const imageItems = pendingAttachments.filter((f) => f.kind === "image" && f.blob);
  const hasImages = imageItems.length > 0;
  const visible = `${task}${attachmentSummary()}`;
  const textAttachments = await buildAttachmentText();
  void debugEvent("prompt_submit", { taskChars: task.length, imageCount: imageItems.length, textAttachmentChars: textAttachments.length, modelReady });
  state.chats.push({ id: uid(), role: "user", text: visible, ts: nowIso() });
  await saveState();
  renderMessages();
  els.promptInput.value = "";
  autosize();
  const oldAttachments = [...pendingAttachments];
  pendingAttachments = [];
  renderAttachments();
  els.sendButton.disabled = true;
  try {
    let attachments = textAttachments;
    let visionEvidence = "";
    if (hasImages) {
      visionEvidence = await buildVisionEvidence(task, imageItems);
      attachments = [attachments, visionEvidence].filter(Boolean).join("\n\n");
    }
    let result;
    if (hasImages && !modelReady) {
      result = {
        mode: "s0",
        final: `Vision-предпросмотр (основная текстовая модель пока не загружена):\n\n${visionEvidence}`,
        candidates: [],
        verification: "Vision sensor only; text swarm not started",
        risks: ["Основная текстовая модель SWARM не запускалась; это прямой вывод Vision-сенсора."],
        visionOnly: true,
      };
    } else {
      result = modelReady ? await runSwarm(task, attachments) : demoResponse(task);
    }
    const report = `Режим: ${modePlan[result.mode].label} · blind-кандидатов: ${result.candidates.length || 0} · проверка: ${result.verification ? "да" : "нет"}${hasImages ? " · Vision: да" : ""}${result.risks?.length ? ` · риски: ${result.risks.length}` : ""}`;
    state.chats.push({ id: uid(), role: "assistant", text: result.final, ts: nowIso(), report, demo: !!result.demo });
    state.ledger.push({
      id: uid(),
      ts: nowIso(),
      status: result.demo ? "demo" : "complete",
      mode: result.mode,
      taskSummary: task.slice(0, 180),
      finalSummary: result.final.slice(0, 320),
      verificationScope: result.demo ? "none" : `local logic/math/source consistency${hasImages ? "; SmolVLM visual sensor" : ""}; no external web verification`,
      unresolvedRisk: result.risks?.join(" ") || "",
      nextAction: result.demo ? "prepare local model" : "",
    });
    if (!result.demo) {
      await addAudit({ type: "swarm_run", mode: result.mode, task: task.slice(0, 2000), usedVision: hasImages, internal: result });
    }
    await saveState();
    renderMessages();
    void debugEvent("prompt_complete", { mode: result.mode, hasImages, visionOnly: !!result.visionOnly, finalChars: result.final?.length || 0 });
  } catch (err) {
    console.error(err);
    void debugEvent("prompt_failed", { message: err?.message || String(err), stack: err?.stack || "", hasImages, modelReady, visionReady }, "error");
    const cancelled = String(err?.message || err).includes("CANCELLED");
    const visionFailure = /VISION|SmolVLM|transformers|load failed/i.test(String(err?.message || err));
    const text = cancelled
      ? "Запуск остановлен. Незавершённый внутренний результат не использован."
      : visionFailure
        ? `Vision не смог завершить анализ: ${err?.message || err}. Изображение не было подменено догадкой. DEV-диагностика записала этап ошибки.`
        : `Локальный запуск завершился ошибкой: ${err?.message || err}`;
    state.chats.push({ id: uid(), role: "assistant", text, ts: nowIso() });
    await saveState();
    renderMessages();
  } finally {
    els.runPanel.classList.add("hidden");
    els.sendButton.disabled = false;
    for (const f of oldAttachments) {
      if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
    }
  }
}
''')

# Replace text-model loader with stage-aware diagnostics.
s = replace_between(s, 'async function ensureEngine() {', '\nasync function requestPersistentStorage()', r'''async function ensureEngine() {
  if (modelReady && engine) return engine;
  if (modelLoading) return null;
  if (!("gpu" in navigator)) throw new Error("WebGPU недоступен в этом браузере.");
  modelLoading = true;
  els.prepareModelButton.disabled = true;
  els.downloadProgress.classList.remove("hidden");
  els.downloadProgress.querySelector("span").style.width = "2%";
  els.modelNote.textContent = "Загружаю WebLLM и модель. На первом запуске это может занять несколько минут.";
  updateStatus();
  void debugEvent("text_model_load_start", { modelId: MODEL_ID, library: WEBLLM_URL });
  try {
    try {
      modelModule = modelModule || await import(WEBLLM_URL);
      void debugEvent("webllm_library_ready", { library: WEBLLM_URL });
    } catch (err) {
      void debugEvent("webllm_library_failed", { library: WEBLLM_URL, message: err?.message || String(err), stack: err?.stack || "" }, "error");
      throw err;
    }
    let lastBucket = -1;
    const initProgressCallback = (report) => {
      const p = Number.isFinite(report?.progress) ? Math.round(report.progress * 100) : 5;
      els.downloadProgress.querySelector("span").style.width = `${Math.max(2, Math.min(100, p))}%`;
      els.modelNote.textContent = report?.text || `Подготовка модели: ${p}%`;
      const bucket = Math.floor(p / 25);
      if (bucket !== lastBucket) {
        lastBucket = bucket;
        void debugEvent("text_model_progress", { progress: p, text: report?.text || "" });
      }
    };
    try {
      engine = await modelModule.CreateMLCEngine(MODEL_ID, { initProgressCallback, logLevel: "WARN" }, { context_window_size: 2048 });
    } catch (err) {
      void debugEvent("text_model_engine_failed", { modelId: MODEL_ID, message: err?.message || String(err), stack: err?.stack || "" }, "error");
      throw err;
    }
    modelReady = true;
    els.downloadProgress.querySelector("span").style.width = "100%";
    els.modelNote.textContent = "Основная модель готова. Полный офлайн-тест оставлен на отдельный этап.";
    toast("Основная модель готова");
    await addAudit({ type: "model_ready", model: MODEL_ID, appVersion: APP_VERSION });
    void debugEvent("text_model_ready", { modelId: MODEL_ID });
  } finally {
    modelLoading = false;
    els.prepareModelButton.disabled = false;
    updateStatus();
    updateDiagnostics();
  }
  return engine;
}
''')

# Diagnostics UI and status.
s = s.replace('  els.modelReady.textContent = modelReady ? "готова" : "не загружена";\n}', '  els.modelReady.textContent = modelReady ? "готова" : "не загружена";\n  if (els.debugReady) els.debugReady.textContent = debugTopic ? `подключён · ${debugBuffer.length} событий` : `не подключён · ${debugBuffer.length} локальных`;\n  if (els.debugNote) els.debugNote.textContent = debugTopic ? "Технические события отправляются в DEV-канал и остаются в локальном буфере." : "Технические события сохраняются локально; удалённый DEV-канал не подключён.";\n}', 1)
s = s.replace('  els.runtimeLabel.textContent = navigator.onLine ? "локальный режим · сеть доступна" : "локальный режим · офлайн";', '  els.runtimeLabel.textContent = `${debugTopic ? "DEV · " : ""}${navigator.onLine ? "локальный режим · сеть доступна" : "локальный режим · офлайн"}`;\n  if (els.devBadge) els.devBadge.classList.toggle("hidden", !DEV_MODE);\n  if (els.composerFoot) els.composerFoot.textContent = debugTopic ? "DEV MODE · техническая диагностика подключена; фото и полный текст запроса автоматически не отправляются." : "DEV MODE · технические события сохраняются локально.";', 1)
s = s.replace('    ["Память Context Capsule", `${state.memory.length} записей`], ["Ledger", `${state.ledger.length} записей`],', '    ["Память Context Capsule", `${state.memory.length} записей`], ["Ledger", `${state.ledger.length} записей`],\n    ["DEV Debug Bridge", debugTopic ? `подключён · ${debugBuffer.length} событий` : `не подключён · ${debugBuffer.length} локальных`],', 1)

# Bind debug controls and global runtime errors.
needle = '  els.statusClose.addEventListener("click", () => els.statusDialog.close());\n'
assert needle in s
s = s.replace(needle, needle + '''  if (els.debugConnectButton) els.debugConnectButton.addEventListener("click", () => {\n    try { setDebugTopic(els.debugTopicInput?.value); toast("DEV-диагностика подключена"); }\n    catch (err) { toast(err?.message || String(err), 4200); }\n  });\n  if (els.debugDisconnectButton) els.debugDisconnectButton.addEventListener("click", () => { clearDebugTopic(); toast("DEV-диагностика отключена"); });\n  window.addEventListener("error", (e) => { void debugEvent("window_error", { message: e.message || "", filename: e.filename || "", line: e.lineno || 0, col: e.colno || 0, stack: e.error?.stack || "" }, "error"); });\n  window.addEventListener("unhandledrejection", (e) => { void debugEvent("unhandled_rejection", { reason: e.reason?.message || String(e.reason || ""), stack: e.reason?.stack || "" }, "error"); });\n''', 1)

# Boot the bridge before any other initialization work.
s = s.replace('async function init() {\n  bindEvents(); autosize();', 'async function init() {\n  bootstrapDebugBridge();\n  bindEvents(); autosize();\n  if (els.debugTopicInput) els.debugTopicInput.value = debugTopic;\n  void debugEvent("app_init_start", { secureContext: window.isSecureContext, language: navigator.language || "" });', 1)
s = s.replace('  setTimeout(updateDiagnostics, 900);\n}', '  setTimeout(updateDiagnostics, 900);\n  void debugEvent("app_init_complete", { serviceWorker: !!navigator.serviceWorker?.controller, persistentStorageSupported: !!navigator.storage?.persist });\n}', 1)

p.write_text(s, encoding="utf-8")

# --- vision-worker.js ---
p = Path("vision-worker.js")
v = p.read_text(encoding="utf-8")
v = v.replace('SWARM Vision Sensor v0.8.0', 'SWARM Vision Sensor v0.8.2')
# Give the main app precise phases instead of a generic load failure.
old_getmodel = '''async function getModel() {\n  if (processor && model) return [processor, model];\n  if (!loadPromise) {\n    post("loading", { data: "Загружаю лёгкий Vision-модуль…" });\n    loadPromise = Promise.all([\n      AutoProcessor.from_pretrained(MODEL_ID, {\n        progress_callback: (x) => self.postMessage(x),\n      }),\n      AutoModelForVision2Seq.from_pretrained(MODEL_ID, {\n        dtype: "fp32",\n        device: "webgpu",\n        progress_callback: (x) => self.postMessage(x),\n      }),\n    ]).then(([p, m]) => {\n      processor = p;\n      model = m;\n      post("ready", { modelId: MODEL_ID });\n      return [p, m];\n    }).catch((error) => {\n      loadPromise = null;\n      post("error", { data: String(error?.message || error) });\n      throw error;\n    });\n  }\n  return loadPromise;\n}\n'''
new_getmodel = '''async function getModel() {\n  if (processor && model) return [processor, model];\n  if (!loadPromise) {\n    loadPromise = (async () => {\n      try {\n        post("loading", { phase: "processor", data: "Vision: загружаю процессор изображения" });\n        processor = await AutoProcessor.from_pretrained(MODEL_ID, {\n          progress_callback: (x) => self.postMessage({ ...x, phase: "processor" }),\n        });\n      } catch (error) {\n        throw Object.assign(new Error(`PROCESSOR_LOAD_FAILED: ${error?.message || error}`), { phase: "processor" });\n      }\n      try {\n        post("loading", { phase: "model", data: "Vision: загружаю веса модели" });\n        model = await AutoModelForVision2Seq.from_pretrained(MODEL_ID, {\n          dtype: "fp32",\n          device: "webgpu",\n          progress_callback: (x) => self.postMessage({ ...x, phase: "model" }),\n        });\n      } catch (error) {\n        throw Object.assign(new Error(`MODEL_LOAD_FAILED: ${error?.message || error}`), { phase: "model" });\n      }\n      post("ready", { modelId: MODEL_ID });\n      return [processor, model];\n    })().catch((error) => {\n      loadPromise = null;\n      post("error", { phase: error?.phase || "load", data: String(error?.message || error) });\n      throw error;\n    });\n  }\n  return loadPromise;\n}\n'''
assert old_getmodel in v
v = v.replace(old_getmodel, new_getmodel, 1)
# Make image decoding and inference failures distinguishable.
old_generate = 'async function generate({ requestId, prompt, image }) {\n  try {\n    stoppingCriteria.reset();\n    const [p, m] = await getModel();\n    const rawImage = await load_image(image);'
new_generate = 'async function generate({ requestId, prompt, image }) {\n  let phase = "model";\n  try {\n    stoppingCriteria.reset();\n    const [p, m] = await getModel();\n    phase = "image_decode";\n    const rawImage = await load_image(image);\n    phase = "preprocess";'
assert old_generate in v
v = v.replace(old_generate, new_generate, 1)
v = v.replace('    post("start", { requestId });\n    await m.generate({', '    post("start", { requestId });\n    phase = "inference";\n    await m.generate({', 1)
v = v.replace('  } catch (error) {\n    post("error", { requestId, data: String(error?.message || error) });\n  }\n}', '  } catch (error) {\n    post("error", { requestId, phase, data: `${String(phase).toUpperCase()}_FAILED: ${String(error?.message || error)}` });\n  }\n}', 1)
p.write_text(v, encoding="utf-8")

# --- index.html ---
p = Path("index.html")
h = p.read_text(encoding="utf-8")
h = h.replace('SWARM One · v0.8.1', 'SWARM One · v0.8.2')
h = h.replace('<div class="brand-title">SWARM One</div>', '<div class="brand-title">SWARM One <span id="devBadge" class="dev-badge">DEV</span></div>', 1)
h = h.replace('<div class="diag-row"><span>Локальная модель</span><strong id="modelReady">не загружена</strong></div>', '<div class="diag-row"><span>Локальная модель</span><strong id="modelReady">не загружена</strong></div>\n          <div class="diag-row"><span>DEV Debug Bridge</span><strong id="debugReady">не подключён</strong></div>', 1)
settings_anchor = '''          <div class="settings-card switch-row">\n            <div>\n              <strong>Только локально</strong>'''
debug_card = '''          <div class="settings-card">\n            <div>\n              <strong>DEV диагностика</strong>\n              <p>Временно отправляет технические события в закрытый по случайному коду канал. Фото и полный текст запроса автоматически не отправляются.</p>\n            </div>\n            <input id="debugTopicInput" class="search-input" type="password" autocomplete="off" placeholder="Код DEV-канала" />\n            <div class="quick-actions">\n              <button id="debugConnectButton" class="primary-small" type="button">Подключить</button>\n              <button id="debugDisconnectButton" class="ghost-button" type="button">Отключить</button>\n            </div>\n            <small id="debugNote" class="muted">Технические события сохраняются локально.</small>\n          </div>\n'''
assert settings_anchor in h
h = h.replace(settings_anchor, debug_card + settings_anchor, 1)
h = h.replace('<div class="composer-foot">Личные данные остаются на устройстве в локальном режиме.</div>', '<div id="composerFoot" class="composer-foot">DEV MODE · технические события сохраняются локально.</div>', 1)
h = h.replace('./app.js?v=0.8.1', './app.js?v=0.8.2')
p.write_text(h, encoding="utf-8")

# --- styles.css ---
p = Path("styles.css")
c = p.read_text(encoding="utf-8")
css_anchor = '.brand-title { font-weight: 750; letter-spacing: -.02em; }\n'
assert css_anchor in c
c = c.replace(css_anchor, css_anchor + '.dev-badge { display: inline-block; margin-left: 5px; padding: 2px 5px; border: 1px solid rgba(255,213,138,.28); border-radius: 6px; color: #ffd58a; background: rgba(255,213,138,.08); font-size: 8px; letter-spacing: .08em; vertical-align: 2px; }\n', 1)
p.write_text(c, encoding="utf-8")

# --- service-worker.js ---
p = Path("service-worker.js")
w = p.read_text(encoding="utf-8")
w = w.replace('swarm-one-v0.8.1', 'swarm-one-v0.8.2')
w = w.replace('./app.js?v=0.8.1', './app.js?v=0.8.2')
w = w.replace('./vision-worker.js?v=0.8.1', './vision-worker.js?v=0.8.2')
p.write_text(w, encoding="utf-8")

print("SWARM v0.8.2 patch applied")
