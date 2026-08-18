/** Cloudflare Pages Function: /v1/* → https://api.x.ai/v1/* */

const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

export async function onRequest(context) {
  const req = context.request;
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(req) });
  }
  const url = new URL(req.url);
  const target = new URL("https://api.x.ai" + url.pathname + url.search);
  const headers = new Headers();
  for (const [k, v] of req.headers) {
    if (!HOP.has(k.toLowerCase())) headers.set(k, v);
  }
  const init = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req.body;
    init.duplex = "half";
  }
  const res = await fetch(target, init);
  const out = new Headers(res.headers);
  const corsHeaders = cors(req);
  for (const [k, v] of corsHeaders) out.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}

function cors(req) {
  const origin = req.headers.get("Origin") || "*";
  return new Headers({
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Access-Control-Allow-Credentials": "true",
  });
}
