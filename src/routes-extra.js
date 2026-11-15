'use strict';
/** الشهادات + التحقق منها + إدارة البيانات (الحذف والاحتفاظ) */
const crypto = require('node:crypto');
const config = require('./config');
const { db, now, tx, audit, getAllSettings } = require('./db');
const { HttpError, sendJson, readJson } = require('./http');
const storage = require('./storage');
const { guard } = require('./routes-admin');
const { clean } = require('./routes-public');
const { activeSnapshot, categoryOf } = require('./results');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => { let s = ''; for (const b of crypto.randomBytes(8)) s += CODE_ALPHABET[b % CODE_ALPHABET.length]; return `QC-${s.slice(0, 4)}-${s.slice(4)}`; };

function winnerRow(c, s, requirePublished) {
  if (requirePublished && !s.show_results) return null;
  const snap = activeSnapshot(s.season);
  if (!snap) return null;
  for (const g of snap.groups) for (const r of g.rows) if (r.id === c.id) return r.winner ? { rank: r.rank, category: g.name } : null;
  return null;
}

/** يبني بيانات الشهادة ويسجّلها (أو يعيد السجل السابق) */
function issue(c, s, type, w) {
  const existing = db.prepare('SELECT * FROM certificates WHERE contestant_id = ? AND type = ?').get(c.id, type);
  let rec = existing;
  if (!rec || (type === 'winner' && (rec.rank !== w.rank))) {
    if (rec) db.prepare('DELETE FROM certificates WHERE code = ?').run(rec.code);
    rec = { code: newCode(), type, rank: w ? w.rank : null, category: w ? w.category : categoryOf(c.grade, s).name, issued_at: now() };
    db.prepare('INSERT INTO certificates(code, season, contestant_id, type, rank, category, issued_at) VALUES(?,?,?,?,?,?,?)').run(rec.code, s.season, c.id, type, rec.rank, rec.category, rec.issued_at);
  }
  return {
    type, code: rec.code, rank: rec.rank, category: rec.category, issued_at: rec.issued_at,
    full_name: c.full_name, grade: c.grade, section: c.section, title: c.title, entry_no: c.entry_no,
    competition_name: s.competition_name, school_name: s.school_name, season: s.season,
    verify_url: `${config.publicUrl || ''}/verify?c=${rec.code}`,
  };
}

function available(c, s, requirePublished) {
  const w = winnerRow(c, s, requirePublished);
  const out = [];
  if (c.status === 'approved') out.push('participation');
  if (w && c.status === 'approved') out.push('winner');
  return { list: out, w };
}

