import express from "express";
import morgan from "morgan";
import compression from "compression";
import cors from "cors";
import https from "https";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { URL } from "url";

// ======= CONFIG =======
const ORIGIN_BASE = process.env.ORIGIN_BASE || "http://46.152.116.98";
const PORT = process.env.PORT || 10000;
const ALLOW_INSECURE_TLS = String(process.env.ALLOW_INSECURE_TLS || "true") === "true";
const PROXY_TIMEOUT_MS = Number(process.env.PROXY_TIMEOUT_MS || 15000);
const MAX_REDIRECTS = Number(process.env.MAX_REDIRECTS || 5);
// ======================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(morgan("tiny"));

// لا نضغط ملفات الفيديو (m3u8/m4s/ts) — نضغط باقي الملفات فقط
app.use(
  compression({
    filter: (req, res) => {
      if (/\.(m3u8|ts|m4s)$/i.test(req.path)) return false;
      return compression.filter(req, res);
    },
  })
);

app.use(cors());

// ملفات الواجهة
app.use(express.static(path.join(__dirname, "public")));

// ترويسات عامة + أنواع المحتوى
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (/\.(m3u8)$/i.test(req.path)) {
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-store, must-revalidate");
  } else if (/\.(ts)$/i.test(req.path)) {
    res.setHeader("Content-Type", "video/mp2t");
    res.setHeader("Cache-Control", "public, max-age=15, immutable");
  } else if (/\.(m4s)$/i.test(req.path)) {
    res.setHeader("Content-Type", "video/iso.segment");
    res.setHeader("Cache-Control", "public, max-age=15, immutable");
  }
  next();
});

// ===== Keep-Alive لوصلات الـ proxy =====
const keepAliveHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 128 });
const keepAliveHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 128,
  rejectUnauthorized: !ALLOW_INSECURE_TLS,
});

function requestOnce(urlStr, headers) {
  const u = new URL(urlStr);
  const isHttps = u.protocol === "https:";
  const client = isHttps ? https : http;
  const agent = isHttps ? keepAliveHttpsAgent : keepAliveHttpAgent;
  const opts = { method: "GET", headers, agent, timeout: PROXY_TIMEOUT_MS };
  return new Promise((resolve, reject) => {
    const req = client.request(urlStr, opts, (up) => resolve(up));
    req.on("timeout", () => req.destroy(new Error("proxy timeout")));
    req.on("error", reject);
    req.end();
  });
}

async function fetchWithRedirects(urlStr, headers, maxRedirects = MAX_REDIRECTS) {
  let current = urlStr;
  for (let i = 0; i <= maxRedirects; i++) {
    const up = await requestOnce(current, headers);
    const sc = up.statusCode || 0;
    if (sc >= 300 && sc < 400 && up.headers.location) {
      const loc = up.headers.location;
      up.resume();
      current = new URL(loc, current).toString();
      continue;
    }
    return { up, finalUrl: current };
  }
  throw new Error("Too many redirects");
}

function rewriteManifest(text, basePath) {
  return text
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return line;
      if (/^https?:\/\//i.test(t)) {
        try {
          const url = new URL(t);
          return `${basePath}${url.pathname}${url.search || ""}`;
        } catch {
          return line;
        }
      }
      const parent = basePath.replace(/\/[^/]*$/, "/");
      return parent + t;
    })
    .join("\n");
}

// ===== Proxy HLS =====
app.get("/hls/*", async (req, res) => {
  try {
    const upstreamUrl = ORIGIN_BASE + req.originalUrl;
    const headers = {
      ...req.headers,
      host: new URL(ORIGIN_BASE).host,
      ...(req.headers.range ? { Range: req.headers.range } : {}),
      Connection: "keep-alive",
    };

    const { up } = await fetchWithRedirects(upstreamUrl, headers);

    // مرر بعض الترويسات
    if (up.headers["content-type"]) res.set("Content-Type", up.headers["content-type"]);
    if (up.headers["content-length"]) res.set("Content-Length", up.headers["content-length"]);
    if (up.headers["accept-ranges"]) res.set("Accept-Ranges", up.headers["accept-ranges"]);
    if (up.headers["content-range"]) res.set("Content-Range", up.headers["content-range"]);

    // استجابة خطأ من المصدر
    if ((up.statusCode || 0) >= 400) {
      res.status(up.statusCode).end();
      up.resume();
      return;
    }

    // ملفات المانيفست: نعيد كتابتها للمرور عبر البروكسي
    if (/\.m3u8(\?.*)?$/i.test(req.path)) {
      let data = "";
      up.setEncoding("utf8");
      up.on("data", (c) => (data += c));
      up.on("end", () => {
        const rewritten = rewriteManifest(data, req.originalUrl);
        res
          .status(200)
          .type("application/vnd.apple.mpegurl")
          .set("Cache-Control", "no-store, must-revalidate")
          .send(rewritten);
      });
      up.on("error", () => res.status(502).send("Upstream error"));
      return;
    }

    // المقاطع: مررها مباشرة
    res.status(up.statusCode || 200);
    // تنظيف عند إغلاق اتصال العميل
    res.on("close", () => {
      try {
        up.destroy();
      } catch {}
    });
    up.pipe(res);
  } catch (e) {
    console.error(e);
    res.status(500).send("Proxy error");
  }
});

// فحص الصحة
app.get("/health", (_req, res) => res.type("text").send("ok"));

// مشغل بسيط (اختياري)
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

app.listen(PORT, () => {
  console.log("Server on", PORT, "→ origin:", ORIGIN_BASE, "insecureTLS:", ALLOW_INSECURE_TLS);
});
