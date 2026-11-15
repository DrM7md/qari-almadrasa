'use strict';
/**
 * بيانات تجريبية منفصلة تمامًا عن البيانات الحقيقية.
 * - تُنشأ في مجلد مستقل (data-demo افتراضيًا) بقاعدة بيانات خاصة بها.
 * - يرفض السكربت العمل على أي قاعدة بيانات غير موسومة بأنها تجريبية.
 * - يظهر في الموقع شريط واضح «نسخة تجريبية».
 *
 *   npm run demo                → إنشاء البيانات (إن لم توجد) ثم تشغيل الخادم عليها
 *   npm run demo -- --reset     → حذف النسخة التجريبية وإعادة إنشائها
 *   node scripts/demo.js --seed-only
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const DEMO_DIR = path.resolve(process.env.DEMO_DATA_DIR || path.join(ROOT, 'data-demo'));
const REAL_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
if (DEMO_DIR === REAL_DIR && process.env.DATA_DIR) { console.error('✖ مجلد البيانات التجريبية يطابق مجلد البيانات الحقيقية. أوقفت العملية.'); process.exit(1); }

const dbFile = path.join(DEMO_DIR, 'qari.db');
function isDemoDb() {
  if (!fs.existsSync(dbFile)) return null;
  try {
    const d = new DatabaseSync(dbFile, { readOnly: true });
    const r = d.prepare("SELECT value FROM settings WHERE key = 'demo_mode'").get();
    d.close();
    return r && JSON.parse(r.value) === true;
  } catch { return false; }
}
const state = isDemoDb();
if (state === false) { console.error(`✖ ${dbFile} ليست قاعدة بيانات تجريبية. لن ألمسها.`); process.exit(1); }
if (process.argv.includes('--reset') && state) fs.rmSync(DEMO_DIR, { recursive: true, force: true });

process.env.DATA_DIR = DEMO_DIR;
process.env.STORAGE_DRIVER = 'local';
const fresh = !fs.existsSync(dbFile);

async function seed() {
  const { db, now, setSetting, getAllSettings } = require('../src/db');
  const sec = require('../src/security');
  const storage = require('../src/storage');
  const media = require('../src/media');
  const { execFileSync } = require('node:child_process');
  const { tokenHash, newEntryToken } = require('../src/routes-public');
  const { newPin, pinHash } = require('../src/voting');
  const config = require('../src/config');

  setSetting('demo_mode', true);
  const day = 86400000, iso = (d) => new Date(Date.now() + d * day).toISOString();
  const S = {
    school_name: 'مدرسة النموذج التجريبية', competition_name: 'مسابقة قارئ المدرسة — نسخة تجريبية', season: 'DEMO',
    registration_mode: 'auto', registration_start: iso(-20), registration_end: iso(-3),
    voting_mode: 'auto', voting_start: iso(-2), voting_end: iso(5), min_video_seconds: 5,
    stages: [
      { id: 's1', title: 'التسجيل ورفع التلاوات', description: 'يسجّل الطلاب ويرفعون مقاطعهم.', start: iso(-20), end: iso(-3), status: 'auto' },
      { id: 's2', title: 'مراجعة اللجنة والتحكيم', description: 'تُراجع المقاطع ويقيّمها المحكّمون.', start: iso(-3), end: iso(-2), status: 'auto' },
      { id: 's3', title: 'تصويت الطلاب', description: 'يصوّت الطلاب المؤهلون لأجمل الأصوات.', start: iso(-2), end: iso(5), status: 'auto' },
      { id: 's4', title: 'إعلان النتائج', description: 'تعتمد اللجنة النتائج وتعلنها.', start: iso(5), end: iso(8), status: 'auto' },
    ],
  };
  for (const [k, v] of Object.entries(S)) setSetting(k, v);
  const s = getAllSettings();

  const admin = (u, name, role, pw) => db.prepare('INSERT OR IGNORE INTO admins(username, display_name, password_hash, role, can_manage_votes, created_at) VALUES(?,?,?,?,?,?)').run(u, name, sec.hashPassword(pw), role, role === 'admin' ? 1 : 0, now());
  admin('demo', 'المالك (تجريبي)', 'owner', 'Demo2026pass');
  admin('reviewer', 'مراجع تجريبي', 'reviewer', 'Demo2026pass');
  admin('judge1', 'المحكّم الأول (تجريبي)', 'judge', 'Judge2026pass');
  admin('judge2', 'المحكّم الثاني (تجريبي)', 'judge', 'Judge2026pass');
  admin('judge3', 'المحكّم الثالث (تجريبي)', 'judge', 'Judge2026pass');

  // أسماء وهمية بالكامل
  const first = ['يوسف', 'عبدالرحمن', 'حمد', 'سلمان', 'تميم', 'أنس', 'معاذ', 'زياد', 'فهد', 'ناصر', 'عمر', 'خالد', 'سعود', 'بدر', 'راشد', 'ماجد', 'جاسم', 'علي', 'إبراهيم', 'سيف'];
  const last = ['التجريبي', 'النموذجي', 'الافتراضي', 'المثالي'];
  const surahs = ['سورة الملك (1–10)', 'سورة الرحمن (1–25)', 'سورة النبأ', 'سورة يس (1–12)', 'سورة الفجر', 'سورة الضحى والشرح', 'سورة مريم (1–15)', 'سورة الواقعة (1–26)', 'سورة الإنسان (1–12)', 'سورة ق (1–15)', 'سورة الأعلى', 'سورة البروج'];
  const grades = s.grades;
  const hasFf = media.hasMpeg;
  if (!hasFf) console.warn('⚠ ffmpeg غير متاح: ستُنشأ المشاركات دون مقاطع (مسودات).');
  const tmpDir = path.join(config.uploadTmpDir, 'demo'); fs.mkdirSync(tmpDir, { recursive: true });
  const colors = ['0x0a4636', '0x073a2c', '0x0e5a45', '0x052e23'];
  const contestants = [];
  for (let i = 0; i < 12; i++) {
    const full = `${first[i]} ${first[(i + 7) % 20]} ${first[(i + 3) % 20]} ${last[i % 4]}`;
    const grade = grades[(i * 3) % grades.length];
    const entry = 101 + i;
    const ts = iso(-15 + i * 0.5);
    let videoKey = null, posterKey = null, dur = null, size = null;
    if (hasFf) {
      const f = path.join(tmpDir, `v${entry}.mp4`);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${colors[i % 4]}:size=640x360:rate=24`, '-f', 'lavfi', '-i', `sine=frequency=${220 + i * 22}:sample_rate=44100`,
        '-t', String(12 + (i % 5) * 3), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', f]);
      size = fs.statSync(f).size; dur = 12 + (i % 5) * 3;
      const pf = f + '.jpg';
      if (await media.poster(f, pf, 1)) { posterKey = `posters/DEMO/${entry}.jpg`; await storage.putFile(pf, posterKey, 'image/jpeg'); }
      videoKey = `videos/DEMO/${entry}.mp4`; await storage.putFile(f, videoKey, 'video/mp4');
    }
    const status = !hasFf ? 'draft' : i === 11 ? 'pending' : 'approved';
    db.prepare(`INSERT INTO contestants(season, entry_no, full_name, display_name, school_id, grade, section, title, terms_accepted, guardian_consent, consent_at, token_hash, status,
      video_key, poster_key, video_mime, video_size, video_duration, video_uploaded_at, views, featured, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,1,1,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('DEMO', entry, full, `${first[i]} ${last[i % 4]}`, `D${9000 + i}`, grade, s.sections[i % 3], surahs[i], ts, tokenHash(newEntryToken()), status,
        videoKey, posterKey, videoKey ? 'video/mp4' : null, size, dur, videoKey ? ts : null, Math.floor(Math.random() * 60), i < 3 ? 1 : 0, ts, ts);
    contestants.push(db.prepare('SELECT * FROM contestants WHERE season = ? AND entry_no = ?').get('DEMO', entry));
  }

  // 60 طالبًا مؤهلًا بأسماء وهمية + رموز شخصية تُحفظ في ملف للتجربة فقط
  const pins = [['الرقم المدرسي', 'الاسم', 'الصف', 'الرمز الشخصي']];
  for (let i = 0; i < 60; i++) {
    const sid = i < 12 ? `D${9000 + i}` : `D${9100 + i}`;
    const name = `${first[i % 20]} ${first[(i + 5) % 20]} ${last[i % 4]}`;
    const grade = i < 12 ? contestants[i].grade : grades[i % grades.length];
    db.prepare('INSERT INTO students(season, school_id, full_name, grade, section, created_at, updated_at) VALUES(?,?,?,?,?,?,?)').run('DEMO', sid, name, grade, s.sections[i % 3], now(), now());
    const st = db.prepare('SELECT id FROM students WHERE season = ? AND school_id = ?').get('DEMO', sid);
    const pin = newPin();
    db.prepare('UPDATE students SET pin_hash = ?, pin_set_at = ? WHERE id = ?').run(pinHash(pin, st.id), now(), st.id);
    pins.push([sid, name, grade, pin]);
  }
  fs.writeFileSync(path.join(DEMO_DIR, 'demo-pins.csv'), '﻿' + pins.map((r) => r.join(',')).join('\n'));

  // أصوات وتقييمات تجريبية (لتجربة لوحات الإحصاء والنتائج)
  const approved = contestants.filter((c) => c.status === 'approved');
  if (approved.length) {
    const students = db.prepare("SELECT * FROM students WHERE season = 'DEMO'").all();
    students.slice(12, 50).forEach((st, k) => {
      const c = approved[Math.floor(Math.pow(Math.random(), 1.6) * approved.length)];
      db.prepare("INSERT INTO votes(season, contestant_id, student_id, method, status, ip_hash, created_at, updated_at) VALUES('DEMO',?,?,'pin','valid',?,?,?)").run(c.id, st.id, sec.hmac('demo' + k, 'ip'), iso(-2 + k * 0.03), iso(-2 + k * 0.03));
    });
    const judges = db.prepare("SELECT id FROM admins WHERE role = 'judge'").all();
    const crit = s.judging_criteria; const maxT = crit.reduce((a, k) => a + k.max, 0);
    for (const c of approved) for (const j of judges) {
      const sc = {}; let t = 0;
      for (const k of crit) { const v = Math.round((k.max * (0.6 + Math.random() * 0.38)) * 2) / 2; sc[k.id] = v; t += v; }
      db.prepare("INSERT INTO evaluations(season, contestant_id, judge_id, scores, notes, total, max_total, status, submitted_at, created_at, updated_at) VALUES('DEMO',?,?,?,?,?,?,'submitted',?,?,?)")
        .run(c.id, j.id, JSON.stringify(sc), 'ملاحظة تجريبية', t, maxT, now(), now(), now());
    }
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`
✦ أُنشئت النسخة التجريبية في: ${DEMO_DIR}
  حسابات الإدارة:  demo / Demo2026pass  (المالك) · reviewer / Demo2026pass
  حسابات المحكّمين: judge1 · judge2 · judge3 / Judge2026pass
  رموز تصويت الطلاب: ${path.join(DEMO_DIR, 'demo-pins.csv')}
  ملاحظة: بيانات النسخة التجريبية وهمية بالكامل ولا تختلط بقاعدة البيانات الحقيقية.`);
}

(async () => {
  if (fresh) await seed(); else console.log(`✦ النسخة التجريبية موجودة مسبقًا في ${DEMO_DIR} (استخدم --reset لإعادة إنشائها).`);
  if (!process.argv.includes('--seed-only')) require('../server.js');
})().catch((e) => { console.error(e); process.exit(1); });
