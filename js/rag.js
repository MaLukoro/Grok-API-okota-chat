/** ブラウザ向け簡易 TF-IDF RAG（既存 Local LLM Studio と同じ考え方）。 */

const TOKEN_RE = /[A-Za-z0-9_]+|[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]+/g;

export function tokenize(text) {
  const src = String(text || "").toLowerCase();
  const toks = [];
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(src))) {
    const t = m[0];
    if (/^[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]+$/.test(t)) {
      if (t.length === 1) toks.push(t);
      else {
        for (let i = 0; i < t.length; i++) toks.push(t[i]);
        for (let i = 0; i < t.length - 1; i++) toks.push(t.slice(i, i + 2));
      }
    } else {
      toks.push(t);
    }
  }
  return toks;
}

export function chunkText(text, { chunkSize = 800, overlap = 120, source = "" } = {}) {
  const src = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!src) return [];
  const chunks = [];
  const n = src.length;
  let start = 0;
  let idx = 0;
  while (start < n) {
    let end = Math.min(n, start + chunkSize);
    if (end < n) {
      const window = src.slice(start, end);
      const br = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf("。"), window.lastIndexOf(". "));
      if (br > chunkSize * 0.4) end = start + br + 1;
    }
    const piece = src.slice(start, end).trim();
    if (piece) {
      chunks.push({ id: `${source}:${idx}`, source, index: idx, text: piece });
      idx += 1;
    }
    if (end >= n) break;
    start = overlap < end ? end - overlap : end;
    if (start >= end) start = end;
  }
  return chunks;
}

function tf(tokens) {
  const c = new Map();
  for (const t of tokens) c.set(t, (c.get(t) || 0) + 1);
  const total = tokens.length || 1;
  const out = new Map();
  for (const [k, v] of c) out.set(k, v / total);
  return out;
}

export function buildIndex(chunks) {
  const docsTf = [];
  const df = new Map();
  for (const ch of chunks) {
    const t = tf(tokenize(ch.text || ""));
    docsTf.push(t);
    for (const k of t.keys()) df.set(k, (df.get(k) || 0) + 1);
  }
  const nDocs = Math.max(1, chunks.length);
  const idf = new Map();
  for (const [t, d] of df) idf.set(t, Math.log((1 + nDocs) / (1 + d)) + 1);
  const vectors = [];
  const norms = [];
  for (const tmap of docsTf) {
    const vec = new Map();
    let n2 = 0;
    for (const [k, v] of tmap) {
      const w = v * (idf.get(k) || 0);
      vec.set(k, w);
      n2 += w * w;
    }
    vectors.push(vec);
    norms.push(Math.sqrt(n2) || 1);
  }
  return { method: "tfidf", idf, vectors, norms, chunks };
}

function cosine(q, qn, d, dn) {
  if (!q.size || !d.size) return 0;
  let small = q;
  let big = d;
  if (q.size > d.size) {
    small = d;
    big = q;
  }
  let dot = 0;
  for (const [k, v] of small) {
    if (big.has(k)) dot += v * big.get(k);
  }
  return qn && dn ? dot / (qn * dn) : 0;
}

export function searchIndex(index, query, { topK = 5, minScore = 0.04, sources = null } = {}) {
  if (!index || !query) return [];
  let allowed = null;
  if (sources != null) {
    allowed = new Set(sources);
    if (!allowed.size) return [];
  }
  const qtf = tf(tokenize(query));
  const qvec = new Map();
  let qn2 = 0;
  for (const [k, v] of qtf) {
    const w = v * (index.idf.get(k) || 0);
    qvec.set(k, w);
    qn2 += w * w;
  }
  const qn = Math.sqrt(qn2) || 1;
  const scored = [];
  index.chunks.forEach((ch, i) => {
    if (allowed && !allowed.has(ch.source)) return;
    const score = cosine(qvec, qn, index.vectors[i], index.norms[i]);
    if (score >= minScore) scored.push({ ...ch, score });
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

export function retrieveFromFiles(files, query, { topK = 5, maxChars = 6000, perHitChars = 900, sources = null } = {}) {
  const selected =
    sources == null ? files : files.filter((f) => sources.includes(f.name));
  if (!selected.length) {
    return {
      context: "",
      hits: [],
      method: "tfidf",
      context_chars: 0,
      rag_enabled: sources != null && sources.length === 0 ? false : true,
      sources_filter: sources,
    };
  }
  const chunks = [];
  for (const f of selected) {
    chunks.push(...chunkText(f.text || "", { source: f.name }));
  }
  if (!chunks.length) {
    return { context: "", hits: [], method: "tfidf", context_chars: 0, rag_enabled: true, sources_filter: sources };
  }
  const index = buildIndex(chunks);
  let hits = searchIndex(index, query, { topK, sources: sources == null ? null : sources });
  // クエリが短すぎてヒットゼロなら、先頭チャンクを保険で入れる
  if (!hits.length) {
    hits = chunks.slice(0, Math.min(topK, chunks.length)).map((c, i) => ({ ...c, score: 0.01 * (topK - i) }));
  }
  const parts = [];
  let used = 0;
  const clipped = [];
  for (const h of hits) {
    if (used >= maxChars) break;
    let text = h.text || "";
    if (text.length > perHitChars) text = text.slice(0, perHitChars) + "…";
    if (used + text.length > maxChars) text = text.slice(0, Math.max(0, maxChars - used)) + "…";
    if (!text) continue;
    parts.push(`### ${h.source} #${h.index}\n${text}`);
    used += text.length;
    clipped.push({ source: h.source, index: h.index, score: h.score, chars: text.length });
  }
  const context = parts.length
    ? `# 参照資料（プロジェクトファイルから抜粋）\n会話の続きに必要な世界観・設定・過去ログだけを参照せよ。抜粋に無いことは推測で断定しないこと。\n\n${parts.join("\n\n")}`
    : "";
  return {
    context,
    hits: clipped,
    method: "tfidf",
    context_chars: context.length,
    rag_enabled: true,
    sources_filter: sources,
  };
}

export function ragMetaFrom(retrieved, { projectId, ragEnabled, sourcesFilter }) {
  const hits = retrieved?.hits || [];
  const sources = [];
  const seen = new Set();
  for (const h of hits) {
    if (h.source && !seen.has(h.source)) {
      seen.add(h.source);
      sources.push(h.source);
    }
  }
  return {
    project_id: projectId,
    hit_count: hits.length,
    sources,
    method: retrieved?.method || "tfidf",
    context_chars: retrieved?.context_chars || 0,
    rag_enabled: ragEnabled,
    sources_filter: sourcesFilter,
    sources_filter_count: sourcesFilter == null ? null : sourcesFilter.length,
  };
}
