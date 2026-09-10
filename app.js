const APP_VERSION = "0.7.2";
const MODEL_ID = "Qwen2.5-0.5B-Instruct-q4f16_1-MLC";
const WEBLLM_URL = "https://esm.run/@mlc-ai/web-llm@0.2.85";
const BLIND_MEMORY_TYPES = new Set(["FACT", "REQUIREMENT", "PREFERENCE"]);
const MAX_MEMORY_ITEMS = 200;
const MAX_CHAT_MESSAGES = 120;
const MAX_LEDGER_ITEMS = 100;
const MAX_TEXT_ATTACHMENT_BYTES = 5_000_000;
const MAX_IMAGE_ATTACHMENT_BYTES = 25_000_000;
const MAX_IMAGE_EDGE = 1600;
const IMAGE_JPEG_QUALITY = 0.82;
const MAX_ATTACHMENT_CHARS = 8_000;

const $ = (id) => document.getElementById(id);
const nowIso = () => new Date().toISOString();
const uid = () => crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const defaultState = () => ({
  schema: 1,
  settings: {
    depth: "auto",
    report: true,
    localOnly: true,
    modelId: MODEL_ID,
  },
  memory: [],
  chats: [],
  ledger: [],
});

let state = defaultState();
let db = null;
let engine = null;
let modelModule = null;
let modelLoading = false;
let modelReady = false;
let cancelRequested = false;
let pendingAttachments = [];

