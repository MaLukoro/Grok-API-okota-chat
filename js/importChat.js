/** Local LLM Studio チャットJSONとの互換インポート。 */

import { makeId, nowSec } from "./util.js";

const ROLE_MAP = {
  user: "user",
  human: "user",
  assistant: "assistant",
  ai: "assistant",
  bot: "assistant",
  model: "assistant",
  system: "system",
  developer: "system",
};

function normalizeContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = [];
    for (const part of content) {
      if (typeof part === "string") texts.push(part);
      else if (part && typeof part === "object") {
        if (part.type === "text" && part.text) texts.push(String(part.text));
        else if (part.text) texts.push(String(part.text));
      }
    }
    return texts.join("\n");
  }
  return String(content || "");
}

export function normalizeImportPayload(data, { fallbackTitle = "" } = {}) {
  let payload;
  if (Array.isArray(data)) {
    payload = { title: fallbackTitle || "インポート", messages: data };
  } else if (data && typeof data === "object") {
    payload = { ...data };
    if (!("messages" in payload)) {
      for (const key of ["chats", "conversations", "threads"]) {
        const arr = payload[key];
        if (Array.isArray(arr) && arr[0] && typeof arr[0] === "object" && (arr[0].messages || arr[0].role)) {
          if (arr[0].messages) payload = { ...arr[0] };
          else payload = { title: fallbackTitle || "インポート", messages: arr };
          break;
        }
      }
    }
    if (!payload.messages && payload.history) payload.messages = payload.history;
    if (!payload.messages && payload.conversation) {
      const conv = payload.conversation;
      if (Array.isArray(conv)) payload.messages = conv;
      else if (conv && Array.isArray(conv.messages)) payload.messages = conv.messages;
    }
  } else {
    throw new Error("JSON object or messages array required");
  }

  const msgs = payload.messages;
  if (!Array.isArray(msgs)) throw new Error("messages 配列が見つからないよ");

  const clean = [];
  for (const m of msgs) {
    if (!m || typeof m !== "object") continue;
    const roleRaw = String(m.role || m.author || m.from || "").toLowerCase();
    const role = ROLE_MAP[roleRaw];
    if (!role) continue;
    let content = m.content;
    if (content == null) content = m.text || m.message || "";
    content = normalizeContent(content);
    const entry = { role, content };
    if (m.reasoning) entry.reasoning = m.reasoning;
    else if (m.reasoning_content) entry.reasoning = m.reasoning_content;
    if (m.meta && typeof m.meta === "object") entry.meta = m.meta;
    if (m.rag && typeof m.rag === "object") entry.rag = m.rag;
    if (Array.isArray(m.attachments)) entry.attachments = m.attachments;
    clean.push(entry);
  }
  if (!clean.length) throw new Error("有効なメッセージが1件もないよ");

  payload.messages = clean;
  if (!(payload.title || "").trim()) payload.title = fallbackTitle || "インポート";
  return payload;
}

export function toStudioChat(payload, { newId = true, projectId = undefined } = {}) {
  const t = nowSec();
  const chat = {
    id: newId || !payload.id ? makeId() : String(payload.id),
    title: payload.title || "インポート",
    system_prompt: payload.system_prompt || "",
    model: payload.model || null,
    project_id: projectId !== undefined ? projectId || null : payload.project_id || null,
    messages: payload.messages,
    created_at: payload.created_at || t,
    updated_at: t,
    pinned: !!payload.pinned,
    version: 1,
  };
  return chat;
}

/** MaroShare / Grok CLI 寄せ。会話本文だけ残す。 */
export function toExportChat(chat) {
  return {
    title: chat.title || "無題",
    system_prompt: chat.system_prompt || "",
    model: chat.model || null,
    messages: (chat.messages || [])
      .filter((m) => m && (m.role === "user" || m.role === "assistant"))
      .map((m) => {
        const out = { role: m.role, content: normalizeContent(m.content) };
        if (m.reasoning) out.reasoning = m.reasoning;
        return out;
      }),
  };
}
