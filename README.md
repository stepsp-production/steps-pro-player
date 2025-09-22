# Steps Live Multicam + HLS Proxy (Netlify + Cloudflare Workers)

## النشر
1) **انشر الواجهة على Netlify**
   - ربط GitHub → اختر هذا المستودع → publish = `public/`
   - استخدم `netlify.toml` **أو** ملف `_redirects` كما في المشروع.

2) **انشر HLS Proxy على Cloudflare Workers**
   - ادخل Cloudflare → Workers → Create
   - اربط GitHub أو ادفع الكود يدويًا
   - في إعدادات Worker → Variables:
     - ORIGIN_BASE = `https://46.152.17.35` (أو عنوانك)
     - PROXY_TIMEOUT_MS = `15000`
   - نشر `wrangler deploy` (اختياري لو محليًا)

3) **حدث إعادة التوجيه في Netlify**
   - بدّل `https://hls-proxy.<your-subdomain>.workers.dev` بالنطاق الفعلي للـ Worker

4) **اختبار**
   - افتح: `https://<netlify-site>/`
   - `GET /health` على Worker للتأكد (اختياري): `https://hls-proxy.<your-subdomain>.workers.dev/health`

## ملاحظات
- Cloudflare Workers (خطة مجانية) تسمح حتى **~100k طلب/يوم**، وتدعم **Streaming** عبر `ReadableStream`. مناسب جدًا لبث HLS.  \
  (المراجع: Workers limits & streaming)  
- Netlify Rewrites (status=200) تعمل كبروكسي شفاف وتحافظ على نفس URL في شريط العنوان.  
