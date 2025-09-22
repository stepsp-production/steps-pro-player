// Cloudflare Worker: HLS Proxy with manifest rewriting
// - Uses ORIGIN_BASE (Env var) as upstream, e.g. "https://46.152.17.35"
// - Proxies /hls/*, preserves Range headers, streams segments
// - Rewrites .m3u8 to keep all URIs through this proxy path (/hls/...)
//
// Deploy with: wrangler deploy
// Bind ORIGIN_BASE in wrangler.toml (vars) or via dashboard

const TAGS = [
  "EXT-X-KEY",
  "EXT-X-SESSION-KEY",
  "EXT-X-MAP",
  "EXT-X-MEDIA",
  "EXT-X-I-FRAME-STREAM-INF",
  "EXT-X-SESSION-DATA",
];
const TAGS_RE = new RegExp(`^#(?:${TAGS.join("|")}):`, "i");

// Turn a ref (relative/absolute) into /hls/ path on this same site
function refToProxy(ref, baseAbsUrl) {
  try {
    const abs = new URL(ref, baseAbsUrl); // resolve relative
    let p = abs.pathname.replace(/^\/hls/i, ""); // avoid double /hls
    return `/hls${p}${abs.search || ""}`;
  } catch {
    if (typeof ref === "string" && ref.startsWith("/")) {
      const p = ref.replace(/^\/hls/i, "");
      return `/hls${p}`;
    }
    return ref;
  }
}

function rewriteManifest(text, baseAbsUrl) {
  return text
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (TAGS_RE.test(t)) {
        return line.replace(/URI="([^"]+)"/gi, (_m, uri) => `URI="${refToProxy(uri, baseAbsUrl)}"`);
      }
      if (!t || t.startsWith("#")) return line;
      return refToProxy(t, baseAbsUrl);
    })
    .join("\n");
}

function isM3U8(pathname) { return /\.m3u8(\?.*)?$/i.test(pathname); }
function isTS(pathname)   { return /\.ts(\?.*)?$/i.test(pathname); }
function isM4S(pathname)  { return /\.m4s(\?.*)?$/i.test(pathname); }
function isMP4(pathname)  { return /\.mp4(\?.*)?$/i.test(pathname); }
function isKEY(pathname)  { return /\.key(\?.*)?$/i.test(pathname); }

function mimeFor(pathname) {
  if (isM3U8(pathname)) return "application/vnd.apple.mpegurl";
  if (isTS(pathname))   return "video/mp2t";
  if (isM4S(pathname))  return "video/iso.segment";
  if (isMP4(pathname))  return "video/mp4";
  if (isKEY(pathname))  return "application/octet-stream";
  return "application/octet-stream";
}

async function fetchUpstream(u, req, env, ctx) {
  // we call ORIGIN_BASE + /hls/... in your project; here /hls/* → ORIGIN_BASE + same path
  const origin = new URL(env.ORIGIN_BASE);
  const inUrl = new URL(req.url);
  const upstream = new URL(inUrl.pathname + inUrl.search, origin); // same path/query on ORIGIN_BASE

  // Build headers: avoid passing Origin/Referer; force identity encoding for easy rewrite
  const hdrs = new Headers();
  hdrs.set("Host", origin.host);
  hdrs.set("Connection", "keep-alive");
  hdrs.set("Accept", "*/*");
  hdrs.set("Accept-Encoding", "identity");
  hdrs.set("User-Agent", req.headers.get("user-agent") || "Mozilla/5.0");
  const range = req.headers.get("range");
  if (range) hdrs.set("Range", range);

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort("proxy timeout"), Number(env.PROXY_TIMEOUT_MS || 15000));
  let res;
  try {
    res = await fetch(upstream, {
      method: "GET",
      headers: hdrs,
      redirect: "follow",
      signal: controller.signal,
      // cf options can help with streaming
      cf: { cacheEverything: false, cacheTtl: 0 },
    });
  } finally {
    clearTimeout(id);
  }
  return { res, finalUrl: res.url };
}

function withBasicHeaders(init, pathname) {
  const h = new Headers(init.headers || {});
  const ct = mimeFor(pathname);
  if (isM3U8(pathname)) {
    h.set("Content-Type", ct);
    h.set("Cache-Control", "no-store, must-revalidate");
  } else if (isTS(pathname) || isM4S(pathname) || isMP4(pathname)) {
    // let upstream content-type/accept-ranges flow, but set if missing
    if (!h.has("Content-Type")) h.set("Content-Type", ct);
    if (!h.has("Cache-Control")) h.set("Cache-Control", "public, max-age=15, immutable");
  } else if (isKEY(pathname)) {
    h.set("Content-Type", ct);
    h.set("Cache-Control", "no-store");
  }
  // CORS not required if Netlify rewrites internally; safe defaults anyway:
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Expose-Headers", "Accept-Ranges, Content-Range, Content-Length");
  return h;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    // healthcheck
    if (url.pathname === "/health") {
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    }

    // Only proxy under /hls/*
    if (!url.pathname.startsWith("/hls/")) {
      return new Response("Not Found", { status: 404 });
    }

    // Upstream fetch
    const { res, finalUrl } = await fetchUpstream(url, req, env, ctx);

    // If upstream error, bubble it
    if (res.status >= 400) {
      return new Response(`Upstream error ${res.status}`, {
        status: res.status,
        headers: withBasicHeaders({ headers: { "content-type": "text/plain" } }, url.pathname),
      });
    }

    // Manifests: read as text, rewrite, return
    if (isM3U8(url.pathname)) {
      const raw = await res.text();
      const out = rewriteManifest(raw, finalUrl);

      return new Response(out, {
        status: 200,
        headers: withBasicHeaders({ headers: { "content-type": "application/vnd.apple.mpegurl" } }, url.pathname),
      });
    }

    // Segments/keys: stream through as-is (preserve range & accept-ranges if provided)
    const h = withBasicHeaders({ headers: {} }, url.pathname);
    const ct = res.headers.get("content-type");
    const ar = res.headers.get("accept-ranges");
    const cr = res.headers.get("content-range");
    const cl = res.headers.get("content-length");
    if (ct) h.set("Content-Type", ct);
    if (ar) h.set("Accept-Ranges", ar);
    if (cr) h.set("Content-Range", cr);
    if (cl) h.set("Content-Length", cl);

    return new Response(res.body, { status: res.status, headers: h });
  },
};
