'use strict';
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const db = new DatabaseSync(config.dbFile);
// قاعدة البيانات ومجلد البيانات لا يقرؤهما إلا مستخدم الخادم
try { require('node:fs').chmodSync(config.dbFile, 0o600); require('node:fs').chmodSync(config.dataDir, 0o700); } catch { /* أنظمة لا تدعم الصلاحيات */ }
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contestants (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  season            TEXT NOT NULL,
  entry_no          INTEGER NOT NULL,
  full_name         TEXT NOT NULL,
  display_name      TEXT NOT NULL,
  school_id         TEXT NOT NULL,
  grade             TEXT NOT NULL,
  section           TEXT NOT NULL,
  title             TEXT NOT NULL,
  terms_accepted    INTEGER NOT NULL DEFAULT 0,
  guardian_consent  INTEGER NOT NULL DEFAULT 0,
  token_hash        TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'draft', -- draft | pending | approved | rejected | disqualified
  reject_reason     TEXT,
  disqualify_reason TEXT,
  video_key         TEXT,
  poster_key        TEXT,
  video_mime        TEXT,
  video_size        INTEGER,
  video_duration    REAL,
  video_uploaded_at TEXT,
  views             INTEGER NOT NULL DEFAULT 0,
  featured          INTEGER NOT NULL DEFAULT 0,
  reviewed_at       TEXT,
  reviewed_by       INTEGER,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (season, school_id),
  UNIQUE (season, entry_no)
);
CREATE INDEX IF NOT EXISTS idx_contestants_status ON contestants(season, status);

