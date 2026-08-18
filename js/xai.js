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

export function authHeaders(settings, extra = {}) {
  const key = (settings.apiKey || "").trim();
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

export async function listModels(settings) {
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