const els = {
  runtimeLabel: $("runtimeLabel"), statusButton: $("statusButton"), statusDot: $("statusDot"), statusText: $("statusText"),
  welcomeCard: $("welcomeCard"), messages: $("messages"), runPanel: $("runPanel"), runStage: $("runStage"),
  runProgress: $("runProgress"), agentDots: $("agentDots"), stopButton: $("stopButton"),
  memorySearch: $("memorySearch"), addMemoryButton: $("addMemoryButton"), memoryList: $("memoryList"),
  exportButton: $("exportButton"), importFile: $("importFile"), shellReady: $("shellReady"), gpuReady: $("gpuReady"),
  persistReady: $("persistReady"), modelReady: $("modelReady"), depthSelect: $("depthSelect"), prepareModelButton: $("prepareModelButton"),
  downloadProgress: $("downloadProgress"), modelNote: $("modelNote"), reportToggle: $("reportToggle"), localOnlyToggle: $("localOnlyToggle"),
  composerWrap: $("composerWrap"), attachmentStrip: $("attachmentStrip"), attachmentInput: $("attachmentInput"), promptInput: $("promptInput"), sendButton: $("sendButton"),
  memoryDialog: $("memoryDialog"), memoryForm: $("memoryForm"), memoryType: $("memoryType"), memoryText: $("memoryText"), saveMemoryButton: $("saveMemoryButton"),
  statusDialog: $("statusDialog"), statusClose: $("statusClose"), statusDetails: $("statusDetails"),
};

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("swarm-one", 1);
    req.onupgradeneeded = () => {
      const idb = req.result;
      if (!idb.objectStoreNames.contains("kv")) idb.createObjectStore("kv");
      if (!idb.objectStoreNames.contains("audit")) idb.createObjectStore("audit", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(store, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, "readonly").objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(store, value, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const os = tx.objectStore(store);
    key === undefined ? os.put(value) : os.put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function saveState() {
  state.chats = state.chats.slice(-MAX_CHAT_MESSAGES);
  state.ledger = state.ledger.slice(-MAX_LEDGER_ITEMS);
  state.memory = state.memory.slice(-MAX_MEMORY_ITEMS);
  await idbPut("kv", state, "state");
}

async function addAudit(record) {
  try {
    await idbPut("audit", { id: uid(), ts: nowIso(), ...record });
  } catch (err) {
    console.warn("Audit write failed", err);
  }
}

function toast(text, ms = 2600) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function fmtTime(iso) {
  try { return new Intl.DateTimeFormat("ru", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso)); }
  catch { return ""; }
}

function escapeForPrompt(text, limit = 6000) {
  return String(text || "").replace(/\u0000/g, "").slice(0, limit);
}

function getBlindContext() {
  const items = state.memory.filter((m) => BLIND_MEMORY_TYPES.has(m.type)).slice(-50);
  if (!items.length) return "Стабильный Context Capsule отсутствует.";
  return items.map((m) => `[${m.type}] ${m.text}`).join("\n");
}

function protocolSystem(role) {
  return `Ты — ${role} внутри SWARM One.\n\nКлючевые правила:\n- Работай только с исходной задачей и разрешённым Context Capsule.\n- Не выдумывай внешнюю проверку: веб-доступа у тебя нет.\n- Разделяй факты, выводы и неопределённость.\n- Не соглашайся автоматически с формулировкой пользователя или другими кандидатами.\n- Отвечай на русском, компактно и по делу.\n- Если данных недостаточно, явно укажи, чего именно не хватает.`;
}

function taskPacket(task, attachmentText = "") {
  const ctx = getBlindContext();
  return `ИСХОДНАЯ ЗАДАЧА:\n${escapeForPrompt(task)}\n\nCONTEXT GATE (только FACT / REQUIREMENT / PREFERENCE):\n${escapeForPrompt(ctx, 4200)}${attachmentText ? `\n\nМАТЕРИАЛЫ ПОЛЬЗОВАТЕЛЯ:\n${escapeForPrompt(attachmentText, MAX_ATTACHMENT_CHARS)}` : ""}`;
}

async function callModel(system, user, { maxTokens = 420, temperature = 0.45 } = {}) {
  if (!engine) throw new Error("LOCAL_MODEL_NOT_READY");
  if (cancelRequested) throw new Error("CANCELLED");
  const response = await engine.chat.completions.create({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature,
    max_tokens: maxTokens,
  });
  if (cancelRequested) throw new Error("CANCELLED");
  return response?.choices?.[0]?.message?.content?.trim() || "Модель не вернула текст.";
}

function chooseMode(task) {
  const explicit = state.settings.depth;
  if (explicit && explicit !== "auto") return explicit;
  const t = task.toLowerCase();
  if (/полным роем|максимально тщательно|критически важно|s3/.test(t)) return "s3";
  if (/нескольк|рой|сравни|альтернатив|вариант|совет|стратег/.test(t)) return "s2";
  if (/проверь|перепроверь|ошибк|расч[её]т|факт|вериф|s1/.test(t)) return "s1";
  if (task.length > 420 || /проанализ|разбери|объясни|почему/.test(t)) return "s1";
  return "s0";
}

const modePlan = {
  s0: { candidates: 1, stages: 1, label: "S0 · быстро" },
  s1: { candidates: 1, stages: 3, label: "S1 · с проверкой" },
  s2: { candidates: 2, stages: 5, label: "S2 · несколько мнений" },
  s3: { candidates: 3, stages: 8, label: "S3 · полный рой" },
};

function setRun(stage, progress, activeIndex = 0, totalDots = 5) {
  els.runPanel.classList.remove("hidden");
  els.runStage.textContent = stage;
  els.runProgress.style.width = `${Math.max(3, Math.min(100, progress))}%`;
  els.agentDots.replaceChildren();
  for (let i = 0; i < totalDots; i++) {
    const dot = document.createElement("span");
    dot.className = `agent-dot ${i === activeIndex ? "active" : ""}`;
    els.agentDots.appendChild(dot);
  }
}

function shuffle(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function candidatesForReveal(candidates) {
  return shuffle(candidates).map((text, i) => `КАНДИДАТ ${String.fromCharCode(65 + i)}:\n${text}`).join("\n\n---\n\n");
}

async function runSwarm(task, attachmentText = "") {
  const mode = chooseMode(task);
  const plan = modePlan[mode];
  cancelRequested = false;
  const blindPacket = taskPacket(task, attachmentText);
  const candidates = [];
  const roles = ["независимый аналитик", "альтернативный решатель", "практический специалист"];
  let step = 0;
  const pct = () => Math.round((step / plan.stages) * 100);

  for (let i = 0; i < plan.candidates; i++) {
    setRun(`Blind ${i + 1}/${plan.candidates}: независимое решение`, pct(), i, plan.candidates);
    const prompt = `${blindPacket}\n\nСделай своё решение независимо. Не предполагай, что другие агенты придут к тем же выводам.`;
    candidates.push(await callModel(protocolSystem(roles[i]), prompt, { temperature: 0.52 + i * 0.08, maxTokens: 430 }));
    step++;
  }

  if (mode === "s0") {
    setRun("Готово", 100, 0, 1);
    return { mode, final: candidates[0], candidates, verification: "не запускалась", risks: [] };
  }

  const reveal = candidatesForReveal(candidates);
  let critic = "";
  if (mode === "s2" || mode === "s3") {
    setRun("Reveal → Critic: ищем слабые места", pct(), 0, 3);
    critic = await callModel(protocolSystem("критик-фальсификатор"), `${blindPacket}\n\nНиже анонимные независимые ответы. Найди конкретные ошибки, противоречия, пропуски и ложную уверенность. Не критикуй ради критики.\n\n${reveal}`, { temperature: 0.25, maxTokens: 360 });
    step++;
  }

  setRun("Verifier: логика, числа, соответствие данным", pct(), 1, 3);
  const verifier = await callModel(protocolSystem("верификатор"), `${blindPacket}\n\nПроверь ответы ниже только теми средствами, которые реально доступны: логика, арифметика, непротиворечивость, исходный материал. Внешние факты, которых нет в задаче, помечай как НЕ ПРОВЕРЕНЫ, а не как подтверждённые.\n\n${reveal}${critic ? `\n\nКРИТИКА:\n${critic}` : ""}`, { temperature: 0.18, maxTokens: 360 });
  step++;

  if (mode === "s1") {
    setRun("Judge: финальная сборка", pct(), 2, 3);
    const final = await callModel(protocolSystem("судья и финальный редактор"), `${blindPacket}\n\nИСХОДНЫЙ ОТВЕТ:\n${candidates[0]}\n\nВЕРИФИКАЦИЯ:\n${verifier}\n\nСобери лучший финальный ответ. Исправь только подтверждённые проблемы и не скрывай остаточную неопределённость.`, { temperature: 0.2, maxTokens: 520 });
    step++;
    setRun("Готово", 100, 2, 3);
    return { mode, final, candidates, verifier, verification: verifier, risks: extractRisks(verifier) };
  }

  let repaired = reveal;
  let postCheck = "";
  if (mode === "s3") {
    setRun("Repair: исправляем подтверждённые проблемы", pct(), 2, 4);
    repaired = await callModel(protocolSystem("repair-агент"), `${blindPacket}\n\nКАНДИДАТЫ:\n${reveal}\n\nКРИТИКА:\n${critic}\n\nВЕРИФИКАЦИЯ:\n${verifier}\n\nСоздай исправленный кандидат. Не добавляй новые непроверенные факты без явной маркировки.`, { temperature: 0.24, maxTokens: 500 });
    step++;

    setRun("Post-check: повторная проверка ремонта", pct(), 3, 4);
    postCheck = await callModel(protocolSystem("пост-верификатор"), `${blindPacket}\n\nИСПРАВЛЕННЫЙ КАНДИДАТ:\n${repaired}\n\nПроверь, действительно ли устранены замечания и не появились ли новые ошибки.`, { temperature: 0.15, maxTokens: 300 });
    step++;
  }

  setRun("Judge: выбираем и собираем финал", pct(), 2, 3);
  const final = await callModel(protocolSystem("судья и финальный редактор"), `${blindPacket}\n\nАНОНИМНЫЕ КАНДИДАТЫ:\n${reveal}\n\nКРИТИКА:\n${critic}\n\nВЕРИФИКАЦИЯ:\n${verifier}${mode === "s3" ? `\n\nREPAIR:\n${repaired}\n\nPOST-CHECK:\n${postCheck}` : ""}\n\nВыбери доказательно сильные части, отбрось слабые и дай один самостоятельный финальный ответ. Если конфликт не разрешён — покажи его, не сглаживай.`, { temperature: 0.2, maxTokens: 560 });
  step++;
  setRun("Готово", 100, 2, 3);

  return {
    mode, final, candidates, critic, verifier, repaired: mode === "s3" ? repaired : undefined,
    postCheck: mode === "s3" ? postCheck : undefined,
    verification: mode === "s3" ? `${verifier}\n${postCheck}` : verifier,
    risks: extractRisks(`${verifier}\n${postCheck}`),
  };
}

function extractRisks(text) {
  const t = String(text || "").toLowerCase();
  const risks = [];
  if (t.includes("не провер")) risks.push("Есть внешние факты, которые локально не подтверждены.");
  if (t.includes("недостат")) risks.push("Для части вывода может не хватать исходных данных.");
  if (t.includes("противореч")) risks.push("В проверке отмечено противоречие.");
  return [...new Set(risks)].slice(0, 3);
}

function demoResponse(task) {
  const mode = chooseMode(task);
  return {
    mode,
    final: `Офлайн-модель ещё не подготовлена. Я не буду имитировать ответ роя без модели.\n\nДля этой задачи выбран режим ${modePlan[mode].label}. Интерфейс, Context Capsule, Recovery Capsule и Ledger уже работают локально. Чтобы SWARM начал реально решать задачи, открой «Настройки» → «Подготовить офлайн» и дождись загрузки модели.`,
    candidates: [], verification: "demo mode — модель не запускалась", risks: ["Ответ по существу задачи не вычислялся."], demo: true,
  };
}

function renderMessages() {
  els.messages.replaceChildren();
  const items = state.chats;
  els.welcomeCard.classList.toggle("hidden", items.length > 0);
  for (const msg of items) {
    const wrap = document.createElement("div");
    wrap.className = `message ${msg.role}`;
    const inner = document.createElement("div");
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    if (msg.demo) {
      const tag = document.createElement("span");
      tag.className = "demo-tag";
      tag.textContent = "DEMO MODE";
      bubble.appendChild(tag);
      bubble.appendChild(document.createElement("br"));
    }
    const text = document.createElement("span");
    text.textContent = msg.text;
    bubble.appendChild(text);
    if (msg.report && state.settings.report) {
      const report = document.createElement("div");
      report.className = "report-box";
      report.textContent = msg.report;
      bubble.appendChild(report);
    }
    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.textContent = fmtTime(msg.ts);
    inner.append(bubble, meta);
    wrap.appendChild(inner);
    els.messages.appendChild(wrap);
  }
  requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }));
}