function register(router) {
  // ———— شهادة الطالب (بالرقم ورمز المتابعة) ————
  router.post('/api/entry/certificate', async (req, res) => {
    const b = await readJson(req, 2048);
    const { authEntry } = require('./routes-public');
    const { c, s } = authEntry(req, b);
    if (!s.certificates_enabled) throw new HttpError(403, 'إصدار الشهادات غير متاح حاليًا.');
    const { list, w } = available(c, s, true);
    if (!list.length) throw new HttpError(403, 'تصدر الشهادة بعد اعتماد مشاركتك ونشرها.');
    const type = list.includes(b.type) ? b.type : list.includes('winner') ? 'winner' : 'participation';
    sendJson(res, 200, { available: list, certificate: issue(c, s, type, type === 'winner' ? w : null) });
  });

  // ———— شهادة من لوحة الإدارة لأي متسابق معتمد ————
  router.get('/api/admin/contestants/:id/certificate', guard('reviewer', (req, res, { params, query, admin }) => {
    const s = getAllSettings();
    const c = db.prepare('SELECT * FROM contestants WHERE id = ?').get(Number(params.id));
    if (!c) throw new HttpError(404, 'غير موجود.');
    const { list, w } = available(c, s, false);
    if (!list.length) throw new HttpError(409, 'الشهادة تصدر للمشاركات المعتمدة فقط.');
    const type = list.includes(query.get('type')) ? query.get('type') : list.includes('winner') ? 'winner' : 'participation';
    const cert = issue(c, s, type, type === 'winner' ? w : null);
    audit(admin.admin_id, 'certificate_issue', c.entry_no, { type, code: cert.code });
    sendJson(res, 200, { available: list, certificate: cert });
  }));

  // ———— التحقق العام من صحة الشهادة ————
  router.get('/api/public/verify/:code', (req, res, { params }) => {
    const code = clean(params.code, 20).toUpperCase();
    const r = db.prepare(`SELECT ce.*, c.display_name, c.title, c.status FROM certificates ce JOIN contestants c ON c.id = ce.contestant_id WHERE ce.code = ?`).get(code);
    if (!r) return sendJson(res, 200, { valid: false });
    const s = getAllSettings();
    sendJson(res, 200, { valid: true, type: r.type, name: r.display_name, title: r.title, rank: r.rank, category: r.category, season: r.season, issued_at: r.issued_at, competition_name: s.competition_name, school_name: s.school_name });
  });

  // ═════════════ إدارة البيانات والاحتفاظ ═════════════
  router.get('/api/admin/data', guard('admin', (req, res) => {
    const s = getAllSettings();
    const byStatus = db.prepare(`SELECT status, COUNT(*) n, SUM(CASE WHEN video_key IS NOT NULL THEN 1 ELSE 0 END) videos, COALESCE(SUM(video_size),0) bytes FROM contestants WHERE season = ? GROUP BY status`).all(s.season);
    const staleDrafts = db.prepare("SELECT COUNT(*) n FROM contestants WHERE season = ? AND status = 'draft' AND created_at < ?").get(s.season, new Date(Date.now() - 14 * 86400000).toISOString()).n;
    const seasons = db.prepare(`SELECT season, COUNT(*) contestants, SUM(CASE WHEN video_key IS NOT NULL THEN 1 ELSE 0 END) videos, COALESCE(SUM(video_size),0) bytes FROM contestants GROUP BY season ORDER BY season DESC`).all()
      .map((x) => ({ ...x, students: db.prepare('SELECT COUNT(*) n FROM students WHERE season = ?').get(x.season).n, votes: db.prepare('SELECT COUNT(*) n FROM votes WHERE season = ?').get(x.season).n }));
    const end = Date.parse(s.voting_end);
    const due = !isNaN(end) ? new Date(end + s.retention_days * 86400000).toISOString() : null;
    sendJson(res, 200, {
      season: s.season, by_status: byStatus, stale_drafts: staleDrafts, seasons, retention_days: s.retention_days, retention_due: due,
      retention_passed: !!(due && Date.now() > Date.parse(due) && byStatus.some((x) => x.videos > 0)),
      attempts: db.prepare('SELECT COUNT(*) n FROM vote_attempts').get().n,
      has_snapshot: !!activeSnapshot(s.season),
    });
  }));

  async function removeVideos(rows) {
    for (const c of rows) { await storage.remove(c.video_key); await storage.remove(c.poster_key); }
  }

  router.post('/api/admin/contestants/:id/delete-video', guard('admin', async (req, res, { params, admin }) => {
    const c = db.prepare('SELECT * FROM contestants WHERE id = ?').get(Number(params.id));
    if (!c || !c.video_key) throw new HttpError(404, 'لا يوجد فيديو.');
    const b = await readJson(req, 1024);
    const reason = clean(b.reason, 200);
    if (reason.length < 3) throw new HttpError(422, 'سبب الحذف إلزامي.');
    db.prepare("UPDATE contestants SET video_key = NULL, poster_key = NULL, video_size = NULL, video_duration = NULL, featured = 0, status = CASE WHEN status = 'disqualified' THEN status ELSE 'draft' END, updated_at = ? WHERE id = ?").run(now(), c.id);
    await removeVideos([c]);
    audit(admin.admin_id, 'video_delete', c.entry_no, { reason });
    sendJson(res, 200, { ok: true });
  }));

  router.post('/api/admin/data/purge', guard('admin', async (req, res, { admin }) => {
    const b = await readJson(req, 4096);
    const s = getAllSettings();
    const season = clean(b.season, 20) || s.season;
    let rows = [], summary = {};
    if (b.action === 'rejected_videos') {
      rows = db.prepare("SELECT * FROM contestants WHERE season = ? AND status IN ('rejected','disqualified') AND video_key IS NOT NULL").all(season);
      db.prepare("UPDATE contestants SET video_key = NULL, poster_key = NULL, updated_at = ? WHERE season = ? AND status IN ('rejected','disqualified')").run(now(), season);
      summary = { videos: rows.length };
    } else if (b.action === 'stale_drafts') {
      const cutoff = new Date(Date.now() - 14 * 86400000).toISOString();
      summary.deleted = db.prepare("DELETE FROM contestants WHERE season = ? AND status = 'draft' AND video_key IS NULL AND created_at < ?").run(season, cutoff).changes;
    } else if (b.action === 'archive_videos') {
      // حذف مقاطع الموسم بعد انتهائه مع الإبقاء على مقاطع الفائزين اختياريًا. تبقى السجلات والنتائج.
      if (b.confirm !== season) throw new HttpError(422, 'للتأكيد اكتب رمز الموسم.');
      const keep = new Set();
      if (b.keep_winners) { const snap = activeSnapshot(season); if (snap) for (const g of snap.groups) for (const r of g.rows) if (r.winner) keep.add(r.id); }
      rows = db.prepare('SELECT * FROM contestants WHERE season = ? AND video_key IS NOT NULL').all(season).filter((c) => !keep.has(c.id));
      tx(() => { for (const c of rows) db.prepare("UPDATE contestants SET video_key = NULL, poster_key = NULL, featured = 0, status = CASE WHEN status = 'approved' THEN 'archived' ELSE status END, updated_at = ? WHERE id = ?").run(now(), c.id); });
      summary = { videos: rows.length, kept: keep.size };
    } else if (b.action === 'season_all') {
      if (admin.role !== 'owner') throw new HttpError(403, 'الحذف الكامل لموسم متاح للمالك فقط.');
      if (b.confirm !== season) throw new HttpError(422, 'للتأكيد اكتب رمز الموسم.');
      rows = db.prepare('SELECT * FROM contestants WHERE season = ?').all(season);
      tx(() => {
        const ids = rows.map((c) => c.id);
        if (ids.length) {
          const q = ids.map(() => '?').join(',');
          db.prepare(`DELETE FROM judge_assignments WHERE contestant_id IN (${q})`).run(...ids);
        }
        summary.votes = db.prepare('DELETE FROM votes WHERE season = ?').run(season).changes;
        db.prepare('DELETE FROM vote_attempts WHERE season = ?').run(season);
        db.prepare('DELETE FROM evaluations WHERE season = ?').run(season);
        db.prepare('DELETE FROM certificates WHERE season = ?').run(season);
        db.prepare('DELETE FROM result_snapshots WHERE season = ?').run(season);
        db.prepare('DELETE FROM voter_sessions WHERE student_id IN (SELECT id FROM students WHERE season = ?)').run(season);
        summary.students = db.prepare('DELETE FROM students WHERE season = ?').run(season).changes;
        summary.contestants = db.prepare('DELETE FROM contestants WHERE season = ?').run(season).changes;
      });
    } else if (b.action === 'old_attempts') {
      summary.deleted = db.prepare('DELETE FROM vote_attempts WHERE created_at < ?').run(new Date(Date.now() - 90 * 86400000).toISOString()).changes;
    } else throw new HttpError(400, 'إجراء غير معروف.');
    await removeVideos(rows.filter((c) => c.video_key));
    audit(admin.admin_id, 'data_purge', `${b.action} / ${season}`, summary);
    sendJson(res, 200, { ok: true, summary });
  }));
}

module.exports = { register };
