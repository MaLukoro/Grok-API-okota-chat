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

export async function exportPack() {
  const db = await openDb();
  const [chats, projects, files] = await Promise.all([
    reqToPromise(db.transaction("chats").objectStore("chats").getAll()),
    reqToPromise(db.transaction("projects").objectStore("projects").getAll()),
    reqToPromise(db.transaction("files").objectStore("files").getAll()),
  ]);
  return {
    app: "grok-kotatsu",
    version: 2,
    exported_at: nowSec(),
    chats: chats || [],
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
    if (c && c.id) tx.objectStore("chats").put(c);
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