CREATE TABLE IF NOT EXISTS uploads (
  id             TEXT PRIMARY KEY,
  contestant_id  INTEGER NOT NULL REFERENCES contestants(id) ON DELETE CASCADE,
  filename       TEXT NOT NULL,
  mime           TEXT NOT NULL,
  ext            TEXT NOT NULL,
  size           INTEGER NOT NULL,
  received       INTEGER NOT NULL DEFAULT 0,
  fingerprint    TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS view_events (
  contestant_id INTEGER NOT NULL REFERENCES contestants(id) ON DELETE CASCADE,
  viewer_hash   TEXT NOT NULL,
  day           TEXT NOT NULL,
  PRIMARY KEY (contestant_id, viewer_hash, day)
);

CREATE TABLE IF NOT EXISTS admins (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name   TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'reviewer', -- owner | admin | reviewer | judge
  can_manage_votes INTEGER NOT NULL DEFAULT 0,
  active         INTEGER NOT NULL DEFAULT 1,
  failed_logins  INTEGER NOT NULL DEFAULT 0,
  locked_until   TEXT,
  last_login_at  TEXT,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  admin_id    INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf        TEXT NOT NULL,
  ip_hash     TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id    INTEGER,
  action      TEXT NOT NULL,
  target      TEXT,
  details     TEXT,
  created_at  TEXT NOT NULL
);
`);


// ———————— ترحيل من الإصدار الأول (تصويت الأجهزة/الرموز) ————————
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
if (cols('votes').includes('voter_hash')) db.exec('ALTER TABLE votes RENAME TO votes_legacy_v1');
if (!cols('contestants').includes('disqualify_reason')) db.exec('ALTER TABLE contestants ADD COLUMN disqualify_reason TEXT');
if (!cols('contestants').includes('consent_at')) db.exec('ALTER TABLE contestants ADD COLUMN consent_at TEXT');
if (!cols('admins').includes('can_manage_votes')) db.exec('ALTER TABLE admins ADD COLUMN can_manage_votes INTEGER NOT NULL DEFAULT 0');

db.exec(`
-- قائمة الطلاب المؤهلين للتصويت (السجل المعتمد من المدرسة)
CREATE TABLE IF NOT EXISTS students (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  season        TEXT NOT NULL,
  school_id     TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  grade         TEXT NOT NULL,
  section       TEXT NOT NULL DEFAULT '',
  email         TEXT,
  pin_hash      TEXT,
  pin_set_at    TEXT,
  failed        INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (season, school_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_students_email ON students(season, email) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS voter_sessions (
  token_hash  TEXT PRIMARY KEY,
  student_id  INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  method      TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- الأصوات: صوت صحيح واحد فقط لكل طالب في الموسم (قيد فريد جزئي في قاعدة البيانات)
CREATE TABLE IF NOT EXISTS votes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  season         TEXT NOT NULL,
  contestant_id  INTEGER NOT NULL REFERENCES contestants(id) ON DELETE CASCADE,
  student_id     INTEGER NOT NULL REFERENCES students(id),
  method         TEXT NOT NULL,             -- pin | oidc
  status         TEXT NOT NULL DEFAULT 'valid', -- valid | replaced | void
  status_reason  TEXT,
  ip_hash        TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_votes_one_per_student ON votes(season, student_id) WHERE status = 'valid';
CREATE INDEX IF NOT EXISTS idx_votes2_contestant ON votes(contestant_id, status);

-- سجل محاولات التصويت المرفوضة أو المشبوهة (للإدارة فقط)
CREATE TABLE IF NOT EXISTS vote_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  season       TEXT NOT NULL,
  kind         TEXT NOT NULL,
  student_id   INTEGER,
  entered_id   TEXT,
  contestant_id INTEGER,
  ip_hash      TEXT NOT NULL,
  user_agent   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts ON vote_attempts(season, created_at);

-- لجنة التحكيم
CREATE TABLE IF NOT EXISTS judge_assignments (
  judge_id      INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  contestant_id INTEGER NOT NULL REFERENCES contestants(id) ON DELETE CASCADE,
  PRIMARY KEY (judge_id, contestant_id)
);
CREATE TABLE IF NOT EXISTS evaluations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  season         TEXT NOT NULL,
  contestant_id  INTEGER NOT NULL REFERENCES contestants(id) ON DELETE CASCADE,
  judge_id       INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  scores         TEXT NOT NULL,     -- {criterionId: score}
  notes          TEXT,
  total          REAL NOT NULL,
  max_total      REAL NOT NULL,
  status         TEXT NOT NULL DEFAULT 'draft', -- draft | submitted
  submitted_at   TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (contestant_id, judge_id)
);

-- الشهادات الصادرة (للتحقق من صحتها عبر رمز)
CREATE TABLE IF NOT EXISTS certificates (
  code           TEXT PRIMARY KEY,
  season         TEXT NOT NULL,
  contestant_id  INTEGER NOT NULL REFERENCES contestants(id) ON DELETE CASCADE,
  type           TEXT NOT NULL,   -- participation | winner
  rank           INTEGER,
  category       TEXT,
  issued_at      TEXT NOT NULL,
  UNIQUE (contestant_id, type)
);

-- لقطات النتائج المعتمدة إداريًا
CREATE TABLE IF NOT EXISTS result_snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  season       TEXT NOT NULL,
  data         TEXT NOT NULL,
  approved_by  INTEGER,
  approved_at  TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1
);
`);

const now = () => new Date().toISOString();

// ———————————— الإعدادات الافتراضية ————————————
const inDays = (d) => new Date(Date.now() + d * 86400000).toISOString();
const DEFAULT_SETTINGS = {
  season: '1448',
  school_name: 'مدرستنا',
  hero_subtitle: 'مسابقة لاكتشاف أجمل الأصوات في تلاوة القرآن الكريم بين طلاب المدرسة',
  about_text:
    'مسابقة «قارئ المدرسة» مبادرة تربوية تهدف إلى اكتشاف المواهب القرآنية بين الطلاب، وتشجيعهم على إتقان التلاوة وتحسين الأداء والتجويد، في أجواء تنافسية راقية تليق بكتاب الله.',
  goals: [
    'تعزيز ارتباط الطلاب بكتاب الله تلاوةً وتدبّرًا.',
    'اكتشاف الأصوات المتميزة ورعايتها وتنميتها.',
    'نشر ثقافة الإتقان وأحكام التجويد بين الطلاب.',
    'إتاحة منبر آمن ومحترم لعرض المواهب القرآنية.',
  ],
  terms: [
    'المسابقة مخصصة لطلاب المدرسة المسجلين رسميًا فقط.',
    'يحق لكل طالب المشاركة بتلاوة واحدة فقط.',
    'يجب أن تكون التلاوة بصوت الطالب نفسه دون أي معالجة صوتية أو موسيقى أو مؤثرات.',
    'يُفضَّل أن يُظهر المقطع التلاوة فقط دون عرض وجه الطالب، ويُلزم بموافقة ولي الأمر عند ظهوره.',
    'تخضع جميع المقاطع لمراجعة لجنة المسابقة قبل النشر، ويحق للجنة رفض أي مقطع مخالف.',
    'لا تُنشر البيانات الشخصية للطالب، ويظهر للعامة الاسم المعتمد للنشر فقط.',
    'يُمنع التصويت المتكرر أو المدفوع أو الآلي، وتُستبعد الأصوات المخالفة دون الرجوع للمشارك.',
    'قرار لجنة التحكيم نهائي، ويُجمع بين تقييم اللجنة وتصويت الجمهور وفق النسب المعلنة.',
  ],
  registration_mode: 'auto', // auto | open | closed
  registration_start: now(),
  registration_end: inDays(14),
  voting_mode: 'auto',
  voting_start: inDays(16),
  voting_end: inDays(23),
  max_video_mb: 200,
  max_video_seconds: 300,
  min_video_seconds: 15,
  allowed_formats: ['mp4', 'mov', 'm4v', 'webm', 'mpeg', 'mpg', 'mp3'],
  allow_replace: true,
  allow_resubmit_rejected: true,
  require_guardian_consent: true,
  show_class_publicly: true,
  show_vote_counts: false,
  show_views: true,
  // ——— التصويت ———
  voter_auth: 'pin', // pin = رقم مدرسي + رمز شخصي | oidc = حساب مدرسي (Google / Microsoft)
  prevent_self_vote: true,
  allow_vote_change: false,
  vote_restrict_to_category: false,
  // ——— النتائج ———
  results_mode: 'mixed', // votes | judges | mixed
  judge_weight: 70,
  vote_weight: 30,
  vote_normalization: 'share', // share = نسبة من مجموع أصوات الفئة | top = نسبة إلى أعلى متسابق في الفئة
  winner_scope: 'category', // category | school
  winners_count: 3,
  // ——— التحكيم ———
  judging_enabled: true,
  judging_assignment: 'all', // all = كل محكّم يقيّم كل المعتمدين | manual = تكليف يدوي
  judging_completion: 'all_assigned', // all_assigned | minimum
  min_judges_required: 2,
  judging_criteria: [
    { id: 'tajweed', name: 'أحكام التجويد', max: 40 },
    { id: 'hifz', name: 'سلامة الحفظ والتلاوة', max: 30 },
    { id: 'voice', name: 'جمال الصوت والأداء', max: 20 },
    { id: 'waqf', name: 'الوقف والابتداء', max: 10 },
  ],
  competition_name: 'مسابقة قارئ المدرسة',
  // ——— الخصوصية والاحتفاظ ———
  public_results_detail: 'winners', // winners | winners_scores | full
  certificates_enabled: true,
  retention_days: 180,
  guardian_consent_text: 'أقرّ بموافقة ولي الأمر على مشاركتي، ونشر مقطع التلاوة على منصة المسابقة بعد اعتماده من اللجنة، وفق سياسة الخصوصية.',
  privacy_policy: [
    'تجمع المنصة الحد الأدنى من البيانات اللازمة لإدارة المسابقة: الاسم، والرقم المدرسي، والصف والشعبة، وعنوان التلاوة، ومقطع الفيديو.',
    'لا يُعرض للعامة إلا الاسم المعتمد للنشر والصف والشعبة (إن سمحت الإعدادات) وعنوان التلاوة، ولا يُنشر الرقم المدرسي أو الاسم الكامل أو بيانات التواصل.',
    'لا يُنشر أي مقطع إلا بعد مراجعته واعتماده من لجنة المسابقة وإقرار موافقة ولي الأمر. تُحذف البيانات الوصفية من المقاطع (مثل موقع التصوير) تلقائيًا عند الرفع.',
    'التصويت سرّي: لا يُكشف لمن صوّت أي طالب، ولا تُتاح هويات المصوّتين إلا لعدد محدود من المسؤولين المخوّلين، وتُسجَّل أي عملية على الأصوات في سجل تدقيق.',
    'كلمات المرور والرموز الشخصية مخزّنة مشفّرة، وعناوين الشبكة تُحفظ كبصمات مشفّرة لا يمكن عكسها.',
    'يحق لولي الأمر طلب حذف مشاركة الطالب ومقطعه في أي وقت عبر التواصل مع لجنة المسابقة.',
  ],
  // ——— نسخة تجريبية ———
  demo_mode: false,
  school_logo: null,
  categories: [
    { id: 'c1', name: 'المرحلة الابتدائية', grades: ['الصف الرابع', 'الصف الخامس', 'الصف السادس'] },
    { id: 'c2', name: 'المرحلة الإعدادية', grades: ['الصف السابع', 'الصف الثامن', 'الصف التاسع'] },
    { id: 'c3', name: 'المرحلة الثانوية', grades: ['الصف العاشر', 'الصف الحادي عشر', 'الصف الثاني عشر'] },
  ],
  grades: [
    'الصف الرابع', 'الصف الخامس', 'الصف السادس', 'الصف السابع', 'الصف الثامن',
    'الصف التاسع', 'الصف العاشر', 'الصف الحادي عشر', 'الصف الثاني عشر',
  ],
  sections: ['أ', 'ب', 'ج', 'د', 'هـ', 'و', 'ز'],
  stages: [
    { id: 's1', title: 'التسجيل ورفع التلاوات', description: 'يسجّل الطلاب ويرفعون مقاطع تلاواتهم.', start: now(), end: inDays(14), status: 'auto' },
    { id: 's2', title: 'مراجعة اللجنة', description: 'تراجع لجنة المسابقة المقاطع وتعتمد المستوفي للشروط.', start: inDays(14), end: inDays(16), status: 'auto' },
    { id: 's3', title: 'تصويت الجمهور', description: 'يصوّت الجمهور لأجمل الأصوات بين التلاوات المعتمدة.', start: inDays(16), end: inDays(23), status: 'auto' },
    { id: 's4', title: 'التحكيم وإعلان النتائج', description: 'تقيّم لجنة التحكيم المتأهلين وتعلن الفائزين.', start: inDays(23), end: inDays(27), status: 'auto' },
  ],
  footer_note: 'لجنة مسابقة «قارئ المدرسة»',
};

function getAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    try { out[r.key] = JSON.parse(r.value); } catch { /* تجاهل القيم التالفة */ }
  }
  return out;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

// تثبيت الإعدادات الافتراضية أول مرة فقط
(function seed() {
  const has = db.prepare('SELECT COUNT(*) c FROM settings').get().c;
  if (!has) for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) setSetting(k, v);
})();

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}

function audit(adminId, action, target, details) {
  db.prepare('INSERT INTO audit_log(admin_id, action, target, details, created_at) VALUES(?,?,?,?,?)')
    .run(adminId || null, action, target == null ? null : String(target), details ? JSON.stringify(details) : null, now());
}

module.exports = { db, now, tx, audit, getAllSettings, setSetting, DEFAULT_SETTINGS };
