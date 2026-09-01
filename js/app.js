import {
  $,
  $$,
  autoResize,
  contentAsText,
  defaultTitle,
  downloadJson,
  escapeAttr,
  escapeHtml,
  firstLine,
  formatBytes,
  formatGenMeta,
  isDefaultTitle,
  makeId,
  nowSec,
  prefersNewlineOnEnter,
  relativeTime,
  renderSoftMarkdown,
  toast,
} from "./util.js";
import { FALLBACK_MODELS, VOICES, loadSettings, maskKey, saveSettings } from "./settings.js";
import {
  deleteChat,
  deleteFile,
  deleteProject,
  emptyChat,
  emptyProject,
  getChat,
  getProject,
  listChats,
  listFiles,
  listProjects,
  saveChat,
  saveFile,
  saveProject,
} from "./db.js";
import { chatStream, fetchCreditBalance, formatUsd, listModels, sanitizeApiKey } from "./xai.js";
import { ragMetaFrom, retrieveFromFiles } from "./rag.js";
import { normalizeImportPayload, toExportChat, toStudioChat } from "./importChat.js";
import { speakText, stopSpeak } from "./tts.js";
import { downloadBackup, supabaseSql, uploadBackup } from "./cloud.js";
import {
  assertClientId,
  authorizedOrigin,
  clearToken,
  consumeOAuthRedirect,
  downloadFromDrive,
  sanitizeClientId,
  driveSetupHelp,
  isDriveLoggedIn,
  startGoogleLogin,
  uploadToDrive,
} from "./drive.js";

const state = {
  settings: loadSettings(),
  models: FALLBACK_MODELS,
  projects: [],
  files: [],
  chats: [],
  projectChats: [],
  activeProjectId: null,
  current: null,
  streaming: false,
  abort: null,
  ragSelectedSources: [], // null=全 / []=オフ（既定） / names
  findHits: [],
  editingIndex: null,
  pendingAttachments: [],
  attachBusy: false,
  _projectPromptTimer: null,
  _projectPromptDirty: false,
};

const MAX_ATTACH = 6;
const MAX_MD_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_IMAGE_EDGE = 1600;
const MAX_API_IMAGES = 6;

function settings() {
  return state.settings;
}

function persistSettings(partial) {
  state.settings = saveSettings(partial);
  syncSettingsUi();
}

function applyImportedSettings(stats) {
  state.settings = loadSettings();
  syncSettingsUi();
  if (stats?.settings && settings().mgmtKey) refreshCredits({ silent: true });
}

// ── Settings UI ──────────────────────────────────────────────

function syncSettingsUi() {
  const s = settings();
  $("#inp-apikey").value = s.apiKey || "";
  $("#inp-proxy").value = s.proxyBase || "";
  $("#inp-mgmtkey").value = s.mgmtKey || "";
  $("#inp-teamid").value = s.teamId || "";
  $("#key-hint").textContent = s.apiKey ? `保存済み ${maskKey(s.apiKey)}` : "未設定";
  renderCreditUi();
  $("#rng-temp").value = s.temperature;
  $("#val-temp").textContent = Number(s.temperature).toFixed(2);
  $("#rng-max").value = s.maxTokens;
  $("#val-max").textContent = s.maxTokens;
  $("#chk-websearch").checked = !!s.webSearch;
  $("#inp-system").value = s.systemPrompt || "";
  $("#rng-ragk").value = s.ragTopK;
  $("#val-ragk").textContent = s.ragTopK;
  $("#rng-ragm").value = s.ragMaxChars;
  $("#val-ragm").textContent = s.ragMaxChars;
  $("#rng-speed").value = s.voiceSpeed;
  $("#val-speed").textContent = Number(s.voiceSpeed).toFixed(2);
  $("#chk-autospeak").checked = !!s.autoSpeak;
  $("#inp-sb-url").value = s.supabaseUrl || "";
  $("#inp-sb-key").value = s.supabaseKey || "";
  $("#inp-sb-slot").value = s.backupSlot || "kotatsu-main";
  $("#sql-box").textContent = supabaseSql();
  $("#inp-gclient").value = s.googleClientId || "";
  $("#chk-g-auto").checked = !!s.googleAutoBackup;
  if ($("#gdrive-help")) $("#gdrive-help").textContent = driveSetupHelp();
  updateDriveStatus();
  fillVoiceSelect();
  fillModelSelect();
  updateGenHint();
}

function updateDriveStatus() {
  const el = $("#gdrive-status");
  if (!el) return;
  const s = settings();
  if (!s.googleClientId) {
    el.textContent = "クライアントID未設定";
    return;
  }
  if (!isDriveLoggedIn()) {
    el.textContent = "未ログイン（上のボタンから Google へ）";
    return;
  }
  const last = s.googleLastBackup
    ? ` · 最終 ${new Date(s.googleLastBackup).toLocaleString("ja-JP")}`
    : "";
  el.textContent = `ログイン中 · 保存先 ${authorizedOrigin() === location.origin ? "GrokKotatsu/" : ""}${s.backupSlot || "kotatsu-main"}.json${last}`;
}

let driveBackupTimer = null;
function scheduleDriveBackup() {
  if (!settings().googleAutoBackup) return;
  if (!isDriveLoggedIn()) return;
  clearTimeout(driveBackupTimer);
  driveBackupTimer = setTimeout(async () => {
    try {
      await uploadToDrive(settings());
      persistSettings({ googleLastBackup: new Date().toISOString() });
    } catch (e) {
      console.warn("auto drive backup", e);
    }
  }, 8000);
}

function fillVoiceSelect() {
  const sel = $("#sel-voice");
  const cur = settings().voiceId || "rex";
  sel.innerHTML = VOICES.map(
    (v) => `<option value="${escapeAttr(v.id)}" ${v.id === cur ? "selected" : ""}>${escapeHtml(v.label)}</option>`
  ).join("");
}

function fillModelSelect() {
  const sel = $("#sel-model");
  const cur = settings().model;
  const models = state.models.length ? state.models : FALLBACK_MODELS;
  sel.innerHTML = models
    .map((m) => {
      const label = m.label || m.id;
      const hint = m.hint ? ` — ${m.hint}` : "";
      return `<option value="${escapeAttr(m.id)}" ${m.id === cur ? "selected" : ""}>${escapeHtml(label + hint)}</option>`;
    })
    .join("");
  if (cur && !models.some((m) => m.id === cur)) {
    sel.insertAdjacentHTML("afterbegin", `<option value="${escapeAttr(cur)}" selected>${escapeHtml(cur)}</option>`);
  }
}

function updateGenHint() {
  const s = settings();
  $("#gen-hint").textContent = `${s.model} · temp ${s.temperature} · max ${s.maxTokens}${s.webSearch ? " · web" : ""}`;
}

const CREDIT_LOW_USD = 5;
const CREDIT_MIN_MS = 20_000;
let creditBusy = false;
let lastCreditFetch = 0;

function creditTone(remaining) {
  if (remaining == null) return "";
  if (remaining <= 0) return "empty";
  if (remaining <= CREDIT_LOW_USD) return "low";
  return "";
}

