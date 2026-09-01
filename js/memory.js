/** プロジェクト進行メモリ。直近N窓 + 折りたたみ。圧縮は Gemini Lite → 検閲時 Grok NR。 */

import { contentAsText, nowSec } from "./util.js";
import { saveSettings } from "./settings.js";
import { chatCompletionsOnce, sanitizeApiKey } from "./xai.js";
import { geminiGenerate, sanitizeGeminiKey } from "./gemini.js";

export const WINDOW_CHARS = 10000;
export const COMPRESS_BATCH_MIN = 3500;
export const COMPRESS_CHUNK_MAX = 8000;
export const HANDOFF_CHUNK_MAX = 20000;
export const MEMORY_INJECT_MAX = 3000;
export const MEMORY_STORE_MAX = 2500;

export const MEMORY_FIELDS = [
  "場所",
  "時刻",
  "服装",
  "身体・接触",
  "感情・温度",
  "未解決（約束・仕掛り）",
  "今ターンで変えた事実",
  "固有名詞",
];

export const MEMORY_PLACEHOLDER = MEMORY_FIELDS.map((k) => `${k}:`).join("\n");

const COMPRESS_SYS = `あなたは長編ロールプレイの進行メモ係。あらすじを書くな。指定フォームを日本語で上書き更新せよ。

ルール:
- 入力は「現状メモリ」と「これから窓から外す発言」だけ。
- 現状メモリの行は消すな。新しい事実で更新するか、そのま残す。
- 会話の生セリフはコピーするな。状態だけ。
- 場所・服装・身体接触・感情・未解決は具体的に。ぼかして「親密だった」で済ませるな。
- フィクションの成人向け描写も事実として残す。拒否・検閲・説教をするな。
- 不明は「不明」か現状のまま。捏造するな。
- 出力はフォームのみ。前置き禁止。
- 全体は ${MEMORY_STORE_MAX} 字以内。

フォーム:
${MEMORY_PLACEHOLDER}
`;

export function talkMessages(messages) {
  return (messages || []).filter((m) => m.role === "user" || m.role === "assistant");
}

export function msgText(m) {
  if (!m) return "";
  const bits = [contentAsText(m.content)];
  for (const a of m.attachments || []) {
    if (a?.kind === "md" && a.text) bits.push(a.text);
    else if (a?.kind === "image") bits.push(`（画像: ${a.name || "画像"}）`);
    else if (a?.name) bits.push(a.name);
  }
  return bits.filter(Boolean).join("\n").trim();
}

function charsOf(tagged) {
  return tagged.reduce((s, m) => s + (m.text || "").length, 0);
}

export function isLivingThread(project, chat) {
  if (!chat || chat.archived) return false;
  if (!project?.living_chat_id) return true;
  return project.living_chat_id === chat.id;
}

export function livingExists(project, projectChats) {
  const id = project?.living_chat_id;
  if (!id) return false;
  return (projectChats || []).some((c) => c.id === id && !c.archived);
}

export function timeline(chat, project) {
  const carry = Array.isArray(project?.carry?.messages) ? project.carry.messages : [];
  const liveAll = talkMessages(chat?.messages);
  const sameChat = project?.folded_chat_id && chat?.id && project.folded_chat_id === chat.id;
  const foldedCount = sameChat ? Math.min(Number(project.folded_count) || 0, liveAll.length) : 0;
  const live = liveAll.slice(foldedCount);
  const tagged = [];
  carry.forEach((m, i) => {
    tagged.push({
      source: "carry",
      index: i,
      role: m.role,
      content: m.content,
      text: msgText(m),
    });
  });
  live.forEach((m, i) => {
    tagged.push({
      source: "live",
      index: foldedCount + i,
      role: m.role,
      content: m.content,
      text: msgText(m),
      raw: m,
    });
  });
  return { tagged, liveAll, foldedCount, carry };
}

export function splitWindow(tagged, windowChars = WINDOW_CHARS) {
  let used = 0;
  const window = [];
  for (let i = tagged.length - 1; i >= 0; i--) {
    const n = (tagged[i].text || "").length;
    if (window.length && used + n > windowChars) break;
    window.push(tagged[i]);
    used += n;
  }
  window.reverse();
  const overflow = tagged.slice(0, Math.max(0, tagged.length - window.length));
  return { window, overflow, windowChars: used };
}

export function sliceOldestChunk(overflow, maxChars) {
  const out = [];
  let used = 0;
  for (const m of overflow) {
    const n = (m.text || "").length;
    if (out.length && used + n > maxChars) break;
    out.push(m);
    used += n;
  }
  return { chunk: out, chars: used };
}

export function planApiWindow(chat, project, { autoCompress = true, compressing = false } = {}) {
  const { tagged } = timeline(chat, project);
  const { window, overflow } = splitWindow(tagged);
  const overflowChars = charsOf(overflow);
  const keepOverflow = !!autoCompress && (compressing || overflowChars > 0);
  const forApi = keepOverflow ? tagged : window;
  return {
    tagged,
    window,
    overflow,
    overflowChars,
    forApi,
    keepOverflow,
  };
}

export function memoryInjectBlock(memory) {
  const text = String(memory || "").trim();
  if (!text) return "";
  const clipped = text.length > MEMORY_INJECT_MAX ? `${text.slice(0, MEMORY_INJECT_MAX)}\n…` : text;
  return `【進行メモリ】物語のいまの状態。口調・世界の決まりはシスプロ側。ここは事実。要約で削るな。\n\n${clipped}`;
}

export function formatChunkForCompress(chunk) {
  return chunk
    .map((m) => {
      const who = m.role === "user" ? "まろ" : "グリク";
      return `${who}:\n${m.text || ""}`;
    })
    .join("\n\n");
}

