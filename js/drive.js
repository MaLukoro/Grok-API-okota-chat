/** Google Drive バックアップ。GIS トークン（ポップアップ）＋ implicit フォールバック。client secret なし。 */

import { exportPack, importPack, packToJson } from "./db.js";

const TOKEN_KEY = "kotatsu_gdrive_token";
const FOLDER_NAME = "GrokKotatsu";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const GIS_SRC = "https://accounts.google.com/gsi/client";

export function redirectUri() {
  let path = location.pathname || "/";
  if (path.endsWith("index.html")) path = path.slice(0, -10);
  if (!path.endsWith("/")) path += "/";
  return `${location.origin}${path}`;
}

export function authorizedOrigin() {
  return location.origin;
}

export function fileNameFor(settings) {
  const slot = (settings.backupSlot || "kotatsu-main").trim() || "kotatsu-main";
  return `${slot}.json`;
}

export function loadToken() {
  try {
    const raw = JSON.parse(localStorage.getItem(TOKEN_KEY) || "null");
    if (!raw?.access_token) return null;
    if (raw.expires_at && Date.now() > raw.expires_at - 30_000) return null;
    return raw.access_token;
  } catch {
    return null;
  }
}

export function saveToken(accessToken, expiresIn = 3600) {
  localStorage.setItem(
    TOKEN_KEY,
    JSON.stringify({
      access_token: accessToken,
      expires_at: Date.now() + Number(expiresIn) * 1000,
    })
  );
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export function isDriveLoggedIn() {
  return !!loadToken();
}

function isStandalonePwa() {
  try {
    if (window.matchMedia("(display-mode: standalone)").matches) return true;
  } catch {
    /* ignore */
  }
  return !!navigator.standalone;
}

export function consumeOAuthRedirect() {
  const hash = (location.hash || "").replace(/^#/, "");
  const query = (location.search || "").replace(/^\?/, "");
  const hp = hash ? new URLSearchParams(hash) : new URLSearchParams();
  const qp = query ? new URLSearchParams(query) : new URLSearchParams();
  const token = hp.get("access_token");
  const err = hp.get("error") || qp.get("error");
  const state = hp.get("state") || qp.get("state");
  if (!token && !err) return { handled: false };
  if (state && state !== "gdrive") return { handled: false };
  history.replaceState(null, "", redirectUri());
  if (err) {
    return { handled: true, error: qp.get("error_description") || hp.get("error_description") || err };
  }
  saveToken(token, Number(hp.get("expires_in") || 3600));
  return { handled: true, ok: true };
}

export function sanitizeClientId(raw) {
  return String(raw || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/^https?:\/\//i, "")
    .replace(/\s+/g, "")
    .trim();
}

export function assertClientId(raw) {
  const id = sanitizeClientId(raw);
  if (!id) throw new Error("先に Google のクライアントIDを保存してくれ");
  if (!id.endsWith(".apps.googleusercontent.com")) {
    throw new Error(
      "クライアントIDが短いか違う。末尾が .apps.googleusercontent.com の長い方を、切れないように貼ってくれ"
    );
  }
  return id;
}

let gisLoading = null;

function loadGis() {
  if (globalThis.google?.accounts?.oauth2) return Promise.resolve();
  if (gisLoading) return gisLoading;
  gisLoading = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${GIS_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Google ログイン用スクリプトが読めない")), { once: true });
      return;
    }
    const s = document.createElement("script");
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      gisLoading = null;
      reject(new Error("Google ログイン用スクリプトが読めない"));
    };
    document.head.appendChild(s);
  });
  return gisLoading;
}

function requestGisToken(clientId, { prompt = "" } = {}) {
  return new Promise((resolve, reject) => {
    const oauth2 = globalThis.google?.accounts?.oauth2;
    if (!oauth2) {
      reject(new Error("Google ログイン用スクリプトが無い"));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("ログインが時間切れ。もう一回押してくれ"));
    }, 120000);
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    const client = oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      prompt,
      callback: (resp) => {
        if (resp?.error) {
          const msg = resp.error_description || resp.error;
          finish(reject, new Error(humanOAuthError(msg)));
          return;
        }
        if (!resp?.access_token) {
          finish(reject, new Error("トークンが来なかった"));
          return;
        }
        saveToken(resp.access_token, Number(resp.expires_in || 3600));
        finish(resolve, resp.access_token);
      },
      error_callback: (err) => {
        const type = err?.type || err?.message || "popup_failed";
        finish(reject, new Error(String(type)));
      },
    });
    client.requestAccessToken({ prompt });
  });
}

function humanOAuthError(msg) {
  const s = String(msg || "");
  if (/access_denied/i.test(s)) {
    return "この Gmail はテストユーザーに入ってない。Cloud Console の同意画面に今ログインしてるアドレスを追加してくれ";
  }
  if (/invalid_client|OAuth client was not found/i.test(s)) {
    return "クライアントIDが違う。末尾 .apps.googleusercontent.com の長い方を切れず貼ってくれ";
  }
  if (/redirect_uri/i.test(s)) {
    return "リダイレクトURIが一致してない。Cloud Console の登録を覚書どおりにしてくれ";
  }
  if (/popup/i.test(s)) return s;
  return s;
}

