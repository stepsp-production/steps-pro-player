// worker/src/index.js
const TAGS = [
  "EXT-X-KEY","EXT-X-SESSION-KEY","EXT-X-MAP",
  "EXT-X-MEDIA","EXT-X-I-FRAME-STREAM-INF","EXT-X-SESSION-DATA",
];
const TAGS_RE = new RegExp(`^#(?:${TAGS.join("|")}):`, "i");

function isM3U8(p){ return /\.m3u8(\?.*)?$/i.test(p); }
function isTS(p){ return /\.ts(\?.*)?$/i.test(p); }
function isM4S(p){ return /\.m4s(\?.*)?$/i.test(p); }
function isMP4(p){ return /\.mp4(\?.*)?$/i.test(p); }
function isKEY(p){ return /\.key(\?.*)?$/i.test(p); }
function isSegment(p){ return isTS(p)||isM4S(p)||isMP4(p); }

function mimeFor(p){
  if (isM3U8(p)) return "application/vnd.apple.mpegurl";
  if (isTS(p))   return "video/mp2t";
  if (isM4S(p))  return "video/iso.segment";
  if (isMP4(p))  return "video/mp4";
  if (isKEY(p))  return "application/octet-stream";
  return "application/octet-stream";
}

function refToProxy(ref, baseAbsUrl){
  try{
    const abs = new URL(ref, baseAbsUrl);
    let p = abs.pathname.replace(/^\/hls/i, "");
    return `/hls${p}${abs.search || ""}`;
  }catch{
    if (typeof ref === "string" && ref.startsWith("/")){
      const p = ref.replace(/^\/hls/i, "");
      return `/hls${p}`;
    }
    return ref;
  }
}

function rewriteManifest(text, baseAbsUrl){
  return text.split("\n").map(line=>{
    const t = line.trim();
    if (TAGS_RE.test(t)){
      return line.replace(/URI="([^"]+)"/gi, (_m, uri)=> `URI="${refToProxy(uri, baseAbsUrl)}"`);
    }
    if (!t || t.startsWith("#")) return line;
    return refToProxy(t, baseAbsUrl);
  }).join("\n");
}

function basicHeaders(init, pathname){
  const h = new Headers(init.headers || {});
  const ct = mimeFor(pathname);

  if (isM3U8(pathname)){
    h.set("Content-Type", ct);
    h.set("Cache-Control", "no-store, must-revalidate");
  } else if (isSegment(pathname)){
    if (!h.has("Content-Type")) h.set("Content-Type", ct);
    if (!h.has("Cache-Control")){
      h.set("Cache-Control", "public, max-age=20, immutable, stale-while-revalidate=15");
    }
  } else if (isKEY(pathname)){
    h.set("Content-Type", ct);
    h.set("Cache-Control", "no-store");
  } else {
    if (!h.has("Content-Type")) h.set("Content-Type", ct);
    h.set("Cache-Control", "public, max-age=60");
  }

  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Expose-Headers", "Accept-Ranges, Content-Range, Content-Length");
  return h;
}

async function fetchUpstream(req, env){
  const originBase = new URL(env.ORIGIN_BASE || "http://46.152.17.35");
  const inUrl = new URL(req.url);
  const upstream = new URL(inUrl.pathname + inUrl.search, originBase);

  const hdrs = new Headers();
  hdrs.set("Accept", "*/*");
  hdrs.set("User-Agent", req.headers.get("user-agent") || "Mozilla/5.0");
  const range = req.headers.get("range");
  if (range) hdrs.set("Range", range);

  const controller = new AbortController();
  const to = Number(env.PROXY_TIMEOUT_MS || 15000);
  const id = setTimeout(()=>controller.abort("proxy timeout"), to);

  const pathname = inUrl.pathname;
  const isSeg = isSegment(pathname);
  const isList = isM3U8(pathname);

  let res;
  try{
    res = await fetch(upstream, {
      method: "GET",
      headers: hdrs,
      redirect: "follow",
      signal: controller.signal,
      cf: isList
        ? { cacheEverything: false, cacheTtl: 0 }
        : { cacheEverything: true, cacheTtl: 20, cacheTtlByStatus: { "200-299": 20, "404": 1, "500-599": 0 } },
    });
  } finally { clearTimeout(id); }

  return { res, finalUrl: res.url };
}

export default {
  async fetch(req, env){
    const url = new URL(req.url);

    if (url.pathname === "/health"){
      return new Response("ok", { status: 200, headers: { "content-type":"text/plain" } });
    }
    if (!url.pathname.startsWith("/hls/")){
      return new Response("Not Found", { status: 404 });
    }

    let upstream;
    try{
      upstream = await fetchUpstream(req, env);
    }catch(e){
      return new Response("Upstream fetch failed: "+String(e), {
        status: 502,
        headers: { "content-type":"text/plain", "Access-Control-Allow-Origin":"*" }
      });
    }

    const { res, finalUrl } = upstream;

    if (res.status >= 400){
      const h = basicHeaders({ headers: { "content-type":"text/plain" } }, url.pathname);
      return new Response(`Upstream error ${res.status}`, { status: res.status, headers: h });
    }

    if (isM3U8(url.pathname)){
      const raw = await res.text();
      const out = rewriteManifest(raw, finalUrl);
      return new Response(out, {
        status: 200,
        headers: basicHeaders({ headers: { "content-type":"application/vnd.apple.mpegurl" } }, url.pathname),
      });
    }

    const h = basicHeaders({ headers: {} }, url.pathname);
    for (const k of ["content-type","accept-ranges","content-range","content-length","etag","last-modified"]) {
      const v = res.headers.get(k);
      if (v) h.set(k[0].toUpperCase()+k.slice(1), v);
    }
    return new Response(res.body, { status: res.status, headers: h });
  }
};
