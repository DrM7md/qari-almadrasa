'use strict';
/**
 * التصويت الموثّق: لا يصوّت إلا طالب مدرج في القائمة المعتمدة وبعد التحقق من هويته.
 * - التحقق: الرقم المدرسي + رمز شخصي سري تصدره المدرسة، أو حساب المدرسة (OIDC).
 * - صوت صحيح واحد لكل طالب مفروض بقيد فريد في قاعدة البيانات، مهما تغيّر الجهاز أو المتصفح.
 * - كل التحققات والاحتساب في الخادم داخل معاملة قاعدة بيانات واحدة.
 */
const crypto = require('node:crypto');
const config = require('./config');
const { db, now, tx, getAllSettings } = require('./db');
const { HttpError, sendJson, readJson } = require('./http');
const sec = require('./security');
const oidc = require('./oidc');
const { phases } = require('./logic');
const { categoryOf } = require('./results');

const SESSION_MIN = 120;
const MAX_FAILS = 5, LOCK_MIN = 30;
const PIN_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const normId = (v) => String(v || '').replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x660).replace(/[۰-۹]/g, (d) => d.charCodeAt(0) - 0x6F0).replace(/\s/g, '').toUpperCase().slice(0, 30);
const normPin = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const pinHash = (pin, studentId) => sec.hmac(`${studentId}:${normPin(pin)}`, 'pin');

function newPin() {
  let s = ''; for (const b of crypto.randomBytes(6)) s += PIN_ALPHABET[b % PIN_ALPHABET.length];
  return `${s.slice(0, 3)}-${s.slice(3)}`;
}

function logAttempt(req, kind, { student_id = null, entered_id = null, contestant_id = null } = {}) {
  db.prepare('INSERT INTO vote_attempts(season, kind, student_id, entered_id, contestant_id, ip_hash, user_agent, created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(getAllSettings().season, kind, student_id, entered_id ? String(entered_id).slice(0, 30) : null, contestant_id,
      sec.hmac(sec.clientIp(req), 'ip'), String(req.headers['user-agent'] || '').slice(0, 200), now());
}

function limit(req, key, n, ms, kind) {
  const r = sec.rateLimit(`${key}:${sec.clientIp(req)}`, n, ms);
  if (!r.ok) {
    if (kind && r.retryAfter && sec.rateLimit(`log:${key}:${sec.clientIp(req)}`, 1, 60000).ok) logAttempt(req, kind);
    throw new HttpError(429, 'محاولات كثيرة جدًا. انتظر قليلًا ثم حاول مجددًا.');
  }
}

function createSession(res, studentId, method) {
  const tok = sec.randomToken(32);
  db.prepare('DELETE FROM voter_sessions WHERE expires_at < ?').run(now());
  db.prepare('INSERT INTO voter_sessions(token_hash, student_id, method, expires_at, created_at) VALUES(?,?,?,?,?)')
    .run(sec.sha256(tok), studentId, method, new Date(Date.now() + SESSION_MIN * 60000).toISOString(), now());
  res.setHeader('Set-Cookie', sec.cookie('qvs', tok, { maxAge: SESSION_MIN * 60, sameSite: 'Lax' }));
}

function getVoter(req) {
  const tok = sec.parseCookies(req).qvs;
  if (!tok) return null;
  const row = db.prepare(`SELECT vs.method, vs.expires_at, st.* FROM voter_sessions vs JOIN students st ON st.id = vs.student_id WHERE vs.token_hash = ?`).get(sec.sha256(tok));
  if (!row || row.expires_at < now() || !row.active || row.season !== getAllSettings().season) return null;
  return row;
}

const firstName = (n) => String(n || '').split(' ')[0];

function myVote(student, s) {
  return db.prepare(`SELECT v.id, v.created_at, c.entry_no, c.display_name, c.status FROM votes v JOIN contestants c ON c.id = v.contestant_id
    WHERE v.season = ? AND v.student_id = ? AND v.status = 'valid'`).get(s.season, student.id) || null;
}

