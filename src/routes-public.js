'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { db, now, tx, getAllSettings } = require('./db');
const { HttpError, sendJson, readJson } = require('./http');
const sec = require('./security');
const storage = require('./storage');
const media = require('./media');
const { phases, publicContestant, validVotesMap, mediaUrls, ownerVideoUrl } = require('./logic');
const { activeSnapshot, publicSnapshot, categoryOf } = require('./results');

// ———————————— أدوات التحقق ————————————
const clean = (v, max = 200) => String(v == null ? '' : v).normalize('NFC').replace(/[\u0000-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const toAsciiDigits = (s) => String(s).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6F0));
const NAME_RE = /^[\p{Script=Arabic}A-Za-z\s'.\-]+$/u;

function limit(req, key, n, ms) {
  const r = sec.rateLimit(`${key}:${sec.clientIp(req)}`, n, ms);
  if (!r.ok) throw new HttpError(429, `عدد كبير من المحاولات، حاول مجددًا بعد ${Math.ceil(r.retryAfter / 60)} دقيقة.`);
}

const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newEntryToken() {
  const bytes = require('node:crypto').randomBytes(12);
  let s = ''; for (const b of bytes) s += TOKEN_ALPHABET[b % TOKEN_ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}
const tokenHash = (tok) => sec.hmac(String(tok).toUpperCase().replace(/[^A-Z0-9]/g, ''), 'entry');

function defaultDisplayName(full) {
  const parts = full.split(' ').filter(Boolean);
  return parts.length <= 2 ? full : `${parts[0]} ${parts[parts.length - 1]}`;
}

// مصادقة المتسابق برقم المشاركة + رمز المتابعة
function authEntry(req, body) {
  const entry = Number(toAsciiDigits((body && body.entry_no) || req.headers['x-entry-no'] || ''));
  const token = String((body && body.token) || req.headers['x-entry-token'] || '');
  const s = getAllSettings();
  const c = entry ? db.prepare('SELECT * FROM contestants WHERE season = ? AND entry_no = ?').get(s.season, entry) : null;
  if (!c || !token || !sec.safeEqual(c.token_hash, tokenHash(token))) {
    limit(req, 'entry-fail', 15, 15 * 60000);
    throw new HttpError(401, 'رقم المشاركة أو رمز المتابعة غير صحيح.');
  }
  return { c, s };
}

function canUpload(c, s, ph) {
  if (c.status === 'approved') return { ok: false, why: 'تم اعتماد تلاوتك ونشرها، ولا يمكن استبدالها.' };
  if (c.status === 'archived') return { ok: false, why: 'انتهت المسابقة وأُرشفت المشاركة.' };
  if (c.status === 'disqualified') return { ok: false, why: 'استُبعدت هذه المشاركة من المسابقة. للاستفسار تواصل مع لجنة المسابقة.' };
  if (!ph.registrationOpen) return { ok: false, why: 'انتهت فترة التسجيل ورفع المقاطع.' };
  if (c.status === 'draft') return { ok: true };
  if (c.status === 'pending') return s.allow_replace ? { ok: true } : { ok: false, why: 'تلاوتك قيد المراجعة، والاستبدال غير متاح حاليًا.' };
  if (c.status === 'rejected') return s.allow_resubmit_rejected ? { ok: true } : { ok: false, why: 'لا يمكن إعادة الرفع بعد الرفض.' };
  return { ok: false, why: '' };
}

function entryStatus(c, s) {
  const ph = phases(s);
  const up = canUpload(c, s, ph);
  const pending = db.prepare('SELECT id, filename, size, received, fingerprint FROM uploads WHERE contestant_id = ? ORDER BY updated_at DESC LIMIT 1').get(c.id);
  return {
    entry_no: c.entry_no, display_name: c.display_name, title: c.title, grade: c.grade, section: c.section,
    status: c.status, reject_reason: c.status === 'rejected' ? c.reject_reason : c.status === 'disqualified' ? c.disqualify_reason : null,
    certificates_enabled: !!s.certificates_enabled, results_published: !!(s.show_results && activeSnapshot(s.season)),
    has_video: !!c.video_key, video_uploaded_at: c.video_uploaded_at,
    video: ownerVideoUrl(c),
    can_upload: up.ok, upload_block_reason: up.ok ? null : up.why,
    pending_upload: pending || null,
    limits: uploadLimits(s),
  };
}

function uploadLimits(s) {
  return { max_mb: s.max_video_mb, max_seconds: s.max_video_seconds, min_seconds: s.min_video_seconds, formats: s.allowed_formats, chunk_size: config.chunkSize };
}

// ———————————— هوية المصوّت (ملف تعريف موقّع) ————————————
function voterId(req, res) {
  const raw = sec.parseCookies(req).qv || '';
  const [id, sig] = raw.split('.');
  if (id && sig && sec.safeEqual(sig, sec.hmac(id, 'qv').slice(0, 20))) return id;
  const nid = sec.randomToken(18);
  res.setHeader('Set-Cookie', sec.cookie('qv', `${nid}.${sec.hmac(nid, 'qv').slice(0, 20)}`, { maxAge: 400 * 86400 }));
  return nid;
}

const EXT_FOR = { mp4: 'mp4', m4v: 'mp4', mov: 'mov', webm: 'webm', mpeg: 'mpeg', mpg: 'mpeg', mp3: 'mp3' };
function extAllowed(ext, s) { return (s.allowed_formats || []).map((x) => String(x).toLowerCase()).includes(ext); }

function register(router) {
  // ———— إعدادات عامة ومراحل ————
  router.get('/api/public/config', (req, res) => {
    const s = getAllSettings();
    const ph = phases(s);
    sendJson(res, 200, {
      now: now(), season: s.season, school_name: s.school_name, hero_subtitle: s.hero_subtitle,
      about_text: s.about_text, goals: s.goals, terms: s.terms, footer_note: s.footer_note,
      grades: s.grades, sections: s.sections, require_guardian_consent: !!s.require_guardian_consent,
      registration: { open: ph.registrationOpen, start: s.registration_start, end: s.registration_end, mode: s.registration_mode },
      voting: { open: ph.votingOpen, start: s.voting_start, end: s.voting_end, mode: s.voting_mode, auth: s.voter_auth, show_counts: !!s.show_vote_counts && !ph.votingOpen },
      competition_name: s.competition_name, logo: s.school_logo && s.school_logo.key ? `/media/logo?v=${encodeURIComponent(s.school_logo.v || '')}` : null,
      categories: (s.categories || []).map((c) => ({ id: c.id, name: c.name, grades: c.grades })),
      results_published: !!(s.show_results && activeSnapshot(s.season)),
      demo: !!s.demo_mode, guardian_consent_text: s.guardian_consent_text, certificates_enabled: !!s.certificates_enabled,
      privacy_policy: s.privacy_policy, retention_days: s.retention_days,
      show_results: !!s.show_results, show_class: !!s.show_class_publicly, show_views: !!s.show_views,
      stages: ph.stages, countdown: ph.countdown, limits: uploadLimits(s),
    });
  });

  router.get('/api/public/stats', (req, res) => {
    const s = getAllSettings();
    const q = (sql, ...a) => db.prepare(sql).get(s.season, ...a);
    sendJson(res, 200, {
      registered: q("SELECT COUNT(*) n FROM contestants WHERE season = ?").n,
      published: q("SELECT COUNT(*) n FROM contestants WHERE season = ? AND status = 'approved'").n,
      valid_votes: q("SELECT COUNT(*) n FROM votes WHERE season = ? AND status = 'valid'").n,
      voters: q("SELECT COUNT(DISTINCT student_id) n FROM votes WHERE season = ? AND status = 'valid'").n,
    });
  });

  router.get('/api/public/contestants', (req, res, { query }) => {
    const s = getAllSettings();
    const where = ["season = ?", "status = 'approved'"]; const args = [s.season];
    const qtext = clean(query.get('q'), 60);
    if (qtext) { where.push('(display_name LIKE ? OR title LIKE ? OR CAST(entry_no AS TEXT) = ?)'); args.push(`%${qtext}%`, `%${qtext}%`, toAsciiDigits(qtext)); }
    const grade = clean(query.get('grade'), 60);
    if (grade && s.show_class_publicly) { where.push('grade = ?'); args.push(grade); }
    if (query.get('featured') === '1') where.push('featured = 1');
    const sort = query.get('sort');
    const order = sort === 'name' ? 'display_name COLLATE NOCASE ASC' : sort === 'entry_desc' ? 'entry_no DESC' : sort === 'random' ? 'RANDOM()' : 'entry_no ASC';
    const lim = Math.min(Math.max(Number(query.get('limit')) || 60, 1), 200);
    const rows = db.prepare(`SELECT * FROM contestants WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`).all(...args, lim);
    const showVotes = s.show_vote_counts && !phases(s).votingOpen;
    const votes = showVotes ? validVotesMap(s.season) : null;
    sendJson(res, 200, { items: rows.map((c) => ({ ...publicContestant(c, s, votes), category: categoryOf(c.grade, s).name, category_id: categoryOf(c.grade, s).id })) });
  });

  router.get('/api/public/contestants/:entry', (req, res, { params }) => {
    const s = getAllSettings();
    const c = db.prepare("SELECT * FROM contestants WHERE season = ? AND entry_no = ? AND status = 'approved'").get(s.season, Number(params.entry));
    if (!c) throw new HttpError(404, 'المشاركة غير موجودة.');
    const showVotes = s.show_vote_counts && !phases(s).votingOpen;
    sendJson(res, 200, { ...publicContestant(c, s, showVotes ? validVotesMap(s.season) : null), category: categoryOf(c.grade, s).name, category_id: categoryOf(c.grade, s).id });
  });

  // مشاهدة واحدة لكل زائر لكل مقطع في اليوم — منفصلة تمامًا عن الأصوات
  router.post('/api/public/contestants/:entry/view', (req, res, { params }) => {
    limit(req, 'view', 120, 60000);
    const s = getAllSettings();
    const c = db.prepare("SELECT id FROM contestants WHERE season = ? AND entry_no = ? AND status = 'approved'").get(s.season, Number(params.entry));
    if (!c) throw new HttpError(404, 'غير موجود');
    const vh = sec.hmac(voterId(req, res), 'view');
    const day = now().slice(0, 10);
    const r = db.prepare('INSERT OR IGNORE INTO view_events(contestant_id, viewer_hash, day) VALUES(?,?,?)').run(c.id, vh, day);
    if (r.changes) db.prepare('UPDATE contestants SET views = views + 1 WHERE id = ?').run(c.id);
    sendJson(res, 200, { ok: true });
  });

  // ———— النتائج المعتمدة (تظهر فقط بعد الاعتماد الإداري وتفعيل الإعلان) ————
  router.get('/api/public/results', (req, res) => {
    const s = getAllSettings();
    const snap = s.show_results ? activeSnapshot(s.season) : null;
    if (!snap) throw new HttpError(403, 'لم تُعلن النتائج بعد.');
    sendJson(res, 200, publicSnapshot(snap, s));
  });

  // ———— شعار المدرسة ————
  router.get('/media/logo', (req, res) => {
    const s = getAllSettings();
    if (!s.school_logo || !s.school_logo.key) throw new HttpError(404, 'لا يوجد شعار.');
    streamMedia(req, res, s.school_logo.key, s.school_logo.mime);
  });

  // ———— تسجيل متسابق ————
  router.post('/api/register', async (req, res) => {
    limit(req, 'register', 12, 3600000);
    const b = await readJson(req, 8192);
    const s = getAllSettings();
    if (!phases(s).registrationOpen) throw new HttpError(403, 'التسجيل مغلق حاليًا.');
    const errors = {};
    const full = clean(b.full_name, 90);
    if (full.split(' ').length < 3 || full.length < 8) errors.full_name = 'اكتب الاسم الثلاثي على الأقل.';
    else if (!NAME_RE.test(full)) errors.full_name = 'الاسم يجب أن يحتوي على حروف فقط.';
    const sid = toAsciiDigits(clean(b.school_id, 30)).replace(/\s/g, '').toUpperCase();
    if (!/^[A-Z0-9\-]{3,20}$/.test(sid)) errors.school_id = 'الرقم المدرسي غير صالح (3–20 خانة من الأرقام أو الحروف اللاتينية).';
    const grade = clean(b.grade, 60);
    if (!s.grades.includes(grade)) errors.grade = 'اختر الصف الدراسي.';
    const section = clean(b.section, 20);
    if (!(s.sections || []).includes(section)) errors.section = 'اختر الشعبة.';
    const title = clean(b.title, 100);
    if (title.length < 2) errors.title = 'اكتب عنوان التلاوة أو اسم السورة.';
    if (b.terms !== true) errors.terms = 'يجب الموافقة على شروط المسابقة.';
    if (s.require_guardian_consent && b.guardian !== true) errors.guardian = 'يلزم إقرار موافقة ولي الأمر.';
    if (Object.keys(errors).length) throw new HttpError(422, 'يرجى تصحيح الحقول المشار إليها.', { errors });

    const token = newEntryToken();
    const created = tx(() => {
      const dup = db.prepare('SELECT id FROM contestants WHERE season = ? AND school_id = ?').get(s.season, sid);
      if (dup) throw new HttpError(409, 'هذا الرقم المدرسي مسجّل مسبقًا في المسابقة. إن كنت صاحب التسجيل فاستخدم «متابعة التسجيل»، أو تواصل مع لجنة المسابقة.', { errors: { school_id: 'الرقم المدرسي مسجّل مسبقًا.' } });
      const next = (db.prepare('SELECT MAX(entry_no) m FROM contestants WHERE season = ?').get(s.season).m || 100) + 1;
      const ts = now();
      db.prepare(`INSERT INTO contestants(season, entry_no, full_name, display_name, school_id, grade, section, title, terms_accepted, guardian_consent, consent_at, token_hash, status, created_at, updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'draft', ?, ?)`).run(s.season, next, full, defaultDisplayName(full), sid, grade, section, title, 1, b.guardian ? 1 : 0, ts, tokenHash(token), ts, ts);
      return next;
    });
    sendJson(res, 201, { entry_no: created, token, message: 'تم حفظ التسجيل. احتفظ برقم المشاركة ورمز المتابعة لإكمال رفع التلاوة أو متابعة حالتها.' });
  });

  router.post('/api/entry/status', async (req, res) => {
    limit(req, 'entry', 60, 60000);
    const b = await readJson(req, 2048);
    const { c, s } = authEntry(req, b);
    sendJson(res, 200, entryStatus(c, s));
  });

  // ———— الرفع المجزّأ القابل للاستئناف ————
  router.post('/api/uploads/init', async (req, res) => {
    limit(req, 'upinit', 30, 3600000);
    const b = await readJson(req, 4096);
    const { c, s } = authEntry(req, b);
    const up = canUpload(c, s, phases(s));
    if (!up.ok) throw new HttpError(403, up.why);
    const filename = clean(b.filename, 150) || 'video';
    const ext = path.extname(filename).slice(1).toLowerCase();
    if (!EXT_FOR[ext] || !extAllowed(ext, s)) throw new HttpError(415, `صيغة الملف غير مسموحة. الصيغ المتاحة: ${s.allowed_formats.join('، ').toUpperCase()}`);
    const size = Number(b.size);
    if (!Number.isInteger(size) || size < 10 * 1024) throw new HttpError(400, 'الملف فارغ أو تالف.');
    if (size > s.max_video_mb * 1024 * 1024) throw new HttpError(413, `حجم الفيديو يتجاوز الحد المسموح (${s.max_video_mb} ميجابايت).`);
    const dur = Number(b.duration);
    if (dur && dur > s.max_video_seconds + 2) throw new HttpError(422, `مدة الفيديو تتجاوز الحد المسموح (${Math.round(s.max_video_seconds / 60 * 10) / 10} دقيقة).`);
    if (dur && dur < s.min_video_seconds) throw new HttpError(422, `مدة الفيديو أقل من الحد الأدنى (${s.min_video_seconds} ثانية).`);
    const fingerprint = sec.sha256(`${filename}|${size}|${clean(b.last_modified, 20)}`);
    const existing = db.prepare('SELECT * FROM uploads WHERE contestant_id = ? AND fingerprint = ?').get(c.id, fingerprint);
    if (existing) {
      const file = path.join(config.uploadTmpDir, existing.id);
      const actual = fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (actual !== existing.received) db.prepare('UPDATE uploads SET received = ? WHERE id = ?').run(actual, existing.id);
      return sendJson(res, 200, { upload_id: existing.id, received: actual, chunk_size: config.chunkSize, resumed: actual > 0 });
    }
    // إلغاء أي رفع سابق غير مكتمل لنفس المتسابق
    for (const old of db.prepare('SELECT id FROM uploads WHERE contestant_id = ?').all(c.id)) {
      try { fs.unlinkSync(path.join(config.uploadTmpDir, old.id)); } catch {}
    }
    db.prepare('DELETE FROM uploads WHERE contestant_id = ?').run(c.id);
    const id = sec.randomToken(18);
    fs.writeFileSync(path.join(config.uploadTmpDir, id), '');
    const ts = now();
    db.prepare('INSERT INTO uploads(id, contestant_id, filename, mime, ext, size, received, fingerprint, created_at, updated_at) VALUES(?,?,?,?,?,?,0,?,?,?)')
      .run(id, c.id, filename, clean(b.mime, 60) || 'video/mp4', ext, size, fingerprint, ts, ts);
    sendJson(res, 201, { upload_id: id, received: 0, chunk_size: config.chunkSize, resumed: false });
  });

  function loadUpload(req, id) {
    const { c, s } = authEntry(req, null);
    const u = db.prepare('SELECT * FROM uploads WHERE id = ? AND contestant_id = ?').get(String(id), c.id);
    if (!u) throw new HttpError(404, 'عملية الرفع غير موجودة أو انتهت صلاحيتها، ابدأ الرفع من جديد.');
    return { c, s, u, file: path.join(config.uploadTmpDir, u.id) };
  }

  router.get('/api/uploads/:id', (req, res, { params }) => {
    const { u, file } = loadUpload(req, params.id);
    const actual = fs.existsSync(file) ? fs.statSync(file).size : 0;
    sendJson(res, 200, { upload_id: u.id, received: actual, size: u.size });
  });

  router.put('/api/uploads/:id/chunk', (req, res, { params, query }) => new Promise((resolve, reject) => {
    let ctx;
    try { ctx = loadUpload(req, params.id); } catch (e) { req.resume(); return reject(e); }
    const { u, file } = ctx;
    const offset = Number(query.get('offset'));
    const actual = fs.existsSync(file) ? fs.statSync(file).size : 0;
    if (offset !== actual) { req.resume(); return resolve(sendJson(res, 409, { error: 'offset_mismatch', received: actual })); }
    const len = Number(req.headers['content-length']);
    if (!len || len > config.chunkSize + 1024 || offset + len > u.size) { req.resume(); return reject(new HttpError(413, 'جزء غير صالح.')); }
    const ws = fs.createWriteStream(file, { flags: 'a' });
    let got = 0, failed = false;
    req.on('data', (d) => { got += d.length; if (got > len) { failed = true; req.destroy(); } });
    let done = false;
    req.on('aborted', () => { failed = true; ws.destroy(); });
    req.on('close', () => { if (!req.complete) { failed = true; ws.destroy(); } });
    ws.on('close', () => {
      if (done) return;
      done = true;
      try { fs.truncateSync(file, offset); } catch {}
      resolve();
    });
    req.pipe(ws);
    ws.on('finish', () => {
      done = true;
      if (failed || got !== len) {
        // تراجع إلى آخر نقطة سليمة كي يُستأنف الرفع بدقة
        try { fs.truncateSync(file, offset); } catch {}
        return resolve(sendJson(res, 409, { error: 'incomplete_chunk', received: offset }));
      }
      db.prepare('UPDATE uploads SET received = ?, updated_at = ? WHERE id = ?').run(offset + got, now(), u.id);
      resolve(sendJson(res, 200, { received: offset + got }));
    });
    ws.on('error', reject);
  }));

  router.post('/api/uploads/:id/complete', async (req, res, { params }) => {
    const { c, s, u, file } = loadUpload(req, params.id);
    const actual = fs.statSync(file).size;
    if (actual !== u.size) throw new HttpError(409, 'لم يكتمل رفع الملف بعد.', { received: actual });
    const fail = (msg) => {
      try { fs.unlinkSync(file); } catch {}
      db.prepare('DELETE FROM uploads WHERE id = ?').run(u.id);
      throw new HttpError(422, msg);
    };
    const sniff = media.sniffVideo(file);
    if (!sniff) fail('الملف المرفوع ليس مقطع فيديو بصيغة مدعومة.');
    const kindOk = (sniff.kind === 'mp4' && (extAllowed('mp4', s) || extAllowed('m4v', s))) || (sniff.kind === 'mpeg' && (extAllowed('mpeg', s) || extAllowed('mpg', s))) || extAllowed(sniff.kind, s);
    if (!kindOk) fail('صيغة الفيديو غير مسموحة.');
    let duration = null;
    const info = await media.probe(file);
    if (info) {
      if (info.error || (!info.hasVideo && sniff.kind !== 'mp3')) fail('تعذّرت قراءة الملف؛ قد يكون تالفًا. جرّب ملفًا آخر.');
      if (!info.hasAudio) fail('المقطع لا يحتوي على صوت، والتلاوة لا تكتمل إلا بالصوت.');
      duration = info.duration;
      if (duration && duration > s.max_video_seconds + 2) fail(`مدة الفيديو تتجاوز الحد المسموح (${s.max_video_seconds} ثانية).`);
      if (duration && duration < s.min_video_seconds - 1) fail(`مدة الفيديو أقل من الحد الأدنى (${s.min_video_seconds} ثانية).`);
    }
    const rand = sec.randomToken(6);
    const base = `${s.season}/${c.entry_no}-${rand}`;
    let finalFile = file, finalMime = sniff.mime, finalExt = sniff.kind === 'mp3' ? 'mp3' : EXT_FOR[u.ext] === 'mov' ? 'mov' : sniff.kind === 'webm' ? 'webm' : 'mp4';
    const clean = await media.sanitize(file, sniff.kind);
    // MPEG لا تشغّله المتصفحات: التحويل إلى MP4 إلزامي
    if (sniff.kind === 'mpeg' && !clean) fail('تعذّر تحويل ملف MPEG إلى صيغة قابلة للتشغيل. جرّب ملف MP4.');
    if (clean) { finalFile = clean.file; finalMime = clean.mime; finalExt = clean.ext; }
    const videoKey = `videos/${base}.${finalExt}`;
    let posterKey = null;
    const posterTmp = file + '.jpg';
    if (sniff.kind !== 'mp3' && await media.poster(file, posterTmp, duration ? Math.min(3, duration / 3) : 2)) {
      posterKey = `posters/${base}.jpg`;
      await storage.putFile(posterTmp, posterKey, 'image/jpeg');
    }
    await storage.putFile(finalFile, videoKey, finalMime);
    if (finalFile !== file) { try { fs.unlinkSync(file); } catch {} }
    const old = db.prepare('SELECT video_key, poster_key FROM contestants WHERE id = ?').get(c.id);
    const ts = now();
    db.prepare(`UPDATE contestants SET video_key = ?, poster_key = ?, video_mime = ?, video_size = ?, video_duration = ?, video_uploaded_at = ?,
      status = 'pending', reject_reason = NULL, updated_at = ? WHERE id = ?`).run(videoKey, posterKey, finalMime, fs.existsSync(require('node:path').join(config.localMediaDir, videoKey)) ? fs.statSync(require('node:path').join(config.localMediaDir, videoKey)).size : u.size, duration, ts, ts, c.id);
    db.prepare('DELETE FROM uploads WHERE id = ?').run(u.id);
    if (old.video_key) await storage.remove(old.video_key);
    if (old.poster_key) await storage.remove(old.poster_key);
    const fresh = db.prepare('SELECT * FROM contestants WHERE id = ?').get(c.id);
    sendJson(res, 200, { ok: true, message: 'تم استلام تلاوتك بنجاح، وهي الآن بانتظار مراجعة لجنة المسابقة.', status: entryStatus(fresh, s) });
  });

  router.delete('/api/uploads/:id', (req, res, { params }) => {
    const { u, file } = loadUpload(req, params.id);
    try { fs.unlinkSync(file); } catch {}
    db.prepare('DELETE FROM uploads WHERE id = ?').run(u.id);
    sendJson(res, 200, { ok: true });
  });

  // ———— تشغيل المقاطع (روابط موقّعة مؤقتة، بلا تنزيل مباشر) ————
  router.get('/media/:kind/:entry', (req, res, { params, query }) => {
    const kind = params.kind;
    if (!['v', 'p', 'o'].includes(kind)) throw new HttpError(404, 'غير موجود');
    const s = getAllSettings();
    const c = db.prepare('SELECT * FROM contestants WHERE season = ? AND entry_no = ?').get(s.season, Number(params.entry));
    const key = c && (kind === 'p' ? c.poster_key : c.video_key);
    if (!c || !key || !sec.verifySigned(`${kind}:${c.id}:${key}`, query.get('s'))) throw new HttpError(403, 'انتهت صلاحية الرابط، حدّث الصفحة.');
    // الرابط العام لا يعمل إلا لمقطع معتمد حاليًا — إن أُلغي النشر أو رُفض يتوقف فورًا حتى لو كان الرابط ما زال ساريًا
    if (kind !== 'o' && c.status !== 'approved') throw new HttpError(404, 'المقطع غير متاح.');
    res.setHeader('X-Robots-Tag', 'noindex');
    streamMedia(req, res, key, kind === 'p' ? 'image/jpeg' : c.video_mime);
  });
}

function streamMedia(req, res, key, mime) {
  if (storage.name === 's3') {
    res.writeHead(302, { Location: storage.presign(key, 3600, mime), 'Cache-Control': 'no-store' });
    return res.end();
  }
  const st = storage.stat(key);
  if (!st) throw new HttpError(404, 'الملف غير موجود');
  const file = storage.resolve(key);
  const headers = {
    'Content-Type': mime || 'application/octet-stream', 'Accept-Ranges': 'bytes',
    'Content-Disposition': 'inline', 'Cache-Control': 'private, max-age=3600',
  };
  const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (range) {
    let start = range[1] === '' ? st.size - Number(range[2]) : Number(range[1]);
    let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : st.size - 1;
    if (isNaN(start) || start < 0) start = 0;
    end = Math.min(end, st.size - 1);
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

module.exports = { register, streamMedia, tokenHash, newEntryToken, clean, authEntry };
