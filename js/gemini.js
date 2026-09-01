/** Gemini generateContent。ブラウザ直。圧縮専用。 */

export function sanitizeGeminiKey(raw) {
  return String(raw || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

const SAFETY_NONE = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
];

const REFUSAL_RE =
  /i\s*(can('t|not)|won'?t)\s+(help|assist|provide)|against (google'?s )?(policies|guidelines)|community guidelines|お手伝いできません|対応できません|生成できません|リクエストに(は)?お応えできません|安全上の理由|コンテンツポリシー/i;

function candidateText(json) {
  const parts = json?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function finishReason(json) {
  return String(json?.candidates?.[0]?.finishReason || json?.promptFeedback?.blockReason || "");
}

export function isGeminiCensored(json, text) {
  const block = json?.promptFeedback?.blockReason;
  if (block && block !== "BLOCK_REASON_UNSPECIFIED") return true;
  const fr = finishReason(json).toUpperCase();
  if (fr && ["SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "OTHER"].includes(fr)) return true;
  if (!json?.candidates?.length) return true;
  const t = String(text || "").trim();
  if (!t) return true;
  if (REFUSAL_RE.test(t) && t.length < 800) return true;
  return false;
}

async function readGeminiError(res) {
  let detail = `${res.status} ${res.statusText}`;
  try {
    const j = await res.json();
    detail = j.error?.message || j.error?.status || JSON.stringify(j);
  } catch {
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
  }
  return typeof detail === "string" ? detail : JSON.stringify(detail);
}

function buildBody(prompt, systemInstruction, { thinking = true } = {}) {
  const generationConfig = {
    temperature: 0.2,
    maxOutputTokens: 2048,
  };
  if (thinking) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig,
    safetySettings: SAFETY_NONE,
  };
  if (systemInstruction) {
    body.systemInstruction = { parts: [{ text: systemInstruction }] };
  }
  return body;
}

async function postGenerate(key, model, body, signal) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const err = new Error(await readGeminiError(res));
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const LITE_FALLBACKS = ["gemini-2.5-flash-lite", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];

export async function geminiGenerate(apiKey, { model, prompt, systemInstruction, signal } = {}) {
  const key = sanitizeGeminiKey(apiKey);
  if (!key) throw new Error("Gemini APIキーが未設定だよ。⚙ の進行メモリ欄へ。");
  const tried = [];
  const queue = [model, ...LITE_FALLBACKS].filter((id, i, arr) => id && arr.indexOf(id) === i);

  let lastErr = null;
  for (const id of queue) {
    tried.push(id);
    for (const thinking of [true, false]) {
      try {
        const json = await postGenerate(key, id, buildBody(prompt, systemInstruction, { thinking }), signal);
        const text = candidateText(json);
        return { text, json, model: id, censored: isGeminiCensored(json, text) };
      } catch (e) {
        lastErr = e;
        const msg = String(e.message || e);
        const status = e.status;
        const retryable404 = status === 404 || /not found|NOT_FOUND/i.test(msg);
        const retryThinking = thinking && (status === 400 || /thinkingConfig|unknown name|invalid/i.test(msg));
        if (retryThinking) continue;
        if (retryable404) break;
        throw e;
      }
    }
  }
  throw lastErr || new Error(`Gemini モデルが見つからない: ${tried.join(", ")}`);
}
