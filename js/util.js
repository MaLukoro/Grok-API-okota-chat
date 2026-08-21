/** Small helpers. iOS LAN HTTP でも動く ID 生成を含む。 */

export function $(sel, root = document) {
  return root.querySelector(sel);
}

export function $$(sel, root = document) {
  return [...root.querySelectorAll(sel)];
}

export function nowSec() {
  return Date.now() / 1000;
}

export function makeId() {
  try {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  } catch {
    /* insecure context */
  }
  try {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    buf[6] = (buf[6] & 0x0f) | 0x40;
    buf[8] = (buf[8] & 0x3f) | 0x80;
    const hex = [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } catch {
    return `k${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
  }
}

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function escapeAttr(s) {
  return escapeHtml(s).replace(/`/g, "&#96;");
}

export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts > 1e12 ? ts : ts * 1000);
  if (Number.isNaN(d.getTime())) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:${mi}`;
}

export function relativeTime(ts) {
  if (!ts) return "";
  const t = ts > 1e12 ? ts : ts * 1000;
  const diff = Date.now() - t;
  if (diff < 60_000) return "たった今";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}分前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}時間前`;
  if (diff < 7 * 86400_000) return `${Math.floor(diff / 86400_000)}日前`;
  return formatTime(ts);
}

export function autoResize(el) {
  if (!el) return;
  el.style.height = "auto";
  const max = Math.min(window.innerHeight * 0.35, 220);
  el.style.height = `${Math.min(el.scrollHeight, max)}px`;
}

export function toast(msg, type = "") {
  const el = $("#toast");
  if (!el) {
    console.log(msg);
    return;
  }
  el.textContent = msg;
  el.className = "toast" + (type ? ` ${type}` : "");
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, 3200);
}

export function defaultTitle(projectId) {
  return projectId ? "新しいスレッド" : "新しいチャット";
}

export function isDefaultTitle(title) {
  const t = (title || "").trim();
  return !t || t === "新しいチャット" || t === "新しいスレッド" || t === "インポート";
}

export function firstLine(text, max = 40) {
  const s = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function contentAsText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object") {
          if (p.type === "text" || p.text) return String(p.text || "");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return String(content);
}

export function renderSoftMarkdown(text) {
  const raw = String(text ?? "");
  let html = escapeHtml(raw);
  html = html.replace(/```([\s\S]*?)```/g, (_, code) => `<pre class="md-pre"><code>${code}</code></pre>`);
  html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|\n)#{1,3}\s+([^\n]+)/g, "$1<strong>$2</strong>");
  return html;
}

export function stripForSpeech(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[#*_>~]/g, " ")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** 思考過程の中の「ユーザー」を、最初からまろに読み替える。 */
export function localizeReasoning(text) {
  return String(text ?? "")
    .replace(/ユーザー(?:さん|様)?/g, "まろ")
    .replace(/ユーザ(?:さん|様)?/g, "まろ")
    .replace(/\b[Tt]he users\b/g, "まろたち")
    .replace(/\b[Tt]he user(?:'s|’s)?\b/g, (m) => (/['’]s$/i.test(m) ? "まろの" : "まろ"))
    .replace(/\bUsers\b/g, "まろたち")
    .replace(/\bUser(?:'s|’s)?\b/g, (m) => (/['’]s$/.test(m) ? "まろの" : "まろ"));
}

export function formatGenMeta(meta) {
  if (!meta) return "";
  const parts = [];
  if (meta.elapsed_ms != null) parts.push(`${(meta.elapsed_ms / 1000).toFixed(1)}s`);
  if (meta.model) parts.push(meta.model);
  if (meta.total_tokens) parts.push(`tok ${meta.total_tokens}`);
  else if (meta.tokens_estimated && (meta.prompt_tokens || meta.completion_tokens)) {
    parts.push(`≈${(meta.prompt_tokens || 0) + (meta.completion_tokens || 0)}`);
  }
  return parts.join(" · ");
}
