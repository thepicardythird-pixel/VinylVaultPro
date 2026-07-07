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
    return res.status(200).send("ok — proxy v3 (clean-headers)");
  }

  // Discogs authenticates via a ?token= query param on the target URL, and that
  // is exactly how the app sends it. LEAVE IT ON THE URL. Do NOT move it to an
  // `Authorization: Discogs token=` header — Discogs does not honor that form
  // through this proxy and bounces the call to its website 404 (HTML).
  let targetUrl = u;

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
    // Browser-style UA: Discogs serves its website 404 to some non-browser UAs on
    // authenticated endpoints, even though public/cached endpoints answer fine.
    "User-Agent": "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36",
    "Accept": "application/json",
  };

  // eBay / other Bearer-auth APIs send a real Authorization header — forward it
  // verbatim and don't touch the URL.
  const incomingAuth = req.headers["authorization"];
  if (incomingAuth) {
    headers["Authorization"] = incomingAuth;
  } else if (token && !/[?&]token=/.test(targetUrl)) {
    // Discogs token passed as a separate &token= proxy param (e.g. the in-app
    // "Test Discogs Connection" screen) with no token already on the URL:
    // put it on the target URL, since that's the only form Discogs accepts.
    try {
      const p = new URL(targetUrl);
      p.searchParams.set("token", token);
      targetUrl = p.toString();
    } catch (e) {
      targetUrl += (targetUrl.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
    }
  }

  // Forward ONLY eBay's marketplace header. Do NOT blanket-forward all x-* headers:
  // Vercel injects x-forwarded-for / x-forwarded-host / x-vercel-* on every request,
  // and leaking those to Discogs makes it 404 authenticated (origin-hitting) calls,
  // while cached public calls slip through untouched.
  for (const [key, val] of Object.entries(req.headers)) {
    if (key.toLowerCase().startsWith("x-ebay-") && val) {
      headers[key] = val;
    }
  }

  // Diagnostic: ?debug=1 performs the real Discogs call from the server and
  // reports exactly what came back (status, content-type, body snippet) plus the
  // User-Agent used — so we can see whether the server-side call itself is blocked.
  if (req.query.debug === "1") {
    let upstreamStatus = null, upstreamCT = null, upstreamSnippet = null, fetchErr = null, upstreamServer = null, upstreamCfRay = null;
    try {
      const up = await fetch(targetUrl, { method: "GET", headers });
      upstreamStatus = up.status;
      upstreamCT = up.headers.get("Content-Type") || null;
      upstreamServer = up.headers.get("Server") || null;
      upstreamCfRay = up.headers.get("CF-Ray") || null;
      upstreamSnippet = (await up.text()).replace(/\s+/g, " ").trim().slice(0, 220);
    } catch (e) {
      fetchErr = String((e && e.message) || e);
    }
    res.setHeader("Content-Type", "application/json");
    return res.status(200).json({
      version: "v3",
      userAgentSent: headers["User-Agent"],
      requestHeaderKeysSent: Object.keys(headers),
      finalTargetUrl: targetUrl,
      tokenIsOnFinalUrl: /[?&]token=/.test(targetUrl),
      upstreamStatus,
      upstreamContentType: upstreamCT,
      upstreamServer: upstreamServer,
      upstreamCfRay: upstreamCfRay,
      upstreamBodySnippet: upstreamSnippet,
      fetchError: fetchErr,
    });
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

