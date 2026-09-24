/** Gemini 圧縮クライアント。本体の Grok とは別。失敗したら呼び出し側が Grok に落とす。 */

function hostHasLocalProxy() {
  const h = location.hostname || "";
  if (h === "localhost" || h === "127.0.0.1") return true;
  if (h.endsWith(".pages.dev") || h.endsWith(".workers.dev")) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return true;
  return false;
}

export const GEMINI_COMPRESS_MODELS = [
  "gemini-2.5-flash-lite",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-2.0-flash-lite",
];

const SAFETY = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
  "HARM_CATEGORY_CIVIC_INTEGRITY",
].map((category) => ({ category, threshold: "BLOCK_NONE" }));

export function sanitizeGeminiKey(raw) {
  return String(raw || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

export function isGeminiSafetyError(err) {
  if (!err) return false;
  if (err.code === "SAFETY") return true;
  const m = String(err.message || err);
  return /blocked|SAFETY|PROHIBITED|BLOCKLIST|finishReason/i.test(m);
}

function geminiProxyBase(settings) {
  const custom = (settings?.proxyBase || "").trim().replace(/\/+$/, "");
  if (custom) {
    if (custom.endsWith("/v1")) return `${custom.slice(0, -3)}/gemini`;
    return `${custom}/gemini`;
  }
  if (hostHasLocalProxy()) return `${location.origin}/gemini`;
  return "";
}

function extractText(json) {
  const block = json?.promptFeedback?.blockReason;
  if (block && block !== "BLOCK_REASON_UNSPECIFIED" && block !== "NONE") {
    const err = new Error(`Gemini blocked: ${block}`);
    err.code = "SAFETY";
    throw err;
  }
  const c = json?.candidates?.[0];
  const fr = c?.finishReason;
  if (fr === "SAFETY" || fr === "PROHIBITED_CONTENT" || fr === "BLOCKLIST" || fr === "SPII") {
    const err = new Error(`Gemini blocked: ${fr}`);
    err.code = "SAFETY";
    throw err;
  }
  const parts = c?.content?.parts || [];
  const text = parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
  return text.trim();
}

async function readError(res) {
  let detail = `${res.status} ${res.statusText}`;
  try {
    const j = await res.json();
    detail = j.error?.message || j.message || JSON.stringify(j);
  } catch {
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
  }
  const err = new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  err.status = res.status;
  if (/safety|blocked|prohibited/i.test(String(detail))) err.code = "SAFETY";
  return err;
}

async function postGenerate(url, key, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": key,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readError(res);
  return res.json();
}

function modelUrls(settings, model, key) {
  const q = `key=${encodeURIComponent(key)}`;
  const path = `/v1beta/models/${encodeURIComponent(model)}:generateContent?${q}`;
  const urls = [`https://generativelanguage.googleapis.com${path}`];
  const proxy = geminiProxyBase(settings);
  if (proxy) urls.push(`${proxy}${path}`);
  return urls;
}

export async function geminiGenerateText(settings, prompt, { models } = {}) {
  const key = sanitizeGeminiKey(settings?.geminiApiKey);
  if (!key) {
    const err = new Error("Geminiキー未設定");
    err.code = "NO_KEY";
    throw err;
  }
  const preferred = settings?.geminiCompressModel;
  const list = [];
  if (preferred) list.push(preferred);
  for (const id of models || GEMINI_COMPRESS_MODELS) {
    if (!list.includes(id)) list.push(id);
  }

  const payload = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 2048,
      thinkingConfig: { thinkingBudget: 0 },
    },
    safetySettings: SAFETY,
  };
  const payloadNoThink = {
    ...payload,
    generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
  };

  let lastErr = null;
  for (const model of list) {
    const urls = modelUrls(settings, model, key);
    for (const url of urls) {
      for (const body of [payload, payloadNoThink]) {
        try {
          const json = await postGenerate(url, key, body);
          const text = extractText(json);
          if (!text) {
            lastErr = new Error("Geminiの出力が空");
            continue;
          }
          return { text, model };
        } catch (e) {
          lastErr = e;
          if (e.status === 404 || /not found|NOT_FOUND/i.test(String(e.message || ""))) break;
          if (e.code === "SAFETY") throw e;
          if (/thinkingConfig|Unknown name/i.test(String(e.message || ""))) continue;
          break;
        }
      }
    }
  }
  throw lastErr || new Error("Gemini圧縮に失敗");
}
