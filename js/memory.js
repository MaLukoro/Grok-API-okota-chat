/** 進行メモリ + 直近N。画面のログは触らない。切るのは API 行きだけ。 */

import { contentAsText } from "./util.js";

export const WINDOW_CHARS = 10000;
export const MEMORY_CAP = 2500;
export const OVERFLOW_MIN = 3500;
export const CHUNK_CHARS = 8000;
export const HANDOFF_CHUNK = 12000;

export const MEMORY_FORM = `場所:
時刻:
服装:
身体・接触:
感情・温度:
未解決（約束・仕掛り）:
今ターンで変えた事実:
固有名詞:`;

const FORM_LABELS = [
  "場所:",
  "時刻:",
  "服装:",
  "身体・接触:",
  "感情・温度:",
  "未解決",
  "今ターンで変えた事実:",
  "固有名詞:",
];

export function messagePlainText(m) {
  if (!m) return "";
  const bits = [contentAsText(m.content)];
  for (const a of m.attachments || []) {
    if (a?.kind === "md" && a.text) bits.push(a.text);
    else if (a?.name) bits.push(a.name);
  }
  return bits.filter(Boolean).join("\n");
}

export function isLiveThread(chat, project) {
  if (!chat || !project || chat.archived) return false;
  if (!chat.project_id || chat.project_id !== project.id) return false;
  if (!project.live_thread_id) return false;
  return project.live_thread_id === chat.id;
}

/** 本番未指定なら、今開いてる未凍結スレッドが名乗れる。 */
export function canWriteMemory(chat, project) {
  if (!chat || !project || chat.archived) return false;
  if (!chat.project_id || chat.project_id !== project.id) return false;
  if (!project.live_thread_id) return true;
  return project.live_thread_id === chat.id;
}

export function collectRawItems(project, chat, { includeHandoff = true } = {}) {
  const items = [];
  if (includeHandoff) {
    const handoff = project?.handoff?.messages || [];
    for (let i = 0; i < handoff.length; i++) {
      const m = handoff[i];
      if (!m || m.folded) continue;
      if (m.role !== "user" && m.role !== "assistant") continue;
      items.push({ source: "handoff", index: i, message: m });
    }
  }
  const msgs = chat?.messages || [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m || m.folded) continue;
    if (m.role !== "user" && m.role !== "assistant") continue;
    items.push({ source: "chat", index: i, message: m });
  }
  return items;
}

export function splitWindow(items, budget = WINDOW_CHARS) {
  let used = 0;
  const recent = [];
  const overflow = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const n = messagePlainText(items[i].message).length;
    if (used + n > budget && recent.length) overflow.push(items[i]);
    else {
      recent.push(items[i]);
      used += n;
    }
  }
  recent.reverse();
  overflow.reverse();
  return { recent, overflow, used };
}

export function overflowChars(overflow) {
  return overflow.reduce((n, it) => n + messagePlainText(it.message).length, 0);
}

/** 窓のすぐ左から一塊。古い章の先頭からではない。 */
export function chunkOverflow(overflow, maxChars = CHUNK_CHARS) {
  const chunk = [];
  let used = 0;
  for (let i = overflow.length - 1; i >= 0; i--) {
    const n = messagePlainText(overflow[i].message).length;
    if (used + n > maxChars && chunk.length) break;
    chunk.push(overflow[i]);
    used += n;
  }
  chunk.reverse();
  return { chunk, used };
}

export function selectApiMessages(project, chat, { keepOverflow = false, windowChars = WINDOW_CHARS } = {}) {
  const live = !!(project && isLiveThread(chat, project));
  const items = collectRawItems(live ? project : null, chat, { includeHandoff: live });
  const { recent, overflow } = splitWindow(items, windowChars);
  const picked = keepOverflow ? overflow.concat(recent) : recent;
  return picked.map((it) => it.message);
}

export function formatChunk(items) {
  return items
    .map((it) => {
      const who = it.message.role === "user" ? "まろ" : "グリク";
      return `${who}:\n${messagePlainText(it.message).trim()}`;
    })
    .filter((s) => s.length > 3)
    .join("\n\n");
}

export function cloneHandoffMessages(recentItems) {
  return recentItems.map((it) => ({
    role: it.message.role,
    content: messagePlainText(it.message),
  }));
}

export function markFolded(items) {
  for (const it of items) {
    if (it?.message) it.message.folded = true;
  }
}

export function pruneHandoff(project) {
  if (!project?.handoff?.messages) return project;
  const kept = project.handoff.messages.filter((m) => !m.folded);
  if (!kept.length) project.handoff = null;
  else project.handoff.messages = kept;
  return project;
}

export function remainingHandoff(project) {
  return (project?.handoff?.messages || []).filter((m) => !m.folded && (m.role === "user" || m.role === "assistant"));
}

export function capMemory(text, cap = MEMORY_CAP) {
  const s = String(text || "").trim();
  if (s.length <= cap) return s;
  const cut = s.slice(0, cap);
  const nl = cut.lastIndexOf("\n");
  return (nl > cap * 0.6 ? cut.slice(0, nl) : cut).trim();
}

export function looksLikeForm(text) {
  const s = String(text || "");
  if (s.length < 20) return false;
  let hits = 0;
  for (const lab of FORM_LABELS) {
    if (s.includes(lab)) hits += 1;
  }
  return hits >= 4;
}

export function looksLikeRefusal(text) {
  const s = String(text || "").trim();
  if (!s) return true;
  return (
    /i\s+can('t|not)\s/i.test(s) ||
    /cannot\s+(help|assist|comply)/i.test(s) ||
    /against\s+(our|the)\s+policy/i.test(s) ||
    /お手伝いできません|対応できません|出力できません|リクエストに答えられ/.test(s) ||
    /safety|nsfw policy/i.test(s)
  );
}

export function stripFences(text) {
  let s = String(text || "").trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "");
  }
  return s.trim();
}

export function buildCompressPrompt({ memory, chunkText, cap = MEMORY_CAP }) {
  const prev = (memory || "").trim() || "（まだ空。フォームから埋めてくれ）";
  return `あなたは長編ロープレの進行メモ係。物語のあらすじは書かない。状態フォームを上書き更新する。

ルール:
- 出力はフォームだけ。前置き・後書き・コードフェンス・セリフの引用は禁止
- 今の進行メモリを前状態として残し、新しい事実で上書きする
- ユーザーが手で書いた行は落とさない（ピン）
- 場所・服装・身体・接触・未解決は具体的に残す。ぼかさない
- ${cap}字以内。超えるなら確定事実側を圧縮
- 刺激的な描写も事実として残す。検閲しない

フォーム:
${MEMORY_FORM}

今の進行メモリ:
${prev}

これから窓から外す生ログ:
${chunkText}`;
}

export function windowStats(project, chat, windowChars = WINDOW_CHARS) {
  const live = !!(project && isLiveThread(chat, project));
  const items = collectRawItems(live ? project : null, chat, { includeHandoff: live });
  const { recent, overflow, used } = splitWindow(items, windowChars);
  return {
    live,
    recentCount: recent.length,
    overflowCount: overflow.length,
    used,
    overflowChars: overflowChars(overflow),
    handoffCount: remainingHandoff(project).length,
  };
}
