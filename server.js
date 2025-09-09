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
const ORIGIN_BASE = process.env.ORIGIN_BASE || "https://stream.mux.com";
const PORT = process.env.PORT || 10000;
const ALLOW_INSECURE_TLS = String(process.env.ALLOW_INSECURE_TLS || "true") === "true";
const PROXY_TIMEOUT_MS = Number(process.env.PROXY_TIMEOUT_MS || 15000);
const MAX_REDIRECTS = Number(process.env.MAX_REDIRECTS || 5);
// ======================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(morgan("tiny"));

// لا نضغط ملفات الميديا
app.use(
  compression({
    filter: (req, res) => (!/\.(m3u8|ts|m4s|mp4|key)$/i.test(req.path) && compression.filter(req, res)),
  })
);

app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

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
  } else if (/\.(mp4)$/i.test(req.path)) {
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Cache-Control", "public, max-age=15, immutable");
  } else if (/\.(key)$/i.test(req.path)) {
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});

// Keep-Alive
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

// مطلق -> عبر بروكسي /hls
function absoluteToProxy(u) {
  try {
    const url = new URL(u);
    return `/hls${url.pathname}${url.search || ""}`;
  } catch {
    if (typeof u === "string" && u.startsWith("/")) return `/hls${u}`;
    return u;
  }
}

// إعادة كتابة manifest (يشمل URI داخل التاجّات)
function rewriteManifest(text, baseDirProxy) {
  const ABS_HTTP = /^(https?:)?\/\//i;
  const TAGS_WITH_URI = [
    "EXT-X-KEY",
    "EXT-X-MAP",
    "EXT-X-MEDIA",
    "EXT-X-I-FRAME-STREAM-INF",
    "EXT-X-SESSION-DATA"
  ];
  const TAGS_RE = new RegExp(`^#(?:${TAGS_WITH_URI.join("|")}):`, "i");

  return text
    .split("\n")
    .map((line) => {
      const t = line.trim();

      // وسوم فيها URI="..."
      if (TAGS_RE.test(t)) {
        return line.replace(/URI="([^"]+)"/gi, (_m, uri) => {
          if (ABS_HTTP.test(uri) || uri.startsWith("/")) return `URI="${absoluteToProxy(uri)}"`;
          return `URI="${baseDirProxy}${uri}"`; // نسبي -> داخل مجلد الـPlayback ID
        });
      }

      // السطور العادية
      if (!t || t.startsWith("#")) return line;
      if (ABS_HTTP.test(t) || t.startsWith("/")) return absoluteToProxy(t);
      return baseDirProxy + t; // نسبي
    })
    .join("\n");
}

// احسب baseDirProxy بشكل صحيح لمُعرِّف Mux
function computeBaseDirProxy(reqOriginalUrl) {
  const noQuery = reqOriginalUrl.replace(/[?#].*$/, "");
  // حالة master: /hls/<ID>.m3u8 => /hls/<ID>/
  const m = noQuery.match(/^\/hls\/([^/?#]+)\.m3u8$/i);
  if (m) return `/hls/${m[1]}/`;
  // حالة القوائم الداخلية: /hls/<ID>/.../foo.m3u8 => أبقي المجلد كما هو
  return noQuery.replace(/\/[^/]*$/, "/");
}

// Proxy HLS عبر /hls/*
app.get("/hls/*", async (req, res) => {
  try {
    const upstreamPathWithQuery = req.originalUrl.replace(/^\/hls/, "");
    const upstreamUrl = ORIGIN_BASE + upstreamPathWithQuery;

    const headers = {
      ...req.headers,
      host: new URL(ORIGIN_BASE).host,
      Connection: "keep-alive",
      "accept-encoding": "identity",
    };
    delete headers["Accept-Encoding"];

    const { up } = await fetchWithRedirects(upstreamUrl, headers);

    const isManifest = /\.m3u8(\?.*)?$/i.test(req.originalUrl);

    if (!isManifest) {
      if (up.headers["content-type"]) res.set("Content-Type", up.headers["content-type"]);
      if (up.headers["content-length"]) res.set("Content-Length", up.headers["content-length"]);
      if (up.headers["accept-ranges"]) res.set("Accept-Ranges", up.headers["accept-ranges"]);
      if (up.headers["content-range"]) res.set("Content-Range", up.headers["content-range"]);
    }

    if ((up.statusCode || 0) >= 400) {
      res.status(up.statusCode).end();
      up.resume();
      return;
    }

    if (isManifest) {
      const baseDirProxy = computeBaseDirProxy(req.originalUrl);
      let data = "";
      up.setEncoding("utf8"); // مضمون غير مضغوط
      up.on("data", (c) => (data += c));
      up.on("end", () => {
        const rewritten = rewriteManifest(data, baseDirProxy);
        res
          .status(200)
          .type("application/vnd.apple.mpegurl")
          .set("Cache-Control", "no-store, must-revalidate")
          .send(rewritten);
      });
      up.on("error", () => res.status(502).send("Upstream error"));
      return;
    }

    res.status(up.statusCode || 200);
    res.on("close", () => { try { up.destroy(); } catch {} });
    up.pipe(res);
  } catch (e) {
    console.error(e);
    res.status(500).send("Proxy error");
  }
});

app.get("/health", (_req, res) => res.type("text").send("ok"));

app.listen(PORT, () => {
  console.log("Server on", PORT, "→ origin:", ORIGIN_BASE, "insecureTLS:", ALLOW_INSECURE_TLS);
});
