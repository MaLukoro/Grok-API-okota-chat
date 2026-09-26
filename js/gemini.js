/** Gemini 圧縮クライアント。本体の Grok とは別。失敗したら呼び出し側が Grok に落とす。 */

function hostHasLocalProxy() {
  const h = location.hostname || "";
  if (h === "localhost" || h === "127.0.0.1") return true;
  if (h.endsWith(".pages.dev") || h.endsWith(".workers.dev")) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return true;
  return false;
}

export const GEMINI_COMPRESS_MODELS = [
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash-lite",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash-lite",
];

// CIVIC_INTEGRITY は廃止済み。載せると 3.x が 400 を返す。
const SAFETY = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
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
  if (/safetySettings|harm_category|civic/i.test(m)) return false;
  return /blocked|PROHIBITED|BLOCKLIST|finishReason|\bSAFETY\b/i.test(m);
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
  const text = parts
    .map((p) => (p?.thought ? "" : typeof p?.text === "string" ? p.text : ""))
    .join("");
  return text.trim();
}

function isGemini3(model) {
  return /gemini-3(?:\.|\b)/.test(String(model || ""));
}

/** 3.x に thinkingBudget: 0 を渡すと 400。レベルは minimal。2.5 は考えないのが既定。 */
function generationConfigs(model, maxOutputTokens) {
  const bare = { temperature: 0.2, maxOutputTokens };
  if (isGemini3(model)) {
    return [{ ...bare, thinkingConfig: { thinkingLevel: "minimal" } }, bare];
  }
  return [bare, { ...bare, thinkingConfig: { thinkingBudget: 0 } }];
}

function isNotFound(err) {
  return err?.status === 404 || /not found|NOT_FOUND/i.test(String(err?.message || ""));
}

function isThinkingReject(err) {
  return /thinking/i.test(String(err?.message || ""));
}

function isSafetySettingReject(err) {
  return /safetySettings|harm_category|civic|threshold/i.test(String(err?.message || ""));
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
  const msg = String(detail);
  if (!/safetySettings|harm_category|civic|threshold/i.test(msg) && /blocked|prohibited/i.test(msg)) {
    err.code = "SAFETY";
  }
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

export async function geminiGenerateText(settings, prompt, { models, maxOutputTokens = 2048 } = {}) {
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
  const outTok = Math.max(256, Number(maxOutputTokens) || 2048);

  let lastErr = null;
  for (const model of list) {
    const urls = modelUrls(settings, model, key);
    const configs = generationConfigs(model, outTok);
    let skipModel = false;
    for (const url of urls) {
      if (skipModel) break;
      for (const generationConfig of configs) {
        const withSafety = {
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig,
          safetySettings: SAFETY,
        };
        const bareSafety = {
          contents: withSafety.contents,
          generationConfig,
        };
        const bodies = [withSafety];
        for (let bi = 0; bi < bodies.length; bi++) {
          try {
            let json;
            try {
              json = await postGenerate(url, key, bodies[bi]);
            } catch (e) {
              if ((e.status === 503 || e.status === 429) && !e.retried) {
                await new Promise((r) => setTimeout(r, 500));
                json = await postGenerate(url, key, bodies[bi]);
              } else {
                throw e;
              }
            }
            const text = extractText(json);
            if (!text) {
              lastErr = new Error(`${model}: Geminiの出力が空`);
              continue;
            }
            return { text, model };
          } catch (e) {
            lastErr = e;
            if (e.code === "SAFETY") throw e;
            if (isNotFound(e)) {
              skipModel = true;
              break;
            }
            if (e.status === 400 && isSafetySettingReject(e) && bodies[bi].safetySettings) {
              bodies.push(bareSafety);
              continue;
            }
            if (e.status === 400 && isThinkingReject(e)) continue;
            break;
          }
        }
        if (skipModel) break;
      }
    }
  }
  throw lastErr || new Error("Gemini圧縮に失敗");
}