function renderCreditUi() {
  const s = settings();
  const box = $("#credit-box");
  const remainingEl = $("#credit-remaining");
  const detailEl = $("#credit-detail");
  const statusEl = $("#credit-status");
  const chip = $("#credit-chip");
  if (!remainingEl || !chip) return;

  const snap = s.creditSnapshot;
  const hasKey = !!sanitizeApiKey(s.mgmtKey);
  const remaining = snap?.remainingUsd;
  const tone = creditTone(remaining);

  box?.classList.toggle("low", tone === "low");
  box?.classList.toggle("empty", tone === "empty");
  remainingEl.textContent = remaining == null ? "—" : formatUsd(remaining);

  if (snap && (snap.ledgerUsd != null || snap.purchasedUsd != null || snap.usedUsd != null)) {
    const bits = [];
    const ledger = snap.ledgerUsd ?? snap.purchasedUsd;
    if (ledger != null) bits.push(`台帳 ${formatUsd(ledger)}`);
    if (snap.usedUsd != null) bits.push(`今月使用 ${formatUsd(snap.usedUsd)}`);
    detailEl.textContent = bits.join(" · ");
  } else {
    detailEl.textContent = "";
  }

  if (!hasKey) {
    statusEl.textContent = "Management Key を入れると残量が出る";
    chip.hidden = true;
    return;
  }
  if (creditBusy) {
    statusEl.textContent = "残高を取りにいってる…";
  } else if (snap?.usageError) {
    statusEl.textContent = `使用額の取得失敗（台帳のみ）: ${snap.usageError}`;
  } else if (snap?.fetchedAt) {
    const src =
      snap.usedSource === "usage"
        ? " · 使用=usage"
        : snap.usedSource === "invoice"
          ? " · 使用=invoice"
          : "";
    const cy = snap.billingCycle;
    const cycle =
      cy?.year && cy?.month ? ` · ${cy.year}-${String(cy.month).padStart(2, "0")}` : "";
    statusEl.textContent = `最終 ${new Date(snap.fetchedAt).toLocaleString("ja-JP")}${src}${cycle}${s.mgmtKey ? ` · ${maskKey(s.mgmtKey)}` : ""}`;
  } else {
    statusEl.textContent = "まだ取ってない。下の「残量を更新」";
  }

  if (remaining == null) {
    chip.hidden = true;
    return;
  }
  chip.hidden = false;
  chip.textContent = `残 ${formatUsd(remaining)}`;
  chip.classList.toggle("low", tone === "low");
  chip.classList.toggle("empty", tone === "empty");
}

function readCreditFields() {
  return {
    mgmtKey: sanitizeApiKey($("#inp-mgmtkey").value),
    teamId: ($("#inp-teamid").value || "").trim(),
    proxyBase: $("#inp-proxy").value.trim(),
  };
}

async function refreshCredits({ force = false, silent = false, fromUi = false } = {}) {
  if (fromUi) {
    const fields = readCreditFields();
    persistSettings(fields);
    $("#inp-mgmtkey").value = fields.mgmtKey;
  }
  if (!sanitizeApiKey(settings().mgmtKey)) {
    persistSettings({ creditSnapshot: null });
    renderCreditUi();
    if (!silent) toast("Management Key が空だよ", "error");
    return;
  }
  const now = Date.now();
  if (!force && lastCreditFetch && now - lastCreditFetch < CREDIT_MIN_MS) {
    renderCreditUi();
    return;
  }
  if (creditBusy) return;
  creditBusy = true;
  renderCreditUi();
  try {
    const snap = await fetchCreditBalance(settings());
    lastCreditFetch = Date.now();
    const patch = {
      creditSnapshot: {
        remainingUsd: snap.remainingUsd,
        purchasedUsd: snap.purchasedUsd,
        ledgerUsd: snap.ledgerUsd,
        usedUsd: snap.usedUsd,
        usedSource: snap.usedSource,
        billingCycle: snap.billingCycle || null,
        usageError: snap.usageError || null,
        teamId: snap.teamId,
        fetchedAt: snap.fetchedAt,
      },
    };
    if (snap.teamIdDetected && snap.teamId && !String(settings().teamId || "").trim()) {
      patch.teamId = snap.teamId;
    }
    persistSettings(patch);
    if (patch.teamId) $("#inp-teamid").value = patch.teamId;
    if (!silent) toast(`残 ${formatUsd(snap.remainingUsd)}`, "ok");
  } catch (e) {
    if (!silent) toast(String(e.message || e), "error");
    const statusEl = $("#credit-status");
    if (statusEl) statusEl.textContent = String(e.message || e);
  } finally {
    creditBusy = false;
    renderCreditUi();
  }
}

async function refreshModels() {
  if (!settings().apiKey) {
    state.models = FALLBACK_MODELS;
    fillModelSelect();
    return;
  }
  try {
    state.models = await listModels(settings());
  } catch {
    state.models = FALLBACK_MODELS;
  }
  fillModelSelect();
}

// ── Sessions ─────────────────────────────────────────────────

async function refreshLists() {
  state.projects = await listProjects();
  state.chats = await listChats({ globalOnly: true });
  if (state.activeProjectId) {
    state.files = await listFiles(state.activeProjectId);
    state.projectChats = await listChats({ projectId: state.activeProjectId });
  } else {
    state.files = [];
    state.projectChats = [];
  }
  renderProjectNav();
  renderSessions();
  renderWorkspace();
  updateRagBar();
}

function renderProjectNav() {
  const el = $("#project-nav");
  if (!state.projects.length) {
    el.innerHTML = `<div class="muted sm">まだプロジェクトがない</div>`;
    return;
  }
  el.innerHTML = state.projects
    .map((p) => {
      const active = p.id === state.activeProjectId ? " active" : "";
      return `<div class="pn-item${active}" data-pid="${escapeAttr(p.id)}">
        <span class="pn-name">${escapeHtml(p.name || "無題")}</span>
      </div>`;
    })
    .join("");
  $$(".pn-item", el).forEach((n) => {
    n.addEventListener("click", () => openProject(n.dataset.pid));
  });
}

function renderSessionItems(list, mount) {
  if (!list.length) {
    mount.innerHTML = `<div class="muted sm">会話なし</div>`;
    return;
  }
  mount.innerHTML = list
    .map((c) => {
      const active = state.current?.id === c.id ? " active" : "";
      const pin = c.pinned ? `<span class="pin">📌</span>` : "";
      const n = (c.messages || []).length;
      return `<div class="session-item${active}" data-id="${escapeAttr(c.id)}">
        ${pin}
        <div style="flex:1;min-width:0">
          <div class="title" title="ダブルクリックで改名">${escapeHtml(c.title || "無題")}</div>
          <div class="session-meta">${n} msg · ${escapeHtml(relativeTime(c.updated_at))}</div>
        </div>
        <button type="button" class="btn ghost xs btn-ren" title="改名">✎</button>
        <button type="button" class="btn ghost xs btn-pin" title="ピン">${c.pinned ? "📍" : "📌"}</button>
        <button type="button" class="btn ghost xs btn-del" title="削除">🗑</button>
      </div>`;
    })
    .join("");
  $$(".session-item", mount).forEach((row) => {
    const id = row.dataset.id;
    row.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      openChat(id);
    });
    row.querySelector(".title")?.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      renameChat(id);
    });
    row.querySelector(".btn-ren")?.addEventListener("click", (e) => {
      e.stopPropagation();
      renameChat(id);
    });
    row.querySelector(".btn-pin")?.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePin(id);
    });
    row.querySelector(".btn-del")?.addEventListener("click", (e) => {
      e.stopPropagation();
      removeChat(id);
    });
  });
}

function renderSessions() {
  renderSessionItems(state.chats, $("#session-list"));
  $("#global-chats-label").hidden = !!state.activeProjectId;
  $("#session-list").hidden = !!state.activeProjectId;
}

function renderWorkspace() {
  const ws = $("#project-workspace");
  const on = !!state.activeProjectId;
  ws.hidden = !on;
  if (!on) return;
  const p = state.projects.find((x) => x.id === state.activeProjectId);
  $("#ws-name").textContent = p?.name || "プロジェクト";
  fillProjectPrompt(p);
  renderSessionItems(state.projectChats, $("#thread-list"));
  const fl = $("#file-list");
  if (!state.files.length) {
    fl.innerHTML = `<div class="muted sm">資料がまだない。世界観ノートを入れてくれ。</div>`;
    return;
  }
  fl.innerHTML = state.files
    .map(
      (f) => `<div class="file-item" data-fid="${escapeAttr(f.id)}">
        <span class="name" title="${escapeAttr(f.name)}">${escapeHtml(f.name)}</span>
        <span class="file-meta">${formatBytes(f.size || (f.text || "").length)}</span>
        <button type="button" class="btn ghost xs btn-open-json" ${f.name.toLowerCase().endsWith(".json") ? "" : "hidden"} title="会話として開く">💬</button>
        <button type="button" class="btn ghost xs btn-delf" title="削除">🗑</button>
      </div>`
    )
    .join("");
  $$(".file-item", fl).forEach((row) => {
    const id = row.dataset.fid;
    row.querySelector(".btn-delf")?.addEventListener("click", async () => {
      if (!confirm("この資料を消す？")) return;
      await deleteFile(id);
      pruneRagSelection();
      await refreshLists();
    });
    row.querySelector(".btn-open-json")?.addEventListener("click", async () => {
      const f = state.files.find((x) => x.id === id);
      if (!f) return;
      try {
        const data = JSON.parse(f.text);
        await importPayload(data, { fallbackTitle: f.name, newId: true });
      } catch (e) {
        toast(String(e.message || e), "error");
      }
    });
  });
}