function renderMemory() {
  const q = els.memorySearch.value.trim().toLowerCase();
  const items = state.memory.filter((m) => !q || m.text.toLowerCase().includes(q) || m.type.toLowerCase().includes(q));
  els.memoryList.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("div"); empty.className = "empty-state";
    empty.textContent = state.memory.length ? "Ничего не найдено." : "Память пока пуста. Добавляй только устойчивые правила и факты.";
    els.memoryList.appendChild(empty); return;
  }
  for (const m of [...items].reverse()) {
    const card = document.createElement("div"); card.className = "memory-card";
    const top = document.createElement("div"); top.className = "memory-top";
    const type = document.createElement("span"); type.className = "memory-type"; type.textContent = m.type;
    const actions = document.createElement("div"); actions.className = "memory-actions";
    const del = document.createElement("button"); del.className = "icon-button"; del.type = "button"; del.textContent = "Удалить";
    del.addEventListener("click", async () => { state.memory = state.memory.filter((x) => x.id !== m.id); await saveState(); renderMemory(); });
    actions.appendChild(del); top.append(type, actions);
    const txt = document.createElement("div"); txt.className = "memory-text"; txt.textContent = m.text;
    card.append(top, txt); els.memoryList.appendChild(card);
  }
}

function switchView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.dataset.view === name));
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.target === name));
  els.composerWrap.classList.toggle("hidden", name !== "chat");
  if (name === "memory") renderMemory();
  if (name === "vault") updateDiagnostics();
}

