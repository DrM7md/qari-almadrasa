'use strict';
const crypto = require('node:crypto');
const { db, now, tx, audit, getAllSettings, setSetting, DEFAULT_SETTINGS } = require('./db');
const { HttpError, sendJson, readJson } = require('./http');
const sec = require('./security');
const storage = require('./storage');
const { phases, mediaUrls } = require('./logic');
const xlsx = require('./xlsx');
const { categoryOf, computeResults } = require('./results');
const { streamMedia, tokenHash, newEntryToken, clean } = require('./routes-public');

const SESSION_HOURS = 12;
const ROLE_RANK = { judge: 0, reviewer: 1, admin: 2, owner: 3 };
const ROLE_AR = { judge: 'محكّم', reviewer: 'مراجع', admin: 'مدير', owner: 'المالك' };

function getSession(req) {
  const tok = sec.parseCookies(req).qa_s;
  if (!tok) return null;
  const row = db.prepare(`SELECT s.*, a.username, a.display_name, a.role, a.active, a.can_manage_votes FROM sessions s JOIN admins a ON a.id = s.admin_id
    WHERE s.token_hash = ?`).get(sec.sha256(tok));
  if (!row || !row.active || row.expires_at < now()) return null;
  return row;
}

// يتطلب جلسة صالحة + صلاحية كافية + رمز CSRF لأي طلب يغيّر البيانات
function guard(minRole, handler) {
  return async (req, res, ctx) => {
    const s = getSession(req);
    if (!s) throw new HttpError(401, 'انتهت الجلسة، يرجى تسجيل الدخول.');
    if (ROLE_RANK[s.role] < ROLE_RANK[minRole]) throw new HttpError(403, 'لا تملك صلاحية تنفيذ هذا الإجراء.');
    if (req.method !== 'GET' && req.method !== 'HEAD' && !sec.safeEqual(req.headers['x-csrf-token'] || '', s.csrf)) throw new HttpError(403, 'رمز الحماية غير صالح، حدّث الصفحة.');
    return handler(req, res, { ...ctx, admin: s });
  };
}

function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // منع حقن الصيغ في Excel
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function sendCsv(res, name, header, rows) {
  const body = '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendXlsx(res, name, sheets) {
  const buf = xlsx.build(sheets);
  res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${name}"`, 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
}
const canManageVotes = (a) => a.role === 'owner' || !!a.can_manage_votes;

function adminContestant(c, votes = {}) {
  const m = c.video_key ? { video: `/media/admin/v/${c.id}`, poster: c.poster_key ? `/media/admin/p/${c.id}` : null } : { video: null, poster: null };
  return {
    id: c.id, entry_no: c.entry_no, full_name: c.full_name, display_name: c.display_name, school_id: c.school_id,
    grade: c.grade, section: c.section, title: c.title, status: c.status, reject_reason: c.reject_reason, disqualify_reason: c.disqualify_reason,
    category: categoryOf(c.grade, getAllSettings()).name,
    guardian_consent: !!c.guardian_consent, featured: !!c.featured, views: c.views,
    video_size: c.video_size, video_duration: c.video_duration, video_uploaded_at: c.video_uploaded_at,
    created_at: c.created_at, reviewed_at: c.reviewed_at, reviewed_by: c.reviewer_name || null,
    votes_valid: votes.valid || 0, votes_flagged: votes.flagged || 0, ...m,
    public_url: c.status === 'approved' ? mediaUrls(c).video : null,
  };
}

function voteCounts(season) {
  const out = {};
  for (const r of db.prepare('SELECT contestant_id id, status, COUNT(*) n FROM votes WHERE season = ? GROUP BY contestant_id, status').all(season)) {
    (out[r.id] ||= {})[r.status] = r.n;
  }
  return out;
}

