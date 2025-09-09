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

// لا نضغط ملفات الميديا
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

const httpAgent  = new http.Agent({ keepAlive:true, maxSockets:128 });
const httpsAgent = new https.Agent({ keepAlive:true, maxSockets:128, rejectUnauthorized:!ALLOW_INSECURE_TLS });

function headersForUpstream(req) {
  const h = {
    Host: new URL(ORIGIN_BASE).host,
    Connection: "keep-alive",
    Accept: "*/*",
    "Accept-Encoding": "identity",   // مهم: بدون gzip
    "User-Agent": req.headers["user-agent"] || "Mozilla/5.0",
  };
  if (req.headers.range) h.Range = req.headers.range;
  return h; // لا نمرّر Origin/Referer/CF…
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

// تتبّع التحويلات 3xx لكـل شيء (m3u8 و ts و m4s…)
async function fetchWithRedirects(urlStr, headers, max=MAX_REDIRECTS){
  let current = urlStr;
  for (let i=0;i<=max;i++){
    const up = await requestOnce(current, headers);
    const sc = up.statusCode || 0;
    if (sc>=300 && sc<400 && up.headers.location){
      const loc = new URL(up.headers.location, current).toString();
      up.resume(); // تفريغ الرد قبل المتابعة
      current = loc;
      continue;
    }
    return { up, finalUrl: current };
  }
  throw new Error("Too many redirects");
}

// حوّل أي مرجع (نسبي/مطلق) إلى مسار بروكسي /hls بدون تكرار
function refToProxyPath(ref, baseAbsUrl){
  try{
    const abs = new URL(ref, baseAbsUrl);      // يحلّ النسبي
    let p = abs.pathname.replace(/^\/hls/i,''); // تجنّب /hls/hls
    return `/hls${p}${abs.search||''}`;
  }catch{
    if (typeof ref==='string' && ref.startsWith('/')){
      const p = ref.replace(/^\/hls/i,'');
      return `/hls${p}`;
    }
    return ref;
  }
}

// إعادة كتابة manifest (يشمل URI داخل الوسوم)
function rewriteManifest(text, baseAbsUrl){
  const TAGS = ["EXT-X-KEY","EXT-X-SESSION-KEY","EXT-X-MAP","EXT-X-MEDIA","EXT-X-I-FRAME-STREAM-INF","EXT-X-SESSION-DATA"];
  const TAGS_RE = new RegExp(`^#(?:${TAGS.join("|")}):`, "i");
  return text.split("\n").map(line=>{
    const t=line.trim();
    if (TAGS_RE.test(t)){
      return line.replace(/URI="([^"]+)"/gi, (_m, uri)=> `URI="${refToProxyPath(uri, baseAbsUrl)}"`);
    }
    if (!t || t.startsWith("#")) return line;
    return refToProxyPath(t, baseAbsUrl);
  }).join("\n");
}

// ========= البروكسي =========
app.get("/hls/*", async (req,res)=>{
  try{
    // الأصل يستخدم /hls، لذا لا نزيلها
    const upstreamUrl = ORIGIN_BASE + req.originalUrl;
    const { up, finalUrl } = await fetchWithRedirects(upstreamUrl, headersForUpstream(req));

    const isManifest = /\.m3u8(\?.*)?$/i.test(req.originalUrl);

    if (!isManifest) {
      if (up.headers["content-type"])  res.set("Content-Type", up.headers["content-type"]);
      if (up.headers["accept-ranges"])  res.set("Accept-Ranges",  up.headers["accept-ranges"]);
      if (up.headers["content-range"])  res.set("Content-Range",  up.headers["content-range"]);
      // لا نحتاج لتمرير Content-Length مع البث المتدفق
    }

    if ((up.statusCode||0) >= 400) { res.status(up.statusCode).end(); up.resume(); return; }

    if (isManifest) {
      let raw=""; up.setEncoding("utf8");
      up.on("data", c=>raw+=c);
      up.on("end", ()=>{
        const out = rewriteManifest(raw, finalUrl);
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

// فحص سريع: يظهر أول 40 سطر قبل/بعد
app.get("/diag", async (req,res)=>{
  const path = String(req.query.path || "/hls/live/playlist.m3u8");
  try{
    const { up, finalUrl } = await fetchWithRedirects(ORIGIN_BASE + path, headersForUpstream({headers:{}}));
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