function autosize() {
  els.promptInput.style.height = "auto";
  els.promptInput.style.height = `${Math.min(140, els.promptInput.scrollHeight)}px`;
}

async function buildAttachmentText() {
  const blocks = [];
  let used = 0;
  for (const f of pendingAttachments) {
    if (!f.supported || !f.text) continue;
    const left = MAX_ATTACHMENT_CHARS - used;
    if (left <= 0) break;
    const part = f.text.slice(0, left);
    blocks.push(`[Файл: ${f.name}]\n${part}`);
    used += part.length;
  }
  return blocks.join("\n\n");
}

function attachmentSummary() {
  if (!pendingAttachments.length) return "";
  return `\n\nВложения: ${pendingAttachments.map((f) => {
    if (f.kind === "image") return `${f.name} (изображение; Vision пока не подключён)`;
    return `${f.name}${f.supported ? "" : " (не извлечено)"}`;
  }).join(", ")}`;
}

async function submitPrompt(prefill) {
  const task = (prefill ?? els.promptInput.value).trim();
  if (!task || modelLoading) return;
  const hasImages = pendingAttachments.some((f) => f.kind === "image");
  const visible = `${task}${attachmentSummary()}`;
  const attachments = await buildAttachmentText();
  state.chats.push({ id: uid(), role: "user", text: visible, ts: nowIso() });
  await saveState(); renderMessages();
  els.promptInput.value = ""; autosize();
  const oldAttachments = pendingAttachments;
  pendingAttachments = []; renderAttachments();
  els.sendButton.disabled = true;
  try {
    if (hasImages) {
      const text = "Изображение принято и локально подготовлено, но текущая офлайн-модель SWARM — текстовая и ещё не умеет видеть содержимое фотографии. Я не буду делать вид, что проанализировал изображение. Vision подключим отдельной локальной моделью после проверки её устойчивости на iPhone.";
      state.chats.push({ id: uid(), role: "assistant", text, ts: nowIso(), report: "Vision: не запускался · изображение не отправлялось наружу" });
      state.ledger.push({ id: uid(), ts: nowIso(), status: "blocked", mode: "vision", taskSummary: task.slice(0,180), finalSummary: text, verificationScope: "none", unresolvedRisk: "Vision model not installed", nextAction: "prepare local vision model" });
      await saveState(); renderMessages();
      return;
    }
    const result = modelReady ? await runSwarm(task, attachments) : demoResponse(task);
    const report = `Режим: ${modePlan[result.mode].label} · blind-кандидатов: ${result.candidates.length || 0} · проверка: ${result.verification ? "да" : "нет"}${result.risks?.length ? ` · риски: ${result.risks.length}` : ""}`;
    state.chats.push({ id: uid(), role: "assistant", text: result.final, ts: nowIso(), report, demo: !!result.demo });
    state.ledger.push({
      id: uid(), ts: nowIso(), status: result.demo ? "demo" : "complete", mode: result.mode,
      taskSummary: task.slice(0, 180), finalSummary: result.final.slice(0, 320),
      verificationScope: result.demo ? "none" : "local logic/math/source consistency; no external web verification",
      unresolvedRisk: result.risks?.join(" ") || "",
      nextAction: result.demo ? "prepare local model" : "",
    });
    if (!result.demo) await addAudit({ type: "swarm_run", mode: result.mode, task: task.slice(0, 2000), internal: result });
    await saveState(); renderMessages();
  } catch (err) {
    console.error(err);
    const cancelled = String(err?.message || err).includes("CANCELLED");
    state.chats.push({ id: uid(), role: "assistant", text: cancelled ? "Запуск остановлен. Незавершённый внутренний результат не использован." : `Локальный запуск завершился ошибкой: ${err?.message || err}`, ts: nowIso() });
    await saveState(); renderMessages();
  } finally {
    els.runPanel.classList.add("hidden");
    els.sendButton.disabled = false;
    oldAttachments.length = 0;
  }
}

