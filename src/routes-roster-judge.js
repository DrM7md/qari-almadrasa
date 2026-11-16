'use strict';
/** قائمة الطلاب المؤهلين للتصويت + نظام لجنة التحكيم */
const { db, now, tx, audit, getAllSettings } = require('./db');
const { HttpError, sendJson, readJson } = require('./http');
const sec = require('./security');
const { guard } = require('./routes-admin');
const { streamMedia, clean } = require('./routes-public');
const { newPin, pinHash, normId } = require('./voting');
const { categoryOf, judgingSummary, activeJudges } = require('./results');

const STUDENT_FIELDS = 'id, school_id, full_name, grade, section, email, active, failed, locked_until, pin_set_at, created_at';

function register(router) {
  // ═════════════ الطلاب المؤهلون ═════════════
  router.get('/api/admin/students', guard('admin', (req, res, { query }) => {
    const s = getAllSettings();
    const where = ['st.season = ?']; const args = [s.season];
    const q = clean(query.get('q'), 60);
    if (q) { where.push('(st.full_name LIKE ? OR st.school_id LIKE ? OR st.email LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    const g = clean(query.get('grade'), 60);
    if (g) { where.push('st.grade = ?'); args.push(g); }
    const f = query.get('filter');
    if (f === 'voted') where.push("EXISTS(SELECT 1 FROM votes v WHERE v.student_id = st.id AND v.status = 'valid')");
    if (f === 'not_voted') where.push("NOT EXISTS(SELECT 1 FROM votes v WHERE v.student_id = st.id AND v.status = 'valid')");
    if (f === 'no_pin') where.push('st.pin_hash IS NULL');
    if (f === 'locked') where.push('st.locked_until > ?'), args.push(now());
    if (f === 'inactive') where.push('st.active = 0');
    const rows = db.prepare(`SELECT ${STUDENT_FIELDS.split(', ').map((x) => 'st.' + x).join(', ')}, st.pin_hash IS NOT NULL AS has_pin,
        EXISTS(SELECT 1 FROM votes v WHERE v.student_id = st.id AND v.status = 'valid') AS voted
      FROM students st WHERE ${where.join(' AND ')} ORDER BY st.grade, st.section, st.full_name LIMIT 3000`).all(...args);
    const totals = db.prepare(`SELECT COUNT(*) total, SUM(active) active, SUM(CASE WHEN pin_hash IS NOT NULL THEN 1 ELSE 0 END) with_pin,
        (SELECT COUNT(DISTINCT student_id) FROM votes WHERE season = ? AND status = 'valid') voted FROM students WHERE season = ?`).get(s.season, s.season);
    sendJson(res, 200, { items: rows.map((r) => ({ ...r, locked: !!(r.locked_until && r.locked_until > now()), category: categoryOf(r.grade, s).name })), totals });
  }));

  // استيراد القائمة المعتمدة (من ملف CSV يحوَّل في المتصفح إلى صفوف)
  router.post('/api/admin/students/import', guard('admin', async (req, res, { admin }) => {
    const b = await readJson(req, 4 * 1024 * 1024);
    const s = getAllSettings();
    const rows = Array.isArray(b.rows) ? b.rows.slice(0, 10000) : [];
    if (!rows.length) throw new HttpError(422, 'الملف لا يحتوي على صفوف.');
    const errors = []; let added = 0, updated = 0;
    const grades = new Set(s.grades);
    tx(() => {
      const find = db.prepare('SELECT id FROM students WHERE season = ? AND school_id = ?');
      const ins = db.prepare('INSERT INTO students(season, school_id, full_name, grade, section, email, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)');
      const upd = db.prepare('UPDATE students SET full_name = ?, grade = ?, section = ?, email = COALESCE(?, email), active = 1, updated_at = ? WHERE id = ?');
      const seen = new Set();
      rows.forEach((r, i) => {
        const line = i + 2;
        const sid = normId(r.school_id);
        const name = clean(r.full_name, 90);
        const grade = clean(r.grade, 60);
        const section = clean(r.section, 20);
        const email = clean(r.email, 120).toLowerCase() || null;
        if (!/^[A-Z0-9\-]{3,20}$/.test(sid)) return errors.push(`السطر ${line}: رقم شخصي غير صالح «${sid}».`);
        if (seen.has(sid)) return errors.push(`السطر ${line}: الرقم الشخصي ${sid} مكرر في الملف.`);
        seen.add(sid);
        if (name.length < 3) return errors.push(`السطر ${line}: الاسم مطلوب.`);
        if (!grades.has(grade)) return errors.push(`السطر ${line}: الصف «${grade}» غير موجود في إعدادات الصفوف.`);
        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return errors.push(`السطر ${line}: بريد غير صالح.`);
        const ex = find.get(s.season, sid);
        try {
          if (ex) { upd.run(name, grade, section, email, now(), ex.id); updated++; }
          else { ins.run(s.season, sid, name, grade, section, email, now(), now()); added++; }
        } catch (e) { errors.push(`السطر ${line}: ${/UNIQUE/.test(e.message) ? 'البريد مستخدم لطالب آخر.' : 'خطأ في الحفظ.'}`); }
      });
      if (b.deactivate_missing) {
        const list = [...seen];
        if (list.length) db.prepare(`UPDATE students SET active = 0, updated_at = ? WHERE season = ? AND school_id NOT IN (${list.map(() => '?').join(',')})`).run(now(), s.season, ...list);
      }
    });
    audit(admin.admin_id, 'students_import', `${added}+${updated}`, { errors: errors.length, deactivate_missing: !!b.deactivate_missing });
    sendJson(res, 200, { ok: true, added, updated, errors: errors.slice(0, 200) });
  }));

  router.post('/api/admin/students', guard('admin', async (req, res, { admin }) => {
    const b = await readJson(req, 4096);
    const s = getAllSettings();
    const sid = normId(b.school_id), name = clean(b.full_name, 90);
    if (!/^[A-Z0-9\-]{3,20}$/.test(sid) || name.length < 3 || !s.grades.includes(b.grade)) throw new HttpError(422, 'تحقق من الرقم الشخصي والاسم والصف.');
    try {
      db.prepare('INSERT INTO students(season, school_id, full_name, grade, section, email, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(s.season, sid, name, b.grade, clean(b.section, 20), clean(b.email, 120).toLowerCase() || null, now(), now());
    } catch (e) { throw new HttpError(409, /email/.test(e.message) ? 'البريد مستخدم.' : 'الرقم الشخصي موجود مسبقًا.'); }
    audit(admin.admin_id, 'student_add', sid);
    sendJson(res, 201, { ok: true });
  }));

  router.patch('/api/admin/students/:id', guard('admin', async (req, res, { params, admin }) => {
    const st = db.prepare('SELECT * FROM students WHERE id = ?').get(Number(params.id));
    if (!st) throw new HttpError(404, 'غير موجود.');
    const b = await readJson(req, 4096);
    if (b.active !== undefined) {
      db.prepare('UPDATE students SET active = ?, updated_at = ? WHERE id = ?').run(b.active ? 1 : 0, now(), st.id);
      if (!b.active) db.prepare('DELETE FROM voter_sessions WHERE student_id = ?').run(st.id);
    }
    if (b.unlock) db.prepare('UPDATE students SET failed = 0, locked_until = NULL WHERE id = ?').run(st.id);
    if (b.email !== undefined) {
      const e = clean(b.email, 120).toLowerCase() || null;
      try { db.prepare('UPDATE students SET email = ?, updated_at = ? WHERE id = ?').run(e, now(), st.id); } catch { throw new HttpError(409, 'البريد مستخدم لطالب آخر.'); }
    }
    audit(admin.admin_id, 'student_update', st.school_id, b);
    sendJson(res, 200, { ok: true });
  }));

  router.delete('/api/admin/students/:id', guard('admin', (req, res, { params, admin }) => {
    const st = db.prepare('SELECT * FROM students WHERE id = ?').get(Number(params.id));
    if (!st) throw new HttpError(404, 'غير موجود.');
    if (db.prepare('SELECT 1 FROM votes WHERE student_id = ?').get(st.id)) throw new HttpError(409, 'لا يمكن حذف طالب له صوت مسجّل؛ يمكنك تعطيله بدلًا من ذلك.');
    db.prepare('DELETE FROM students WHERE id = ?').run(st.id);
    audit(admin.admin_id, 'student_delete', st.school_id);
    sendJson(res, 200, { ok: true });
  }));

  // إصدار الرموز الشخصية: تُعرض مرة واحدة فقط لطباعتها وتوزيعها، ولا تُخزَّن إلا مشفّرة
  router.post('/api/admin/students/pins', guard('admin', async (req, res, { admin }) => {
    const b = await readJson(req, 512 * 1024);
    const s = getAllSettings();
    let rows;
    if (b.scope === 'missing') rows = db.prepare('SELECT * FROM students WHERE season = ? AND active = 1 AND pin_hash IS NULL ORDER BY grade, section, full_name').all(s.season);
    else if (b.scope === 'all') rows = db.prepare('SELECT * FROM students WHERE season = ? AND active = 1 ORDER BY grade, section, full_name').all(s.season);
    else {
      const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Number.isInteger).slice(0, 5000);
      rows = ids.length ? db.prepare(`SELECT * FROM students WHERE season = ? AND id IN (${ids.map(() => '?').join(',')})`).all(s.season, ...ids) : [];
    }
    if (!rows.length) throw new HttpError(422, 'لا يوجد طلاب مطابقون لإصدار رموز لهم.');
    const out = [];
    tx(() => {
      const upd = db.prepare('UPDATE students SET pin_hash = ?, pin_set_at = ?, failed = 0, locked_until = NULL WHERE id = ?');
      for (const r of rows) { const pin = newPin(); upd.run(pinHash(pin, r.id), now(), r.id); out.push({ school_id: r.school_id, full_name: r.full_name, grade: r.grade, section: r.section, pin }); }
      db.prepare(`DELETE FROM voter_sessions WHERE student_id IN (${rows.map(() => '?').join(',')})`).run(...rows.map((r) => r.id));
    });
    audit(admin.admin_id, 'pins_issue', `${out.length} students`, { scope: b.scope || 'selected' });
    sendJson(res, 200, { ok: true, pins: out });
  }));

  // ═════════════ لجنة التحكيم ═════════════
  router.get('/api/admin/judging', guard('reviewer', (req, res) => {
    const s = getAllSettings();
    const { judges, summary } = judgingSummary(s);
    const contestants = db.prepare("SELECT id, entry_no, display_name, grade, title FROM contestants WHERE season = ? AND status = 'approved' ORDER BY entry_no").all(s.season);
    const assignments = db.prepare('SELECT judge_id, contestant_id FROM judge_assignments').all();
    const evals = db.prepare('SELECT judge_id, contestant_id, status, total, max_total, submitted_at FROM evaluations WHERE season = ?').all(s.season);
    sendJson(res, 200, {
      criteria: s.judging_criteria, assignment: s.judging_assignment, completion: s.judging_completion, min_required: s.min_judges_required, enabled: !!s.judging_enabled,
      judges, assignments,
      contestants: contestants.map((c) => ({ ...c, category: categoryOf(c.grade, s).name, ...summary.get(c.id),
        evaluations: evals.filter((e) => e.contestant_id === c.id).map((e) => ({ judge_id: e.judge_id, status: e.status, pct: e.max_total ? Math.round((e.total / e.max_total) * 10000) / 100 : 0, submitted_at: e.submitted_at })) })),
    });
  }));

  router.post('/api/admin/judging/assign', guard('admin', async (req, res, { admin }) => {
    const b = await readJson(req, 256 * 1024);
    const judge = db.prepare("SELECT id FROM admins WHERE id = ? AND role = 'judge'").get(Number(b.judge_id));
    if (!judge) throw new HttpError(404, 'المحكّم غير موجود.');
    const ids = (Array.isArray(b.contestant_ids) ? b.contestant_ids : []).map(Number).filter(Number.isInteger);
    tx(() => {
      db.prepare('DELETE FROM judge_assignments WHERE judge_id = ?').run(judge.id);
      const ins = db.prepare('INSERT OR IGNORE INTO judge_assignments(judge_id, contestant_id) VALUES(?,?)');
      for (const id of ids) ins.run(judge.id, id);
    });
    audit(admin.admin_id, 'judge_assign', judge.id, { count: ids.length });
    sendJson(res, 200, { ok: true });
  }));

  // إعادة فتح تقييم معتمد (لتصحيح خطأ) — يُسجَّل في سجل العمليات
  router.post('/api/admin/evaluations/reopen', guard('admin', async (req, res, { admin }) => {
    const b = await readJson(req, 2048);
    const reason = clean(b.reason, 200);
    if (reason.length < 3) throw new HttpError(422, 'سبب إعادة الفتح إلزامي.');
    const e = db.prepare('SELECT * FROM evaluations WHERE judge_id = ? AND contestant_id = ?').get(Number(b.judge_id), Number(b.contestant_id));
    if (!e || e.status !== 'submitted') throw new HttpError(404, 'لا يوجد تقييم معتمد.');
    db.prepare("UPDATE evaluations SET status = 'draft', submitted_at = NULL, updated_at = ? WHERE id = ?").run(now(), e.id);
    audit(admin.admin_id, 'evaluation_reopen', `judge ${e.judge_id} / contestant ${e.contestant_id}`, { reason, previous_total: e.total });
    sendJson(res, 200, { ok: true });
  }));

  // ═════════════ واجهة المحكّم ═════════════
  const isAssigned = (s, judgeId, cid) => s.judging_assignment !== 'manual' || !!db.prepare('SELECT 1 FROM judge_assignments WHERE judge_id = ? AND contestant_id = ?').get(judgeId, cid);
  function judgeGuard(handler) {
    return guard('judge', async (req, res, ctx) => {
      if (ctx.admin.role !== 'judge') throw new HttpError(403, 'هذه الواجهة مخصصة للمحكّمين.');
      const s = getAllSettings();
      if (!s.judging_enabled) throw new HttpError(403, 'نظام التحكيم غير مفعّل حاليًا.');
      return handler(req, res, { ...ctx, s });
    });
  }
  const loadContestant = (s, judgeId, cid) => {
    const c = db.prepare("SELECT * FROM contestants WHERE id = ? AND season = ? AND status = 'approved'").get(Number(cid), s.season);
    if (!c || !isAssigned(s, judgeId, c.id)) throw new HttpError(404, 'هذه المشاركة غير مكلَّف بتقييمها.');
    return c;
  };

  router.get('/api/judge/assignments', judgeGuard((req, res, { admin, s }) => {
    const rows = s.judging_assignment === 'manual'
      ? db.prepare("SELECT c.* FROM contestants c JOIN judge_assignments a ON a.contestant_id = c.id WHERE a.judge_id = ? AND c.season = ? AND c.status = 'approved' ORDER BY c.entry_no").all(admin.admin_id, s.season)
      : db.prepare("SELECT * FROM contestants WHERE season = ? AND status = 'approved' ORDER BY entry_no").all(s.season);
    const mine = new Map(db.prepare('SELECT * FROM evaluations WHERE judge_id = ? AND season = ?').all(admin.admin_id, s.season).map((e) => [e.contestant_id, e]));
    // للمحكّم: الاسم المعتمد فقط، دون الرقم الشخصي أو الاسم الكامل (تحكيم محايد)
    sendJson(res, 200, {
      criteria: s.judging_criteria,
      items: rows.map((c) => { const e = mine.get(c.id); return { id: c.id, entry_no: c.entry_no, display_name: c.display_name, grade: c.grade, category: categoryOf(c.grade, s).name, title: c.title, duration: c.video_duration, status: e ? e.status : 'none', pct: e && e.max_total ? Math.round((e.total / e.max_total) * 10000) / 100 : null }; }),
    });
  }));

  router.get('/api/judge/evaluations/:cid', judgeGuard((req, res, { admin, s, params }) => {
    const c = loadContestant(s, admin.admin_id, params.cid);
    const e = db.prepare('SELECT * FROM evaluations WHERE judge_id = ? AND contestant_id = ?').get(admin.admin_id, c.id);
    let others = null;
    if (e && e.status === 'submitted') {
      // تقييمات بقية المحكّمين تظهر فقط بعد اعتماد المحكّم تقييمه
      others = db.prepare("SELECT e.scores, e.total, e.max_total, e.notes, a.display_name FROM evaluations e JOIN admins a ON a.id = e.judge_id WHERE e.contestant_id = ? AND e.judge_id != ? AND e.status = 'submitted'")
        .all(c.id, admin.admin_id).map((o) => ({ judge: o.display_name, scores: JSON.parse(o.scores), pct: o.max_total ? Math.round((o.total / o.max_total) * 10000) / 100 : 0, notes: o.notes }));
    }
    sendJson(res, 200, {
      contestant: { id: c.id, entry_no: c.entry_no, display_name: c.display_name, grade: c.grade, title: c.title, video: `/media/judge/v/${c.id}`, poster: c.poster_key ? `/media/judge/p/${c.id}` : null },
      criteria: s.judging_criteria,
      evaluation: e ? { scores: JSON.parse(e.scores), notes: e.notes, status: e.status, total: e.total, max_total: e.max_total, submitted_at: e.submitted_at, updated_at: e.updated_at } : null,
      others,
    });
  }));

  router.put('/api/judge/evaluations/:cid', judgeGuard(async (req, res, { admin, s, params }) => {
    const c = loadContestant(s, admin.admin_id, params.cid);
    const b = await readJson(req, 16 * 1024);
    const crit = s.judging_criteria;
    const scores = {}; let total = 0; const maxTotal = crit.reduce((a, k) => a + k.max, 0);
    for (const k of crit) {
      const raw = b.scores ? b.scores[k.id] : undefined;
      if (raw === undefined || raw === null || raw === '') { if (b.submit) throw new HttpError(422, `أدخل درجة «${k.name}» قبل الاعتماد.`); continue; }
      const v = Number(raw);
      if (!isFinite(v) || v < 0 || v > k.max) throw new HttpError(422, `درجة «${k.name}» يجب أن تكون بين 0 و${k.max}.`);
      if (Math.round(v * 4) !== v * 4) throw new HttpError(422, 'الدرجات تقبل الكسور بربع درجة فقط (مثل 7.25 أو 7.5).');
      scores[k.id] = v; total += v;
    }
    const notes = clean(b.notes, 2000);
    const ts = now();
    tx(() => {
      const e = db.prepare('SELECT * FROM evaluations WHERE judge_id = ? AND contestant_id = ?').get(admin.admin_id, c.id);
      if (e && e.status === 'submitted') throw new HttpError(409, 'هذا التقييم معتمد نهائيًا ولا يمكن تعديله. تواصل مع الإدارة لإعادة فتحه.');
      const st = b.submit ? 'submitted' : 'draft';
      if (e) db.prepare('UPDATE evaluations SET scores = ?, notes = ?, total = ?, max_total = ?, status = ?, submitted_at = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(scores), notes, total, maxTotal, st, b.submit ? ts : null, ts, e.id);
      else db.prepare('INSERT INTO evaluations(season, contestant_id, judge_id, scores, notes, total, max_total, status, submitted_at, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(s.season, c.id, admin.admin_id, JSON.stringify(scores), notes, total, maxTotal, st, b.submit ? ts : null, ts, ts);
    });
    if (b.submit) audit(admin.admin_id, 'evaluation_submit', c.entry_no, { total, max: maxTotal });
    sendJson(res, 200, { ok: true, status: b.submit ? 'submitted' : 'draft', total, max_total: maxTotal });
  }));

  router.get('/media/judge/:kind/:id', judgeGuard((req, res, { admin, s, params }) => {
    const c = loadContestant(s, admin.admin_id, params.id);
    const key = params.kind === 'p' ? c.poster_key : c.video_key;
    if (!key) throw new HttpError(404, 'لا يوجد ملف.');
    streamMedia(req, res, key, params.kind === 'p' ? 'image/jpeg' : c.video_mime);
  }));
}

module.exports = { register };