// ———— التحقق من الإعدادات ————
const isoOrNull = (v) => { if (!v) return null; const d = new Date(v); if (isNaN(d)) throw new HttpError(422, 'تاريخ غير صالح.'); return d.toISOString(); };
const strList = (v, max = 40, len = 300) => {
  if (!Array.isArray(v)) throw new HttpError(422, 'قائمة غير صالحة.');
  return v.map((x) => clean(x, len)).filter(Boolean).slice(0, max);
};
const SETTING_RULES = {
  season: (v) => { const s = clean(v, 20); if (!s) throw new HttpError(422, 'رمز الموسم مطلوب.'); return s; },
  school_name: (v) => clean(v, 80),
  hero_subtitle: (v) => clean(v, 200),
  about_text: (v) => clean(v, 1500),
  footer_note: (v) => clean(v, 150),
  goals: (v) => strList(v, 12),
  terms: (v) => strList(v, 30, 500),
  grades: (v) => { const l = strList(v, 30, 50); if (!l.length) throw new HttpError(422, 'أضف صفًا واحدًا على الأقل.'); return l; },
  sections: (v) => { const l = strList(v, 40, 15); if (!l.length) throw new HttpError(422, 'أضف شعبة واحدة على الأقل.'); return l; },
  registration_mode: (v) => (['auto', 'open', 'closed'].includes(v) ? v : 'auto'),
  voting_mode: (v) => (['auto', 'open', 'closed'].includes(v) ? v : 'auto'),
  registration_start: isoOrNull, registration_end: isoOrNull, voting_start: isoOrNull, voting_end: isoOrNull,
  max_video_mb: (v) => Math.min(Math.max(Math.round(Number(v) || 0), 5), 2048),
  max_video_seconds: (v) => Math.min(Math.max(Math.round(Number(v) || 0), 20), 3600),
  min_video_seconds: (v) => Math.min(Math.max(Math.round(Number(v) || 0), 0), 600),
  allowed_formats: (v) => { const l = strList(v, 7, 5).map((x) => x.toLowerCase()).filter((x) => ['mp4', 'mov', 'm4v', 'webm', 'mpeg', 'mpg', 'mp3'].includes(x)); if (!l.length) throw new HttpError(422, 'اختر صيغة واحدة على الأقل.'); return [...new Set(l)]; },
  allow_replace: Boolean, allow_resubmit_rejected: Boolean, require_guardian_consent: Boolean,
  show_class_publicly: Boolean, show_vote_counts: Boolean, show_views: Boolean, show_results: Boolean,
  prevent_self_vote: Boolean, allow_vote_change: Boolean, vote_restrict_to_category: Boolean, judging_enabled: Boolean,
  voter_auth: (v) => (v === 'oidc' ? 'oidc' : 'pin'),
  competition_name: (v) => clean(v, 100),
  public_results_detail: (v) => (['winners', 'winners_scores', 'full'].includes(v) ? v : 'winners'),
  certificates_enabled: Boolean,
  retention_days: (v) => Math.min(Math.max(Math.round(Number(v) || 0), 7), 3650),
  guardian_consent_text: (v) => clean(v, 500),
  privacy_policy: (v) => strList(v, 40, 800),
  results_mode: (v) => (['votes', 'judges', 'mixed'].includes(v) ? v : 'mixed'),
  judge_weight: (v) => Math.min(Math.max(Number(v) || 0, 0), 100),
  vote_weight: (v) => Math.min(Math.max(Number(v) || 0, 0), 100),
  vote_normalization: (v) => (v === 'top' ? 'top' : 'share'),
  winner_scope: (v) => (v === 'school' ? 'school' : 'category'),
  winners_count: (v) => Math.min(Math.max(Math.round(Number(v) || 1), 1), 20),
  judging_assignment: (v) => (v === 'manual' ? 'manual' : 'all'),
  judging_completion: (v) => (v === 'minimum' ? 'minimum' : 'all_assigned'),
  min_judges_required: (v) => Math.min(Math.max(Math.round(Number(v) || 1), 1), 20),
  judging_criteria: (v) => {
    if (!Array.isArray(v) || !v.length) throw new HttpError(422, 'أضف معيار تحكيم واحدًا على الأقل.');
    const ids = new Set();
    return v.slice(0, 12).map((c, i) => {
      const id = (clean(c.id, 20) || `k${i + 1}`).replace(/[^a-zA-Z0-9_]/g, '') || `k${i + 1}`;
      if (ids.has(id)) throw new HttpError(422, 'معرّفات المعايير مكررة.'); ids.add(id);
      const max = Number(c.max);
      if (!(max > 0 && max <= 1000)) throw new HttpError(422, 'درجة كل معيار يجب أن تكون بين 1 و1000.');
      const name = clean(c.name, 60); if (!name) throw new HttpError(422, 'اسم المعيار مطلوب.');
      return { id, name, max };
    });
  },
  categories: (v) => {
    if (!Array.isArray(v)) throw new HttpError(422, 'فئات غير صالحة.');
    return v.slice(0, 20).map((c, i) => ({ id: clean(c.id, 20) || `c${i + 1}`, name: clean(c.name, 60) || `فئة ${i + 1}`, grades: strList(c.grades || [], 30, 50) }));
  },
  stages: (v) => {
    if (!Array.isArray(v)) throw new HttpError(422, 'مراحل غير صالحة.');
    return v.slice(0, 10).map((st, i) => ({
      id: clean(st.id, 20) || `s${i + 1}`, title: clean(st.title, 80) || `المرحلة ${i + 1}`, description: clean(st.description, 300),
      start: isoOrNull(st.start), end: isoOrNull(st.end), status: ['auto', 'upcoming', 'active', 'done'].includes(st.status) ? st.status : 'auto',
    }));
  },
};