function isTextFile(file) {
  const ext = file.name.split(".").pop()?.toLowerCase();
  const allowed = new Set(["txt","md","csv","json","html","htm","css","js","mjs","ts","tsx","jsx","py","xml","yaml","yml","log","sql"]);
  return file.type.startsWith("text/") || file.type === "application/json" || allowed.has(ext);
}

function isImageFile(file) {
  const ext = file.name.split(".").pop()?.toLowerCase();
  return file.type.startsWith("image/") || new Set(["jpg","jpeg","png","webp","heic","heif"]).has(ext);
}

function canvasToBlob(canvas, type = "image/jpeg", quality = IMAGE_JPEG_QUALITY) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function normalizeImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("IMAGE_DECODE_FAILED"));
      el.src = url;
    });
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("CANVAS_UNAVAILABLE");
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await canvasToBlob(canvas);
    if (!blob) throw new Error("IMAGE_ENCODE_FAILED");
    return { width, height, blob, objectUrl: URL.createObjectURL(blob) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function handleFiles(files) {
  for (const file of [...files].slice(0, 8)) {
    if (isImageFile(file)) {
      if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
        toast(`${file.name}: фото больше 25 МБ — выбери обычную фотографию вместо RAW/очень большого файла`, 4200);
        continue;
      }
      try {
        const normalized = await normalizeImage(file);
        pendingAttachments.push({ id: uid(), kind: "image", name: file.name, size: normalized.blob.size, originalSize: file.size, width: normalized.width, height: normalized.height, supported: false, text: "", previewUrl: normalized.objectUrl });
        toast(`${file.name}: фото подготовлено локально (${normalized.width}×${normalized.height}). Vision пока не подключён.`, 3600);
      } catch {
        pendingAttachments.push({ id: uid(), kind: "image", name: file.name, size: file.size, supported: false, text: "" });
        toast(`${file.name}: не удалось декодировать изображение`, 3600);
      }
      continue;
    }
    if (isTextFile(file)) {
      if (file.size > MAX_TEXT_ATTACHMENT_BYTES) {
        toast(`${file.name}: текстовый файл больше 5 МБ — не добавлен`); continue;
      }
      try {
        const text = await file.text();
        pendingAttachments.push({ id: uid(), kind: "text", name: file.name, size: file.size, supported: true, text });
      } catch {
        pendingAttachments.push({ id: uid(), kind: "text", name: file.name, size: file.size, supported: false, text: "" });
      }
      continue;
    }
    pendingAttachments.push({ id: uid(), kind: "binary", name: file.name, size: file.size, supported: false, text: "" });
    toast(`${file.name}: этот тип файла пока не обрабатывается`, 3200);
  }
  renderAttachments();
  els.attachmentInput.value = "";
}

