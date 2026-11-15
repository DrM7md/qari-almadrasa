'use strict';
/**
 * منصة «قارئ المدرسة» — خادم Node.js مستقل بلا أي تبعيات خارجية.
 * يتطلب Node.js 22.13 أو أحدث (قاعدة SQLite مدمجة).
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const config = require('./src/config');
const { db, now, audit } = require('./src/db');
const { Router, HttpError, sendJson, securityHeaders, serveStatic, PUBLIC_DIR } = require('./src/http');
const sec = require('./src/security');
const media = require('./src/media');
const storage = require('./src/storage');

// ———————— أمر سطر الأوامر: إنشاء حساب مشرف ————————
async function createAdminCli() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((r) => rl.question(q, r));
  const username = (await ask('اسم المستخدم (لاتيني): ')).trim();
  const display = (await ask('الاسم الظاهر: ')).trim() || username;
  const password = await ask('كلمة المرور (10 أحرف على الأقل، أحرف وأرقام): ');
  rl.close();
  const p = sec.passwordProblems(password);
  if (p) { console.error(p); process.exit(1); }
  const owners = db.prepare("SELECT COUNT(*) n FROM admins WHERE role = 'owner'").get().n;
  const existing = db.prepare('SELECT id FROM admins WHERE username = ?').get(username);
  if (existing) {
    db.prepare('UPDATE admins SET password_hash = ?, active = 1, failed_logins = 0, locked_until = NULL WHERE id = ?').run(sec.hashPassword(password), existing.id);
    console.log('✔ تم تحديث كلمة مرور الحساب الموجود.');
  } else {
    db.prepare('INSERT INTO admins(username, display_name, password_hash, role, created_at) VALUES(?,?,?,?,?)')
      .run(username, display, sec.hashPassword(password), owners ? 'admin' : 'owner', now());
    console.log(`✔ تم إنشاء الحساب بصلاحية ${owners ? 'مدير' : 'المالك'}.`);
  }
  process.exit(0);
}

function bootstrapAdmin() {
  const n = db.prepare('SELECT COUNT(*) n FROM admins').get().n;
  if (n) return;
  const { username, password } = config.bootstrapAdmin;
  if (username && password && !sec.passwordProblems(password)) {
    db.prepare("INSERT INTO admins(username, display_name, password_hash, role, created_at) VALUES(?,?,?,'owner',?)")
      .run(username, 'مالك المنصة', sec.hashPassword(password), now());
    audit(null, 'bootstrap_owner', username);
    console.log(`[init] تم إنشاء حساب المالك «${username}» من متغيرات البيئة.`);
  } else {
    console.warn('[init] لا يوجد أي حساب مشرف. أنشئ واحدًا بالأمر: npm run create-admin  أو بتعيين ADMIN_USERNAME و ADMIN_PASSWORD.');
  }
}

// تنظيف عمليات الرفع المهجورة (أقدم من 48 ساعة) وجلسات منتهية
function cleanup() {
  const cutoff = new Date(Date.now() - 48 * 3600000).toISOString();
  for (const u of db.prepare('SELECT id FROM uploads WHERE updated_at < ?').all(cutoff)) {
    try { fs.unlinkSync(path.join(config.uploadTmpDir, u.id)); } catch {}
    db.prepare('DELETE FROM uploads WHERE id = ?').run(u.id);
  }
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
  db.prepare('DELETE FROM voter_sessions WHERE expires_at < ?').run(now());
  db.prepare('DELETE FROM view_events WHERE day < ?').run(new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10));
}

function main() {
  bootstrapAdmin();
  const router = new Router();
  require('./src/routes-public').register(router);
  require('./src/routes-admin').register(router);
  require('./src/voting').register(router);
  require('./src/routes-roster-judge').register(router);
  require('./src/routes-extra').register(router);
  router.get('/healthz', (req, res) => sendJson(res, 200, { ok: true, storage: storage.name, ffprobe: media.hasProbe, ffmpeg: media.hasMpeg, oidc: require('./src/oidc').enabled() }));

  const notFoundPage = fs.readFileSync(path.join(PUBLIC_DIR, '404.html'));

  const server = http.createServer(async (req, res) => {
    securityHeaders(res);
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end(); }
    const pathname = url.pathname;
    try {
      // حماية من الطلبات العابرة للمواقع على واجهات الكتابة
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && pathname.startsWith('/api/')) {
        const origin = req.headers.origin;
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        let originHost = null;
        try { originHost = origin ? new URL(origin).host : null; } catch { originHost = 'invalid'; }
        if (origin && originHost !== host && (!config.publicUrl || origin !== new URL(config.publicUrl).origin)) {
          throw new HttpError(403, 'مصدر الطلب غير مسموح.');
        }
      }
      const m = router.match(req.method, pathname);
      if (m) return await m.handler(req, res, { params: m.params, query: url.searchParams });
      if ((req.method === 'GET' || req.method === 'HEAD') && !pathname.startsWith('/api/') && serveStatic(req, res, pathname)) return;
      if (pathname.startsWith('/api/')) throw new HttpError(404, 'المسار غير موجود.');
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(notFoundPage);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(`[${now()}] ${req.method} ${pathname}`, err);
      if (res.headersSent) { try { res.end(); } catch {} return; }
      sendJson(res, status, { error: status >= 500 ? 'حدث خطأ غير متوقع في الخادم، حاول مجددًا.' : err.message, ...(err.extra || {}) });
    }
  });
  server.requestTimeout = 10 * 60 * 1000;
  server.headersTimeout = 60 * 1000;
  server.keepAliveTimeout = 65 * 1000;

  cleanup();
  setInterval(cleanup, 3600000).unref();

  server.listen(config.port, config.host, () => {
    console.log(`✦ منصة «قارئ المدرسة» تعمل على http://localhost:${config.port}`);
    console.log(`  التخزين: ${storage.name} | ffprobe: ${media.hasProbe ? 'متاح' : 'غير متاح'} | ffmpeg: ${media.hasMpeg ? 'متاح' : 'غير متاح'}`);
  });
  const shutdown = () => { server.close(() => { try { db.close(); } catch {} process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[2] === 'create-admin') createAdminCli();
else main();
