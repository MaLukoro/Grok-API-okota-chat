/** IndexedDB: chats / projects / files */

import { makeId, nowSec } from "./util.js";
import { exportSettings, importSettings } from "./settings.js";

const DB_NAME = "grok-kotatsu";
const DB_VERSION = 1;

let _db = null;

function openDb() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("chats")) {
        const chats = db.createObjectStore("chats", { keyPath: "id" });
        chats.createIndex("project_id", "project_id", { unique: false });
        chats.createIndex("updated_at", "updated_at", { unique: false });
      }
      if (!db.objectStoreNames.contains("projects")) {
        db.createObjectStore("projects", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("files")) {
        const files = db.createObjectStore("files", { keyPath: "id" });
        files.createIndex("project_id", "project_id", { unique: false });
      }
    };
    req.onsuccess = () => {
      _db = req.result;
      _db.onversionchange = () => {
        _db.close();
        _db = null;
      };
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function emptyChat({
  id = null,
  title = "新しいチャット",
  system_prompt = "",
  model = null,
  project_id = null,
} = {}) {
  const t = nowSec();
  return {
    id: id || makeId(),
    title,
    system_prompt,
    model,
    project_id: project_id || null,
    messages: [],
    created_at: t,
    updated_at: t,
    pinned: false,
    archived: false,
    version: 1,
  };
}

export function emptyProject({ name = "新しいプロジェクト", description = "", system_prompt = "" } = {}) {
  const t = nowSec();
  return {
    id: makeId(),
    name,
    description,
    system_prompt,
    progress_memory: "",
    live_thread_id: null,
    handoff: null,
    created_at: t,
    updated_at: t,
  };
}

export async function saveChat(chat) {
  const db = await openDb();
  const copy = { ...chat, updated_at: nowSec(), version: chat.version || 1 };
  if (!copy.id) copy.id = makeId();
  if (!Array.isArray(copy.messages)) copy.messages = [];
  const tx = db.transaction("chats", "readwrite");
  tx.objectStore("chats").put(copy);
  await txDone(tx);
  return copy;
}

export async function getChat(id) {
  if (!id) return null;
  const db = await openDb();
  return reqToPromise(db.transaction("chats").objectStore("chats").get(id));
}

export async function deleteChat(id) {
  const db = await openDb();
  const tx = db.transaction("chats", "readwrite");
  tx.objectStore("chats").delete(id);
  await txDone(tx);
}

export async function listChats({ projectId = undefined, globalOnly = false } = {}) {
  const db = await openDb();
  const all = await reqToPromise(db.transaction("chats").objectStore("chats").getAll());
  let items = all || [];
  if (projectId) {
    items = items.filter((c) => (c.project_id || null) === projectId);
  } else if (globalOnly) {
    items = items.filter((c) => !c.project_id);
  }
  items.sort((a, b) => {
    const pin = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
    if (pin) return pin;
    return (b.updated_at || 0) - (a.updated_at || 0);
  });
  return items;
}

export async function saveProject(project) {
  const db = await openDb();
  const copy = { ...project, updated_at: nowSec() };
  if (!copy.id) copy.id = makeId();
  const tx = db.transaction("projects", "readwrite");
  tx.objectStore("projects").put(copy);
  await txDone(tx);
  return copy;
}

export async function getProject(id) {
  if (!id) return null;
  const db = await openDb();
  return reqToPromise(db.transaction("projects").objectStore("projects").get(id));
}

export async function deleteProject(id) {
  const db = await openDb();
  const tx = db.transaction(["projects", "files", "chats"], "readwrite");
  tx.objectStore("projects").delete(id);
  const files = tx.objectStore("files");
  const idx = files.index("project_id");
  const req = idx.openCursor(IDBKeyRange.only(id));
  req.onsuccess = () => {
    const cursor = req.result;
    if (cursor) {
      cursor.delete();
      cursor.continue();
    }
  };
  // スレッドは残す（project_id だけ外す）— ログを消さない
  const chats = tx.objectStore("chats");
  const cidx = chats.index("project_id");
  const creq = cidx.openCursor(IDBKeyRange.only(id));
  creq.onsuccess = () => {
    const cursor = creq.result;
    if (cursor) {
      const val = { ...cursor.value, project_id: null };
      cursor.update(val);
      cursor.continue();
    }
  };
  await txDone(tx);
}

export async function listProjects() {
  const db = await openDb();
  const all = await reqToPromise(db.transaction("projects").objectStore("projects").getAll());
  return (all || []).sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
}

export async function saveFile(file) {
  const db = await openDb();
  const copy = { ...file, updated_at: nowSec() };
  if (!copy.id) copy.id = makeId();
  const tx = db.transaction("files", "readwrite");
  tx.objectStore("files").put(copy);
  await txDone(tx);
  return copy;
}

export async function listFiles(projectId) {
  const db = await openDb();
  if (!projectId) return [];
  const idx = db.transaction("files").objectStore("files").index("project_id");
  const all = await reqToPromise(idx.getAll(projectId));
  return (all || []).sort((a, b) => (a.name || "").localeCompare(b.name || "", "ja"));
}

export async function deleteFile(id) {
  const db = await openDb();
  const tx = db.transaction("files", "readwrite");
  tx.objectStore("files").delete(id);
  await txDone(tx);
}

function isImageDataUrl(s) {
  return typeof s === "string" && /^data:image\//i.test(s);
}

function messageHasImageData(m) {
  if ((m?.attachments || []).some((a) => a?.kind === "image" && a.dataUrl)) return true;
  if (Array.isArray(m?.content)) {
    return m.content.some((p) => isImageDataUrl(p?.image_url?.url || p?.url));
  }
  return false;
}

function stripMessageImageData(m) {
  if (!m || typeof m !== "object") return m;
  const next = { ...m };
  const atts = Array.isArray(next.attachments)
    ? next.attachments.map((a) => {
        if (a?.kind === "image" && a.dataUrl) {
          const { dataUrl: _drop, ...rest } = a;
          return { ...rest, omitted: true };
        }
        return a;
      })
    : [];

  if (Array.isArray(next.content)) {
    const kept = [];
    let droppedImage = false;
    for (const p of next.content) {
      const url = p?.image_url?.url || (p?.type === "image_url" && p.url);
      if (isImageDataUrl(url)) {
        droppedImage = true;
        continue;
      }
      kept.push(p);
    }
    if (droppedImage && !atts.some((a) => a.kind === "image")) {
      atts.push({ kind: "image", name: "image", omitted: true });
    }
    if (kept.length === 1 && kept[0]?.type === "text") next.content = kept[0].text || "";
    else next.content = kept;
  }
  if (atts.length) next.attachments = atts;
  return next;
}

function stripChatImageData(chat) {
  if (!chat?.messages) return chat;
  return {
    ...chat,
    messages: chat.messages.map(stripMessageImageData),
  };
}

function mergeChatKeepingImages(existing, incoming) {
  if (!existing?.messages?.length) return incoming;
  const oldMsgs = existing.messages;
  const nextMsgs = (incoming.messages || []).map((m, i) => {
    const old = oldMsgs[i];
    if (old && old.role === m.role && messageHasImageData(old) && !messageHasImageData(m)) {
      return {
        ...m,
        attachments: old.attachments || m.attachments,
        content: Array.isArray(old.content) ? old.content : m.content,
      };
    }
    return m;
  });
  return { ...incoming, messages: nextMsgs };
}

export function dropImagePayloads(_key, value) {
  if (typeof value === "string" && /^data:image\//i.test(value)) return undefined;
  return value;
}

export function packToJson(pack) {
  const json = JSON.stringify(pack, dropImagePayloads);
  if (/data:image\//i.test(json)) {
    throw new Error("画像の base64 がパックに残った。グリクに言え");
  }
  return json;
}

export async function exportPack({ omitImageData = false } = {}) {
  const db = await openDb();
  const [chats, projects, files] = await Promise.all([
    reqToPromise(db.transaction("chats").objectStore("chats").getAll()),
    reqToPromise(db.transaction("projects").objectStore("projects").getAll()),
    reqToPromise(db.transaction("files").objectStore("files").getAll()),
  ]);
  const chatsOut = omitImageData ? (chats || []).map(stripChatImageData) : chats || [];
  return {
    app: "grok-kotatsu",
    version: 2,
    exported_at: nowSec(),
    omit_image_data: !!omitImageData,
    chats: chatsOut,
    projects: projects || [],
    files: files || [],
    settings: exportSettings(),
  };
}

export async function importPack(pack, { merge = true } = {}) {
  if (!pack || typeof pack !== "object") throw new Error("パックJSONが読めないよ");
  const chats = Array.isArray(pack.chats) ? pack.chats : [];
  const projects = Array.isArray(pack.projects) ? pack.projects : [];
  const files = Array.isArray(pack.files) ? pack.files : [];
  const db = await openDb();
  const tx = db.transaction(["chats", "projects", "files"], "readwrite");
  if (!merge) {
    tx.objectStore("chats").clear();
    tx.objectStore("projects").clear();
    tx.objectStore("files").clear();
  }
  for (const p of projects) {
    if (p && p.id) tx.objectStore("projects").put(p);
  }
  for (const f of files) {
    if (f && f.id) tx.objectStore("files").put(f);
  }
  for (const c of chats) {
    if (!c || !c.id) continue;
    if (merge) {
      const existing = await reqToPromise(tx.objectStore("chats").get(c.id));
      tx.objectStore("chats").put(mergeChatKeepingImages(existing, c));
    } else {
      tx.objectStore("chats").put(c);
    }
  }
  await txDone(tx);
  let settingsImported = false;
  if (pack.settings) {
    importSettings(pack.settings, { merge });
    settingsImported = true;
  }
  return {
    chats: chats.length,
    projects: projects.length,
    files: files.length,
    settings: settingsImported,
  };
}