function renderAttachments() {
  els.attachmentStrip.replaceChildren();
  for (const f of pendingAttachments) {
    const pill = document.createElement("span"); pill.className = "attachment-pill";
    const txt = document.createElement("span");
    const icon = f.kind === "image" ? "▧" : (f.supported ? "▤" : "◻︎");
    const suffix = f.kind === "image" && f.width ? ` · ${f.width}×${f.height}` : "";
    txt.textContent = `${icon} ${f.name}${suffix}`;
    const rm = document.createElement("button"); rm.type = "button"; rm.textContent = "×";
    rm.addEventListener("click", () => {
      if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
      pendingAttachments = pendingAttachments.filter((x) => x.id !== f.id);
      renderAttachments();
    });
    pill.append(txt, rm); els.attachmentStrip.appendChild(pill);
  }
}

async function ensureEngine() {
  if (modelReady && engine) return engine;
  if (modelLoading) return null;
  if (!("gpu" in navigator)) throw new Error("WebGPU недоступен в этом браузере.");
  modelLoading = true;
  els.prepareModelButton.disabled = true;
  els.downloadProgress.classList.remove("hidden");
  els.downloadProgress.querySelector("span").style.width = "2%";
  els.modelNote.textContent = "Загружаю WebLLM и модель. На первом запуске это может занять несколько минут.";
  updateStatus();
  try {
    modelModule = modelModule || await import(WEBLLM_URL);
    const initProgressCallback = (report) => {
      const p = Number.isFinite(report?.progress) ? Math.round(report.progress * 100) : 5;
      els.downloadProgress.querySelector("span").style.width = `${Math.max(2, Math.min(100, p))}%`;
      els.modelNote.textContent = report?.text || `Подготовка модели: ${p}%`;
    };
    engine = await modelModule.CreateMLCEngine(MODEL_ID, { initProgressCallback, logLevel: "WARN" }, { context_window_size: 2048 });
    modelReady = true;
    els.downloadProgress.querySelector("span").style.width = "100%";
    els.modelNote.textContent = "Модель готова. Теперь проверь работу в авиарежиме после полного закрытия приложения.";
    toast("Офлайн-модель готова");
    await addAudit({ type: "model_ready", model: MODEL_ID, appVersion: APP_VERSION });
  } finally {
    modelLoading = false;
    els.prepareModelButton.disabled = false;
    updateStatus(); updateDiagnostics();
  }
  return engine;
}

