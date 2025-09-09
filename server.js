import express from "express";
import morgan from "morgan";
import compression from "compression";
import cors from "cors";
import https from "https";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { URL } from "url";

// ===== CONFIG =====
const ORIGIN_BASE = process.env.ORIGIN_BASE || "http://46.152.116.98";
const PORT = process.env.PORT || 10000;
const ALLOW_INSECURE_TLS = String(process.env.ALLOW_INSECURE_TLS || "true")==="true";
const PROXY_TIMEOUT_MS = Number(process.env.PROXY_TIMEOUT_MS || 15000);
const MAX_REDIRECTS = Number(process.env.MAX_REDIRECTS || 5);
const DEBUG = String(process.env.DEBUG_HLS || "false")==="true";
// ===================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(morgan("tiny"));

app.use(compression({
  filter: (req,res)=> (!/\.(m3u8|ts|m4s|mp4|key)$/i.test(req.path) && compression.filter(req,res)),
}));
app.use(cors());
app.use(express.static(path.join(__dirname,"public")));

app.use((req,res,next)=>{
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Headers","*");
  if (/\.m3u8$/i.test(req.path)) {
    res.type("application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control","no-store, must-revalidate");
  } else if (/\.ts$/i.test(req.path)) {
    res.type("video/mp2t"); res.setHeader("Cache-Control","public, max-age=15, immutable");
  } else if (/\.m4s$/i.test(req.path)) {
    res.type("video/iso.segment"); res.setHeader("Cache-Control","public, max-age=15, immutable");
  } else if (/\.mp4$/i.test(req.path)) {
    res.type("video/mp4"); res.setHeader("Cache-Control","public, max-age=15, immutable");
  } else if (/\.key$/i.test(req.path)) {
    res.type("application/octet-stream"); res.setHeader("Cache-Control","no-store");
  }
  next();
});

// Keep-Alive agents
const keepAliveHttpAgent = new http.Agent({ keepAlive:true, maxSockets:128 });
const keepAliveHttpsAgent = new https.Agent({ keepAlive:true, maxSockets:128, rejectUnauthorized:!ALLOW_INSECURE_TLS });

function buildUpstreamHeaders(req){
  const h = {
    Host: new URL(ORIGIN_BASE).host,
    Connection: "keep-alive",
    Accept: "*/*",
    "Accept-Encoding": "identity",        // مهم: بدون gzip
    "User-Agent": req.headers["user-agent"] || "Mozilla/5.0",
  };
  if (req.headers.range) h.Range = req.headers.range;
  return h; // لا نمرر Origin/Referer/CF/X-Forwarded…
}

function requestOnce(urlStr, headers){
  const u = new URL(urlStr);
  const isHttps = u.protocol === "https:";
  const client = isHttps ? https : http;
  const agent  = isHttps ? keepAliveHttpsAgent : keepAliveHttpAgent;
  const opts = { method:"GET", headers, agent, timeout:PROXY_TIMEOUT_MS };
  return new Promise((resolve,reject)=>{
    const req = client.request(urlStr, opts, up=>resolve(up));
    req.on("timeout", ()=>req.destroy(new Error("proxy timeout")));
    req.on("error", reject);
    req.end();
  });
}

async function fetchWithRedirects(urlStr, headers, maxRedirects=MAX_REDIRECTS){
  let current = urlStr;
  for (let i=0;i<=maxRedirects;i++){
    const up = await requestOnce(current, headers);
    const sc = up.statusCode || 0;
    if (sc>=300 && sc<400 && up.headers.location){
      const loc = up.headers.location;
      up.resume();
      current = new URL(loc, current).toString();
      continue;
    }
    return { up, finalUrl: current };
  }
  throw new Error("Too many redirects");
}

// حوّل أي مرجع (نسبي/مطلق) إلى URL مطلق ثم إلى مسار بروكسي /hls بدون تكرار
function refToProxyPath(ref, baseAbsUrl){
  try{
    const abs = new URL(ref, baseAbsUrl);         // يحلّ النسبي كاملًا
    let p = abs.pathname || "/";
    p = p.replace(/^\/hls/i, "");                 // لا نضاعف
    return `/hls${p}${abs.search || ""}`;
  }catch{
    if (typeof ref==="string" && ref.startsWith("/")){
      const p = ref.replace(/^\/hls/i,"");
      return `/hls${p}`;
    }
    return ref; // سطر لا يمكن تفسيره
  }
}

