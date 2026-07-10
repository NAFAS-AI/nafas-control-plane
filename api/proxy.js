/**
 * EduOS — /api/proxy.js
 * الخطوة 2+3 من خطة الأمان: وسيط Supabase مع تحديد معدل + تدقيق
 * Step 2+3 Security Plan: Supabase write proxy with rate limiting + audit logging
 *
 * الاستخدام / Usage:
 *   POST /api/proxy
 *   Headers: x-session-token: <base64 session>
 *   Body: { table, method, body, query }
 *
 * © 2026 NAFAS FOR ARTIFICIAL INTELLIGENCE — CN-6573712
 */

// ── Rate Limiting ──
const rateLimitStore = new Map();
const WINDOW_MS = 60_000;
const MAX_WRITE_REQS = 20; // 20 writes/min per IP (strict)

function checkRateLimit(ip) {
  const now = Date.now();
  const key = `prx:${ip}:${Math.floor(now / WINDOW_MS)}`;
  const count = (rateLimitStore.get(key) || 0) + 1;
  rateLimitStore.set(key, count);
  if (count === 1) setTimeout(() => rateLimitStore.delete(key), WINDOW_MS * 2);
  return count <= MAX_WRITE_REQS;
}

// ── Session Validation ──
function validateSession(token) {
  if (!token) return null;
  try {
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
    if (!decoded.role_key && !decoded.role) return null;
    if (!decoded.loginTime) return null;
    // 15 min session
    if (Date.now() - decoded.loginTime > 15 * 60 * 1000) return null;
    return decoded;
  } catch (e) {
    return null;
  }
}

// ── Audit Log (fire and forget) ──
async function logAudit(sbUrl, sbKey, entry) {
  try {
    await fetch(`${sbUrl}/rest/v1/audit_logs`, {
      method: 'POST',
      headers: {
        'apikey': sbKey,
        'Authorization': `Bearer ${sbKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(entry),
    });
  } catch (e) {
    // Silent fail — audit must never break the app
  }
}

export default async function handler(req, res) {
  // ── CORS ──
  const origin = req.headers.origin || '';
  const isAllowed = /^https?:\/\/(.*\.eduos\.ae|localhost(:\d+)?)$/.test(origin);
  if (isAllowed) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session-Token');
    return res.status(200).end();
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Rate Limit ──
  const ip = ((req.headers['x-forwarded-for'] || '') + '').split(',')[0].trim() || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded', retryAfter: 60 });
  }

  // ── Session Validation ──
  const sessionToken = req.headers['x-session-token'];
  const session = validateSession(sessionToken);
  if (!session) {
    return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
  }

  // ── Parse body ──
  const { table, method = 'POST', body, query } = req.body || {};
  if (!table) return res.status(400).json({ error: 'Missing required field: table' });

  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_ANON_KEY;

  if (!SB_URL || !SB_KEY) {
    return res.status(503).json({ error: 'Database configuration missing' });
  }

  // ── Build Supabase URL ──
  let sbUrl = `${SB_URL}/rest/v1/${table}`;
  if (query) sbUrl += `?${query}`;

  const startTime = Date.now();
  let success = false;

  try {
    const sbRes = await fetch(sbUrl, {
      method,
      headers: {
        'apikey': SB_KEY,
        'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    success = sbRes.ok;
    const data = await sbRes.json();

    // ── Audit Log (async, don't await) ──
    logAudit(SB_URL, SB_KEY, {
      event_type: 'DB_WRITE',
      user_id: session.id || session.staff_db_id || 'unknown',
      role: session.role_key || session.role || 'unknown',
      action: method,
      table_name: table,
      ip_address: ip,
      success,
      duration_ms: Date.now() - startTime,
      details: { query: query || null },
      created_at: new Date().toISOString(),
    });

    return res.status(sbRes.status).json(data);
  } catch (e) {
    // Log failure
    logAudit(SB_URL, SB_KEY, {
      event_type: 'DB_WRITE_ERROR',
      user_id: session.id || 'unknown',
      role: session.role_key || 'unknown',
      action: method,
      table_name: table,
      ip_address: ip,
      success: false,
      details: { error: e.message },
      created_at: new Date().toISOString(),
    });

    return res.status(500).json({ error: 'Proxy error', details: e.message });
  }
}
