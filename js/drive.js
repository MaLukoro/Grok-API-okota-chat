/** Google Drive バックアップ。同じタブで PKCE リダイレクト（ポップアップにしない）。 */

import { exportPack, importPack, packToJson } from "./db.js";

const TOKEN_KEY = "kotatsu_gdrive_token";
const PKCE_KEY = "kotatsu_gdrive_pkce";
const FOLDER_NAME = "GrokKotatsu";
const SCOPE = "https://www.googleapis.com/auth/drive.file";

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

export function saveToken(accessToken, expiresIn = 3600, extra = {}) {
  localStorage.setItem(
    TOKEN_KEY,
    JSON.stringify({
      access_token: accessToken,
      refresh_token: extra.refresh_token || loadRefreshToken(),
      expires_at: Date.now() + Number(expiresIn || 3600) * 1000,
    })
  );
}

function loadRefreshToken() {
  try {
    return JSON.parse(localStorage.getItem(TOKEN_KEY) || "null")?.refresh_token || null;
  } catch {
    return null;
  }
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export function isDriveLoggedIn() {
  return !!loadToken();
}

function loadPkce() {
  try {
    const raw = JSON.parse(localStorage.getItem(PKCE_KEY) || "null");
    if (!raw?.verifier) return null;
    if (raw.at && Date.now() - raw.at > 15 * 60 * 1000) {
      localStorage.removeItem(PKCE_KEY);
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

function randomUrlSafe(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let bin = "";
  buf.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkceChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const buf = new Uint8Array(hash);
  let bin = "";
  buf.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function exchangeCode({ code, verifier, clientId, redirect }) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: redirect,
    }),
  });
  let json = {};
  try {
    json = await res.json();
  } catch {
    json = {};
  }
  if (!res.ok || !json.access_token) {
    const detail = json.error_description || json.error || `${res.status} ${res.statusText}`;
    const err = new Error(humanOAuthError(detail));
    err.status = res.status;
    throw err;
  }
  saveToken(json.access_token, json.expires_in, json);
  return json.access_token;
}

export async function consumeOAuthRedirect() {
  const hash = (location.hash || "").replace(/^#/, "");
  const query = (location.search || "").replace(/^\?/, "");
  const hp = hash ? new URLSearchParams(hash) : new URLSearchParams();
  const qp = query ? new URLSearchParams(query) : new URLSearchParams();
  const token = hp.get("access_token");
  const code = qp.get("code");
  const err = hp.get("error") || qp.get("error");
  const state = hp.get("state") || qp.get("state");
  if (!token && !code && !err) return { handled: false };
  if (state && state !== "gdrive") return { handled: false };
  history.replaceState(null, "", redirectUri());
  if (err) {
    localStorage.removeItem(PKCE_KEY);
    return { handled: true, error: qp.get("error_description") || hp.get("error_description") || err };
  }
  if (token) {
    localStorage.removeItem(PKCE_KEY);
    saveToken(token, Number(hp.get("expires_in") || 3600));
    return { handled: true, ok: true };
  }
  const pkce = loadPkce();
  localStorage.removeItem(PKCE_KEY);
  if (!pkce?.verifier) {
    return { handled: true, error: "ログインの途中データが消えた。もう一回「Googleでログイン」を押してくれ" };
  }
  try {
    await exchangeCode({
      code,
      verifier: pkce.verifier,
      clientId: pkce.clientId,
      redirect: pkce.redirect || redirectUri(),
    });
    return { handled: true, ok: true };
  } catch (e) {
    const msg = String(e.message || e);
    if (/client_secret|Failed to fetch|NetworkError|CORS|unauthorized_client/i.test(msg)) {
      localStorage.setItem("kotatsu_gdrive_oauth_mode", "implicit");
      return {
        handled: true,
        error: `${msg} 次は昔の方式で飛ぶ。もう一回「Googleでログイン」を押してくれ`,
      };
    }
    return { handled: true, error: msg };
  }
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
  if (/unauthorized_client|unsupported_response_type/i.test(s)) {
    return "このクライアントはウェブのログイン方式が違う。Cloud Console の種類が「ウェブアプリケーション」か見てくれ";
  }
  if (/invalid_grant/i.test(s)) {
    return "ログインコードの期限が切れた。もう一回「Googleでログイン」を押してくれ";
  }
  if (/Failed to fetch|NetworkError|CORS/i.test(s)) {
    return "Google とのコード交換がブラウザに拒否された。もう一回ログインを試してくれ";
  }
  return s;
}

export async function startPkceLogin(clientId) {
  const id = assertClientId(clientId);
  const redirect = redirectUri();
  const verifier = randomUrlSafe(32);
  const challenge = await pkceChallenge(verifier);
  const state = "gdrive";
  localStorage.setItem(
    PKCE_KEY,
    JSON.stringify({ verifier, clientId: id, redirect, state, at: Date.now() })
  );
  const params = new URLSearchParams({
    client_id: id,
    redirect_uri: redirect,
    response_type: "code",
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    include_granted_scopes: "true",
    prompt: "select_account",
    access_type: "online",
  });
  location.assign(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}

/** 8月に通ってた同じタブ方式。ポップアップも GIS も待たない。 */
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

export async function loginToDrive(clientId) {
  // 既定は 8 月に通った implicit（同じタブ）。PKCE は token 交換が CORS で死ぬ端末だけ。
  const preferPkce = localStorage.getItem("kotatsu_gdrive_oauth_mode") === "pkce";
  if (preferPkce && globalThis.crypto?.subtle) {
    try {
      await startPkceLogin(clientId);
      return { redirected: true };
    } catch (e) {
      console.warn("pkce start failed", e);
    }
  }
  startImplicitLogin(clientId);
  return { redirected: true };
}

export async function ensureDriveToken(settings) {
  const existing = loadToken();
  if (existing) return existing;
  const refresh = loadRefreshToken();
  const id = sanitizeClientId(settings?.googleClientId);
  if (refresh && id) {
    try {
      const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: id,
          refresh_token: refresh,
          grant_type: "refresh_token",
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.access_token) {
        saveToken(json.access_token, json.expires_in, { refresh_token: refresh });
        return json.access_token;
      }
    } catch {
      /* fall through */
    }
  }
  throw new Error("Google にログインしてくれ。上の「Googleでログイン」を押して戻ってくれば保存できる");
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

ログインは同じタブで Google に飛ぶ。戻ってきたら完了。
マイドライブに「GrokKotatsu」フォルダができて、スロット名.json が置かれる。
Gemini キーも xAI キーもこの JSON に乗る。`;
}