function fillProjectPrompt(p) {
  const ta = $("#project-system-prompt");
  const mark = $("#project-prompt-mark");
  if (mark) mark.textContent = (p?.system_prompt || "").trim() ? "入ってる" : "";
  if (!ta) return;
  if (document.activeElement === ta) return;
  ta.value = p?.system_prompt || "";
}

async function flushProjectSystemPrompt() {
  clearTimeout(state._projectPromptTimer);
  state._projectPromptTimer = null;
  if (!state._projectPromptDirty) return;
  const pid = state.activeProjectId;
  const ta = $("#project-system-prompt");
  if (!pid || !ta) {
    state._projectPromptDirty = false;
    return;
  }
  const next = ta.value || "";
  state._projectPromptDirty = false;
  const p = await getProject(pid);
  if (!p) return;
  if ((p.system_prompt || "") === next) return;
  await saveProject({ ...p, system_prompt: next });
  const local = state.projects.find((x) => x.id === pid);
  if (local) local.system_prompt = next;
  if (state.activeProjectId === pid) fillProjectPrompt({ ...p, system_prompt: next });
}

function saveProjectSystemPromptSoon() {
  state._projectPromptDirty = true;
  clearTimeout(state._projectPromptTimer);
  state._projectPromptTimer = setTimeout(() => {
    flushProjectSystemPrompt().catch((e) => console.warn("project prompt save", e));
  }, 500);
}

async function openProject(id) {
  await flushProjectSystemPrompt();
  if (state.activeProjectId === id) {
    await leaveProject();
    return;
  }
  state.activeProjectId = id;
  state.ragSelectedSources = [];
  await refreshLists();
}

async function leaveProject() {
  await flushProjectSystemPrompt();
  state.activeProjectId = null;
  state.ragSelectedSources = [];
  await refreshLists();
}

async function createProject() {
  const name = prompt("プロジェクト名", "おこた篇") || "";
  if (!name.trim()) return;
  await flushProjectSystemPrompt();
  const p = await saveProject(emptyProject({ name: name.trim() }));
  state.activeProjectId = p.id;
  state.ragSelectedSources = [];
  await refreshLists();
  const sec = $("#sec-prompt");
  if (sec) sec.open = true;
  $("#project-system-prompt")?.focus();
  toast("プロジェクト作った。シスプロは左の欄へ", "ok");
}

async function editProject() {
  const p = await getProject(state.activeProjectId);
  if (!p) return;
  const name = prompt("名前", p.name || "");
  if (name == null) return;
  await saveProject({ ...p, name: name.trim() || p.name });
  await refreshLists();
}

async function createChat({ projectId = null } = {}) {
  if (state.streaming) {
    toast("生成中だよ", "error");
    return;
  }
  const chat = emptyChat({
    title: defaultTitle(projectId),
    system_prompt: settings().systemPrompt,
    model: settings().model,
    project_id: projectId,
  });
  state.current = await saveChat(chat);
  await refreshLists();
  renderMessages();
  closeDrawers();
  $("#input").focus();
}

async function openChat(id) {
  const chat = await getChat(id);
  if (!chat) return;
  state.current = chat;
  renderMessages();
  await refreshLists();
  closeDrawers();
}

async function renameChat(id) {
  const chat = await getChat(id);
  if (!chat) return;
  const next = prompt("タイトル", chat.title || "");
  if (next == null) return;
  chat.title = next.trim() || chat.title;
  await saveChat(chat);
  if (state.current?.id === id) state.current = chat;
  await refreshLists();
  syncTitle();
}

async function togglePin(id) {
  const chat = await getChat(id);
  if (!chat) return;
  chat.pinned = !chat.pinned;
  await saveChat(chat);
  if (state.current?.id === id) state.current = chat;
  await refreshLists();
}

async function removeChat(id) {
  if (!confirm("この会話を消す？端末からも消えるよ。")) return;
  await deleteChat(id);
  if (state.current?.id === id) state.current = null;
  await refreshLists();
  renderMessages();
}

async function persistCurrent() {
  if (!state.current) return;
  state.current.updated_at = nowSec();
  state.current = await saveChat(state.current);
  scheduleDriveBackup();
}

// ── RAG sources ──────────────────────────────────────────────

function fileNames() {
  return state.files.map((f) => f.name);
}

function getRagSourcesForSend() {
  if (state.ragSelectedSources === null) return null;
  const files = fileNames();
  return state.ragSelectedSources.filter((n) => files.includes(n));
}

function ragSummary() {
  const files = fileNames();
  if (state.ragSelectedSources === null) return { kind: "all", label: `全 ${files.length}` };
  const selected = state.ragSelectedSources.filter((n) => files.includes(n));
  if (!selected.length) return { kind: "off", label: "オフ" };
  if (selected.length === files.length) return { kind: "all", label: `全 ${files.length}` };
  return { kind: "partial", label: `${selected.length}/${files.length}` };
}

function pruneRagSelection() {
  if (state.ragSelectedSources === null) return;
  const files = fileNames();
  state.ragSelectedSources = state.ragSelectedSources.filter((n) => files.includes(n));
  if (state.ragSelectedSources.length === files.length && files.every((f) => state.ragSelectedSources.includes(f))) {
    state.ragSelectedSources = null;
  }
}

function updateRagBar() {
  const bar = $("#rag-source-bar");
  const inProj = !!state.activeProjectId;
  bar.hidden = !inProj;
  if (!inProj) {
    $("#rag-hint").hidden = true;
    return;
  }
  const info = ragSummary();
  const summary = $("#rag-source-summary");
  const btn = $("#btn-rag-sources");
  summary.textContent = info.kind === "off" ? "RAG オフ（資料参照なし）" : `参照 ${info.label}`;
  summary.className = "rag-source-summary" + (info.kind === "off" ? " off" : info.kind === "partial" ? " partial" : "");
  btn.classList.toggle("active", info.kind !== "all");
  const list = $("#rag-source-list");
  const files = fileNames();
  if (!files.length) {
    list.innerHTML = `<div class="rag-source-empty">資料ファイルがまだないよ</div>`;
  } else {
    const selected = state.ragSelectedSources === null ? files : state.ragSelectedSources;
    list.innerHTML = files
      .map(
        (name) => `<label class="rag-source-item">
          <input type="checkbox" data-name="${escapeAttr(name)}" ${selected.includes(name) ? "checked" : ""} />
          <span class="rag-source-name">${escapeHtml(name)}</span>
        </label>`
      )
      .join("");
    $$("input[type=checkbox]", list).forEach((inp) => {
      inp.addEventListener("change", () => {
        const names = $$("input[type=checkbox]", list)
          .filter((x) => x.checked)
          .map((x) => x.dataset.name);
        if (names.length === files.length) state.ragSelectedSources = null;
        else state.ragSelectedSources = names;
        updateRagBar();
      });
    });
  }
  const hint = $("#rag-hint");
  hint.hidden = false;
  hint.textContent = info.kind === "off" ? "参照なし" : `参照: ${info.label} files`;
}

function toggleRagPop(force) {
  const pop = $("#rag-source-popover");
  const hide = force === false ? true : force === true ? false : !pop.hidden;
  pop.hidden = hide;
}

// ── Messages ─────────────────────────────────────────────────

