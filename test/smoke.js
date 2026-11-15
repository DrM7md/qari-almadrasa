'use strict';
/**
 * اختبار شامل لمسار المنصة عبر الواجهة البرمجية:
 * تسجيل → رفع مجزّأ (مع استئناف) → مراجعة → نشر → مشاهدة → تصويت → حماية.
 * الاستخدام: BASE=http://localhost:3000 ADMIN_USER=owner ADMIN_PASS=... node test/smoke.js <video.mp4>
 */
const fs = require('node:fs');
const assert = require('node:assert');
const BASE = process.env.BASE || 'http://localhost:3000';
const VIDEO = process.argv[2];
if (!VIDEO) { console.error('usage: node test/smoke.js <video.mp4>'); process.exit(2); }

let adminCookie = '', csrf = '', voterCookie = '';
async function call(method, path, { body, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
  const r = await fetch(BASE + path, { method, headers: h, body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined, duplex: 'half' });
  const sc = r.headers.get('set-cookie');
  let data = null; const ct = r.headers.get('content-type') || '';
  if (ct.includes('json')) data = await r.json(); else data = await r.text();
  return { status: r.status, data, setCookie: sc, headers: r.headers };
}
const ok = (name) => console.log('  ✔', name);

(async () => {
  console.log('▶ الإعدادات العامة');
  const cfg = (await call('GET', '/api/public/config')).data;
  assert.ok(cfg.stages.length); ok('config + stages');

  console.log('▶ دخول الإدارة وفتح التسجيل والتصويت');
  const login = await call('POST', '/api/admin/login', { body: { username: process.env.ADMIN_USER, password: process.env.ADMIN_PASS } });
  assert.strictEqual(login.status, 200, JSON.stringify(login.data));
  adminCookie = login.setCookie.split(';')[0]; csrf = login.data.csrf;
  const A = { Cookie: adminCookie, 'X-CSRF-Token': csrf };
  const noCsrf = await call('PUT', '/api/admin/settings', { body: { registration_mode: 'open' }, headers: { Cookie: adminCookie } });
  assert.strictEqual(noCsrf.status, 403); ok('CSRF مطلوب');
  const st = await call('PUT', '/api/admin/settings', { body: { registration_mode: 'open', voting_mode: 'closed', min_video_seconds: 10 }, headers: A });
  assert.strictEqual(st.status, 200); ok('settings updated');

  console.log('▶ التسجيل');
  const bad = await call('POST', '/api/register', { body: { full_name: 'x', school_id: '!', grade: 'z', section: 'q', title: '', terms: false } });
  assert.strictEqual(bad.status, 422); assert.ok(bad.data.errors.full_name); ok('رفض بيانات غير صالحة');
  const sid = String(Date.now()).slice(-8);
  const reg = await call('POST', '/api/register', { body: { full_name: 'عبدالله محمد أحمد السالم', school_id: sid, grade: cfg.grades[0], section: cfg.sections[0], title: 'سورة الملك', terms: true, guardian: true } });
  assert.strictEqual(reg.status, 201, JSON.stringify(reg.data)); ok(`تسجيل جديد رقم ${reg.data.entry_no}`);
  const dup = await call('POST', '/api/register', { body: { full_name: 'آخر محمد أحمد', school_id: sid, grade: cfg.grades[0], section: cfg.sections[0], title: 'سورة', terms: true, guardian: true } });
  assert.strictEqual(dup.status, 409); ok('منع تكرار الرقم المدرسي');
  const { entry_no, token } = reg.data;
  const E = { 'X-Entry-No': String(entry_no), 'X-Entry-Token': token };
  const wrong = await call('POST', '/api/entry/status', { body: { entry_no, token: 'AAAA-BBBB-CCCC' } });
  assert.strictEqual(wrong.status, 401); ok('رمز متابعة خاطئ مرفوض');
  const s1 = await call('POST', '/api/entry/status', { body: { entry_no, token } });
  assert.strictEqual(s1.data.status, 'draft'); ok('الحالة: مسودة');

  console.log('▶ الرفع المجزّأ مع الاستئناف');
  const buf = fs.readFileSync(VIDEO);
  const badExt = await call('POST', '/api/uploads/init', { headers: E, body: { filename: 'x.exe', size: buf.length } });
  assert.strictEqual(badExt.status, 415); ok('منع الصيغ غير المسموحة');
  const meta = { filename: 'tilawa.mp4', size: buf.length, mime: 'video/mp4', last_modified: '1' };
  const init = await call('POST', '/api/uploads/init', { headers: E, body: meta });
  assert.strictEqual(init.status, 201);
  const cs = init.data.chunk_size;
  // الجزء الأول ثم "انقطاع" ثم استئناف
  let r = await call('PUT', `/api/uploads/${init.data.upload_id}/chunk?offset=0`, { headers: { ...E, 'Content-Type': 'application/octet-stream' }, body: buf.subarray(0, cs), raw: true });
  assert.strictEqual(r.status, 200);
  const mis = await call('PUT', `/api/uploads/${init.data.upload_id}/chunk?offset=0`, { headers: { ...E, 'Content-Type': 'application/octet-stream' }, body: buf.subarray(0, 100), raw: true });
  assert.strictEqual(mis.status, 409); ok('رفض إزاحة غير متطابقة');
  const again = await call('POST', '/api/uploads/init', { headers: E, body: meta });
  assert.strictEqual(again.data.resumed, true); assert.strictEqual(again.data.received, Math.min(cs, buf.length)); ok('استئناف الرفع من آخر نقطة');
  let off = again.data.received;
  while (off < buf.length) {
    r = await call('PUT', `/api/uploads/${init.data.upload_id}/chunk?offset=${off}`, { headers: { ...E, 'Content-Type': 'application/octet-stream' }, body: buf.subarray(off, off + cs), raw: true });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data)); off = r.data.received;
  }
  const done = await call('POST', `/api/uploads/${init.data.upload_id}/complete`, { headers: E, body: {} });
  assert.strictEqual(done.status, 200, JSON.stringify(done.data)); assert.strictEqual(done.data.status.status, 'pending'); ok('اكتمل الرفع → بانتظار المراجعة');

  console.log('▶ النشر والخصوصية');
  let pub = await call('GET', '/api/public/contestants');
  assert.ok(!pub.data.items.some((i) => i.entry_no === entry_no)); ok('غير المعتمد لا يُنشر');
  const list = await call('GET', '/api/admin/contestants?status=pending', { headers: A });
  const item = list.data.items.find((i) => i.entry_no === entry_no);
  const rej0 = await call('POST', `/api/admin/contestants/${item.id}/review`, { headers: A, body: { decision: 'reject' } });
  assert.strictEqual(rej0.status, 422); ok('الرفض يتطلب سببًا');
  const ap = await call('POST', `/api/admin/contestants/${item.id}/review`, { headers: A, body: { decision: 'approve' } });
  assert.strictEqual(ap.status, 200); ok('اعتماد المشاركة');
  pub = await call('GET', '/api/public/contestants');
  const p = pub.data.items.find((i) => i.entry_no === entry_no);
  assert.ok(p); assert.strictEqual(p.school_id, undefined); assert.strictEqual(p.full_name, undefined); assert.strictEqual(p.name, 'عبدالله السالم');
  ok('المنشور: الاسم المعتمد فقط بلا رقم مدرسي');
  const vid = await call('GET', p.video, { headers: { Range: 'bytes=0-99' } });
  assert.strictEqual(vid.status, 206); ok('بث الفيديو بالنطاقات (Range)');
  const forged = await call('GET', `/media/v/${entry_no}?s=123.abc`);
  assert.strictEqual(forged.status, 403); ok('رفض رابط فيديو مزوّر');

  console.log('▶ المشاهدات');
  const v1 = await call('POST', `/api/public/contestants/${entry_no}/view`, { body: {} });
  voterCookie = v1.setCookie.split(';')[0];
  await call('POST', `/api/public/contestants/${entry_no}/view`, { body: {}, headers: { Cookie: voterCookie } });
  const one = await call('GET', `/api/public/contestants/${entry_no}`);
  assert.strictEqual(one.data.views, 1); ok('مشاهدة واحدة لكل زائر يوميًا');

  console.log('▶ قائمة الطلاب المؤهلين والرموز الشخصية');
  // متسابق ثانٍ معتمد لاختبار التعادل والفئات
  const reg2 = await call('POST', '/api/register', { body: { full_name: 'خالد سعيد ناصر الكواري', school_id: sid + '9', grade: cfg.grades[0], section: cfg.sections[0], title: 'سورة النبأ', terms: true, guardian: true } });
  const E2 = { 'X-Entry-No': String(reg2.data.entry_no), 'X-Entry-Token': reg2.data.token };
  const i2 = await call('POST', '/api/uploads/init', { headers: E2, body: { ...meta, last_modified: '2' } });
  for (let o = 0; o < buf.length;) { const rr = await call('PUT', `/api/uploads/${i2.data.upload_id}/chunk?offset=${o}`, { headers: { ...E2, 'Content-Type': 'application/octet-stream' }, body: buf.subarray(o, o + cs), raw: true }); o = rr.data.received; }
  await call('POST', `/api/uploads/${i2.data.upload_id}/complete`, { headers: E2, body: {} });
  const id2 = (await call('GET', '/api/admin/contestants?status=pending', { headers: A })).data.items.find((i) => i.entry_no === reg2.data.entry_no).id;
  await call('POST', `/api/admin/contestants/${id2}/review`, { headers: A, body: { decision: 'approve' } });

  const imp = await call('POST', '/api/admin/students/import', { headers: A, body: { rows: [
    { school_id: sid, full_name: 'عبدالله محمد أحمد السالم', grade: cfg.grades[0], section: 'أ' },     // المتسابق نفسه
    { school_id: 'S1001', full_name: 'طالب أول', grade: cfg.grades[0], section: 'أ' },
    { school_id: 'S1002', full_name: 'طالب ثان', grade: cfg.grades[0], section: 'ب' },
    { school_id: 'S1003', full_name: 'طالب ثالث', grade: cfg.grades[cfg.grades.length - 1], section: 'أ' },
    { school_id: 'S1004', full_name: 'طالب رابع', grade: 'صف وهمي', section: 'أ' },
  ] } });
  assert.strictEqual(imp.data.added, 4); assert.strictEqual(imp.data.errors.length, 1); ok('استيراد القائمة مع رفض الصف غير المعرّف');
  const pins = await call('POST', '/api/admin/students/pins', { headers: A, body: { scope: 'missing' } });
  assert.strictEqual(pins.data.pins.length, 4); ok('إصدار رموز شخصية');
  const pinOf = (id) => pins.data.pins.find((p) => p.school_id === id).pin;

  const vlogin = async (school_id, pin) => { const r = await call('POST', '/api/vote/login', { body: { school_id, pin } }); return { r, cookie: r.setCookie ? r.setCookie.split(';')[0] : '' }; };
  const anonVote = await call('POST', '/api/vote', { body: { entry_no } });
  assert.strictEqual(anonVote.status, 401); ok('لا تصويت دون تحقق من الهوية');
  const idOnly = await vlogin('S1001', '');
  assert.strictEqual(idOnly.r.status, 422); ok('الرقم المدرسي وحده لا يكفي');
  const wrongPin = await vlogin('S1001', 'AAA-AAA');
  assert.strictEqual(wrongPin.r.status, 401); ok('رمز شخصي خاطئ مرفوض');
  const ghost = await vlogin('NOPE99', 'AAA-AAA');
  assert.strictEqual(ghost.r.status, 401); ok('طالب خارج القائمة مرفوض');

  const sv1 = await vlogin('S1001', pinOf('S1001'));
  assert.strictEqual(sv1.r.status, 200);
  const closedV = await call('POST', '/api/vote', { body: { entry_no }, headers: { Cookie: sv1.cookie } });
  assert.strictEqual(closedV.status, 403); ok('التصويت مغلق قبل موعده');
  await call('POST', '/api/admin/voting/state', { headers: A, body: { mode: 'open' } });
  const pubDuring = await call('GET', '/api/public/contestants');
  assert.ok(pubDuring.data.items.every((i) => i.votes == null)); ok('النتائج مخفية أثناء التصويت');
  const okv = await call('POST', '/api/vote', { body: { entry_no }, headers: { Cookie: sv1.cookie } });
  assert.strictEqual(okv.status, 200); assert.strictEqual(okv.data.message, 'تم تسجيل صوتك بنجاح'); ok('«تم تسجيل صوتك بنجاح»');
  const againV = await call('POST', '/api/vote', { body: { entry_no: reg2.data.entry_no }, headers: { Cookie: sv1.cookie } });
  assert.strictEqual(againV.status, 409); ok('لا يمكن تعديل الصوت بعد اعتماده');
  const sv1b = await vlogin('S1001', pinOf('S1001'));  // "جهاز آخر"
  const dupOther = await call('POST', '/api/vote', { body: { entry_no: reg2.data.entry_no }, headers: { Cookie: sv1b.cookie } });
  assert.strictEqual(dupOther.status, 409); ok('منع التكرار من جهاز/جلسة أخرى');
  // تصويت متزامن من جلستين لنفس الطالب
  const s2a = await vlogin('S1002', pinOf('S1002')), s2b = await vlogin('S1002', pinOf('S1002'));
  const par = await Promise.all([call('POST', '/api/vote', { body: { entry_no }, headers: { Cookie: s2a.cookie } }), call('POST', '/api/vote', { body: { entry_no: reg2.data.entry_no }, headers: { Cookie: s2b.cookie } })]);
  assert.strictEqual(par.filter((p) => p.status === 200).length, 1); ok('طلبان متزامنان → صوت واحد فقط');
  const self = await vlogin(sid, pinOf(sid));
  const selfV = await call('POST', '/api/vote', { body: { entry_no }, headers: { Cookie: self.cookie } });
  assert.strictEqual(selfV.status, 403); ok('منع التصويت للنفس');
  await call('PUT', '/api/admin/settings', { headers: A, body: { allow_vote_change: true } });
  const changed = await call('POST', '/api/vote', { body: { entry_no: reg2.data.entry_no }, headers: { Cookie: sv1.cookie } });
  assert.strictEqual(changed.status, 200); ok('تعديل الصوت عند تفعيله من الإدارة');
  await call('PUT', '/api/admin/settings', { headers: A, body: { allow_vote_change: false } });
  for (let i = 0; i < 5; i++) await vlogin('S1003', 'BAD-PIN');
  const locked = await vlogin('S1003', pinOf('S1003'));
  assert.strictEqual(locked.r.status, 423); ok('قفل الحساب بعد 5 محاولات خاطئة');
  const att = await call('GET', '/api/admin/vote-attempts', { headers: A });
  const kinds = att.data.summary.map((k) => k.kind);
  assert.ok(['duplicate', 'self_vote', 'bad_pin', 'locked', 'unauthenticated'].every((k) => kinds.includes(k))); ok('سجل تدقيق للمحاولات المرفوضة');
  const stats2 = (await call('GET', '/api/public/stats')).data;
  assert.strictEqual(stats2.valid_votes, 2); assert.strictEqual(stats2.voters, 2); ok(`الإحصاءات: ${JSON.stringify(stats2)}`);

  console.log('▶ صلاحية تعديل الأصوات');
  const vlist = await call('GET', '/api/admin/votes', { headers: A });
  const noReason = await call('POST', '/api/admin/votes/status', { headers: A, body: { ids: [vlist.data.items[0].id], status: 'void' } });
  assert.strictEqual(noReason.status, 422); ok('السبب إلزامي لتعديل الأصوات');

  console.log('▶ لجنة التحكيم');
  const mk = async (u) => { await call('POST', '/api/admin/admins', { headers: A, body: { username: u, display_name: 'المحكّم ' + u, password: 'Judge2026pass', role: 'judge' } }); const l = await call('POST', '/api/admin/login', { body: { username: u, password: 'Judge2026pass' } }); return { Cookie: l.setCookie.split(';')[0], 'X-CSRF-Token': l.data.csrf }; };
  const J1 = await mk('judge1'), J2 = await mk('judge2');
  const forbid = await call('GET', '/api/admin/contestants', { headers: J1 });
  assert.strictEqual(forbid.status, 403); ok('المحكّم لا يدخل بيانات الطلاب');
  const asg = await call('GET', '/api/judge/assignments', { headers: J1 });
  assert.strictEqual(asg.data.items.length, 2); assert.strictEqual(asg.data.items[0].school_id, undefined); ok('المحكّم يرى المشاركات المعتمدة دون بيانات خاصة');
  const [c1, c2] = asg.data.items;
  const over = await call('PUT', `/api/judge/evaluations/${c1.id}`, { headers: J1, body: { scores: { tajweed: 41 } } });
  assert.strictEqual(over.status, 422); ok('رفض درجة تتجاوز الحد');
  await call('PUT', `/api/judge/evaluations/${c1.id}`, { headers: J1, body: { scores: { tajweed: 30 }, notes: 'مسودة' } });
  const inc = await call('PUT', `/api/judge/evaluations/${c1.id}`, { headers: J1, body: { scores: { tajweed: 30 }, submit: true } });
  assert.strictEqual(inc.status, 422); ok('لا اعتماد قبل إكمال كل المعايير');
  const sc = (a, b, c, d) => ({ tajweed: a, hifz: b, voice: c, waqf: d });
  await call('PUT', `/api/judge/evaluations/${c1.id}`, { headers: J2, body: { scores: sc(36, 27, 18, 9), submit: true } });
  const hidden = await call('GET', `/api/judge/evaluations/${c1.id}`, { headers: J1 });
  assert.strictEqual(hidden.data.others, null); ok('لا يرى تقييمات الآخرين قبل اعتماد تقييمه');
  await call('PUT', `/api/judge/evaluations/${c1.id}`, { headers: J1, body: { scores: sc(34, 28, 17, 9), submit: true } });
  const shown = await call('GET', `/api/judge/evaluations/${c1.id}`, { headers: J1 });
  assert.strictEqual(shown.data.others.length, 1); ok('تظهر تقييمات الآخرين بعد الاعتماد');
  const locked2 = await call('PUT', `/api/judge/evaluations/${c1.id}`, { headers: J1, body: { scores: sc(1, 1, 1, 1) } });
  assert.strictEqual(locked2.status, 409); ok('التقييم المعتمد مقفل');
  const critLock = await call('PUT', '/api/admin/settings', { headers: A, body: { judging_criteria: [{ id: 'x', name: 'س', max: 100 }] } });
  assert.strictEqual(critLock.status, 409); ok('لا تعديل للمعايير بعد بدء الاعتماد');

  console.log('▶ النتائج');
  let rs = (await call('GET', '/api/admin/results', { headers: A })).data.live;
  assert.ok(!rs.ready && rs.issues.some((i) => /مفتوح/.test(i)) && rs.issues.some((i) => /غير مكتمل/.test(i))); ok('منع الاعتماد: التصويت مفتوح والتحكيم ناقص');
  const early = await call('POST', '/api/admin/results/approve', { headers: A, body: {} });
  assert.strictEqual(early.status, 409);
  await call('PUT', `/api/judge/evaluations/${c2.id}`, { headers: J1, body: { scores: sc(30, 25, 15, 8), submit: true } });
  await call('PUT', `/api/judge/evaluations/${c2.id}`, { headers: J2, body: { scores: sc(32, 24, 16, 8), submit: true } });
  await call('POST', '/api/admin/voting/state', { headers: A, body: { mode: 'closed' } });
  rs = (await call('GET', '/api/admin/results', { headers: A })).data.live;
  assert.ok(rs.ready, JSON.stringify(rs.issues));
  const row1 = rs.groups.flatMap((g) => g.rows).find((r) => r.entry_no === c1.entry_no);
  // c1: متوسط (90 + 88) / 2 = 89 ؛ أصوات c1 = 1 من 2 = 50% ؛ النهائي = 0.7×89 + 0.3×50 = 77.3
  assert.strictEqual(row1.judge_pct, 89); assert.strictEqual(row1.vote_pct, 50); assert.strictEqual(row1.score, 77.3); ok(`المعادلة المختلطة: ${row1.formula}`);
  const pubEarly = await call('PUT', '/api/admin/settings', { headers: A, body: { show_results: true } });
  assert.strictEqual(pubEarly.status, 409); ok('لا إعلان قبل الاعتماد');
  const appr = await call('POST', '/api/admin/results/approve', { headers: A, body: {} });
  assert.strictEqual(appr.status, 200);
  assert.strictEqual((await call('GET', '/api/public/results')).status, 403);
  await call('POST', '/api/admin/results/publish', { headers: A, body: { publish: true } });
  const pr = await call('GET', '/api/public/results');
  assert.strictEqual(pr.status, 200); assert.ok(!JSON.stringify(pr.data).includes('عبدالله محمد أحمد')); ok('إعلان النتائج المعتمدة دون بيانات خاصة');
  const x = await call('GET', '/api/admin/export/results.xlsx', { headers: A });
  assert.strictEqual(x.status, 200); assert.ok(x.headers.get('content-type').includes('spreadsheetml')); ok('تصدير Excel');

  console.log('▶ صفحة الفائزين والشهادات والخصوصية');
  assert.ok(pr.data.groups.every((g) => g.rows.every((r) => r.winner && r.votes == null && r.score == null))); ok('الإعلان الافتراضي: الفائزون فقط دون أرقام تفصيلية');
  assert.ok(pr.data.groups[0].rows[0].video); ok('تلاوة الفائز متاحة للمشاهدة');
  const cert = await call('POST', '/api/entry/certificate', { body: { entry_no, token } });
  assert.strictEqual(cert.status, 200, JSON.stringify(cert.data));
  assert.ok(cert.data.available.includes('winner')); ok(`شهادة ${cert.data.certificate.type} برمز ${cert.data.certificate.code}`);
  const ver = await call('GET', '/api/public/verify/' + cert.data.certificate.code);
  assert.strictEqual(ver.data.valid, true); assert.strictEqual(ver.data.name, 'عبدالله السالم'); ok('التحقق العام من الشهادة (بالاسم المعتمد فقط)');
  assert.strictEqual((await call('GET', '/api/public/verify/QC-FAKE-CODE')).data.valid, false); ok('رمز مزوّر غير صالح');
  const pubVid = pr.data.groups[0].rows[0].video;
  assert.strictEqual((await call('GET', pubVid, { headers: { Range: 'bytes=0-9' } })).status, 206);
  const c1id = (await call('GET', '/api/admin/contestants?status=approved', { headers: A })).data.items.find((i) => i.entry_no === entry_no).id;
  await call('POST', `/api/admin/contestants/${c1id}/review`, { headers: A, body: { decision: 'pending' } });
  assert.strictEqual((await call('GET', pubVid)).status, 404); ok('الرابط العام يتوقف فور إلغاء اعتماد المقطع');
  await call('POST', `/api/admin/contestants/${c1id}/review`, { headers: A, body: { decision: 'approve' } });
  const own = (await call('POST', '/api/entry/status', { body: { entry_no, token } })).data.video;
  assert.ok(own.startsWith('/media/o/')); ok('رابط معاينة خاص بصاحب المشاركة');

  console.log('▶ الاستبعاد');
  const dq = await call('POST', `/api/admin/contestants/${id2}/review`, { headers: A, body: { decision: 'disqualify', reason: 'مخالفة الشروط' } });
  assert.strictEqual(dq.status, 200);
  assert.strictEqual((await call('GET', '/api/public/stats')).data.valid_votes, 1); ok('استبعاد متسابق يلغي أصواته');

  console.log('▶ إدارة البيانات');
  const dv = await call('POST', `/api/admin/contestants/${c1id}/delete-video`, { headers: A, body: {} });
  assert.strictEqual(dv.status, 422); ok('حذف الفيديو يتطلب سببًا');
  const arch = await call('POST', '/api/admin/data/purge', { headers: A, body: { action: 'archive_videos', confirm: 'خطأ' } });
  assert.strictEqual(arch.status, 422); ok('الأرشفة تتطلب كتابة رمز الموسم');
  const ov = await call('GET', '/api/admin/data', { headers: A });
  assert.ok(ov.data.seasons.length >= 1); ok('نظرة عامة على البيانات المخزّنة');

  console.log('▶ التصدير والسجل');
  const csv = await call('GET', '/api/admin/export/results.csv', { headers: A });
  assert.ok(String(csv.data).includes('الأصوات الصحيحة')); ok('تصدير النتائج CSV');
  const anon = await call('GET', '/api/admin/contestants');
  assert.strictEqual(anon.status, 401); ok('لوحة الإدارة محمية');
  console.log('\n✅ جميع الاختبارات نجحت');
})().catch((e) => { console.error('\n❌', e); process.exit(1); });
