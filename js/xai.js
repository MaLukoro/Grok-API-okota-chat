/** xAI Chat / Models / TTS。同一オリジンの /v1 プロキシを優先。 */

import { FALLBACK_MODELS } from "./settings.js";

function hostHasLocalProxy() {
  const h = location.hostname || "";
  if (h === "localhost" || h === "127.0.0.1") return true;
  if (h.endsWith(".pages.dev") || h.endsWith(".workers.dev")) return true;
  // preview.py を LAN の iPhone から叩くとき
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return true;
  return false;
}

export function resolveApiBase(settings) {
  const custom = (settings.proxyBase || "").trim().replace(/\/+$/, "");
  if (custom) return custom;
  // GitHub Pages は /v1 プロキシが無い。origin/v1 に飛ばすと 404 になる
  if (hostHasLocalProxy()) return `${location.origin}/v1`;
  return "https://api.x.ai/v1";
}

export function sanitizeApiKey(raw) {
  return String(raw || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

export function authHeaders(settings, extra = {}) {
  const key = sanitizeApiKey(settings.apiKey);
  if (!key) throw new Error("xAI APIキーが未設定だよ。右の設定から入れてくれ。");
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function readError(res) {
  let detail = `${res.status} ${res.statusText}`;
  try {
    const j = await res.json();
    detail = j.error?.message || j.error || j.detail || JSON.stringify(j);
  } catch {
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
  }
  return typeof detail === "string" ? detail : JSON.stringify(detail);
}

export async function listModels(settings, { allowFallback = true } = {}) {
  try {
    const res = await fetch(`${resolveApiBase(settings)}/models`, {
      headers: authHeaders(settings),
    });
    if (!res.ok) throw new Error(await readError(res));
    const data = await res.json();
    const items = Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : [];
    const grok = items
      .map((m) => (typeof m === "string" ? m : m.id))
      .filter((id) => typeof id === "string" && id.startsWith("grok-") && !id.includes("imagine") && !id.includes("tts") && !id.includes("voice"));
    grok.sort();
    if (!grok.length) return FALLBACK_MODELS;
    const known = new Map(FALLBACK_MODELS.map((m) => [m.id, m]));
    return grok.map((id) => known.get(id) || { id, label: id, hint: "" });
  } catch (e) {
    if (!allowFallback) throw e;
    console.warn("models fallback", e);
    return FALLBACK_MODELS;
  }
}

function extractDelta(json) {
  const delta = json.choices?.[0]?.delta || {};
  const msg = json.choices?.[0]?.message || {};
  return {
    content: delta.content || msg.content || "",
    reasoning: delta.reasoning_content || delta.reasoning || msg.reasoning_content || msg.reasoning || "",
  };
}

export async function chatCompletionsStream(settings, body, { signal, onDelta } = {}) {
  const url = `${resolveApiBase(settings)}/chat/completions`;
  const payload = {
    model: body.model,
    messages: body.messages,
    temperature: body.temperature ?? 0.8,
    top_p: body.topP ?? 0.95,
    max_tokens: body.maxTokens ?? 4096,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (body.webSearch) {
    payload.tools = [{ type: "web_search" }];
  }

  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(settings),
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) throw new Error(await readError(res));
  if (!res.body) throw new Error("ストリームが開けなかった");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  let fullReason = "";
  let usage = null;
  let resolvedModel = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() || "";
    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.error) {
        throw new Error(typeof json.error === "string" ? json.error : json.error.message || JSON.stringify(json.error));
      }
      if (json.usage) usage = json.usage;
      if (json.model && !resolvedModel) resolvedModel = json.model;
      if (!json.choices) continue;
      const { content, reasoning } = extractDelta(json);
      if (content && reasoning && content === reasoning) {
        fullReason += reasoning;
      } else {
        if (reasoning) fullReason += reasoning;
        if (content) {
          if (!fullReason || !fullReason.endsWith(content) || full) {
            if (!reasoning) full += content;
            else if (content !== reasoning) full += content;
          }
        }
      }
      if ((content || reasoning) && onDelta) onDelta(full, fullReason);
    }
  }

  return {
    content: full,
    reasoning: fullReason,
    usage,
    model: resolvedModel || body.model,
  };
}

/** Web検索トグル時。Responses API。失敗したら呼び出し側で completions に落とす。 */
export async function responsesStream(settings, body, { signal, onDelta } = {}) {
  const url = `${resolveApiBase(settings)}/responses`;
  const input = (body.messages || [])
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    }));
  const sys = (body.messages || []).filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const payload = {
    model: body.model,
    input,
    temperature: body.temperature ?? 0.8,
    stream: true,
    tools: [{ type: "web_search" }],
  };
  if (sys) payload.instructions = sys;

  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(settings),
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) throw new Error(await readError(res));

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  let usage = null;
  let resolvedModel = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() || "";
    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.type === "response.output_text.delta" && json.delta) {
        full += json.delta;
        if (onDelta) onDelta(full, "");
      } else if (json.type === "response.output_item.delta" && json.delta?.text) {
        full += json.delta.text;
        if (onDelta) onDelta(full, "");
      } else if (typeof json.delta === "string" && json.type?.includes("text")) {
        full += json.delta;
        if (onDelta) onDelta(full, "");
      }
      if (json.response?.usage) usage = json.response.usage;
      if (json.response?.model) resolvedModel = json.response.model;
    }
  }
  return { content: full, reasoning: "", usage, model: resolvedModel || body.model };
}