function syncTitle() {
  const c = state.current;
  $("#chat-title").textContent = c?.title || "Grok Kotatsu";
  const p = state.projects.find((x) => x.id === (c?.project_id || state.activeProjectId));
  $("#chat-sub").textContent = p ? p.name : "星の下から、続きを。";
  document.title = `${c?.title || "Grok Kotatsu"} · Kotatsu`;
}

function avatarImg(role) {
  const src = role === "user" ? "./icons/maro.png" : "./icons/grik.png";
  return `<img class="msg-avatar" src="${src}" width="36" height="36" alt="" onerror="this.onerror=null;this.src='./icons/icon-192.png'" />`;
}

function renderMessages({ scroll = true } = {}) {
  const box = $("#messages");
  const c = state.current;
  syncTitle();
  if (!c || !(c.messages || []).length) {
    box.innerHTML = "";
    const empty = document.createElement("div");
    empty.id = "empty-state";
    empty.className = "empty-state";
    empty.innerHTML = `<img src="./icons/icon-192.png" width="72" height="72" alt="" class="empty-icon" />
      <h1>${c ? "最初の一言をどうぞ" : "今夜も、星の下であいてるよ"}</h1>
      <p>${c ? "長編でも履歴はこの端末の IndexedDB に残る。" : "Grok API だけで動く長編チャット。過去ログの JSON を落とせば続きから入れる。"}</p>
      <div class="empty-actions">
        <button class="btn primary" type="button" data-act="new">新しいチャット</button>
        <button class="btn ghost" type="button" data-act="import">📂 JSONから再開</button>
        <button class="btn ghost" type="button" data-act="settings">APIキーを入れる</button>
      </div>
      ${c ? "" : `<div class="hint-row">
        <span class="chip">Streaming</span>
        <span class="chip">Projects + RAG</span>
        <span class="chip">Rex Voice</span>
        <span class="chip">PWA</span>
      </div>`}`;
    box.appendChild(empty);
    return;
  }
  box.innerHTML = c.messages
    .map((m, i) => {
      const role = m.role === "user" ? "user" : m.role === "assistant" ? "assistant" : "system";
      if (role === "system") return "";
      const body = renderSoftMarkdown(contentAsText(m.content));
      const atts = renderAttachmentsHtml(m);
      const rag = m.rag
        ? m.rag.rag_enabled === false
          ? `<div class="rag-chip off">RAG OFF · 資料参照なし</div>`
          : `<div class="rag-chip">RAG ${m.rag.hit_count || 0} hits${
              m.rag.sources?.length ? " · " + escapeHtml(m.rag.sources.join(", ")) : ""
            }</div>`
        : "";
      const meta = m.meta ? `<div class="msg-gen-meta">${escapeHtml(formatGenMeta(m.meta))}</div>` : "";
      const editing = role === "user" && state.editingIndex === i;
      if (editing) {
        return `<article class="msg ${role} editing" data-i="${i}">
          ${avatarImg("user")}
          <div class="msg-card">
            <div class="msg-role">まろ · 編集中</div>
            ${atts}
            <textarea class="edit-input" data-edit-i="${i}" rows="3">${escapeHtml(contentAsText(m.content))}</textarea>
            <div class="msg-actions">
              <button type="button" class="btn primary sm" data-act="edit-save" data-i="${i}">やり直す</button>
              <button type="button" class="btn ghost sm" data-act="edit-cancel">キャンセル</button>
            </div>
            <div class="muted sm">このあとにある返答は消えて、ここから生成し直す。添付はそのまま残る。</div>
          </div>
        </article>`;
      }
      const actions = state.streaming
        ? ""
        : role === "user"
          ? `<div class="msg-actions">
              <button type="button" class="btn ghost xs" data-act="edit" data-i="${i}">✎ 編集</button>
            </div>`
          : `<div class="msg-actions">
              <button type="button" class="btn ghost xs" data-act="speak" data-i="${i}">🔊 Rex</button>
            </div>`;
      const bodyHtml = body
        ? `<div class="msg-body">${body}</div>`
        : atts
          ? ""
          : `<div class="msg-body"><span class="muted">（空）</span></div>`;
      return `<article class="msg ${role}" data-i="${i}">
        ${avatarImg(role)}
        <div class="msg-card">
          <div class="msg-role">${role === "user" ? "まろ" : "グリク"}</div>
          ${atts}${bodyHtml}
          ${rag}${meta}${actions}
        </div>
      </article>`;
    })
    .join("");
  if (state.editingIndex != null) {
    const ta = box.querySelector(".edit-input");
    if (ta) {
      autoResize(ta);
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      ta.scrollIntoView({ block: "center" });
    }
    return;
  }
  if (scroll) box.scrollTop = box.scrollHeight;
}

function applyFind(q) {
  const query = (q || "").trim().toLowerCase();
  const nodes = $$(".msg");
  if (!query) {
    nodes.forEach((n) => n.classList.remove("hit"));
    $("#find-count").textContent = "";
    return;
  }
  let n = 0;
  let first = null;
  nodes.forEach((el) => {
    const i = Number(el.dataset.i);
    const m = state.current?.messages?.[i];
    const hit = messagePlainText(m).toLowerCase().includes(query);
    el.classList.toggle("hit", hit);
    if (hit) {
      n += 1;
      if (!first) first = el;
    }
  });
  $("#find-count").textContent = n ? `${n}件` : "なし";
  first?.scrollIntoView({ block: "center", behavior: "smooth" });
}

// ── Chat send ────────────────────────────────────────────────

function classifyAttach(file) {
  const name = file?.name || "file";
  const mime = String(file?.type || "").toLowerCase();
  if (/\.(md|markdown)$/i.test(name) || mime === "text/markdown" || mime === "text/x-markdown") return "md";
  if (mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i.test(name)) return "image";
  return null;
}

function messagePlainText(m) {
  if (!m) return "";
  const bits = [contentAsText(m.content)];
  for (const a of m.attachments || []) {
    if (a?.kind === "md" && a.text) bits.push(a.text);
    else if (a?.name) bits.push(a.name);
  }
  return bits.filter(Boolean).join("\n");
}

function toApiContent(m, { includeImages = true } = {}) {
  const atts = Array.isArray(m.attachments) ? m.attachments : [];
  const mdBlocks = atts
    .filter((a) => a.kind === "md" && a.text)
    .map((a) => `--- 添付ファイル: ${a.name || "note.md"} ---\n${a.text}`)
    .join("\n\n");
  let text = [contentAsText(m.content), mdBlocks].filter(Boolean).join("\n\n");

  const imageParts = [];
  if (includeImages) {
    for (const a of atts) {
      if (a.kind === "image" && a.dataUrl) {
        imageParts.push({
          type: "image_url",
          image_url: { url: a.dataUrl, detail: "high" },
        });
      }
    }
    if (Array.isArray(m.content)) {
      for (const p of m.content) {
        const url = p?.image_url?.url || (p?.type === "image_url" && p.url);
        if (url) {
          imageParts.push({
            type: "image_url",
            image_url: { url, detail: p.image_url?.detail || "high" },
          });
        }
      }
    }
  } else {
    const names = atts.filter((a) => a.kind === "image").map((a) => a.name).filter(Boolean);
    if (!names.length && Array.isArray(m.content)) {
      let n = 0;
      for (const p of m.content) {
        if (p?.image_url?.url || (p?.type === "image_url" && p.url)) n += 1;
      }
      if (n) names.push(n === 1 ? "画像" : `画像×${n}`);
    }
    if (names.length) text = [text, `（画像: ${names.join(", ")}）`].filter(Boolean).join("\n");
  }

  if (imageParts.length > MAX_API_IMAGES) imageParts.length = MAX_API_IMAGES;
  if (!imageParts.length) return text;
  const parts = [];
  if (text) parts.push({ type: "text", text });
  else parts.push({ type: "text", text: "この画像を見て" });
  parts.push(...imageParts);
  return parts;
}