function register(router) {
  router.get('/api/vote/me', (req, res) => {
    const s = getAllSettings();
    const ph = phases(s);
    const v = getVoter(req);
    const base = {
      voting_open: ph.votingOpen, auth: s.voter_auth, oidc_available: s.voter_auth === 'oidc' && oidc.enabled(), oidc_label: oidc.label(),
      allow_change: !!s.allow_vote_change, prevent_self_vote: !!s.prevent_self_vote, restrict_category: !!s.vote_restrict_to_category,
    };
    if (!v) return sendJson(res, 200, { ...base, authenticated: false });
    const mv = myVote(v, s);
    const own = db.prepare('SELECT entry_no FROM contestants WHERE season = ? AND school_id = ?').get(s.season, v.school_id);
    sendJson(res, 200, {
      ...base, authenticated: true,
      student: { first_name: firstName(v.full_name), grade: v.grade, category: categoryOf(v.grade, s).name, category_id: categoryOf(v.grade, s).id },
      own_entry: own ? own.entry_no : null,
      voted: mv ? { entry_no: mv.entry_no, name: mv.display_name, at: mv.created_at } : null,
    });
  });

  // ———— الدخول بالرقم المدرسي + الرمز الشخصي ————
  router.post('/api/vote/login', async (req, res) => {
    limit(req, 'vlogin', 25, 15 * 60000, 'rate_limited');
    const b = await readJson(req, 2048);
    const s = getAllSettings();
    if (b.website) { logAttempt(req, 'bot'); throw new HttpError(400, 'طلب غير صالح.'); }
    if (s.voter_auth !== 'pin') throw new HttpError(400, 'طريقة الدخول هذه غير مفعّلة.');
    const sid = normId(b.school_id);
    const generic = 'الرقم المدرسي أو الرمز الشخصي غير صحيح.';
    if (!sid || !normPin(b.pin)) throw new HttpError(422, 'أدخل الرقم المدرسي والرمز الشخصي.');
    const st = db.prepare('SELECT * FROM students WHERE season = ? AND school_id = ?').get(s.season, sid);
    if (!st || !st.active) { logAttempt(req, 'unknown_student', { entered_id: sid }); throw new HttpError(401, generic); }
    if (st.locked_until && st.locked_until > now()) { logAttempt(req, 'locked', { student_id: st.id }); throw new HttpError(423, `تم إيقاف الدخول مؤقتًا بسبب محاولات خاطئة متكررة. حاول بعد ${LOCK_MIN} دقيقة أو راجع لجنة المسابقة.`); }
    if (!st.pin_hash || !sec.safeEqual(st.pin_hash, pinHash(b.pin, st.id))) {
      const f = st.failed + 1;
      db.prepare('UPDATE students SET failed = ?, locked_until = ? WHERE id = ?').run(f >= MAX_FAILS ? 0 : f, f >= MAX_FAILS ? new Date(Date.now() + LOCK_MIN * 60000).toISOString() : null, st.id);
      logAttempt(req, f >= MAX_FAILS ? 'locked' : 'bad_pin', { student_id: st.id });
      throw new HttpError(401, generic);
    }
    db.prepare('UPDATE students SET failed = 0, locked_until = NULL WHERE id = ?').run(st.id);
    createSession(res, st.id, 'pin');
    sendJson(res, 200, { ok: true, first_name: firstName(st.full_name) });
  });

  router.post('/api/vote/logout', (req, res) => {
    const tok = sec.parseCookies(req).qvs;
    if (tok) db.prepare('DELETE FROM voter_sessions WHERE token_hash = ?').run(sec.sha256(tok));
    res.setHeader('Set-Cookie', sec.cookie('qvs', '', { maxAge: 0 }));
    sendJson(res, 200, { ok: true });
  });

  // ———— الدخول بحساب المدرسة (OIDC) ————
  const redirectUri = (req) => `${config.publicUrl || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`}/auth/school/callback`;
  router.get('/auth/school/start', async (req, res, { query }) => {
    const s = getAllSettings();
    if (s.voter_auth !== 'oidc' || !oidc.enabled()) throw new HttpError(404, 'الدخول بحساب المدرسة غير مفعّل.');
    limit(req, 'oidc', 30, 15 * 60000);
    const a = await oidc.authUrl(redirectUri(req));
    const back = /^\/[a-z0-9/?=&-]*$/i.test(query.get('return') || '') ? query.get('return') : '/contestants';
    const payload = Buffer.from(JSON.stringify({ st: a.state, n: a.nonce, v: a.verifier, r: back, t: Date.now() })).toString('base64url');
    res.setHeader('Set-Cookie', sec.cookie('qoidc', `${payload}.${sec.hmac(payload, 'oidc').slice(0, 32)}`, { maxAge: 600, sameSite: 'Lax' }));
    res.writeHead(302, { Location: a.url }); res.end();
  });

  router.get('/auth/school/callback', async (req, res, { query }) => {
    const fail = (msg) => { res.writeHead(302, { Location: '/contestants?login_error=' + encodeURIComponent(msg) }); res.end(); };
    const raw = sec.parseCookies(req).qoidc || '';
    const [payload, sig] = raw.split('.');
    res.setHeader('Set-Cookie', sec.cookie('qoidc', '', { maxAge: 0, sameSite: 'Lax' }));
    if (!payload || !sig || !sec.safeEqual(sig, sec.hmac(payload, 'oidc').slice(0, 32))) return fail('انتهت جلسة الدخول، حاول مجددًا.');
    const st = JSON.parse(Buffer.from(payload, 'base64url'));
    if (Date.now() - st.t > 600000 || query.get('state') !== st.st || !query.get('code')) return fail('طلب دخول غير صالح.');
    let ident;
    try { ident = await oidc.exchange(query.get('code'), redirectUri(req), st.v, st.n); }
    catch (e) { logAttempt(req, 'oidc_failed', { entered_id: e.message }); return fail(e.message === 'domain' ? 'يجب استخدام حساب المدرسة الرسمي.' : 'تعذّر التحقق من حساب المدرسة.'); }
    const s = getAllSettings();
    const student = db.prepare('SELECT * FROM students WHERE season = ? AND email = ? AND active = 1').get(s.season, ident.email);
    if (!student) { logAttempt(req, 'unknown_student', { entered_id: ident.email }); return fail('حسابك غير موجود في قائمة الطلاب المؤهلين للتصويت.'); }
    createSession(res, student.id, 'oidc');
    // يجب إرسال ملف الجلسة مع ملف مسح قيم الدخول المؤقتة
    res.setHeader('Set-Cookie', [res.getHeader('Set-Cookie'), sec.cookie('qoidc', '', { maxAge: 0, sameSite: 'Lax' })].flat());
    res.writeHead(302, { Location: st.r }); res.end();
  });

  // ———— التصويت ————
  router.post('/api/vote', async (req, res) => {
    limit(req, 'vote', 40, 60000, 'rate_limited');
    const b = await readJson(req, 2048);
    const s = getAllSettings();
    const v = getVoter(req);
    if (b.website) { logAttempt(req, 'bot', { student_id: v && v.id }); throw new HttpError(400, 'طلب غير صالح.'); }
    if (!v) { logAttempt(req, 'unauthenticated'); throw new HttpError(401, 'يجب التحقق من هويتك قبل التصويت.', { need_login: true }); }
    const r2 = sec.rateLimit(`vote-student:${v.id}`, 6, 60000);
    if (!r2.ok) { logAttempt(req, 'rate_limited', { student_id: v.id }); throw new HttpError(429, 'محاولات كثيرة جدًا، انتظر دقيقة.'); }
    const entry = Number(b.entry_no);

    // تُسجَّل المحاولة المرفوضة بعد التراجع عن المعاملة حتى لا تُلغى مع الإلغاء
    const deny = (kind, cid, status, msg) => { const e = new HttpError(status, msg); e.attempt = { kind, contestant_id: cid }; throw e; };
    let result;
    try { result = tx(() => {
      const fresh = getAllSettings();
      if (!phases(fresh).votingOpen) deny('closed', null, 403, 'التصويت مغلق حاليًا.');
      const c = db.prepare("SELECT id, entry_no, school_id, grade, display_name FROM contestants WHERE season = ? AND entry_no = ? AND status = 'approved'").get(s.season, entry);
      if (!c) throw new HttpError(404, 'المشاركة غير موجودة أو غير متاحة للتصويت.');
      if (fresh.prevent_self_vote && c.school_id === v.school_id) {
        deny('self_vote', c.id, 403, 'لا يمكنك التصويت لمشاركتك.');
      }
      if (fresh.vote_restrict_to_category && categoryOf(c.grade, fresh).id !== categoryOf(v.grade, fresh).id) {
        deny('category', c.id, 403, 'يمكنك التصويت لمتسابقي فئتك فقط.');
      }
      const existing = db.prepare("SELECT * FROM votes WHERE season = ? AND student_id = ? AND status = 'valid'").get(s.season, v.id);
      const ts = now();
      const ip = sec.hmac(sec.clientIp(req), 'ip');
      if (existing) {
        if (existing.contestant_id === c.id) throw new HttpError(409, 'صوتك مسجّل لهذا القارئ بالفعل.');
        if (!fresh.allow_vote_change) {
          deny('duplicate', c.id, 409, 'لقد سجّلت صوتك مسبقًا، ولا يمكن تعديله بعد اعتماده.');
        }
        db.prepare("UPDATE votes SET status = 'replaced', status_reason = 'عدّله الطالب', updated_at = ? WHERE id = ?").run(ts, existing.id);
      }
      try {
        db.prepare('INSERT INTO votes(season, contestant_id, student_id, method, status, ip_hash, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)')
          .run(s.season, c.id, v.id, v.method, 'valid', ip, ts, ts);
      } catch (e) {
        // القيد الفريد في قاعدة البيانات يمنع أي احتساب مزدوج حتى مع الطلبات المتزامنة
        if (/UNIQUE/i.test(e.message)) deny('duplicate', c.id, 409, 'لقد سجّلت صوتك مسبقًا.');
        throw e;
      }
      return { changed: !!existing, entry_no: c.entry_no, name: c.display_name };
    }); }
    catch (e) { if (e.attempt) logAttempt(req, e.attempt.kind, { student_id: v.id, contestant_id: e.attempt.contestant_id }); throw e; }
    sendJson(res, 200, { ok: true, message: result.changed ? 'تم تعديل صوتك بنجاح.' : 'تم تسجيل صوتك بنجاح', voted: result });
  });
}

module.exports = { register, newPin, pinHash, normId, getVoter, logAttempt };
