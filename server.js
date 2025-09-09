import express from "express";
import morgan from "morgan";
import compression from "compression";
import cors from "cors";
import https from "https";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { URL } from "url";
import { pipeline } from "stream";

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
app.use(cors());

// ❗ تعطيل الضغط على وسائط الفيديو/الصوت/الـmanifests لتفادي تجزئة/تشويش البث
const shouldCompress = (req, res) => {
  const p = req.path.toLowerCase();
  if (p.endsWith(".m3u8") || p.endsWith(".mpd") || p.endsWith(".ts") || p.endsWith(".m4s") || p.endsWith(".mp4")) {
    return false;
  }
  return compression.filter(req, res);
};
app.use(compression({ filter: shouldCompress }));

// تقديم الواجهة
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders(res, filePath) {
    const low = filePath.toLowerCase();
    // لا كاش لـ m3u8 (لأنها متغيرة) — لكن اسمح بكاش قصير للSegments
    if (low.endsWith(".m3u8")) {
      res.setHeader("Cache-Control", "no-store, must-revalidate");
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    } else if (low.endsWith(".ts")) {
      res.setHeader("Cache-Control", "public, max-age=30, immutable");
      res.setHeader("Content-Type", "video/mp2t");
    } else if (low.endsWith(".m4s")) {
      res.setHeader("Cache-Control", "public, max-age=30, immutable");
      // CMAF segments
      res.setHeader("Content-Type", "video/iso.segment");
    }
  }
}));

// عناوين افتراضية
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  next();
});

// Keep-Alive agents
const insecureHttpsAgent = new https.Agent({
  rejectUnauthorized: !ALLOW_INSECURE_TLS,
  keepAlive: true,
  timeout: PROXY_TIMEOUT_MS
});
const httpAgent = new http.Agent({ keepAlive: true, timeout: PROXY_TIMEOUT_MS });

function requestOnce(urlStr, headers) {
  const u = new URL(urlStr);
  const isHttps = u.protocol === "https:";
  const client = isHttps ? https : http;
  const agent = isHttps ? insecureHttpsAgent : httpAgent;
  const opts = {
    method: "GET",
    headers,
    agent,
    timeout: PROXY_TIMEOUT_MS,
  };
  return new Promise((resolve, reject) => {
    const req = client.request(urlStr, opts, (up) => resolve(up));
    req.on("timeout", () => {
      req.destroy(new Error("Upstream request timeout"));
    });
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
      up.resume(); // discard body
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

// مساعد لتعيين Content-Type الصحيح
function setContentTypeHeaders(reqPath, res, upstreamCT) {
  const p = reqPath.toLowerCase();

  if (p.endsWith(".m3u8") || upstreamCT?.includes("application/vnd.apple.mpegurl")) {
    res.set("Content-Type", "application/vnd.apple.mpegurl");
    return;
  }
  if (p.endsWith(".ts") || upstreamCT?.includes("video/mp2t")) {
    res.set("Content-Type", "video/mp2t");
    return;
  }
  if (p.endsWith(".m4s")) {
    // CMAF segments
    res.set("Content-Type", "video/iso.segment");
    return;
  }
  if (upstreamCT) {
    res.set("Content-Type", upstreamCT);
  }
}

// Proxy HLS
app.get("/hls/*", async (req, res) => {
  // تمرير الـ Range كما هو إن وُجد، واحترام Accept-Ranges
  try {
    const upstreamUrl = ORIGIN_BASE + req.originalUrl;
    const originHost = new URL(ORIGIN_BASE).host;
    const headers = {
      ...req.headers,
      host: originHost,
      // منع ضغط غير متوقع من الأصل
      "accept-encoding": "identity",
    };

    const { up } = await fetchWithRedirects(upstreamUrl, headers);

    // لو عميل أغلق الاتصال، أغلق upstream
    const abortUpstream = () => {
      try { up.destroy(); } catch {}
    };
    res.on("close", abortUpstream);
    res.on("finish", abortUpstream);

    // تمرير رؤوس مهمة
    setContentTypeHeaders(req.path, res, up.headers["content-type"] || "");
    if (up.headers["content-length"]) res.set("Content-Length", up.headers["content-length"]);
    if (up.headers["accept-ranges"]) res.set("Accept-Ranges", up.headers["accept-ranges"]);
    if (up.headers["content-range"]) res.set("Content-Range", up.headers["content-range"]);

    // سياسات كاش: لا كاش للـ m3u8 — كاش خفيف للـ segments
    const low = req.path.toLowerCase();
    if (low.endsWith(".m3u8")) {
      res.set("Cache-Control", "no-store, must-revalidate");
    } else if (low.endsWith(".ts") || low.endsWith(".m4s")) {
      res.set("Cache-Control", "public, max-age=15, immutable");
    }

    if ((up.statusCode || 0) >= 400) {
      res.status(up.statusCode).end();
      up.resume();
      return;
    }

    if (/\.m3u8(\?.*)?$/i.test(req.path)) {
      // إعادة كتابة الـ URIs داخل الـ manifest
      let data = "";
      up.setEncoding("utf8");
      up.on("data", (c) => (data += c));
      up.on("end", () => {
        const rewritten = rewriteManifest(data, req.originalUrl);
        res.type("application/vnd.apple.mpegurl").send(rewritten);
      });
      up.on("error", () => res.status(502).send("Upstream error"));
      return;
    }

    // تمرير البث كما هو مع pipeline (تدفق آمن)
    res.status(up.statusCode || 200);
    pipeline(up, res, (err) => {
      if (err && !res.headersSent) {
        res.status(502).end("Proxy pipeline error");
      }
    });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).send("Proxy error");
  }
});

// Test player (اختياري)
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
if (window.Hls && Hls.isSupported()) { const h=new Hls({lowLatencyMode:false}); h.loadSource(src); h.attachMedia(v); }
else { v.src=src; }
</script>
</body></html>`);
});

// صحّة
app.get("/health", (req, res) => {
  res.json({ ok: true, origin: ORIGIN_BASE, insecureTLS: ALLOW_INSECURE_TLS });
});

app.listen(PORT, () => {
  console.log("Server on", PORT, "→ origin:", ORIGIN_BASE, "insecureTLS:", ALLOW_INSECURE_TLS);
});
