export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    // صحّة
    if (url.pathname === "/health") {
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    }

    // لا نعمل إلا تحت /hls/*
    if (!url.pathname.startsWith("/hls/")) {
      return new Response("Not Found", { status: 404 });
    }

    // الإعدادات
    const ORIGIN_BASE = env?.ORIGIN_BASE || "https://46.152.17.35";
    const PROXY_TIMEOUT_MS = Number(env?.PROXY_TIMEOUT_MS || 15000);

    const isM3U8 = p => /\.m3u8(\?.*)?$/i.test(p);
    const isTS   = p => /\.ts(\?.*)?$/i.test(p);
    const isM4S  = p => /\.m4s(\?.*)?$/i.test(p);
    const isMP4  = p => /\.mp4(\?.*)?$/i.test(p);
    const isKEY  = p => /\.key(\?.*)?$/i.test(p);

    function mimeFor(p) {
      if (isM3U8(p)) return "application/vnd.apple.mpegurl";
      if (isTS(p))   return "video/mp2t";
      if (isM4S(p))  return "video/iso.segment";
      if (isMP4(p))  return "video/mp4";
      if (isKEY(p))  return "application/octet-stream";
      return "application/octet-stream";
    }

    const TAGS = [
      "EXT-X-KEY","EXT-X-SESSION-KEY","EXT-X-MAP",
      "EXT-X-MEDIA","EXT-X-I-FRAME-STREAM-INF","EXT-X-SESSION-DATA",
    ];
    const TAGS_RE = new RegExp(`^#(?:${TAGS.join("|")}):`, "i");

    function refToProxy(ref, baseAbsUrl) {
      try {
        const abs = new URL(ref, baseAbsUrl);
        let p = abs.pathname.replace(/^\/hls/i, "");
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
        .map(line => {
          const t = line.trim();
          if (TAGS_RE.test(t)) {
            return line.replace(/URI="([^"]+)"/gi, (_m, uri) => `URI="${refToProxy(uri, baseAbsUrl)}"`);
          }
          if (!t || t.startsWith("#")) return line;
          return refToProxy(t, baseAbsUrl);
        })
        .join("\n");
    }

    function withBasicHeaders(init, pathname) {
      const h = new Headers(init.headers || {});
      const ct = mimeFor(pathname);
      if (isM3U8(pathname)) {
        h.set("Content-Type", ct);
        h.set("Cache-Control", "no-store, must-revalidate");
      } else if (isTS(pathname) || isM4S(pathname) || isMP4(pathname)) {
        if (!h.has("Content-Type")) h.set("Content-Type", ct);
        if (!h.has("Cache-Control")) h.set("Cache-Control", "public, max-age=15, immutable");
      } else if (isKEY(pathname)) {
        h.set("Content-Type", ct);
        h.set("Cache-Control", "no-store");
      }
      // CORS آمن حتى لو لم يلزم مع نتلايف
      h.set("Access-Control-Allow-Origin", "*");
      h.set("Access-Control-Expose-Headers", "Accept-Ranges, Content-Range, Content-Length");
      return h;
    }

    async function fetchUpstream(req) {
      const origin = new URL(ORIGIN_BASE);
      const inUrl  = new URL(req.url);
      const upstream = new URL(inUrl.pathname + inUrl.search, origin);

      const hdrs = new Headers();
      hdrs.set("Host", origin.host);
      hdrs.set("Connection", "keep-alive");
      hdrs.set("Accept", "*/*");
      hdrs.set("Accept-Encoding", "identity");
      hdrs.set("User-Agent", req.headers.get("user-agent") || "Mozilla/5.0");
      const r = req.headers.get("range");
      if (r) hdrs.set("Range", r);

      const controller = new AbortController();
      const id = setTimeout(() => controller.abort("proxy timeout"), PROXY_TIMEOUT_MS);
      let resp;
      try {
        resp = await fetch(upstream, {
          method: "GET",
          headers: hdrs,
          redirect: "follow",
          signal: controller.signal,
          cf: { cacheEverything: false, cacheTtl: 0 },
        });
      } finally { clearTimeout(id); }
      return { resp, finalUrl: resp.url };
    }

    const { resp, finalUrl } = await fetchUpstream(req);

    if (resp.status >= 400) {
      return new Response(`Upstream error ${resp.status}`, {
        status: resp.status,
        headers: withBasicHeaders({ headers: { "content-type": "text/plain" } }, url.pathname),
      });
    }

    if (isM3U8(url.pathname)) {
      const raw = await resp.text();
      const out = rewriteManifest(raw, finalUrl);
      return new Response(out, {
        status: 200,
        headers: withBasicHeaders({ headers: { "content-type": "application/vnd.apple.mpegurl" } }, url.pathname),
      });
    }

    // المقاطع/المفاتيح: مرّر كما هي مع رؤوس النطاق
    const h = withBasicHeaders({ headers: {} }, url.pathname);
    const ct = resp.headers.get("content-type");
    const ar = resp.headers.get("accept-ranges");
    const cr = resp.headers.get("content-range");
    const cl = resp.headers.get("content-length");
    if (ct) h.set("Content-Type", ct);
    if (ar) h.set("Accept-Ranges", ar);
    if (cr) h.set("Content-Range", cr);
    if (cl) h.set("Content-Length", cl);

    return new Response(resp.body, { status: resp.status, headers: h });
  },
};
``
