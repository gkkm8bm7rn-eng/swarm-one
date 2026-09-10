const APP_VERSION = "0.8.2";
const MODEL_ID = "Qwen2.5-0.5B-Instruct-q4f16_1-MLC";
const WEBLLM_URL = "https://esm.run/@mlc-ai/web-llm@0.2.85";
const VISION_MODEL_ID = "HuggingFaceTB/SmolVLM-256M-Instruct";
const BLIND_MEMORY_TYPES = new Set(["FACT", "REQUIREMENT", "PREFERENCE"]);
const MAX_MEMORY_ITEMS = 200;
const MAX_CHAT_MESSAGES = 120;
const MAX_LEDGER_ITEMS = 100;
const MAX_TEXT_ATTACHMENT_BYTES = 5_000_000;
const MAX_IMAGE_ATTACHMENT_BYTES = 25_000_000;
const MAX_IMAGE_EDGE = 1600;
const IMAGE_JPEG_QUALITY = 0.82;
const MAX_ATTACHMENT_CHARS = 8_000;
const DEV_MODE = true;
const DEBUG_TOPIC_KEY = "swarm-dev-debug-topic";
const DEBUG_BUFFER_KEY = "swarm-dev-debug-buffer";
const DEBUG_ENDPOINT = "https://ntfy.sh";
const MAX_DEBUG_BUFFER = 80;


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
let visionWorker = null;
let visionReady = false;
let visionLoading = false;
let visionLoadPromise = null;
let visionLoadResolve = null;
let visionLoadReject = null;
const visionRequests = new Map();
let debugTopic = "";
let debugSession = uid();
let debugSeq = 0;
let debugBuffer = [];


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
  debugReady: $("debugReady"), debugTopicInput: $("debugTopicInput"), debugConnectButton: $("debugConnectButton"),
  debugDisconnectButton: $("debugDisconnectButton"), debugNote: $("debugNote"), composerFoot: $("composerFoot"), devBadge: $("devBadge"),
};

function cleanDebugValue(value, depth = 0) {
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


function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("IMAGE_READ_FAILED"));
    reader.readAsDataURL(blob);
  });
}

function getVisionWorker() {
  if (visionWorker) return visionWorker;
  visionWorker = new Worker(`./vision-worker.js?v=${APP_VERSION}`, { type: "module" });
  void debugEvent("vision_worker_created", { workerVersion: APP_VERSION });
  visionWorker.addEventListener("message", (event) => {
    const msg = event.data || {};
    if (msg.status === "loading") {
      visionLoading = true;
      void debugEvent("vision_load_stage", { phase: msg.phase || "loading", message: msg.data || "" });
      setRun("Vision: загружаю сенсор изображения", 12, 0, 3);
      return;
    }
    if (msg.status === "initiate" || msg.status === "progress" || msg.status === "done") {
      const raw = Number(msg.progress);
      const pct = Number.isFinite(raw) ? (raw <= 1 ? raw * 100 : raw) : 20;
      setRun(`Vision: подготовка модели${msg.file ? ` · ${msg.file}` : ""}`, Math.max(12, Math.min(55, 12 + pct * 0.43)), 0, 3);
      return;
    }
    if (msg.status === "ready") {
      visionReady = true;
      visionLoading = false;
      if (visionLoadResolve) visionLoadResolve(true);
      visionLoadResolve = null;
      visionLoadReject = null;
      toast("Vision готов");
      void debugEvent("vision_ready", { modelId: msg.modelId || VISION_MODEL_ID });
      return;
    }
    if (msg.status === "complete" && msg.requestId) {
      const item = visionRequests.get(msg.requestId);
      if (item) {
        clearTimeout(item.timeout);
        visionRequests.delete(msg.requestId);
        item.resolve(String(msg.output || "").trim());
      }
      return;
    }
    if (msg.status === "error") {
      const error = new Error(msg.data || "VISION_ERROR");
      void debugEvent("vision_worker_reported_error", { phase: msg.phase || "unknown", requestId: msg.requestId || null, message: error.message }, "error");
      if (msg.requestId && visionRequests.has(msg.requestId)) {
        const item = visionRequests.get(msg.requestId);
        clearTimeout(item.timeout);
        visionRequests.delete(msg.requestId);
        item.reject(error);
      } else if (visionLoadReject) {
        visionLoadReject(error);
        visionLoadPromise = null;
        visionLoadResolve = null;
        visionLoadReject = null;
      }
      visionLoading = false;
    }
  });
  visionWorker.addEventListener("error", (event) => {
    console.error("Vision worker error", event);
    const error = new Error(event.message || "VISION_WORKER_ERROR");
    void debugEvent("vision_worker_crash", { message: error.message, filename: event.filename || "", line: event.lineno || 0, col: event.colno || 0 }, "error");
    if (visionLoadReject) visionLoadReject(error);
    visionLoadPromise = null;
    visionLoadResolve = null;
    visionLoadReject = null;
    visionLoading = false;
  });
  visionWorker.postMessage({ type: "check" });
  return visionWorker;
}

