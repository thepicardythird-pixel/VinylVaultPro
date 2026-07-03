// /api/proxy.js — Vercel serverless function
// Replaces worker.js (Cloudflare Worker). Same job: CORS-safe passthrough proxy
// for Discogs (GET + token) and eBay OAuth (POST + Basic auth + form body).
//
// Called the same way as before: /api/proxy?url=<target>&token=<optional>
// (Update _CF_WORKER in the HTML to point at your Vercel domain + /api/proxy)

module.exports = async function handler(req, res) {
 try {
  return await _handle(req, res);
 } catch (e) {
  try {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json");
    return res.status(500).json({ error: "proxy crashed: " + String(e && e.message || e) });
  } catch (e2) {
    return res.end();
  }
 }
};

async function _handle(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Max-Age", "86400");
    return res.status(204).end();
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  const u = req.query.url;
  const token = req.query.token; // optional: forwarded as Discogs Authorization header

  if (!u) {
    return res.status(200).send("ok");
  }

  // Strip ?token= from the target URL if present — send as a header instead
  let targetUrl = u;
  try {
    const parsed = new URL(u);
    if (parsed.searchParams.has("token")) {
      parsed.searchParams.delete("token");
      targetUrl = parsed.toString();
    }
  } catch (e) {}

  // POST passthrough — forwards this request's own Authorization/Content-Type headers
  // and body directly to the target. Needed for OAuth token exchanges (eBay, Discogs
  // OAuth1 request-token step) which require POST + real headers + a body.
  if (req.method === "POST") {
    const fwdHeaders = { "User-Agent": "VinylVaultPro/1.0 +https://vinylvaultpro.app" };
    const auth = req.headers["authorization"];
    const ctype = req.headers["content-type"];
    if (auth) fwdHeaders["Authorization"] = auth;
    if (ctype) fwdHeaders["Content-Type"] = ctype;

    try {
      // Vercel gives raw body as string/Buffer depending on content-type parsing;
      // req.body may already be parsed for form-urlencoded, so re-serialize safely.
      let bodyStr = "";
      if (typeof req.body === "string") {
        bodyStr = req.body;
      } else if (Buffer.isBuffer(req.body)) {
        bodyStr = req.body.toString("utf8");
      } else if (req.body && typeof req.body === "object") {
        bodyStr = new URLSearchParams(req.body).toString();
      }

      const upstream = await fetch(targetUrl, { method: "POST", headers: fwdHeaders, body: bodyStr });
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader("Content-Type", upstream.headers.get("Content-Type") || "application/json");
      return res.status(upstream.status).send(buf);
    } catch (e) {
      res.setHeader("Content-Type", "application/json");
      return res.status(502).json({ error: String(e) });
    }
  }

  // GET path — Discogs (token param) and eBay/other Bearer-auth APIs (real header)
  const headers = {
    "User-Agent": "VinylVaultPro/1.0 +https://vinylvaultpro.app",
    "Accept": "application/json",
  };

  // Prefer a real Authorization header sent on this request (e.g. eBay "Bearer ...")
  const incomingAuth = req.headers["authorization"];
  if (incomingAuth) {
    headers["Authorization"] = incomingAuth;
  } else {
    const tok = token || (() => {
      try { return new URL(u).searchParams.get("token"); } catch (e) { return null; }
    })();
    if (tok) {
      headers["Authorization"] = `Discogs token=${tok}`;
    }
  }

  // Forward any custom X-* headers verbatim (e.g. eBay's X-EBAY-C-MARKETPLACE-ID)
  for (const [key, val] of Object.entries(req.headers)) {
    if (key.toLowerCase().startsWith("x-") && val) {
      headers[key] = val;
    }
  }

  try {
    const upstream = await fetch(targetUrl, { method: "GET", headers });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader("Content-Type", upstream.headers.get("Content-Type") || "application/json");
    return res.status(upstream.status).send(buf);
  } catch (e) {
    res.setHeader("Content-Type", "application/json");
    return res.status(502).json({ error: String(e) });
  }
}