export function startImplicitLogin(clientId) {
  const id = assertClientId(clientId);
  const params = new URLSearchParams({
    client_id: id,
    redirect_uri: redirectUri(),
    response_type: "token",
    scope: SCOPE,
    include_granted_scopes: "true",
    state: "gdrive",
    prompt: "select_account",
  });
  location.assign(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}

/** 互換。GIS が使えなければ Google のページへ飛ばす。 */
export function startGoogleLogin(clientId) {
  startImplicitLogin(clientId);
}

export async function loginToDrive(clientId) {
  const id = assertClientId(clientId);
  try {
    await loadGis();
    await requestGisToken(id, { prompt: "select_account" });
    return { ok: true };
  } catch (e) {
    const msg = String(e.message || e);
    if (/access_denied|invalid_client|redirect_uri/i.test(msg)) throw e;
    startImplicitLogin(id);
    return { redirected: true };
  }
}

export async function ensureDriveToken(settings) {
  const existing = loadToken();
  if (existing) return existing;
  const id = sanitizeClientId(settings?.googleClientId);
  if (!id) throw new Error("先に Google のクライアントIDを保存してくれ");
  try {
    await loadGis();
    return await requestGisToken(id, { prompt: "" });
  } catch (e) {
    const msg = String(e.message || e);
    if (isStandalonePwa() || /popup|closed|failed to load|スクリプト/i.test(msg)) {
      throw new Error("Google のログイン期限が切れてる。上の「Googleでログイン」をもう一回押してくれ");
    }
    throw new Error(humanOAuthError(msg));
  }
}

async function driveFetch(path, { method = "GET", body, contentType, raw = false } = {}) {
  const token = loadToken();
  if (!token) throw new Error("Google にログインしてくれ");
  const headers = { Authorization: `Bearer ${token}` };
  if (contentType) headers["Content-Type"] = contentType;
  const res = await fetch(`https://www.googleapis.com${path}`, {
    method,
    headers,
    body,
    cache: "no-store",
  });
  if (res.status === 401) {
    clearToken();
    throw new Error("ログイン期限切れ。もう一回 Google ログインしてくれ");
  }
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const j = await res.json();
      detail = j.error?.message || JSON.stringify(j.error || j);
    } catch {
      detail = await res.text();
    }
    throw new Error(`Drive: ${detail}`);
  }
  if (res.status === 204) return null;
  if (raw) return res;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}

async function findFolder() {
  const q = encodeURIComponent(
    `name = '${FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
  );
  const data = await driveFetch(`/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=1&spaces=drive`);
  return data.files?.[0] || null;
}

async function ensureFolder() {
  const existing = await findFolder();
  if (existing) return existing.id;
  const created = await driveFetch("/drive/v3/files", {
    method: "POST",
    contentType: "application/json",
    body: JSON.stringify({
      name: FOLDER_NAME,
      mimeType: "application/vnd.google-apps.folder",
    }),
  });
  return created.id;
}

async function findBackupFile(folderId, name) {
  const q = encodeURIComponent(`name = '${name}' and '${folderId}' in parents and trashed = false`);
  const data = await driveFetch(`/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)&pageSize=1`);
  return data.files?.[0] || null;
}

export async function uploadToDrive(settings) {
  await ensureDriveToken(settings);
  const pack = await exportPack({ omitImageData: true });
  const name = fileNameFor(settings);
  const folderId = await ensureFolder();
  const existing = await findBackupFile(folderId, name);
  const json = packToJson(pack);
  if (existing) {
    await driveFetch(`/upload/drive/v3/files/${existing.id}?uploadType=media`, {
      method: "PATCH",
      contentType: "application/json; charset=UTF-8",
      body: json,
    });
    return {
      chats: pack.chats.length,
      projects: pack.projects.length,
      files: pack.files.length,
      name,
      fileId: existing.id,
      updated: true,
    };
  }
  const boundary = `kotatsu_${Date.now()}`;
  const meta = JSON.stringify({
    name,
    parents: [folderId],
    mimeType: "application/json",
  });
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    meta,
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    json,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  const created = await driveFetch(`/upload/drive/v3/files?uploadType=multipart`, {
    method: "POST",
    contentType: `multipart/related; boundary=${boundary}`,
    body,
  });
  return {
    chats: pack.chats.length,
    projects: pack.projects.length,
    files: pack.files.length,
    name,
    fileId: created.id,
    updated: false,
  };
}

export async function downloadFromDrive(settings, { merge = true } = {}) {
  await ensureDriveToken(settings);
  const name = fileNameFor(settings);
  const folderId = await ensureFolder();
  const existing = await findBackupFile(folderId, name);
  if (!existing) throw new Error(`ドライブに「${FOLDER_NAME}/${name}」が無いよ。先に上げてくれ`);
  const res = await driveFetch(`/drive/v3/files/${existing.id}?alt=media`, { raw: true });
  const pack = await res.json();
  if (!pack || !Array.isArray(pack.chats)) throw new Error("ドライブのファイルがパックJSONじゃない");
  const stats = await importPack(pack, { merge });
  return { ...stats, name, modifiedTime: existing.modifiedTime };
}

export function driveSetupHelp() {
  const origin = authorizedOrigin();
  const redirect = redirectUri();
  return `1. https://console.cloud.google.com/ でプロジェクト作成
2. 「APIとサービス」→ ライブラリ → Google Drive API を有効化
3. 「OAuth同意画面」→ External → アプリ名は Grok Kotatsu
   テストユーザーに自分のGmailを追加
4. 「認証情報」→ OAuth クライアント ID → ウェブアプリケーション
   承認済みの JavaScript 生成元:
   ${origin}
   承認済みのリダイレクト URI:
   ${redirect}
5. 出てきたクライアントIDを上に貼って保存 → Googleでログイン

PC / Safari はポップアップでログインする。ホーム画面アプリでポップアップが死んだら Google のページへ飛ぶ。
マイドライブに「GrokKotatsu」フォルダができて、スロット名.json が置かれる。
Gemini キーも xAI キーもこの JSON に乗る。`;
}