function register(router) {
  // ———— الدخول والخروج ————
  router.post('/api/admin/login', async (req, res) => {
    const rl = sec.rateLimit('login:' + sec.clientIp(req), 10, 15 * 60000);
    if (!rl.ok) throw new HttpError(429, 'محاولات كثيرة، حاول بعد قليل.');
    const b = await readJson(req, 2048);
    const username = clean(b.username, 60);
    const a = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
    if (a && a.locked_until && a.locked_until > now()) throw new HttpError(423, 'الحساب مقفل مؤقتًا بسبب محاولات خاطئة متكررة. حاول بعد 15 دقيقة.');
    if (!a || !a.active || !sec.verifyPassword(String(b.password || ''), a.password_hash)) {
      if (a) {
        const f = a.failed_logins + 1;
        db.prepare('UPDATE admins SET failed_logins = ?, locked_until = ? WHERE id = ?').run(f >= 5 ? 0 : f, f >= 5 ? new Date(Date.now() + 15 * 60000).toISOString() : null, a.id);
        if (f >= 5) audit(a.id, 'lockout', a.username);
      }
      throw new HttpError(401, 'اسم المستخدم أو كلمة المرور غير صحيحة.');
    }
    const tok = sec.randomToken(32);
    const csrf = sec.randomToken(24);
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
    db.prepare('INSERT INTO sessions(token_hash, admin_id, csrf, ip_hash, expires_at, created_at) VALUES(?,?,?,?,?,?)')
      .run(sec.sha256(tok), a.id, csrf, sec.hmac(sec.clientIp(req), 'ip'), new Date(Date.now() + SESSION_HOURS * 3600000).toISOString(), now());
    db.prepare('UPDATE admins SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?').run(now(), a.id);
    audit(a.id, 'login', a.username);
    res.setHeader('Set-Cookie', sec.cookie('qa_s', tok, { maxAge: SESSION_HOURS * 3600, sameSite: 'Strict' }));
    sendJson(res, 200, { ok: true, csrf, admin: { id: a.id, username: a.username, display_name: a.display_name, role: a.role } });
  });

  router.post('/api/admin/logout', (req, res) => {
    const tok = sec.parseCookies(req).qa_s;
    if (tok) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sec.sha256(tok));
    res.setHeader('Set-Cookie', sec.cookie('qa_s', '', { maxAge: 0, sameSite: 'Strict' }));
    sendJson(res, 200, { ok: true });
  });

  router.get('/api/admin/me', (req, res) => {
    const s = getSession(req);
    if (!s) throw new HttpError(401, 'غير مسجّل الدخول.');
    sendJson(res, 200, { csrf: s.csrf, admin: { id: s.admin_id, username: s.username, display_name: s.display_name, role: s.role, role_ar: ROLE_AR[s.role], can_manage_votes: !!s.can_manage_votes } });
  });

  router.post('/api/admin/password', guard('judge', async (req, res, { admin }) => {
    const b = await readJson(req, 2048);
    const a = db.prepare('SELECT * FROM admins WHERE id = ?').get(admin.admin_id);
    if (!sec.verifyPassword(String(b.current || ''), a.password_hash)) throw new HttpError(403, 'كلمة المرور الحالية غير صحيحة.');
    const p = sec.passwordProblems(b.next); if (p) throw new HttpError(422, p);
    db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(sec.hashPassword(b.next), a.id);
    db.prepare('DELETE FROM sessions WHERE admin_id = ? AND token_hash != ?').run(a.id, admin.token_hash);
    audit(a.id, 'password_change', a.username);
    sendJson(res, 200, { ok: true });
  }));

  // ———— لوحة المعلومات ————
  router.get('/api/admin/dashboard', guard('reviewer', (req, res) => {
    const s = getAllSettings();
    const by = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM contestants WHERE season = ? GROUP BY status').all(s.season).map((r) => [r.status, r.n]));
    const votes = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM votes WHERE season = ? GROUP BY status').all(s.season).map((r) => [r.status, r.n]));
    const voters = db.prepare("SELECT COUNT(DISTINCT student_id) n FROM votes WHERE season = ? AND status = 'valid'").get(s.season).n;
    const eligible = db.prepare('SELECT COUNT(*) n FROM students WHERE season = ? AND active = 1').get(s.season).n;
    const withPin = db.prepare('SELECT COUNT(*) n FROM students WHERE season = ? AND active = 1 AND pin_hash IS NOT NULL').get(s.season).n;
    const views = db.prepare('SELECT COALESCE(SUM(views),0) n FROM contestants WHERE season = ?').get(s.season).n;
    const uploaded = db.prepare('SELECT COUNT(*) n FROM contestants WHERE season = ? AND video_key IS NOT NULL').get(s.season).n;
    const byGrade = db.prepare("SELECT grade, COUNT(*) n FROM contestants WHERE season = ? GROUP BY grade ORDER BY n DESC").all(s.season);
    const byCat = {};
    for (const g of byGrade) { const c = categoryOf(g.grade, s).name; byCat[c] = (byCat[c] || 0) + g.n; }
    const perDay = db.prepare("SELECT substr(created_at,1,10) d, COUNT(*) n FROM votes WHERE season = ? AND status = 'valid' GROUP BY d ORDER BY d DESC LIMIT 14").all(s.season).reverse();
    const perContestant = db.prepare(`SELECT c.entry_no, c.display_name, c.grade, c.views, COUNT(v.id) n FROM contestants c
      LEFT JOIN votes v ON v.contestant_id = c.id AND v.status = 'valid' WHERE c.season = ? AND c.status = 'approved'
      GROUP BY c.id ORDER BY n DESC, c.entry_no`).all(s.season).map((r) => ({ ...r, category: categoryOf(r.grade, s).name }));
    const attempts24 = db.prepare('SELECT COUNT(*) n FROM vote_attempts WHERE season = ? AND created_at > ?').get(s.season, new Date(Date.now() - 86400000).toISOString()).n;
    const evals = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM evaluations WHERE season = ? GROUP BY status').all(s.season).map((r) => [r.status, r.n]));
    sendJson(res, 200, {
      season: s.season, phases: phases(s),
      contestants: { draft: by.draft || 0, pending: by.pending || 0, approved: by.approved || 0, rejected: by.rejected || 0, disqualified: by.disqualified || 0, archived: by.archived || 0 },
      registered: Object.values(by).reduce((a, b) => a + b, 0), uploaded,
      votes: { valid: votes.valid || 0, replaced: votes.replaced || 0, void: votes.void || 0 },
      voters, eligible, with_pin: withPin, participation: eligible ? Math.round((voters / eligible) * 1000) / 10 : 0,
      views, by_grade: byGrade, by_category: Object.entries(byCat).map(([name, n]) => ({ name, n })), votes_per_day: perDay,
      per_contestant: perContestant, top: perContestant.slice(0, 10), attempts_24h: attempts24,
      evaluations: { draft: evals.draft || 0, submitted: evals.submitted || 0 },
      retention_due: (() => { const e = Date.parse(s.voting_end); return isNaN(e) ? null : new Date(e + s.retention_days * 86400000).toISOString(); })(),
      demo: !!s.demo_mode,
    });
  }));

  // ———— المشاركات ————
  router.get('/api/admin/contestants', guard('reviewer', (req, res, { query }) => {
    const s = getAllSettings();
    const where = ['c.season = ?']; const args = [s.season];
    const st = query.get('status');
    if (['draft', 'pending', 'approved', 'rejected', 'disqualified', 'archived'].includes(st)) { where.push('c.status = ?'); args.push(st); }
    const q = clean(query.get('q'), 60);
    if (q) { where.push('(c.full_name LIKE ? OR c.display_name LIKE ? OR c.school_id LIKE ? OR c.title LIKE ? OR CAST(c.entry_no AS TEXT) = ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, q); }
    const g = clean(query.get('grade'), 60);
    if (g) { where.push('c.grade = ?'); args.push(g); }
    const rows = db.prepare(`SELECT c.*, a.display_name reviewer_name FROM contestants c LEFT JOIN admins a ON a.id = c.reviewed_by
      WHERE ${where.join(' AND ')} ORDER BY CASE c.status WHEN 'pending' THEN 0 WHEN 'draft' THEN 2 ELSE 1 END, c.entry_no DESC LIMIT 1000`).all(...args);
    const vc = voteCounts(s.season);
    sendJson(res, 200, { items: rows.map((c) => adminContestant(c, vc[c.id])) });
  }));

  const getC = (id) => {
    const c = db.prepare('SELECT c.*, a.display_name reviewer_name FROM contestants c LEFT JOIN admins a ON a.id = c.reviewed_by WHERE c.id = ?').get(Number(id));
    if (!c) throw new HttpError(404, 'المشاركة غير موجودة.');
    return c;
  };

  router.patch('/api/admin/contestants/:id', guard('reviewer', async (req, res, { params, admin }) => {
    const c = getC(params.id);
    const b = await readJson(req, 4096);
    const s = getAllSettings();
    const upd = {};
    if (b.display_name !== undefined) { const v = clean(b.display_name, 60); if (v.length < 2) throw new HttpError(422, 'الاسم المعتمد للنشر قصير جدًا.'); upd.display_name = v; }
    if (b.full_name !== undefined) { const v = clean(b.full_name, 90); if (v.length < 5) throw new HttpError(422, 'الاسم الكامل غير صالح.'); upd.full_name = v; }
    if (b.title !== undefined) { const v = clean(b.title, 100); if (v.length < 2) throw new HttpError(422, 'عنوان التلاوة مطلوب.'); upd.title = v; }
    if (b.grade !== undefined) { if (!s.grades.includes(b.grade)) throw new HttpError(422, 'صف غير صالح.'); upd.grade = b.grade; }
    if (b.section !== undefined) { if (!s.sections.includes(b.section)) throw new HttpError(422, 'شعبة غير صالحة.'); upd.section = b.section; }
    if (b.featured !== undefined) upd.featured = b.featured ? 1 : 0;
    if (b.school_id !== undefined) {
      if (ROLE_RANK[admin.role] < 2) throw new HttpError(403, 'تعديل الرقم الشخصي متاح للمدير فقط.');
      const v = clean(b.school_id, 20).toUpperCase();
      if (!/^[A-Z0-9\-]{3,20}$/.test(v)) throw new HttpError(422, 'رقم شخصي غير صالح.');
      if (db.prepare('SELECT id FROM contestants WHERE season = ? AND school_id = ? AND id != ?').get(c.season, v, c.id)) throw new HttpError(409, 'الرقم الشخصي مستخدم في مشاركة أخرى.');
      upd.school_id = v;
    }
    const keys = Object.keys(upd);
    if (!keys.length) return sendJson(res, 200, { ok: true });
    db.prepare(`UPDATE contestants SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => upd[k]), now(), c.id);
    audit(admin.admin_id, 'contestant_edit', c.entry_no, upd);
    sendJson(res, 200, { ok: true, item: adminContestant(getC(c.id), voteCounts(c.season)[c.id]) });
  }));

  router.post('/api/admin/contestants/:id/review', guard('reviewer', async (req, res, { params, admin }) => {
    const c = getC(params.id);
    const b = await readJson(req, 4096);
    const ts = now();
    const reason = clean(b.reason, 500);
    if (b.decision === 'approve') {
      if (!c.video_key) throw new HttpError(409, 'لا يوجد مقطع مرفوع لهذه المشاركة بعد.');
      db.prepare("UPDATE contestants SET status = 'approved', reject_reason = NULL, disqualify_reason = NULL, reviewed_at = ?, reviewed_by = ?, updated_at = ? WHERE id = ?").run(ts, admin.admin_id, ts, c.id);
      audit(admin.admin_id, 'approve', c.entry_no);
    } else if (b.decision === 'reject') {
      if (!c.video_key) throw new HttpError(409, 'لا يوجد مقطع مرفوع لهذه المشاركة بعد.');
      if (reason.length < 3) throw new HttpError(422, 'يجب كتابة سبب الرفض.');
      db.prepare("UPDATE contestants SET status = 'rejected', reject_reason = ?, featured = 0, reviewed_at = ?, reviewed_by = ?, updated_at = ? WHERE id = ?").run(reason, ts, admin.admin_id, ts, c.id);
      audit(admin.admin_id, 'reject', c.entry_no, { reason });
    } else if (b.decision === 'disqualify') {
      if (ROLE_RANK[admin.role] < 2) throw new HttpError(403, 'استبعاد المتسابقين متاح للمدير فقط.');
      if (reason.length < 3) throw new HttpError(422, 'يجب كتابة سبب الاستبعاد.');
      // تُلغى أصوات المتسابق المستبعد ويستعيد أصحابها حقّهم في التصويت
      tx(() => {
        db.prepare("UPDATE contestants SET status = 'disqualified', disqualify_reason = ?, featured = 0, reviewed_at = ?, reviewed_by = ?, updated_at = ? WHERE id = ?").run(reason, ts, admin.admin_id, ts, c.id);
        db.prepare("UPDATE votes SET status = 'void', status_reason = 'استبعاد المتسابق', updated_at = ? WHERE contestant_id = ? AND status = 'valid'").run(ts, c.id);
      });
      audit(admin.admin_id, 'disqualify', c.entry_no, { reason });
    } else if (b.decision === 'pending') {
      if (c.status === 'disqualified' && ROLE_RANK[admin.role] < 2) throw new HttpError(403, 'إلغاء الاستبعاد متاح للمدير فقط.');
      db.prepare("UPDATE contestants SET status = ?, featured = 0, disqualify_reason = NULL, reviewed_at = NULL, reviewed_by = NULL, updated_at = ? WHERE id = ?").run(c.video_key ? 'pending' : 'draft', ts, c.id);
      audit(admin.admin_id, c.status === 'disqualified' ? 'reinstate' : 'unpublish', c.entry_no);
    } else throw new HttpError(400, 'قرار غير معروف.');
    sendJson(res, 200, { ok: true, item: adminContestant(getC(c.id), voteCounts(c.season)[c.id]) });
  }));

  router.post('/api/admin/contestants/:id/reset-token', guard('reviewer', (req, res, { params, admin }) => {
    const c = getC(params.id);
    const token = newEntryToken();
    db.prepare('UPDATE contestants SET token_hash = ?, updated_at = ? WHERE id = ?').run(tokenHash(token), now(), c.id);
    audit(admin.admin_id, 'reset_token', c.entry_no);
    sendJson(res, 200, { ok: true, token, entry_no: c.entry_no });
  }));

  router.delete('/api/admin/contestants/:id', guard('admin', async (req, res, { params, admin }) => {
    const c = getC(params.id);
    db.prepare('DELETE FROM contestants WHERE id = ?').run(c.id);
    await storage.remove(c.video_key); await storage.remove(c.poster_key);
    audit(admin.admin_id, 'contestant_delete', c.entry_no, { name: c.full_name, school_id: c.school_id });
    sendJson(res, 200, { ok: true });
  }));

  router.get('/media/admin/:kind/:id', guard('reviewer', (req, res, { params }) => {
    const c = getC(params.id);
    const key = params.kind === 'p' ? c.poster_key : c.video_key;
    if (!key) throw new HttpError(404, 'لا يوجد ملف.');
    streamMedia(req, res, key, params.kind === 'p' ? 'image/jpeg' : c.video_mime);
  }));

  // ———— الأصوات (سرية الاقتراع: لا تُكشف هوية المصوّت إلا لصاحب صلاحية إدارة الأصوات) ————
  router.get('/api/admin/votes', guard('admin', (req, res, { query, admin }) => {
    const s = getAllSettings();
    const where = ['v.season = ?']; const args = [s.season];
    const st = query.get('status');
    if (['valid', 'replaced', 'void'].includes(st)) { where.push('v.status = ?'); args.push(st); }
    const e = Number(query.get('entry'));
    if (e) { where.push('c.entry_no = ?'); args.push(e); }
    const full = canManageVotes(admin);
    const rows = db.prepare(`SELECT v.id, v.status, v.status_reason, v.method, v.created_at, v.updated_at, c.entry_no, c.display_name,
        st.school_id, st.full_name, st.grade, v.student_id, substr(v.ip_hash,1,8) ip
      FROM votes v JOIN contestants c ON c.id = v.contestant_id JOIN students st ON st.id = v.student_id
      WHERE ${where.join(' AND ')} ORDER BY v.id DESC LIMIT 500`).all(...args)
      .map((r) => (full ? r : { ...r, school_id: null, full_name: null, student_ref: sec.hmac(r.student_id, 'sref').slice(0, 8), student_id: undefined }));
    sendJson(res, 200, { items: rows, identities_visible: full });
  }));

  router.get('/api/admin/vote-attempts', guard('admin', (req, res, { query, admin }) => {
    const s = getAllSettings();
    const kind = clean(query.get('kind'), 30);
    const rows = db.prepare(`SELECT a.id, a.kind, a.entered_id, a.created_at, substr(a.ip_hash,1,8) ip, a.user_agent, a.student_id,
        st.school_id, st.full_name, c.entry_no FROM vote_attempts a LEFT JOIN students st ON st.id = a.student_id LEFT JOIN contestants c ON c.id = a.contestant_id
      WHERE a.season = ? ${kind ? 'AND a.kind = ?' : ''} ORDER BY a.id DESC LIMIT 500`).all(...(kind ? [s.season, kind] : [s.season]));
    const summary = db.prepare('SELECT kind, COUNT(*) n FROM vote_attempts WHERE season = ? GROUP BY kind ORDER BY n DESC').all(s.season);
    // الطلاب الأكثر محاولات مرفوضة (مؤشر على حالات تستحق المراجعة)
    const suspects = db.prepare(`SELECT st.id, st.school_id, st.full_name, COUNT(*) n, GROUP_CONCAT(DISTINCT a.kind) kinds FROM vote_attempts a JOIN students st ON st.id = a.student_id
      WHERE a.season = ? AND a.kind IN ('duplicate','self_vote','bad_pin','locked','category','rate_limited') GROUP BY st.id HAVING n >= 3 ORDER BY n DESC LIMIT 50`).all(s.season);
    const full = canManageVotes(admin);
    const mask = (r) => (full ? r : { ...r, school_id: r.school_id ? '•••' + String(r.school_id).slice(-2) : null, full_name: r.full_name ? r.full_name.split(' ')[0] + ' …' : null, entered_id: r.entered_id ? '•••' : null });
    sendJson(res, 200, { items: rows.map(mask), summary, suspects: suspects.map(mask), identities_visible: full });
  }));

  // تعديل حالة الأصوات: صلاحية خاصة + سبب إلزامي + سجل تدقيق
  router.post('/api/admin/votes/status', guard('admin', async (req, res, { admin }) => {
    if (!canManageVotes(admin)) throw new HttpError(403, 'تعديل الأصوات يتطلب صلاحية «إدارة الأصوات» الخاصة.');
    const b = await readJson(req, 64 * 1024);
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Number.isInteger).slice(0, 1000);
    if (!ids.length || !['valid', 'void'].includes(b.status)) throw new HttpError(400, 'طلب غير صالح.');
    const reason = clean(b.reason, 200);
    if (reason.length < 3) throw new HttpError(422, 'سبب التعديل إلزامي.');
    const skipped = [];
    tx(() => {
      for (const id of ids) {
        const v = db.prepare('SELECT * FROM votes WHERE id = ?').get(id);
        if (!v || v.status === b.status) continue;
        if (b.status === 'valid' && db.prepare("SELECT id FROM votes WHERE season = ? AND student_id = ? AND status = 'valid'").get(v.season, v.student_id)) { skipped.push(id); continue; }
        db.prepare('UPDATE votes SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?').run(b.status, `${reason} — ${admin.display_name}`, now(), id);
        audit(admin.admin_id, 'vote_' + b.status, 'vote#' + id, { from: v.status, reason, contestant_id: v.contestant_id });
      }
    });
    sendJson(res, 200, { ok: true, skipped, message: skipped.length ? `تُرك ${skipped.length} صوت لأن أصحابها لديهم أصوات صحيحة أخرى.` : 'تم التحديث.' });
  }));

  // ———— النتائج: احتساب، اعتماد، إلغاء اعتماد ————
  router.get('/api/admin/results', guard('reviewer', (req, res) => {
    const s = getAllSettings();
    const snap = require('./results').activeSnapshot(s.season);
    sendJson(res, 200, { live: computeResults(s), snapshot: snap ? { id: snap.snapshot_id, approved_at: snap.approved_at, data: snap } : null, show_results: !!s.show_results });
  }));

  router.post('/api/admin/results/approve', guard('admin', async (req, res, { admin }) => {
    const s = getAllSettings();
    const r = computeResults(s);
    if (!r.ready) throw new HttpError(409, 'لا يمكن اعتماد النتائج قبل استيفاء الشروط.', { issues: r.issues });
    tx(() => {
      db.prepare('UPDATE result_snapshots SET active = 0 WHERE season = ?').run(s.season);
      db.prepare('INSERT INTO result_snapshots(season, data, approved_by, approved_at, active) VALUES(?,?,?,?,1)').run(s.season, JSON.stringify(r), admin.admin_id, now());
    });
    audit(admin.admin_id, 'results_approve', s.season, { mode: r.mode, weights: r.weights, contestants: r.totals.contestants });
    sendJson(res, 200, { ok: true });
  }));

  router.post('/api/admin/results/revoke', guard('admin', (req, res, { admin }) => {
    const s = getAllSettings();
    db.prepare('UPDATE result_snapshots SET active = 0 WHERE season = ?').run(s.season);
    setSetting('show_results', false);
    audit(admin.admin_id, 'results_revoke', s.season);
    sendJson(res, 200, { ok: true });
  }));

  router.post('/api/admin/results/publish', guard('admin', async (req, res, { admin }) => {
    const b = await readJson(req, 1024);
    const s = getAllSettings();
    if (b.publish && !require('./results').activeSnapshot(s.season)) throw new HttpError(409, 'اعتمد النتائج أولًا.');
    setSetting('show_results', !!b.publish);
    audit(admin.admin_id, b.publish ? 'results_publish' : 'results_hide', s.season);
    sendJson(res, 200, { ok: true });
  }));

  // ———— التحكم السريع بالتصويت ————
  router.post('/api/admin/voting/state', guard('admin', async (req, res, { admin }) => {
    const b = await readJson(req, 1024);
    const mode = ['auto', 'open', 'closed'].includes(b.mode) ? b.mode : null;
    if (!mode) throw new HttpError(400, 'حالة غير صالحة.');
    setSetting('voting_mode', mode);
    audit(admin.admin_id, 'voting_' + mode, '');
    sendJson(res, 200, { ok: true, phases: phases(getAllSettings()) });
  }));

  // ———— شعار المدرسة ————
  router.post('/api/admin/logo', guard('admin', async (req, res, { admin }) => {
    const { readBody } = require('./http');
    const buf = await readBody(req, 1024 * 1024);
    let ext = null, mime = null;
    if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') { ext = 'png'; mime = 'image/png'; }
    else if (buf[0] === 0xff && buf[1] === 0xd8) { ext = 'jpg'; mime = 'image/jpeg'; }
    else if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') { ext = 'webp'; mime = 'image/webp'; }
    if (!ext) throw new HttpError(415, 'الشعار يجب أن يكون صورة PNG أو JPG أو WEBP (حتى 1 م.ب).');
    const fs = require('node:fs'); const path = require('node:path');
    const tmp = path.join(require('./config').uploadTmpDir, 'logo-' + sec.randomToken(6));
    fs.writeFileSync(tmp, buf);
    const key = `branding/logo-${sec.randomToken(6)}.${ext}`;
    await storage.putFile(tmp, key, mime);
    const old = getAllSettings().school_logo;
    setSetting('school_logo', { key, mime, v: Date.now().toString(36) });
    if (old && old.key) await storage.remove(old.key);
    audit(admin.admin_id, 'logo_update', key);
    sendJson(res, 200, { ok: true });
  }));
  router.delete('/api/admin/logo', guard('admin', async (req, res, { admin }) => {
    const old = getAllSettings().school_logo;
    setSetting('school_logo', null);
    if (old && old.key) await storage.remove(old.key);
    audit(admin.admin_id, 'logo_remove', '');
    sendJson(res, 200, { ok: true });
  }));

  // ———— الإعدادات ————
  router.get('/api/admin/settings', guard('reviewer', (req, res) => sendJson(res, 200, { settings: getAllSettings(), defaults: DEFAULT_SETTINGS })));

  router.put('/api/admin/settings', guard('admin', async (req, res, { admin }) => {
    const b = await readJson(req, 128 * 1024);
    const changed = {};
    const cur = getAllSettings();
    if (b.judging_criteria && JSON.stringify(SETTING_RULES.judging_criteria(b.judging_criteria)) !== JSON.stringify(cur.judging_criteria)) {
      const n = db.prepare("SELECT COUNT(*) n FROM evaluations WHERE season = ? AND status = 'submitted'").get(cur.season).n;
      if (n) throw new HttpError(409, `لا يمكن تعديل معايير التحكيم بعد اعتماد ${n} تقييم. أعد فتح التقييمات أولًا أو ابدأ موسمًا جديدًا.`);
    }
    if (b.show_results === true && !require('./results').activeSnapshot(b.season || cur.season)) throw new HttpError(409, 'يجب اعتماد النتائج من تبويب «النتائج» قبل إعلانها للجمهور.');
    for (const [k, v] of Object.entries(b || {})) {
      if (!SETTING_RULES[k]) continue;
      const val = SETTING_RULES[k](v);
      setSetting(k, val); changed[k] = val;
    }
    const s = getAllSettings();
    if (s.min_video_seconds >= s.max_video_seconds) { setSetting('min_video_seconds', 0); }
    // ضمان أن كل الصفوف المعرّفة لها فئة
    if (changed.grades && !changed.categories) {
      const known = new Set((s.categories || []).flatMap((c) => c.grades));
      const missing = s.grades.filter((g) => !known.has(g));
      if (missing.length && s.categories.length) { s.categories[s.categories.length - 1].grades.push(...missing); setSetting('categories', s.categories); }
    }
    audit(admin.admin_id, 'settings_update', Object.keys(changed).join(','));
    sendJson(res, 200, { ok: true, settings: getAllSettings() });
  }));

  // ———— المشرفون والمحكّمون ————
  router.get('/api/admin/admins', guard('admin', (req, res) => {
    sendJson(res, 200, { items: db.prepare('SELECT id, username, display_name, role, active, can_manage_votes, last_login_at, created_at FROM admins ORDER BY id').all() });
  }));

  router.post('/api/admin/admins', guard('admin', async (req, res, { admin }) => {
    const b = await readJson(req, 2048);
    const username = clean(b.username, 40);
    if (!/^[A-Za-z0-9_.\-]{3,40}$/.test(username)) throw new HttpError(422, 'اسم المستخدم: 3–40 حرفًا لاتينيًا أو أرقامًا.');
    const role = ['reviewer', 'admin', 'judge'].includes(b.role) ? b.role : 'reviewer';
    if (role === 'admin' && admin.role !== 'owner') throw new HttpError(403, 'إضافة مدير متاحة للمالك فقط.');
    const p = sec.passwordProblems(b.password); if (p) throw new HttpError(422, p);
    if (db.prepare('SELECT id FROM admins WHERE username = ?').get(username)) throw new HttpError(409, 'اسم المستخدم مستخدم مسبقًا.');
    db.prepare('INSERT INTO admins(username, display_name, password_hash, role, created_at) VALUES(?,?,?,?,?)')
      .run(username, clean(b.display_name, 60) || username, sec.hashPassword(b.password), role, now());
    audit(admin.admin_id, 'admin_create', username, { role });
    sendJson(res, 201, { ok: true });
  }));

  router.patch('/api/admin/admins/:id', guard('admin', async (req, res, { params, admin }) => {
    const target = db.prepare('SELECT * FROM admins WHERE id = ?').get(Number(params.id));
    if (!target) throw new HttpError(404, 'غير موجود.');
    if (target.role === 'owner' && admin.role !== 'owner') throw new HttpError(403, 'لا يمكن تعديل حساب المالك.');
    if (target.role === 'admin' && admin.role !== 'owner' && target.id !== admin.admin_id) throw new HttpError(403, 'تعديل المديرين متاح للمالك فقط.');
    const b = await readJson(req, 2048);
    if (b.active !== undefined) {
      if (target.id === admin.admin_id) throw new HttpError(409, 'لا يمكنك تعطيل حسابك.');
      db.prepare('UPDATE admins SET active = ? WHERE id = ?').run(b.active ? 1 : 0, target.id);
      if (!b.active) db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(target.id);
    }
    if (b.role !== undefined && target.role !== 'owner') {
      if (admin.role !== 'owner') throw new HttpError(403, 'تغيير الصلاحيات متاح للمالك فقط.');
      db.prepare('UPDATE admins SET role = ? WHERE id = ?').run(['admin', 'judge'].includes(b.role) ? b.role : 'reviewer', target.id);
      db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(target.id);
    }
    if (b.can_manage_votes !== undefined) {
      if (admin.role !== 'owner') throw new HttpError(403, 'منح صلاحية إدارة الأصوات متاح للمالك فقط.');
      if (target.role !== 'admin') throw new HttpError(409, 'تُمنح صلاحية إدارة الأصوات للمديرين فقط.');
      db.prepare('UPDATE admins SET can_manage_votes = ? WHERE id = ?').run(b.can_manage_votes ? 1 : 0, target.id);
    }
    if (b.password) {
      const p = sec.passwordProblems(b.password); if (p) throw new HttpError(422, p);
      db.prepare('UPDATE admins SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?').run(sec.hashPassword(b.password), target.id);
      db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(target.id);
    }
    audit(admin.admin_id, 'admin_update', target.username, { active: b.active, role: b.role, can_manage_votes: b.can_manage_votes, password: !!b.password });
    sendJson(res, 200, { ok: true });
  }));

  router.get('/api/admin/audit', guard('admin', (req, res) => {
    const rows = db.prepare('SELECT l.*, a.display_name admin_name FROM audit_log l LEFT JOIN admins a ON a.id = l.admin_id ORDER BY l.id DESC LIMIT 300').all();
    sendJson(res, 200, { items: rows });
  }));

  // ———— التصدير (Excel و CSV) ————
  const STATUS_AR = { draft: 'مسودة (بلا فيديو)', pending: 'بانتظار المراجعة', approved: 'معتمد ومنشور', rejected: 'مرفوض', disqualified: 'مستبعد', archived: 'مؤرشف (حُذف الفيديو)' };
  function contestantsTable() {
    const s = getAllSettings();
    const vc = voteCounts(s.season);
    const rows = db.prepare('SELECT * FROM contestants WHERE season = ? ORDER BY entry_no').all(s.season);
    return {
      s, count: rows.length,
      header: ['رقم المشاركة', 'الاسم الكامل', 'الاسم المعتمد للنشر', 'الرقم الشخصي', 'الصف', 'الشعبة', 'الفئة', 'عنوان التلاوة', 'الحالة', 'سبب الرفض/الاستبعاد', 'موافقة ولي الأمر', 'المدة (ث)', 'المشاهدات', 'الأصوات الصحيحة', 'تاريخ التسجيل'],
      rows: rows.map((c) => [c.entry_no, c.full_name, c.display_name, c.school_id, c.grade, c.section, categoryOf(c.grade, s).name, c.title, STATUS_AR[c.status], c.disqualify_reason || c.reject_reason || '', c.guardian_consent ? 'نعم' : 'لا',
        c.video_duration ? Math.round(c.video_duration) : '', c.views, (vc[c.id] && vc[c.id].valid) || 0, c.created_at.slice(0, 16).replace('T', ' ')]),
    };
  }
  function resultsTables() {
    const s = getAllSettings();
    const snap = require('./results').activeSnapshot(s.season);
    const r = snap || computeResults(s);
    const header = ['الفئة', 'المركز', 'فائز', 'رقم المشاركة', 'الاسم الكامل', 'الاسم المعتمد', 'الصف', 'الشعبة', 'التلاوة', 'الأصوات الصحيحة', 'نسبة التصويت %', 'درجة التحكيم /100', 'تقييمات معتمدة', 'الدرجة النهائية', 'المعادلة'];
    const rows = [];
    for (const g of r.groups) for (const x of g.rows) rows.push([g.name, x.rank, x.winner ? 'نعم' : '', x.entry_no, x.full_name, x.display_name, x.grade, x.section, x.title, x.votes, x.vote_pct, x.judge_pct, `${x.judges_submitted}/${x.judges_required}`, x.score, x.formula]);
    return { s, status: snap ? `معتمدة في ${snap.approved_at}` : 'غير معتمدة (احتساب حي)', header, rows, r };
  }

  router.get('/api/admin/export/contestants.csv', guard('admin', (req, res, { admin }) => {
    const t = contestantsTable(); audit(admin.admin_id, 'export_contestants', t.count, { format: 'csv' });
    sendCsv(res, `contestants-${t.s.season}.csv`, t.header, t.rows);
  }));
  router.get('/api/admin/export/contestants.xlsx', guard('admin', (req, res, { admin }) => {
    const t = contestantsTable(); audit(admin.admin_id, 'export_contestants', t.count, { format: 'xlsx' });
    sendXlsx(res, `contestants-${t.s.season}.xlsx`, [{ name: 'المتسابقون', header: t.header, rows: t.rows }]);
  }));
  router.get('/api/admin/export/results.csv', guard('admin', (req, res, { admin }) => {
    const t = resultsTables(); audit(admin.admin_id, 'export_results', t.rows.length, { format: 'csv' });
    sendCsv(res, `results-${t.s.season}.csv`, t.header, t.rows);
  }));
  router.get('/api/admin/export/results.xlsx', guard('admin', (req, res, { admin }) => {
    const t = resultsTables(); audit(admin.admin_id, 'export_results', t.rows.length, { format: 'xlsx' });
    sendXlsx(res, `results-${t.s.season}.xlsx`, [
      { name: 'النتائج', header: t.header, rows: t.rows },
      { name: 'طريقة الاحتساب', header: ['البند', 'القيمة'], rows: [['حالة النتائج', t.status], ['الوضع', { votes: 'تصويت الطلاب فقط', judges: 'لجنة التحكيم فقط', mixed: 'مختلط' }[t.r.mode]], ['وزن التحكيم %', t.r.weights.judge], ['وزن التصويت %', t.r.weights.vote], ...t.r.formula.map((f, i) => [`المعادلة ${i + 1}`, f]), ...t.r.tie_rules.map((f, i) => [`قاعدة التعادل ${i + 1}`, f])] },
    ]);
  }));
  router.get('/api/admin/export/students.xlsx', guard('admin', (req, res, { admin }) => {
    const s = getAllSettings();
    const rows = db.prepare(`SELECT st.*, EXISTS(SELECT 1 FROM votes v WHERE v.student_id = st.id AND v.status = 'valid') voted FROM students st WHERE st.season = ? ORDER BY st.grade, st.section, st.full_name`).all(s.season);
    audit(admin.admin_id, 'export_students', rows.length);
    sendXlsx(res, `students-${s.season}.xlsx`, [{ name: 'الطلاب المؤهلون', header: ['الرقم الشخصي', 'الاسم', 'الصف', 'الشعبة', 'البريد المدرسي', 'رمز شخصي مُصدَر', 'صوّت', 'نشط'],
      rows: rows.map((r) => [r.school_id, r.full_name, r.grade, r.section, r.email || '', r.pin_hash ? 'نعم' : 'لا', r.voted ? 'نعم' : 'لا', r.active ? 'نعم' : 'لا']) }]);
  }));
}

module.exports = { register, getSession, guard, ROLE_RANK };