// إعادة كتابة manifest (يشمل URI داخل الوسوم)
function rewriteManifest(text, baseAbsUrl){
  const TAGS = ["EXT-X-KEY","EXT-X-SESSION-KEY","EXT-X-MAP","EXT-X-MEDIA","EXT-X-I-FRAME-STREAM-INF","EXT-X-SESSION-DATA"];
  const TAGS_RE = new RegExp(`^#(?:${TAGS.join("|")}):`, "i");
  const ABS_OR_ROOT = /^(https?:)?\/\//i;

  return text.split("\n").map(line=>{
    const t = line.trim();
    if (TAGS_RE.test(t)){
      return line.replace(/URI="([^"]+)"/gi, (_m, uri)=>{
        if (ABS_OR_ROOT.test(uri) || uri.startsWith("/")) return `URI="${refToProxyPath(uri, baseAbsUrl)}"`;
        return `URI="${refToProxyPath(uri, baseAbsUrl)}"`; // نسبي أيضًا
      });
    }
    if (!t || t.startsWith("#")) return line;
    return refToProxyPath(t, baseAbsUrl);
  }).join("\n");
}

// ========= بروكسي HLS =========
app.get("/hls/*", async (req,res)=>{
  try{
    // أصلُك يستخدم /hls، لذا لا نزيلها
    const upstreamUrl = ORIGIN_BASE + req.originalUrl;
    const { up, finalUrl } = await fetchWithRedirects(upstreamUrl, buildUpstreamHeaders(req));

    const isM3U8 = /\.m3u8(\?.*)?$/i.test(req.originalUrl);
    if (!isM3U8){
      if (up.headers["content-type"])  res.set("Content-Type", up.headers["content-type"]);
      if (up.headers["content-length"]) res.set("Content-Length", up.headers["content-length"]);
      if (up.headers["accept-ranges"])  res.set("Accept-Ranges",  up.headers["accept-ranges"]);
      if (up.headers["content-range"])  res.set("Content-Range",  up.headers["content-range"]);
    }

    if ((up.statusCode||0) >= 400){
      res.status(up.statusCode).end();
      up.resume();
      return;
    }

    if (isM3U8){
      let data = "";
      up.setEncoding("utf8");
      up.on("data", c=>data+=c);
      up.on("end", ()=>{
        const rewritten = rewriteManifest(data, finalUrl);
        if (DEBUG) console.log("BASE=", finalUrl, "\n", rewritten.slice(0,800));
        res.status(200).type("application/vnd.apple.mpegurl")
           .set("Cache-Control","no-store, must-revalidate")
           .send(rewritten);
      });
      up.on("error", ()=>res.status(502).send("Upstream error"));
      return;
    }

    res.status(up.statusCode || 200);
    res.on("close", ()=>{ try{ up.destroy(); }catch{} });
    up.pipe(res);
  }catch(e){
    console.error(e);
    res.status(500).send("Proxy error");
  }
});

// فحص سريع: يُظهر أول 40 سطر قبل/بعد
app.get("/diag", async (req,res)=>{
  const path = String(req.query.path || "/hls/live/playlist.m3u8");
  try{
    const { up, finalUrl } = await fetchWithRedirects(ORIGIN_BASE + path, buildUpstreamHeaders({headers:{}}));
    let raw=""; up.setEncoding("utf8");
    up.on("data", c=>raw+=c);
    up.on("end", ()=>{
      const rewritten = rewriteManifest(raw, finalUrl);
      const head = s=>s.split("\n").slice(0,40).join("\n");
      res.type("text").send(`=== UPSTREAM (${finalUrl}) ===\n${head(raw)}\n\n=== REWRITTEN (/hls) ===\n${head(rewritten)}\n`);
    });
  }catch(e){ res.status(500).type("text").send("diag error: "+e.message); }
});

app.get("/health", (_req,res)=>res.type("text").send("ok"));

app.listen(PORT, ()=>{
  console.log("Server on", PORT, "→ origin:", ORIGIN_BASE, "insecureTLS:", ALLOW_INSECURE_TLS, "debug:", DEBUG);
});