async function ensureVision() {
  if (visionReady) return true;
  if (visionLoadPromise) return visionLoadPromise;
  visionLoading = true;
  const worker = getVisionWorker();
  visionLoadPromise = new Promise((resolve, reject) => {
    visionLoadResolve = resolve;
    visionLoadReject = reject;
    worker.postMessage({ type: "load" });
  });
  return visionLoadPromise;
}

async function askVision(prompt, blob) {
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

async function buildVisionEvidence(task, imageItems) {
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

function attachmentSummary() {
  if (!pendingAttachments.length) return "";
  return `\n\nВложения: ${pendingAttachments.map((f) => {
    if (f.kind === "image") return `${f.name} (изображение)`;
    return `${f.name}${f.supported ? "" : " (не извлечено)"}`;
  }).join(", ")}`;
}

async function submitPrompt(prefill) {
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
        pendingAttachments.push({ id: uid(), kind: "image", name: file.name, size: normalized.blob.size, originalSize: file.size, width: normalized.width, height: normalized.height, supported: false, text: "", blob: normalized.blob, previewUrl: normalized.objectUrl });
        toast(`${file.name}: фото подготовлено (${normalized.width}×${normalized.height}). Vision запустится при отправке.`, 3600);
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
  if (els.debugReady) els.debugReady.textContent = debugTopic ? `подключён · ${debugBuffer.length} событий` : `не подключён · ${debugBuffer.length} локальных`;
  if (els.debugNote) els.debugNote.textContent = debugTopic ? "Технические события отправляются в DEV-канал и остаются в локальном буфере." : "Технические события сохраняются локально; удалённый DEV-канал не подключён.";
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
  els.runtimeLabel.textContent = `${debugTopic ? "DEV · " : ""}${navigator.onLine ? "локальный режим · сеть доступна" : "локальный режим · офлайн"}`;
  if (els.devBadge) els.devBadge.classList.toggle("hidden", !DEV_MODE);
  if (els.composerFoot) els.composerFoot.textContent = debugTopic ? "DEV MODE · техническая диагностика подключена; фото и полный текст запроса автоматически не отправляются." : "DEV MODE · технические события сохраняются локально.";
}

async function showStatus() {
  const persistent = await isPersistentStorage();
  const rows = [
    ["Версия", APP_VERSION], ["Режим", state.settings.localOnly ? "только локально" : "локально + будущие адаптеры"],
    ["WebGPU", "gpu" in navigator ? "доступен" : "нет"], ["Модель", modelReady ? MODEL_ID : "не загружена"],
    ["Vision", visionReady ? VISION_MODEL_ID : (visionLoading ? "загружается" : "по требованию")],
    ["Хранилище", persistent ? "persistent" : "browser managed"], ["Сеть", navigator.onLine ? "доступна" : "офлайн"],
    ["Память Context Capsule", `${state.memory.length} записей`], ["Ledger", `${state.ledger.length} записей`],
    ["DEV Debug Bridge", debugTopic ? `подключён · ${debugBuffer.length} событий` : `не подключён · ${debugBuffer.length} локальных`],
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
  if (els.debugConnectButton) els.debugConnectButton.addEventListener("click", () => {
    try { setDebugTopic(els.debugTopicInput?.value); toast("DEV-диагностика подключена"); }
    catch (err) { toast(err?.message || String(err), 4200); }
  });
  if (els.debugDisconnectButton) els.debugDisconnectButton.addEventListener("click", () => { clearDebugTopic(); toast("DEV-диагностика отключена"); });
  window.addEventListener("error", (e) => { void debugEvent("window_error", { message: e.message || "", filename: e.filename || "", line: e.lineno || 0, col: e.colno || 0, stack: e.error?.stack || "" }, "error"); });
  window.addEventListener("unhandledrejection", (e) => { void debugEvent("unhandled_rejection", { reason: e.reason?.message || String(e.reason || ""), stack: e.reason?.stack || "" }, "error"); });
  window.addEventListener("online", updateStatus); window.addEventListener("offline", updateStatus);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { updateStatus(); updateDiagnostics(); } });
}

async function init() {
  bootstrapDebugBridge();
  bindEvents(); autosize();
  if (els.debugTopicInput) els.debugTopicInput.value = debugTopic;
  void debugEvent("app_init_start", { secureContext: window.isSecureContext, language: navigator.language || "" });
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
  void debugEvent("app_init_complete", { serviceWorker: !!navigator.serviceWorker?.controller, persistentStorageSupported: !!navigator.storage?.persist });
}

init();