async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return false;
  try { return await navigator.storage.persist(); } catch { return false; }
}

async function isPersistentStorage() {
  if (!navigator.storage?.persisted) return false;
  try { return await navigator.storage.persisted(); } catch { return false; }
}

async function updateDiagnostics() {
  els.shellReady.textContent = navigator.serviceWorker?.controller ? "готово" : ("serviceWorker" in navigator ? "установлено/ожидает" : "нет SW");
  els.gpuReady.textContent = "gpu" in navigator ? "доступен" : "нет";
  els.persistReady.textContent = (await isPersistentStorage()) ? "persistent" : "обычное";
  els.modelReady.textContent = modelReady ? "готова" : "не загружена";
}

function updateStatus() {
  els.statusDot.className = "status-dot";
  if (modelLoading) {
    els.statusText.textContent = "Загрузка модели";
  } else if (modelReady) {
    els.statusText.textContent = "Локально готов";
    els.statusDot.classList.add("ok");
  } else if (!("gpu" in navigator)) {
    els.statusText.textContent = "Нет WebGPU";
    els.statusDot.classList.add("bad");
  } else {
    els.statusText.textContent = "Нужна модель";
  }
  els.runtimeLabel.textContent = navigator.onLine ? "локальный режим · сеть доступна" : "локальный режим · офлайн";
}

async function showStatus() {
  const persistent = await isPersistentStorage();
  const rows = [
    ["Версия", APP_VERSION], ["Режим", state.settings.localOnly ? "только локально" : "локально + будущие адаптеры"],
    ["WebGPU", "gpu" in navigator ? "доступен" : "нет"], ["Модель", modelReady ? MODEL_ID : "не загружена"],
    ["Хранилище", persistent ? "persistent" : "browser managed"], ["Сеть", navigator.onLine ? "доступна" : "офлайн"],
    ["Память Context Capsule", `${state.memory.length} записей`], ["Ledger", `${state.ledger.length} записей`],
  ];
  els.statusDetails.replaceChildren();
  for (const [a,b] of rows) {
    const line = document.createElement("div"); line.className = "status-line";
    const s = document.createElement("span"); s.textContent = a; const st = document.createElement("strong"); st.textContent = b;
    line.append(s,st); els.statusDetails.appendChild(line);
  }
  els.statusDialog.showModal();
}

