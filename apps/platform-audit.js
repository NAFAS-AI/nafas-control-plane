/**
 * EduOS — platform-audit.js v1.0
 * الخطوة 4 من خطة الأمان: مساعد التدقيق من جانب العميل
 * Step 4 Security Plan: Client-side audit helper — logs every page visit + login + sensitive action
 *
 * الاستخدام / Usage:
 *   <script src="/apps/platform-audit.js"></script>
 *   ثم / then:
 *   window.EduOSAudit.login(userId, role);
 *   window.EduOSAudit.sensitiveAction('DELETE_GRADE', { student_id: 'S1000' });
 *
 * © 2026 NAFAS FOR ARTIFICIAL INTELLIGENCE — CN-6573712
 */
(function () {
  'use strict';

  const VERSION = '1.0';
  const ENDPOINT = '/api/audit';

  // ── Get current session ──
  function getSession() {
    try {
      const raw = sessionStorage.getItem('edoos_user');
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  // ── Core log function ──
  async function logEvent(eventType, overrides) {
    const session = getSession();
    const payload = {
      event_type: eventType,
      user_id: overrides.user_id || session?.id || session?.staff_db_id || 'anonymous',
      role: overrides.role || session?.role_key || session?.role || 'unknown',
      page: window.location.pathname + (window.location.hash || ''),
      details: {
        school: window.EduOS?.school?.id || 'unknown',
        portal: document.title || 'unknown',
        ...overrides.details,
      },
    };

    try {
      await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      });
    } catch (e) {
      // Silent fail — audit must never interrupt UI
    }
  }

  // ── Public API ──
  window.EduOSAudit = {
    version: VERSION,

    /** تسجيل دخول / Login event */
    login: function (userId, role) {
      return logEvent('LOGIN', { user_id: userId, role, details: { method: 'password' } });
    },

    /** تسجيل خروج / Logout event */
    logout: function (userId) {
      const session = getSession();
      return logEvent('LOGOUT', { user_id: userId || session?.id, details: {} });
    },

    /** عرض صفحة / Page view */
    pageView: function () {
      return logEvent('PAGE_VIEW', { details: { referrer: document.referrer } });
    },

    /** عملية حساسة / Sensitive action (grade change, delete, etc.) */
    sensitiveAction: function (action, data) {
      return logEvent('SENSITIVE_ACTION', { details: { action, ...data } });
    },

    /** تنبيه أمني / Security alert */
    securityAlert: function (message, data) {
      return logEvent('SECURITY_ALERT', { details: { message, ...data } });
    },

    /** محاولة دخول فاشلة / Failed login attempt */
    loginFailed: function (username) {
      return logEvent('LOGIN_FAILED', { user_id: username, details: { username } });
    },

    /** تنزيل ملف / File download */
    fileDownload: function (filename) {
      return logEvent('FILE_DOWNLOAD', { details: { filename } });
    },

    /** حدث عام / Generic event */
    log: function (eventType, details) {
      return logEvent(eventType, { details });
    },
  };

  // ── Auto: Log every page view ──
  window._eduosAuditPageStart = Date.now();

  document.addEventListener('DOMContentLoaded', function () {
    // Delay slightly so session is loaded
    setTimeout(function () { window.EduOSAudit.pageView(); }, 500);
  });

  // ── Auto: Log page exit with duration ──
  window.addEventListener('beforeunload', function () {
    const session = getSession();
    if (!session) return;
    const duration = Math.round((Date.now() - (window._eduosAuditPageStart || Date.now())) / 1000);
    navigator.sendBeacon(
      ENDPOINT,
      JSON.stringify({
        event_type: 'PAGE_EXIT',
        user_id: session.id || session.staff_db_id || 'anonymous',
        role: session.role_key || session.role || 'unknown',
        page: window.location.pathname,
        details: { duration_seconds: duration },
      })
    );
  });

})();
