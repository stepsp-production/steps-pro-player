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
app.use(cors());

// ===== بروكسي HLS أولاً (قبل أي static) =====
const httpAgent  = new http.Agent({ keepAlive:true, maxSockets:128 });
const httpsAgent = new https.Agent({ keepAlive:true, maxSockets:128, rejectUnauthorized:!ALLOW_INSECURE_TLS });

function upstreamHeaders(req){
  const h = {
    Host: new URL(ORIGIN_BASE).host,
    Connection: "keep-alive",
    Accept: "*/*",
    "Accept-Encoding": "identity", // نطلب المحتوى غير مضغوط لفك/إعادة الكتابة
    "User-Agent": req.headers["user-agent"] || "Mozilla/5.0",
  };
  if (req.headers.range) h.Range = req.headers.range;
  return h; // لا نمرر Origin/Referer
}

function requestOnce(urlStr, headers){
  const u = new URL(urlStr);
  const client = u.protocol==="https:" ? https : http;
  const agent  = u.protocol==="https:" ? httpsAgent : httpAgent;
  const opts = { method:"GET", headers, agent, timeout:PROXY_TIMEOUT_MS };
  return new Promise((resolve,reject)=>{
    const rq = client.request(urlStr, opts, up=>resolve(up));
    rq.on("timeout", ()=>rq.destroy(new Error("proxy timeout")));
    rq.on("error", reject);
    rq.end();
  });
}

async function fetchWithRedirects(urlStr, headers, max=MAX_REDIRECTS){
  let current = urlStr;
  for (let i=0;i<=max;i++){
    const up = await requestOnce(current, headers);
    const sc = up.statusCode || 0;
    if (sc>=300 && sc<400 && up.headers.location){
      const loc = new URL(up.headers.location, current).toString();
      up.resume();
      current = loc; continue;
    }
    return { up, finalUrl: current };
  }
  throw new Error("Too many redirects");
}

// حوّل أي مرجع (نسبي/مطلق) إلى /hls/* بدون تكرار /hls
function refToProxy(ref, baseAbsUrl){
  try{
    const abs = new URL(ref, baseAbsUrl);      // يحل النسبي أيضًا
    let p = abs.pathname.replace(/^\/hls/i,''); // لا نضاعف /hls
    return `/hls${p}${abs.search||''}`;
  }catch{
    if (typeof ref==='string' && ref.startsWith('/')){
      const p = ref.replace(/^\/hls/i,'');
      return `/hls${p}`;
    }
    return ref;
  }
}

function rewriteManifest(text, baseAbsUrl){
  const TAGS = ["EXT-X-KEY","EXT-X-SESSION-KEY","EXT-X-MAP","EXT-X-MEDIA","EXT-X-I-FRAME-STREAM-INF","EXT-X-SESSION-DATA"];
  const TAGS_RE = new RegExp(`^#(?:${TAGS.join("|")}):`, "i");
  return text.split("\n").map(line=>{
    const t=line.trim();
    if (TAGS_RE.test(t)){
      return line.replace(/URI="([^"]+)"/gi, (_m, uri)=> `URI="${refToProxy(uri, baseAbsUrl)}"`);
    }
    if (!t || t.startsWith("#")) return line;
    return refToProxy(t, baseAbsUrl);
  }).join("\n");
}

// راوتر خاص بالبث
const hlsRouter = express.Router();

hlsRouter.use((req,res,next)=>{
  // ترويسات MIME وكاش
  if (/\.m3u8$/i.test(req.path)) {
    res.type("application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control","no-store, must-revalidate");
  } else if (/\.ts$/i.test(req.path)) {
    res.type("video/mp2t"); res.setHeader("Cache-Control","public, max-age=15, immutable");
  } else if (/\.m4s$/i.test(req.path)) {
    res.type("video/iso.segment"); res.setHeader("Cache-Control","public, max-age=15, immutable");
  } else if (/\.key$/i.test(req.path)) {
    res.type("application/octet-stream"); res.setHeader("Cache-Control","no-store");
  }
  next();
});

hlsRouter.get("/*", async (req,res)=>{
  try{
    // req.originalUrl يتضمن /hls/… — نحتاج تمريره كما هو إلى الأصل
    const upstreamUrl = ORIGIN_BASE + req.originalUrl;
    const { up, finalUrl } = await fetchWithRedirects(upstreamUrl, upstreamHeaders(req));

    const isManifest = /\.m3u8(\?.*)?$/i.test(req.originalUrl);

    if (!isManifest) {
      if (up.headers["content-type"])  res.set("Content-Type", up.headers["content-type"]);
      if (up.headers["accept-ranges"])  res.set("Accept-Ranges",  up.headers["accept-ranges"]);
      if (up.headers["content-range"])  res.set("Content-Range",  up.headers["content-range"]);
    }

    if ((up.statusCode||0) >= 400) { res.status(up.statusCode).end(); up.resume(); return; }

    if (isManifest) {
      let raw=""; up.setEncoding("utf8");
      up.on("data", c=>raw+=c);
      up.on("end", ()=>{
        const out = rewriteManifest(raw, finalUrl); // حلّ النسبي أولاً باستخدام finalUrl
        if (DEBUG) console.log("BASE=", finalUrl, "\n", out.slice(0,800));
        res.status(200).type("application/vnd.apple.mpegurl")
           .set("Cache-Control","no-store, must-revalidate")
           .send(out);
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

// اربط الراوتر قبل أي static:
app.use("/hls", hlsRouter);

// ===== بقية التطبيق (الواجهة) =====
app.use(
  compression({
    filter: (req, res) =>
      (!/\.(m3u8|ts|m4s|mp4|key)$/i.test(req.path) && compression.filter(req, res)),
  })
);

app.use(express.static(path.join(__dirname, "public")));

app.get("/player", (req, res) => {
  const src = req.query.src || "/hls/live/playlist.m3u8";
  res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>HLS Player</title>
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
<style>html,body{margin:0;background:#000} video{width:100vw;height:100vh;object-fit:contain}</style>
</head><body>
<video id="v" controls muted playsinline></video>
<script>
const v=document.getElementById('v'); const src=${JSON.stringify(src)};
if (window.Hls && Hls.isSupported()) { const h=new Hls(); h.loadSource(src); h.attachMedia(v); }
else { v.src=src; }
</script>
</body></html>`);
});

// تشخيص سريع
app.get("/diag", async (req,res)=>{
  const pathQ = String(req.query.path || "/hls/live/playlist.m3u8");
  try{
    const { up, finalUrl } = await fetchWithRedirects(ORIGIN_BASE + pathQ, upstreamHeaders({headers:{}}));
    let raw=""; up.setEncoding("utf8");
    up.on("data", c=>raw+=c);
    up.on("end", ()=>{
      const out = rewriteManifest(raw, finalUrl);
      const head = s=>s.split("\n").slice(0,40).join("\n");
      res.type("text").send(`=== UPSTREAM (${finalUrl}) ===\n${head(raw)}\n\n=== REWRITTEN (/hls) ===\n${head(out)}\n`);
    });
  }catch(e){ res.status(500).type("text").send("diag error: "+e.message); }
});

app.get("/health", (_req,res)=>res.type("text").send("ok"));

app.listen(PORT, ()=>console.log("Server on", PORT, "→ origin:", ORIGIN_BASE, "debug:", DEBUG));