function looksLikeForm(text) {
  const t = String(text || "")
    .replace(/^\s*```[a-zA-Z]*\s*\n?/, "")
    .replace(/\n?```\s*$/, "");
  let n = 0;
  for (const k of MEMORY_FIELDS) {
    if (t.includes(`${k}:`) || t.includes(`${k}：`)) n += 1;
  }
  return n >= 3;
}

function stripFence(text) {
  return String(text || "")
    .replace(/^\s*```[a-zA-Z]*\s*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trim();
}

function clipMemory(text) {
  const t = stripFence(text);
  if (t.length <= MEMORY_STORE_MAX) return t;
  return t.slice(0, MEMORY_STORE_MAX).trimEnd();
}

function packPrompt(currentMemory, chunk) {
  const mem = String(currentMemory || "").trim() || "（空。フォームを新規に埋めよ）";
  return `【現状メモリ】\n${mem}\n\n【これから窓から外す発言】\n${formatChunkForCompress(chunk)}`;
}

async function compressWithGemini(settings, prompt) {
  const r = await geminiGenerate(settings.geminiKey, {
    model: settings.compressGeminiModel || "gemini-2.5-flash-lite",
    prompt,
    systemInstruction: COMPRESS_SYS,
  });
  return {
    text: r.text,
    model: r.model,
    provider: "gemini",
    censored: r.censored,
  };
}

async function compressWithXai(settings, prompt) {
  const model = settings.compressXaiModel || "grok-4.20-0309-non-reasoning";
  const r = await chatCompletionsOnce(settings, {
    model,
    messages: [
      { role: "system", content: COMPRESS_SYS },
      { role: "user", content: prompt },
    ],
    temperature: 0.2,
    maxTokens: 2048,
  });
  return { text: r.content || "", model: r.model || model, provider: "xai", censored: false };
}

export async function foldChunk(settings, { memory, chunk }) {
  if (!chunk?.length) {
    return { ok: false, reason: "empty" };
  }
  const prompt = packPrompt(memory, chunk);
  const provider = settings.compressProvider === "xai" ? "xai" : "gemini";
  let used = null;
  let switched = false;

  const tryGemini = async () => {
    if (!sanitizeGeminiKey(settings.geminiKey)) {
      return { ok: false, reason: "no-gemini-key" };
    }
    const r = await compressWithGemini(settings, prompt);
    if (r.censored) return { ok: false, reason: "censored", raw: r };
    if (!looksLikeForm(r.text)) return { ok: false, reason: "bad-form", raw: r };
    return { ok: true, ...r, text: clipMemory(r.text) };
  };

  const tryXai = async () => {
    if (!sanitizeApiKey(settings.apiKey)) {
      return { ok: false, reason: "no-xai-key" };
    }
    const r = await compressWithXai(settings, prompt);
    if (!looksLikeForm(r.text)) {
      return { ok: false, reason: "bad-form", raw: r };
    }
    return { ok: true, ...r, text: clipMemory(r.text) };
  };

  if (provider === "gemini") {
    try {
      used = await tryGemini();
    } catch (e) {
      const msg = String(e.message || e);
      const status = e.status;
      const reason = status === 429 || /resource.?exhausted|quota/i.test(msg) ? "quota" : "gemini-error";
      used = { ok: false, reason, error: msg };
    }
    if (!used.ok) {
      const fallback = await tryXai().catch((e) => ({
        ok: false,
        reason: "xai-error",
        error: String(e.message || e),
      }));
      if (fallback.ok) {
        switched = used.reason === "censored";
        if (switched) saveSettings({ compressProvider: "xai" });
        used = { ...fallback, switched, switchedFrom: used.reason };
      } else {
        used = { ...used, fallbackError: fallback.error };
      }
    }
  } else {
    used = await tryXai().catch((e) => ({ ok: false, reason: "xai-error", error: String(e.message || e) }));
  }

  return used;
}

export function applyFold(project, chat, foldedTagged, newMemory) {
  const carryMsgs = Array.isArray(project?.carry?.messages) ? [...project.carry.messages] : [];
  const same = project?.folded_chat_id === chat.id;
  let foldedCount = same ? Number(project.folded_count) || 0 : 0;
  let carryDrop = 0;
  let liveDrop = 0;
  for (const m of foldedTagged) {
    if (m.source === "carry") carryDrop += 1;
    else if (m.source === "live") liveDrop += 1;
  }
  const nextCarryMsgs = carryMsgs.slice(carryDrop);
  foldedCount += liveDrop;
  const carry =
    nextCarryMsgs.length > 0
      ? {
          ...(project.carry || {}),
          messages: nextCarryMsgs,
          chars: nextCarryMsgs.reduce((s, m) => s + msgText(m).length, 0),
        }
      : null;
  return {
    ...project,
    memory: newMemory,
    memory_updated_at: nowSec(),
    carry,
    folded_count: foldedCount,
    folded_chat_id: chat.id,
  };
}

export function snapshotCarry(windowTagged, fromChatId) {
  const messages = (windowTagged || []).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.text || "",
  }));
  return {
    messages,
    from_chat_id: fromChatId || null,
    frozen_at: nowSec(),
    chars: messages.reduce((s, m) => s + String(m.content || "").length, 0),
  };
}

export function shouldAutoFold(plan, { autoCompress, compressing, canWrite, memoryDirty }) {
  if (!autoCompress || compressing || !canWrite || memoryDirty) return false;
  return (plan.overflowChars || 0) >= COMPRESS_BATCH_MIN;
}

export function foldChunkFromPlan(plan, { handoff = false } = {}) {
  const max = handoff ? HANDOFF_CHUNK_MAX : COMPRESS_CHUNK_MAX;
  return sliceOldestChunk(plan.overflow || [], max);
}