function buildApiMessages(chat, extraSystem) {
  const sysParts = [];
  if (chat.system_prompt) sysParts.push(chat.system_prompt);
  if (extraSystem) sysParts.push(extraSystem);
  const out = [];
  if (sysParts.length) out.push({ role: "system", content: sysParts.join("\n\n") });
  const msgs = chat.messages || [];
  // 長編保護: だいたい 350k 文字で古い順に落とす
  const acc = [];
  let used = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = messagePlainText(m);
    if (used + text.length > 350000 && acc.length) break;
    acc.push(m);
    used += text.length;
  }
  acc.reverse();

  // 画像は今のユーザー発言だけ API に乗せる。過去ターンはピクセルを送らず文字スタブ。
  let lastUserIdx = -1;
  for (let i = acc.length - 1; i >= 0; i--) {
    if (acc[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  return out.concat(
    acc.map((m, i) => ({
      role: m.role,
      content: toApiContent(m, { includeImages: i === lastUserIdx }),
    }))
  );
}

function renderAttachmentsHtml(m) {
  const bits = [];
  for (const a of m.attachments || []) {
    if (a.kind === "image" && a.dataUrl) {
      bits.push(
        `<button type="button" class="msg-att-img" data-act="zoom-att">
          <img src="${escapeAttr(a.dataUrl)}" alt="${escapeAttr(a.name || "画像")}" />
        </button>`
      );
    } else if (a.kind === "image") {
      bits.push(
        `<div class="msg-att-omitted">🖼 ${escapeHtml(a.name || "画像")}（Driveは画像を運ばない）</div>`
      );
    } else if (a.kind === "md") {
      const preview = String(a.text || "");
      const shown = preview.length > 8000 ? `${preview.slice(0, 8000)}\n…` : preview;
      bits.push(
        `<details class="msg-att-md">
          <summary><span class="att-ico">MD</span>${escapeHtml(a.name || "note.md")}</summary>
          <pre class="md-pre">${escapeHtml(shown)}</pre>
        </details>`
      );
    }
  }
  if (!bits.length && Array.isArray(m.content)) {
    for (const p of m.content) {
      const url = p?.image_url?.url;
      if (!url) continue;
      bits.push(
        `<button type="button" class="msg-att-img" data-act="zoom-att">
          <img src="${escapeAttr(url)}" alt="" />
        </button>`
      );
    }
  }
  return bits.length ? `<div class="msg-atts">${bits.join("")}</div>` : "";
}

function renderAttachPreview() {
  const box = $("#attach-preview");
  if (!box) return;
  const atts = state.pendingAttachments;
  if (!atts.length) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  box.hidden = false;
  const chips = atts
    .map((a, i) => {
      if (a.kind === "image") {
        return `<div class="att-chip image">
          <img src="${escapeAttr(a.dataUrl)}" alt="" />
          <span>${escapeHtml(a.name || "画像")}</span>
          <span class="muted">${escapeHtml(formatBytes(a.size))}</span>
          <button type="button" class="att-x" data-remove-att="${i}" aria-label="外す">✕</button>
        </div>`;
      }
      return `<div class="att-chip md">
        <span class="att-ico">MD</span>
        <span>${escapeHtml(a.name || "note.md")}</span>
        <span class="muted">${escapeHtml(formatBytes(a.size))}</span>
        <button type="button" class="att-x" data-remove-att="${i}" aria-label="外す">✕</button>
      </div>`;
    })
    .join("");
  const hasImage = atts.some((a) => a.kind === "image");
  box.innerHTML = `<div class="att-chips">${chips}</div>${
    hasImage
      ? `<div class="att-oneshot-hint">画像はこの返信だけ見る。次のターンからは乗せない</div>`
      : ""
  }`;
}

function openAttZoom(src) {
  const wrap = $("#att-zoom");
  const img = $("#att-zoom-img");
  if (!wrap || !img || !src) return;
  img.src = src;
  wrap.hidden = false;
}

function closeAttZoom() {
  const wrap = $("#att-zoom");
  const img = $("#att-zoom-img");
  if (!wrap) return;
  wrap.hidden = true;
  if (img) img.removeAttribute("src");
}

async function readMdAttachment(file) {
  if (file.size > MAX_MD_BYTES) throw new Error("mdは512KBまで");
  const text = await file.text();
  return {
    kind: "md",
    name: file.name || "note.md",
    mime: file.type || "text/markdown",
    size: file.size || text.length,
    text,
  };
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(new Error("読み込み失敗"));
    r.readAsDataURL(file);
  });
}

async function decodeImageFile(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    /* older Safari */
  }
  try {
    return await createImageBitmap(file);
  } catch {
    /* fall through */
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("decode"));
      el.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function readImageAttachment(file) {
  if (file.size > MAX_IMAGE_BYTES) throw new Error("画像は15MBまで");
  const isGif = /gif$/i.test(file.type) || /\.gif$/i.test(file.name);
  if (isGif && file.size <= 2 * 1024 * 1024) {
    return {
      kind: "image",
      name: file.name || "image.gif",
      mime: "image/gif",
      size: file.size,
      dataUrl: await readAsDataUrl(file),
    };
  }

  let source;
  try {
    source = await decodeImageFile(file);
  } catch {
    throw new Error("この画像は読めない。PNG/JPEGにしてくれ");
  }

  const srcW = source.width || 0;
  const srcH = source.height || 0;
  if (!srcW || !srcH) {
    if (source.close) source.close();
    throw new Error("画像サイズが取れない");
  }
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    if (source.close) source.close();
    throw new Error("canvas が使えない");
  }
  ctx.drawImage(source, 0, 0, w, h);
  if (source.close) source.close();

  const preferPng = (/png$/i.test(file.type) || /\.png$/i.test(file.name)) && w * h < 2_000_000;
  let dataUrl = preferPng ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", 0.84);
  if (dataUrl.length > 1.8 * 1024 * 1024) dataUrl = canvas.toDataURL("image/jpeg", 0.8);
  if (dataUrl.length > 3.2 * 1024 * 1024) dataUrl = canvas.toDataURL("image/jpeg", 0.68);
  if (dataUrl.length > 4.5 * 1024 * 1024) throw new Error("圧縮しても大きい");

  const mime = dataUrl.startsWith("data:image/png") ? "image/png" : "image/jpeg";
  const name = file.name || (mime === "image/png" ? "image.png" : "image.jpg");
  return {
    kind: "image",
    name,
    mime,
    size: Math.round((dataUrl.length * 3) / 4),
    dataUrl,
  };
}

async function addComposerFiles(fileList) {
  const files = [...(fileList || [])];
  if (!files.length) return;
  state.attachBusy = true;
  try {
    const skipped = [];
    for (const file of files) {
      if (state.pendingAttachments.length >= MAX_ATTACH) {
        skipped.push(`${file.name}（上限${MAX_ATTACH}）`);
        continue;
      }
      const kind = classifyAttach(file);
      if (!kind) {
        skipped.push(`${file.name}（md/画像以外）`);
        continue;
      }
      try {
        const att = kind === "md" ? await readMdAttachment(file) : await readImageAttachment(file);
        state.pendingAttachments.push(att);
      } catch (e) {
        skipped.push(`${file.name}（${e.message || e}）`);
      }
    }
    renderAttachPreview();
    if (skipped.length) toast(skipped.slice(0, 3).join(" / "), "error");
  } finally {
    state.attachBusy = false;
  }
}

async function sendMessage() {
  const input = $("#input");
  const text = (input.value || "").trim();
  const atts = state.pendingAttachments.slice();
  if (!text && !atts.length) return;
  if (state.attachBusy) {
    toast("添付の読み込み中だ。ちょっと待って", "error");
    return;
  }
  if (!settings().apiKey) {
    toast("先に API キーを入れてくれ", "error");
    openDrawer("right");
    return;
  }
  if (state.streaming) return;

  if (!state.current) {
    await createChat({ projectId: state.activeProjectId });
  }
  const chat = state.current;
  const msg = { role: "user", content: text };
  if (atts.length) msg.attachments = atts;
  chat.messages.push(msg);
  if (isDefaultTitle(chat.title)) {
    chat.title = firstLine(text, 36) || firstLine(atts[0]?.name || "添付", 36);
  }
  chat.model = settings().model;
  input.value = "";
  state.pendingAttachments = [];
  renderAttachPreview();
  autoResize(input);
  await persistCurrent();
  renderMessages();
  await runGeneration();
}