export async function chatStream(settings, body, opts) {
  if (body.webSearch) {
    try {
      return await responsesStream(settings, body, opts);
    } catch (e) {
      console.warn("responses web_search failed, fallback completions", e);
    }
  }
  return chatCompletionsStream(settings, body, opts);
}

export async function ttsSpeak(settings, { text, voiceId, language }) {
  const url = `${resolveApiBase(settings)}/tts`;
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(settings),
    body: JSON.stringify({
      text,
      voice_id: voiceId || "rex",
      language: language || "ja",
    }),
  });
  if (!res.ok) throw new Error(await readError(res));
  return res.blob();
}

/** Management API。チャット用キーでは残高は取れない。 */
const MGMT_DIRECT = "https://management-api.x.ai";

export function resolveMgmtBase(settings) {
  const custom = (settings.proxyBase || "").trim().replace(/\/+$/, "");
  if (custom) {
    if (custom.endsWith("/v1")) return `${custom.slice(0, -3)}/mgmt`;
    return `${custom}/mgmt`;
  }
  if (hostHasLocalProxy()) return `${location.origin}/mgmt`;
  return MGMT_DIRECT;
}

function mgmtAuthHeaders(settings) {
  const key = sanitizeApiKey(settings.mgmtKey);
  if (!key) {
    throw new Error("Management Key が未設定だよ。チャット用キーとは別物。⚙ のクレジット欄に入れてくれ。");
  }
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

async function mgmtFetchJson(settings, path) {
  const url = `${resolveMgmtBase(settings)}${path.startsWith("/") ? path : `/${path}`}`;
  let res;
  try {
    res = await fetch(url, { headers: mgmtAuthHeaders(settings) });
  } catch (e) {
    if (resolveMgmtBase(settings) === MGMT_DIRECT) {
      throw new Error(
        "残高APIがブラウザに弾かれた（CORS）。⚙ のプロキシURLに Worker を入れて、Worker も最新に上げ直してくれ。"
      );
    }
    throw new Error(`残高の取得に失敗: ${e.message || e}`);
  }
  if (!res.ok) {
    const detail = await readError(res);
    if (res.status === 401) throw new Error("Management Key が違うか期限切れ。console.x.ai の Management Keys を見てくれ。");
    if (res.status === 403) throw new Error("この Management Key に Billing を読む権限がない。キーの ACL を確認してくれ。");
    if (res.status === 404) throw new Error(`Team ID が見つからない: ${detail}`);
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return res.json();
}

function centsToNumber(v) {
  if (v == null) return null;
  if (typeof v === "object" && v.val != null) v = v.val;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function usdAbsFromCents(cents) {
  const n = centsToNumber(cents);
  if (n == null) return null;
  return Math.abs(n) / 100;
}

export function formatUsd(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function parseCreditSnapshot(balance, invoice) {
  const totalAbs = usdAbsFromCents(balance?.total);
  const prepaidAbs = usdAbsFromCents(invoice?.coreInvoice?.prepaidCredits);
  const usedUsd = usdAbsFromCents(invoice?.coreInvoice?.prepaidCreditsUsed) ?? 0;

  const split = (pool) => {
    if (pool == null) return null;
    // pool が購入合計なら used を引く。すでに残量なら引かない。
    if (usedUsd > 0.0001 && pool + 0.005 >= usedUsd) {
      return { purchasedUsd: pool, remainingUsd: pool - usedUsd };
    }
    return {
      remainingUsd: pool,
      purchasedUsd: usedUsd > 0 ? pool + usedUsd : pool,
    };
  };

  return { usedUsd, ...(split(totalAbs) || split(prepaidAbs) || { purchasedUsd: null, remainingUsd: null }) };
}

export async function validateMgmtKey(settings) {
  return mgmtFetchJson(settings, "/auth/management-keys/validation");
}

export async function fetchCreditBalance(settings) {
  let teamId = String(settings.teamId || "").trim();
  let detected = false;
  if (!teamId) {
    const info = await validateMgmtKey(settings);
    teamId = String(info.teamId || info.scopeId || "").trim();
    detected = true;
    if (!teamId) throw new Error("Management Key から Team ID が取れなかった。⚙ に Team ID を手で入れてくれ。");
  }

  const load = (tid) =>
    Promise.all([
      mgmtFetchJson(settings, `/v1/billing/teams/${encodeURIComponent(tid)}/prepaid/balance`),
      mgmtFetchJson(settings, `/v1/billing/teams/${encodeURIComponent(tid)}/postpaid/invoice/preview`).catch(() => null),
    ]);

  let balance;
  let invoice;
  try {
    [balance, invoice] = await load(teamId);
  } catch (e) {
    const msg = String(e.message || e);
    if (!detected && /404|見つからない|not found/i.test(msg)) {
      const info = await validateMgmtKey(settings);
      const retryId = String(info.teamId || info.scopeId || "").trim();
      if (retryId && retryId !== teamId) {
        teamId = retryId;
        detected = true;
        [balance, invoice] = await load(teamId);
      } else {
        throw e;
      }
    } else {
      throw e;
    }
  }

  const snap = parseCreditSnapshot(balance, invoice);
  if (snap.remainingUsd == null && snap.purchasedUsd == null) {
    throw new Error("残高の数字がレスポンスから読めなかった");
  }
  return { ...snap, teamId, teamIdDetected: detected, fetchedAt: Date.now() };
}
