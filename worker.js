/**
 * Cloudflare Worker 単体版。
 * - 静的ファイルは Pages / assets 側に任せるか、この Worker を /v1 プロキシ専用にする
 * - wrangler: このファイルをデプロイすると https://xxx.workers.dev/v1/* が api.x.ai に飛ぶ
 */
export default {
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(req) });
    }
    if (!url.pathname.startsWith("/v1")) {
      return new Response("Grok Kotatsu proxy. Use /v1/chat/completions", {
        status: 404,
        headers: cors(req),
      });
    }
    const target = "https://api.x.ai" + url.pathname + url.search;
    const headers = new Headers(req.headers);
    headers.delete("host");
    const init = { method: req.method, headers };
    if (req.method !== "GET" && req.method !== "HEAD") {
      init.body = req.body;
      init.duplex = "half";
    }
    const res = await fetch(target, init);
    const out = new Headers(res.headers);
    const c = cors(req);
    for (const [k, v] of c) out.set(k, v);
    return new Response(res.body, { status: res.status, headers: out });
  },
};

function cors(req) {
  const origin = req.headers.get("Origin") || "*";
  return new Headers({
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
  });
}
