/**
 * EduOS — /api/config.js
 * الخطوة 2 من خطة الأمان: مفاتيح Supabase من env vars — لا تظهر في الكود
 * Step 2 Security Plan: Supabase keys served from env vars (not in source code)
 *
 * © 2026 NAFAS FOR ARTIFICIAL INTELLIGENCE — CN-6573712
 */

// ── Rate Limiting (in-memory per serverless instance) ──
const rateLimitStore = new Map();
const WINDOW_MS = 60_000; // 1 minute
const MAX_CONFIG_REQS = 30; // 30 requests/min per IP

function checkRateLimit(ip) {
  const now = Date.now();
  const key = `cfg:${ip}:${Math.floor(now / WINDOW_MS)}`;
  const count = (rateLimitStore.get(key) || 0) + 1;
  rateLimitStore.set(key, count);
  if (count === 1) setTimeout(() => rateLimitStore.delete(key), WINDOW_MS * 2);
  return count <= MAX_CONFIG_REQS;
}

export default function handler(req, res) {
  // ── CORS — only allow *.eduos.ae and localhost ──
  const origin = req.headers.origin || '';
  const isAllowed = /^https?:\/\/(.*\.eduos\.ae|localhost(:\d+)?)$/.test(origin);
  if (isAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');

  // OPTIONS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Rate limit ──
  const ip = ((req.headers['x-forwarded-for'] || '') + '').split(',')[0].trim() || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests', retryAfter: 60 });
  }

  // ── Read from environment variables ──
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  const schoolId = process.env.SCHOOL_ID || 'unknown';

  if (!url || !key) {
    // Env vars not configured — return 503
    return res.status(503).json({ error: 'Configuration unavailable', hint: 'Set SUPABASE_URL and SUPABASE_ANON_KEY in Vercel env vars' });
  }

  return res.status(200).json({
    url,
    key,
    schoolId,
    ts: Date.now(),
    v: '2'
  });
}