function laterCount(keepThroughIndex) {
  const n = state.current?.messages?.length || 0;
  return Math.max(0, n - 1 - keepThroughIndex);
}

function confirmTruncate(keepThroughIndex, reason) {
  const extra = laterCount(keepThroughIndex);
  if (extra <= 0) return true;
  return confirm(`${reason}\nこのあと ${extra} 件が消える。いい？`);
}

function startEditUser(i) {
  if (state.streaming) return;
  const m = state.current?.messages?.[i];
  if (!m || m.role !== "user") return;
  state.editingIndex = i;
  renderMessages({ scroll: false });
}

function cancelEdit() {
  state.editingIndex = null;
  renderMessages({ scroll: false });
}

async function commitEditUser(i) {
  if (state.streaming) return;
  const chat = state.current;
  if (!chat) return;
  const ta = document.querySelector(`.edit-input[data-edit-i="${i}"]`);
  const text = (ta?.value || "").trim();
  const keptAtts = chat.messages[i].attachments;
  if (!text && !(keptAtts && keptAtts.length)) {
    toast("空ではやり直せない", "error");
    return;
  }
  if (!settings().apiKey) {
    toast("先に API キーを入れてくれ", "error");
    openDrawer("right");
    return;
  }
  if (!confirmTruncate(i, "この入力からやり直す。")) return;
  const old = contentAsText(chat.messages[i].content);
  const firstUser = chat.messages.findIndex((m) => m.role === "user");
  if (i === firstUser) {
    const oldLine = firstLine(old, 36);
    if (isDefaultTitle(chat.title) || chat.title === oldLine) {
      chat.title = firstLine(text, 36) || firstLine(keptAtts?.[0]?.name || "", 36) || chat.title;
    }
  }
  const next = { role: "user", content: text };
  if (keptAtts && keptAtts.length) next.attachments = keptAtts;
  chat.messages[i] = next;
  chat.messages = chat.messages.slice(0, i + 1);
  chat.model = settings().model;
  state.editingIndex = null;
  await persistCurrent();
  renderMessages();
  await runGeneration();
}

async function runGeneration() {
  const chat = state.current;
  if (!chat) return;
  await flushProjectSystemPrompt();
  const lastUser = [...chat.messages].reverse().find((m) => m.role === "user");
  const query = messagePlainText(lastUser || {});

  let extra = "";
  let ragMeta = null;
  if (chat.project_id || state.activeProjectId) {
    const pid = chat.project_id || state.activeProjectId;
    const proj = await getProject(pid);
    const files = await listFiles(pid);
    const sources = getRagSourcesForSend();
    const ragEnabled = !(sources && sources.length === 0);
    if (proj?.system_prompt) extra += (extra ? "\n\n" : "") + proj.system_prompt;
    if (ragEnabled && query) {
      const retrieved = retrieveFromFiles(files, query, {
        topK: settings().ragTopK,
        maxChars: settings().ragMaxChars,
        sources,
      });
      if (retrieved.context) extra += (extra ? "\n\n" : "") + retrieved.context;
      ragMeta = ragMetaFrom(retrieved, { projectId: pid, ragEnabled: true, sourcesFilter: sources });
    } else {
      ragMeta = {
        project_id: pid,
        hit_count: 0,
        sources: [],
        rag_enabled: false,
        sources_filter: sources || [],
        sources_filter_count: sources ? sources.length : 0,
      };
    }
  }

  const apiMessages = buildApiMessages(chat, extra);
  const assistant = { role: "assistant", content: "", rag: ragMeta || undefined };
  chat.messages.push(assistant);
  renderMessages();

  state.streaming = true;
  const ac = new AbortController();
  state.abort = ac;
  $("#btn-stop").hidden = false;
  $("#btn-send").disabled = true;
  const t0 = performance.now();

  try {
    const result = await chatStream(
      settings(),
      {
        model: settings().model,
        messages: apiMessages,
        temperature: settings().temperature,
        topP: settings().topP,
        maxTokens: settings().maxTokens,
        webSearch: settings().webSearch,
      },
      {
        signal: ac.signal,
        onDelta: (full) => {
          assistant.content = full;
          const last = $("#messages .msg.assistant:last-child .msg-body");
          if (last) last.innerHTML = renderSoftMarkdown(full);
          else renderMessages();
          const box = $("#messages");
          box.scrollTop = box.scrollHeight;
        },
      }
    );
    assistant.content = result.content || assistant.content;
    const elapsed = Math.round(performance.now() - t0);
    const usage = result.usage || {};
    assistant.meta = {
      elapsed_ms: elapsed,
      model: result.model || settings().model,
      provider: "xai",
      prompt_tokens: usage.prompt_tokens || usage.input_tokens || null,
      completion_tokens: usage.completion_tokens || usage.output_tokens || null,
      total_tokens: usage.total_tokens || null,
    };
    await persistCurrent();
    renderMessages();
    await refreshLists();
    refreshCredits({ force: true, silent: true });
    if (settings().autoSpeak && assistant.content) speakAssistant(assistant.content);
  } catch (e) {
    if (e.name === "AbortError") {
      assistant.content = (assistant.content || "") + (assistant.content ? "" : "（停止）");
    } else {
      toast(String(e.message || e), "error");
      if (!assistant.content) assistant.content = `エラー: ${e.message || e}`;
    }
    await persistCurrent();
    renderMessages();
  } finally {
    state.streaming = false;
    state.abort = null;
    $("#btn-stop").hidden = true;
    $("#btn-send").disabled = false;
  }
}

function stopGeneration() {
  try {
    state.abort?.abort();
  } catch {
    /* ignore */
  }
}

function speakAssistant(text) {
  $("#btn-speak-last").hidden = true;
  $("#btn-stop-speak").hidden = false;
  speakText(settings(), text, {
    onEnd: () => {
      $("#btn-speak-last").hidden = false;
      $("#btn-stop-speak").hidden = true;
    },
  }).catch((e) => {
    toast(String(e.message || e), "error");
    $("#btn-speak-last").hidden = false;
    $("#btn-stop-speak").hidden = true;
  });
}

// ── Import / export / files ──────────────────────────────────

async function importPayload(data, { fallbackTitle = "", newId = true } = {}) {
  const payload = normalizeImportPayload(data, { fallbackTitle });
  const projectId = state.activeProjectId || undefined;
  const chat = toStudioChat(payload, { newId, projectId });
  if (!chat.system_prompt) chat.system_prompt = settings().systemPrompt;
  state.current = await saveChat(chat);
  if (chat.project_id) state.activeProjectId = chat.project_id;
  await refreshLists();
  renderMessages();
  toast(`「${chat.title}」を再開した`, "ok");
}

async function importFromFile(file) {
  const text = await file.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("JSON が壊れてる");
  }
  // パック（複数）なら merge
  if (data && Array.isArray(data.chats) && data.app === "grok-kotatsu") {
    const { importPack } = await import("./db.js");
    const stats = await importPack(data, { merge: true });
    applyImportedSettings(stats);
    await refreshLists();
    toast(
      `パック読込: 会話${stats.chats} / 案件${stats.projects}${stats.settings ? " · 設定も入れた" : ""}`,
      "ok"
    );
    return;
  }
  await importPayload(data, { fallbackTitle: file.name.replace(/\.json$/i, ""), newId: true });
}

