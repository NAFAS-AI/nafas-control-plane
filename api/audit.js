/**
 * EduOS — /api/audit.js
 * الخطوة 4 من خطة الأمان: سجل تدقيق كل دخول وكل عملية حساسة
 * Step 4 Security Plan: Audit log for every login + sensitive operation
 *
 * © 2026 NAFAS FOR ARTIFICIAL INTELLIGENCE — CN-6573712
 */

// ── Rate Limiting ──
const rateLimitStore = new Map();
const WINDOW_MS = 60_000;
const MAX_AUDIT_REQS = 60;

function checkRateLimit(ip) {
  const key = `aud:${ip}:${Math.floor(Date.now() / WINDOW_MS)}`;
  const count = (rateLimitStore.get(key) || 0) + 1;
  rateLimitStore.set(key, count);
  if (count === 1) setTimeout(() => rateLimitStore.delete(key), WINDOW_MS * 2);
  return count <= MAX_AUDIT_REQS;
}

export default async function handler(req, res) {
  // ── CORS ──
  const origin = req.headers.origin || '';
  const isAllowed = /^https?:\/\/(.*\.eduos\.ae|localhost(:\d+)?)$/.test(origin);
  if (isAllowed) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') return res.status(405).end();

  // ── Rate Limit ──
  const ip = ((req.headers['x-forwarded-for'] || '') + '').split(',')[0].trim() || 'unknown';
  if (!checkRateLimit(ip)) return res.status(429).end();

  const {
    event_type = 'UNKNOWN',
    user_id = 'anonymous',
    role = 'unknown',
    page = 'unknown',
    details = {},
  } = req.body || {};

  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_ANON_KEY;

  if (!SB_URL || !SB_KEY) return res.status(200).json({ ok: true }); // Silent — don't break app

  // ── Write to audit_logs ──
  try {
    await fetch(`${SB_URL}/rest/v1/audit_logs`, {
      method: 'POST',
      headers: {
        'apikey': SB_KEY,
        'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        event_type,
        user_id,
        role,
        page,
        ip_address: ip,
        details: {
          ...details,
          userAgent: (req.headers['user-agent'] || '').substring(0, 200),
        },
        created_at: new Date().toISOString(),
      }),
    });
  } catch (e) {
    // Silent fail — audit must never break the app
  }

  return res.status(200).json({ ok: true });
}