async function exportRecovery() {
  const capsule = {
    format: "SWARM_RECOVERY_CAPSULE",
    version: APP_VERSION,
    exportedAt: nowIso(),
    note: "Private Audit Trace intentionally excluded.",
    state: { settings: state.settings, memory: state.memory, chats: state.chats, ledger: state.ledger },
  };
  const blob = new Blob([JSON.stringify(capsule, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `SWARM_Recovery_${new Date().toISOString().slice(0,10)}.swarm`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importRecovery(file) {
  try {
    const raw = await file.text();
    const capsule = JSON.parse(raw);
    if (capsule?.format !== "SWARM_RECOVERY_CAPSULE" || !capsule.state) throw new Error("Это не Recovery Capsule SWARM.");
    if (!confirm("Импорт заменит текущие локальные чаты, память, Ledger и настройки. Продолжить?")) return;
    const incoming = capsule.state;
    state = defaultState();
    state.settings = { ...state.settings, ...(incoming.settings || {}) };
    state.memory = Array.isArray(incoming.memory) ? incoming.memory.slice(-MAX_MEMORY_ITEMS) : [];
    state.chats = Array.isArray(incoming.chats) ? incoming.chats.slice(-MAX_CHAT_MESSAGES) : [];
    state.ledger = Array.isArray(incoming.ledger) ? incoming.ledger.slice(-MAX_LEDGER_ITEMS) : [];
    await saveState(); applySettings(); renderMessages(); renderMemory(); updateStatus();
    toast("Recovery Capsule импортирован");
  } catch (err) {
    toast(`Импорт не выполнен: ${err?.message || err}`, 4200);
  } finally {
    els.importFile.value = "";
  }
}

function applySettings() {
  els.depthSelect.value = state.settings.depth || "auto";
  els.reportToggle.checked = state.settings.report !== false;
  els.localOnlyToggle.checked = state.settings.localOnly !== false;
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  try {
    const reg = await navigator.serviceWorker.register("./service-worker.js", { scope: "./" });
    if (reg.waiting) reg.waiting.postMessage({ type: "SKIP_WAITING" });
  } catch (err) { console.warn("Service worker registration failed", err); }
}

function bindEvents() {
  document.querySelectorAll(".nav-item").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.target)));
  document.querySelectorAll(".quick-chip").forEach((b) => b.addEventListener("click", () => { els.promptInput.value = b.dataset.prompt || ""; autosize(); els.promptInput.focus(); }));
  els.promptInput.addEventListener("input", autosize);
  els.promptInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submitPrompt(); }
  });
  els.sendButton.addEventListener("click", () => submitPrompt());
  els.attachmentInput.addEventListener("change", () => handleFiles(els.attachmentInput.files));
  els.stopButton.addEventListener("click", () => {
    cancelRequested = true;
    try { engine?.interruptGenerate?.(); } catch {}
    els.runStage.textContent = "Останавливаю после текущего шага…";
  });
  els.memorySearch.addEventListener("input", renderMemory);
  els.addMemoryButton.addEventListener("click", () => { els.memoryText.value = ""; els.memoryDialog.showModal(); });
  els.saveMemoryButton.addEventListener("click", async (e) => {
    e.preventDefault();
    const text = els.memoryText.value.trim(); if (!text) return;
    state.memory.push({ id: uid(), type: els.memoryType.value, text, createdAt: nowIso() });
    await saveState(); renderMemory(); els.memoryDialog.close(); toast("Добавлено в Context Capsule");
  });
  els.exportButton.addEventListener("click", exportRecovery);
  els.importFile.addEventListener("change", () => els.importFile.files?.[0] && importRecovery(els.importFile.files[0]));
  els.depthSelect.addEventListener("change", async () => { state.settings.depth = els.depthSelect.value; await saveState(); });
  els.reportToggle.addEventListener("change", async () => { state.settings.report = els.reportToggle.checked; await saveState(); renderMessages(); });
  els.localOnlyToggle.addEventListener("change", async () => { state.settings.localOnly = els.localOnlyToggle.checked; await saveState(); updateStatus(); });
  els.prepareModelButton.addEventListener("click", async () => {
    try { await requestPersistentStorage(); await ensureEngine(); }
    catch (err) { console.error(err); toast(`Модель не подготовлена: ${err?.message || err}`, 5000); els.modelNote.textContent = err?.message || String(err); updateStatus(); }
  });
  els.statusButton.addEventListener("click", showStatus);
  els.statusClose.addEventListener("click", () => els.statusDialog.close());
  window.addEventListener("online", updateStatus); window.addEventListener("offline", updateStatus);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { updateStatus(); updateDiagnostics(); } });
}

async function init() {
  bindEvents(); autosize();
  try {
    db = await openDB();
    const saved = await idbGet("kv", "state");
    if (saved && typeof saved === "object") state = { ...defaultState(), ...saved, settings: { ...defaultState().settings, ...(saved.settings || {}) } };
  } catch (err) {
    console.error("IndexedDB unavailable", err); toast("Не удалось открыть локальное хранилище", 4200);
  }
  applySettings(); renderMessages(); renderMemory(); updateStatus(); updateDiagnostics();
  await registerServiceWorker();
  setTimeout(updateDiagnostics, 900);
}

init();