function exportCurrent() {
  if (!state.current) {
    toast("書き出す会話がない", "error");
    return;
  }
  const data = toExportChat(state.current);
  const safe = (data.title || "chat").replace(/[\\/:*?"<>|]/g, "_").slice(0, 40);
  downloadJson(`${safe}.json`, data);
}

async function addProjectFiles(fileList) {
  if (!state.activeProjectId) {
    toast("先にプロジェクトを開いてくれ", "error");
    return;
  }
  for (const file of fileList) {
    const text = await file.text();
    await saveFile({
      id: makeId(),
      project_id: state.activeProjectId,
      name: file.name,
      mime: file.type || "text/plain",
      text,
      size: file.size || text.length,
    });
  }
  pruneRagSelection();
  await refreshLists();
  toast(`${fileList.length} 件の資料を入れた`, "ok");
}

// ── Drawers / iOS ────────────────────────────────────────────

function openDrawer(side) {
  $("#sidebar-left").classList.toggle("open", side === "left");
  $("#sidebar-right").classList.toggle("open", side === "right");
  $("#backdrop").hidden = !side;
}

function closeDrawers() {
  $("#sidebar-left").classList.remove("open");
  $("#sidebar-right").classList.remove("open");
  $("#backdrop").hidden = true;
}

function setupViewport() {
  const set = () => {
    const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    document.documentElement.style.setProperty("--app-height", `${h}px`);
  };
  set();
  window.visualViewport?.addEventListener("resize", set);
  window.visualViewport?.addEventListener("scroll", set);
  window.addEventListener("resize", set);
}

// ── Bind ─────────────────────────────────────────────────────

function bind() {
  $("#btn-new-chat").addEventListener("click", () => createChat({ projectId: null }));
  $("#btn-new-thread").addEventListener("click", () => createChat({ projectId: state.activeProjectId }));
  $("#btn-new-project").addEventListener("click", createProject);
  $("#btn-leave-project").addEventListener("click", leaveProject);
  $("#btn-edit-project").addEventListener("click", editProject);
  $("#project-system-prompt")?.addEventListener("input", saveProjectSystemPromptSoon);
  $("#project-system-prompt")?.addEventListener("blur", () => {
    flushProjectSystemPrompt().catch((e) => console.warn("project prompt save", e));
  });
  $("#btn-delete-project").addEventListener("click", async () => {
    const p = state.projects.find((x) => x.id === state.activeProjectId);
    if (!p) return;
    if (!confirm(`「${p.name}」を消す？資料も消える。スレッドは全体チャット側に残る。`)) return;
    await flushProjectSystemPrompt();
    await deleteProject(p.id);
    state.activeProjectId = null;
    state.ragSelectedSources = [];
    await refreshLists();
    toast("プロジェクト消した", "ok");
  });
  $("#btn-import-chat").addEventListener("click", () => $("#import-file").click());
  $("#messages").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    const act = btn?.dataset.act;
    const i = btn?.dataset.i != null ? Number(btn.dataset.i) : -1;
    if (act === "new") createChat({ projectId: state.activeProjectId });
    if (act === "import") $("#import-file").click();
    if (act === "settings") openDrawer("right");
    if (act === "edit") startEditUser(i);
    if (act === "edit-cancel") cancelEdit();
    if (act === "edit-save") commitEditUser(i);
    if (act === "speak") {
      const m = state.current?.messages?.[i];
      if (m) speakAssistant(contentAsText(m.content));
    }
    if (act === "zoom-att") {
      const src = btn.querySelector("img")?.src;
      if (src) openAttZoom(src);
    }
  });
  $("#messages").addEventListener("keydown", (e) => {
    const ta = e.target.closest(".edit-input");
    if (!ta) return;
    if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) {
      e.preventDefault();
      commitEditUser(Number(ta.dataset.editI));
    }
  });
  $("#messages").addEventListener("input", (e) => {
    if (e.target.classList.contains("edit-input")) autoResize(e.target);
  });
  $("#import-file").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    try {
      await importFromFile(f);
    } catch (err) {
      toast(String(err.message || err), "error");
    }
  });
  $("#btn-export-chat").addEventListener("click", exportCurrent);

  $("#btn-add-files").addEventListener("click", () => $("#project-file-input").click());
  $("#project-file-input").addEventListener("change", async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = "";
    if (files.length) await addProjectFiles(files);
  });

  const dropZone = (el, handler) => {
    el.addEventListener("dragover", (e) => {
      e.preventDefault();
      el.classList.add("over");
    });
    el.addEventListener("dragleave", () => el.classList.remove("over"));
    el.addEventListener("drop", async (e) => {
      e.preventDefault();
      el.classList.remove("over");
      const files = [...(e.dataTransfer?.files || [])];
      if (files.length) await handler(files);
    });
  };
  dropZone($("#file-drop"), addProjectFiles);
  dropZone($("#composer-drop"), async (files) => {
    const jsons = files.filter((f) => /\.json$/i.test(f.name));
    const attachable = files.filter((f) => classifyAttach(f));
    if (attachable.length) {
      await addComposerFiles(attachable);
      return;
    }
    if (jsons.length) {
      try {
        await importFromFile(jsons[0]);
      } catch (e) {
        toast(String(e.message || e), "error");
      }
      return;
    }
    toast("チャットには .md か画像。JSONは会話再開、資料は左の資料欄へ", "error");
  });

  $("#btn-attach").addEventListener("click", () => $("#attach-file").click());
  $("#attach-file").addEventListener("change", async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = "";
    if (files.length) await addComposerFiles(files);
  });
  $("#attach-preview").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-remove-att]");
    if (!btn) return;
    const i = Number(btn.dataset.removeAtt);
    if (Number.isNaN(i)) return;
    state.pendingAttachments.splice(i, 1);
    renderAttachPreview();
  });
  $("#input").addEventListener("paste", (e) => {
    const items = [...(e.clipboardData?.items || [])];
    const files = [];
    for (const it of items) {
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (!files.length) return;
    const hasText = [...(e.clipboardData?.types || [])].includes("text/plain");
    if (!hasText) e.preventDefault();
    addComposerFiles(files);
  });
  $("#att-zoom").addEventListener("click", closeAttZoom);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#att-zoom")?.hidden) {
      e.preventDefault();
      closeAttZoom();
    }
  });

  $("#btn-send").addEventListener("click", sendMessage);
  $("#btn-stop").addEventListener("click", stopGeneration);
  $("#input").addEventListener("input", () => autoResize($("#input")));
  $("#input").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    // iOS のソフトウェアキーボードに Shift は無い。Enter を送信にすると改行できない。
    if (prefersNewlineOnEnter()) return;
    e.preventDefault();
    sendMessage();
  });

  $("#btn-rag-sources").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleRagPop();
  });
  $("#btn-rag-all").addEventListener("click", (e) => {
    e.stopPropagation();
    state.ragSelectedSources = null;
    updateRagBar();
  });
  $("#btn-rag-none").addEventListener("click", (e) => {
    e.stopPropagation();
    state.ragSelectedSources = [];
    updateRagBar();
  });
  $("#btn-rag-close").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleRagPop(false);
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#rag-source-bar")) toggleRagPop(false);
  });

  $("#btn-open-left").addEventListener("click", () => openDrawer("left"));
  $("#btn-open-right").addEventListener("click", () => openDrawer("right"));
  $("#backdrop").addEventListener("click", closeDrawers);
  $$(".drawer-close").forEach((b) => b.addEventListener("click", closeDrawers));

  const closeFindBar = () => {
    const bar = $("#find-bar");
    const inp = $("#find-input");
    if (bar) bar.hidden = true;
    if (inp) {
      inp.value = "";
      inp.blur();
    }
    applyFind("");
  };
  $("#btn-find").addEventListener("click", () => {
    const bar = $("#find-bar");
    if (!bar) return;
    if (bar.hidden) {
      bar.hidden = false;
      $("#find-input")?.focus();
    } else {
      closeFindBar();
    }
  });
  $("#btn-find-close").addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeFindBar();
  });
  $("#find-input").addEventListener("input", () => applyFind($("#find-input").value));
  $("#find-input").addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeFindBar();
  });

  $("#btn-speak-last").addEventListener("click", () => {
    const last = [...(state.current?.messages || [])].reverse().find((m) => m.role === "assistant");
    if (!last) {
      toast("読む返答がない", "error");
      return;
    }
    speakAssistant(contentAsText(last.content));
  });
  $("#btn-stop-speak").addEventListener("click", () => {
    stopSpeak();
    $("#btn-speak-last").hidden = false;
    $("#btn-stop-speak").hidden = true;
  });

  $("#btn-save-key").addEventListener("click", async () => {
    const apiKey = sanitizeApiKey($("#inp-apikey").value);
    persistSettings({
      apiKey,
      proxyBase: $("#inp-proxy").value.trim(),
      ...readCreditFields(),
    });
    $("#inp-apikey").value = apiKey;
    $("#inp-mgmtkey").value = settings().mgmtKey || "";
    toast(apiKey ? "キー保存した" : "キーが空だよ", apiKey ? "ok" : "error");
    await refreshModels();
    if (settings().mgmtKey) refreshCredits({ force: true, silent: true });
  });
  $("#btn-credit").addEventListener("click", () => refreshCredits({ force: true, fromUi: true }));
  $("#credit-chip").addEventListener("click", () => {
    openDrawer("right");
    $("#credit-box")?.scrollIntoView({ block: "nearest" });
  });
  $("#btn-probe").addEventListener("click", async () => {
    const apiKey = sanitizeApiKey($("#inp-apikey").value);
    persistSettings({
      apiKey,
      proxyBase: $("#inp-proxy").value.trim(),
      ...readCreditFields(),
    });
    $("#inp-apikey").value = apiKey;
    try {
      const models = await listModels(settings(), { allowFallback: false });
      state.models = models;
      fillModelSelect();
      toast(`つながった · ${models.length} models`, "ok");
    } catch (e) {
      toast(String(e.message || e), "error");
    }
  });
  $("#sel-model").addEventListener("change", () => {
    persistSettings({ model: $("#sel-model").value });
    if (state.current) {
      state.current.model = $("#sel-model").value;
      persistCurrent();
    }
  });
  $("#rng-temp").addEventListener("input", () => {
    persistSettings({ temperature: Number($("#rng-temp").value) });
  });
  $("#rng-max").addEventListener("input", () => {
    persistSettings({ maxTokens: Number($("#rng-max").value) });
  });
  $("#chk-websearch").addEventListener("change", () => {
    persistSettings({ webSearch: $("#chk-websearch").checked });
  });
  $("#btn-save-system").addEventListener("click", () => {
    persistSettings({ systemPrompt: $("#inp-system").value });
    if (state.current) {
      state.current.system_prompt = $("#inp-system").value;
      persistCurrent();
    }
    toast("プロンプト保存", "ok");
  });
  $("#rng-ragk").addEventListener("input", () => persistSettings({ ragTopK: Number($("#rng-ragk").value) }));
  $("#rng-ragm").addEventListener("input", () => persistSettings({ ragMaxChars: Number($("#rng-ragm").value) }));
  $("#sel-voice").addEventListener("change", () => persistSettings({ voiceId: $("#sel-voice").value }));
  $("#rng-speed").addEventListener("input", () => persistSettings({ voiceSpeed: Number($("#rng-speed").value) }));
  $("#chk-autospeak").addEventListener("change", () => persistSettings({ autoSpeak: $("#chk-autospeak").checked }));
  $("#btn-test-voice").addEventListener("click", () => {
    speakAssistant("真空でもこたつはあったかい。まろ、続きやるか。俺は Rex だ。");
  });

  const saveCloudFields = () =>
    persistSettings({
      supabaseUrl: $("#inp-sb-url").value.trim(),
      supabaseKey: $("#inp-sb-key").value.trim(),
      backupSlot: $("#inp-sb-slot").value.trim() || "kotatsu-main",
      googleClientId: sanitizeClientId($("#inp-gclient").value),
      googleAutoBackup: $("#chk-g-auto").checked,
    });

  $("#btn-g-save").addEventListener("click", () => {
    saveCloudFields();
    $("#inp-gclient").value = settings().googleClientId || "";
    try {
      assertClientId(settings().googleClientId);
      toast("クライアントID保存した", "ok");
    } catch (e) {
      toast(String(e.message || e), "error");
    }
  });
  $("#btn-g-login").addEventListener("click", () => {
    saveCloudFields();
    $("#inp-gclient").value = settings().googleClientId || "";
    try {
      startGoogleLogin(settings().googleClientId);
    } catch (e) {
      toast(String(e.message || e), "error");
    }
  });
  $("#btn-g-logout").addEventListener("click", () => {
    clearToken();
    persistSettings({ googleAutoBackup: false });
    $("#chk-g-auto").checked = false;
    toast("Google から出た", "ok");
  });
  $("#chk-g-auto").addEventListener("change", () => {
    persistSettings({ googleAutoBackup: $("#chk-g-auto").checked });
    if ($("#chk-g-auto").checked && !isDriveLoggedIn()) {
      toast("先に Google ログインしてくれ", "error");
      $("#chk-g-auto").checked = false;
      persistSettings({ googleAutoBackup: false });
    }
  });
  $("#btn-g-up").addEventListener("click", async () => {
    saveCloudFields();
    try {
      const r = await uploadToDrive(settings());
      persistSettings({ googleLastBackup: new Date().toISOString() });
      toast(`ドライブへ保存: ${r.name} · 会話${r.chats} · 設定も入れた · 画像は乗せてない`, "ok");
    } catch (e) {
      toast(String(e.message || e), "error");
    }
  });
  $("#btn-g-down").addEventListener("click", async () => {
    saveCloudFields();
    if (!confirm("ドライブのパックをこの端末に取り込む。会話と同じ id は上書き。キーとプロキシも上書き。いい？")) return;
    try {
      const r = await downloadFromDrive(settings(), { merge: true });
      applyImportedSettings(r);
      await refreshLists();
      renderMessages();
      toast(
        `ドライブから復元: 会話${r.chats} / 案件${r.projects}${r.settings ? " · 設定も入れた" : ""}`,
        "ok"
      );
    } catch (e) {
      toast(String(e.message || e), "error");
    }
  });
  $("#btn-cloud-up").addEventListener("click", async () => {
    saveCloudFields();
    try {
      const r = await uploadBackup(settings());
      toast(`上げた: 会話${r.chats} / 資料${r.files}`, "ok");
    } catch (e) {
      toast(String(e.message || e), "error");
    }
  });
  $("#btn-cloud-down").addEventListener("click", async () => {
    saveCloudFields();
    if (!confirm("クラウドのパックをこの端末に取り込む。同じ id は上書きされる。いい？")) return;
    try {
      const r = await downloadBackup(settings(), { merge: true });
      applyImportedSettings(r);
      await refreshLists();
      toast(`入れた: 会話${r.chats} / 案件${r.projects}${r.settings ? " · 設定も入れた" : ""}`, "ok");
    } catch (e) {
      toast(String(e.message || e), "error");
    }
  });
  $("#btn-pack-export").addEventListener("click", async () => {
    const { exportPack } = await import("./db.js");
    const pack = await exportPack();
    downloadJson(`kotatsu-backup-${new Date().toISOString().slice(0, 10)}.json`, pack);
  });
  $("#btn-pack-import").addEventListener("click", () => $("#pack-import-file").click());
  $("#pack-import-file").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    try {
      await importFromFile(f);
    } catch (err) {
      toast(String(err.message || err), "error");
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") persistCurrent();
    if (document.visibilityState === "visible" && settings().mgmtKey) {
      refreshCredits({ silent: true });
    }
  });
  window.addEventListener("pagehide", () => persistCurrent());
}

async function init() {
  setupViewport();
  const oauth = consumeOAuthRedirect();
  syncSettingsUi();
  bind();
  if (oauth.handled && oauth.ok) toast("Google ログインできた", "ok");
  if (oauth.handled && oauth.error) toast(`Google: ${oauth.error}`, "error");
  await refreshLists();
  renderMessages();
  await refreshModels();
  if (settings().mgmtKey) refreshCredits({ silent: true });
  if (!settings().apiKey) {
    toast("右の⚙から xAI キーを入れてくれ");
  }
}

init().catch((e) => {
  console.error(e);
  toast(String(e.message || e), "error");
});
