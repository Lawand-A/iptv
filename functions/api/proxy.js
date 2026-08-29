/* Cloudflare Pages Function — CORS proxy for IPTV provider requests.
   Usage: /api/proxy?url=<encoded-target-url>
   The function fetches the target URL server-side (no CORS restrictions)
   and returns the response with permissive CORS headers so the browser
   can read it. Only GET requests are proxied. */
export async function onRequestGet(context) {
  var url = new URL(context.request.url);
  var target = url.searchParams.get("url");

  if (!target) {
    return new Response(JSON.stringify({ error: "Missing ?url= parameter" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  /* Validate the target URL to prevent open-proxy abuse: only http/https. */
  try {
    var parsed = new URL(target);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return new Response(JSON.stringify({ error: "Only http/https URLs are allowed" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid URL" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  try {
    /* Forward the request server-side where CORS does not apply.
       Use no-referrer behaviour to match the client-side fetch. */
    var resp = await fetch(target, {
      headers: { "User-Agent": "VLC/3.0.21 LibVLC/3.0.21" },
      redirect: "follow",
      cf: { cacheTtl: 0 }
    });

    /* Build a new response with CORS headers so the browser can read it. */
    var headers = new Headers();
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "*");
    headers.set("Content-Type", resp.headers.get("Content-Type") || "application/octet-stream");

    /* If the target returned a Content-Length, forward it. */
    var cl = resp.headers.get("Content-Length");
    if (cl) headers.set("Content-Length", cl);

    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: headers
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Proxy fetch failed: " + String(err.message || err) }), {
      status: 502,
      headers: { "Content-Type": "application/json" }
    });
  }
}

/* Handle CORS preflight. */
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400"
    }
  });
}
