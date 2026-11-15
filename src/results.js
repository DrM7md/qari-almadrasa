'use strict';
/**
 * محرّك النتائج: الفئات، متوسطات التحكيم، الأوضاع الثلاثة، قواعد التعادل، الجاهزية للإعلان.
 * كل الحسابات تتم في الخادم من قاعدة البيانات مباشرة.
 */
const { db, getAllSettings } = require('./db');
const { phases } = require('./logic');

const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

function categoryOf(grade, s) {
  for (const c of s.categories || []) if ((c.grades || []).includes(grade)) return { id: c.id, name: c.name };
  return { id: '_other', name: 'فئة غير محددة' };
}

function activeJudges() {
  return db.prepare("SELECT id, display_name FROM admins WHERE role = 'judge' AND active = 1 ORDER BY id").all();
}

/** ملخص التحكيم لكل متسابق معتمد */
function judgingSummary(s = getAllSettings()) {
  const judges = activeJudges();
  const judgeIds = new Set(judges.map((j) => j.id));
  const contestants = db.prepare("SELECT id FROM contestants WHERE season = ? AND status = 'approved'").all(s.season);
  const assigned = new Map();
  if (s.judging_assignment === 'manual') {
    for (const r of db.prepare('SELECT judge_id, contestant_id FROM judge_assignments').all()) {
      if (!judgeIds.has(r.judge_id)) continue;
      if (!assigned.has(r.contestant_id)) assigned.set(r.contestant_id, new Set());
      assigned.get(r.contestant_id).add(r.judge_id);
    }
  } else for (const c of contestants) assigned.set(c.id, new Set(judgeIds));

  const evals = db.prepare('SELECT * FROM evaluations WHERE season = ?').all(s.season);
  const crit = s.judging_criteria || [];
  const first = crit[0];
  const out = new Map();
  for (const c of contestants) {
    const as = assigned.get(c.id) || new Set();
    // تُحتسب فقط تقييمات المحكّمين المكلّفين والنشطين والمعتمدة نهائيًا
    const mine = evals.filter((e) => e.contestant_id === c.id && as.has(e.judge_id));
    const submitted = mine.filter((e) => e.status === 'submitted');
    const required = s.judging_completion === 'minimum' ? Math.max(1, Number(s.min_judges_required) || 1) : as.size;
    const pcts = submitted.map((e) => (e.max_total > 0 ? (e.total / e.max_total) * 100 : 0));
    let firstPct = null;
    if (first && submitted.length) {
      const v = submitted.map((e) => { const sc = JSON.parse(e.scores || '{}'); return first.max ? (Number(sc[first.id]) || 0) / first.max * 100 : 0; });
      firstPct = v.reduce((a, b) => a + b, 0) / v.length;
    }
    out.set(c.id, {
      assigned: as.size, required, submitted: submitted.length, drafts: mine.length - submitted.length,
      complete: required > 0 && submitted.length >= required,
      avg: pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null,
      first_criterion_pct: firstPct,
      judge_scores: pcts.map(r2),
    });
  }
  return { judges, summary: out };
}

const TIE_RULES = {
  votes: ['الأعلى في عدد الأصوات الصحيحة', 'عند التعادل: الأعلى في متوسط درجة التحكيم (إن وُجد)', 'ثم: الأعلى في درجة المعيار الأول للتحكيم', 'إن بقي التعادل: يتشارك المتسابقان المركز نفسه'],
  judges: ['الأعلى في متوسط درجة التحكيم المعتمدة', 'عند التعادل: الأعلى في درجة المعيار الأول للتحكيم', 'ثم: الأعلى في عدد الأصوات الصحيحة', 'إن بقي التعادل: يتشارك المتسابقان المركز نفسه'],
  mixed: ['الأعلى في الدرجة النهائية المركّبة', 'عند التعادل: الأعلى في متوسط درجة التحكيم', 'ثم: الأعلى في عدد الأصوات الصحيحة', 'ثم: الأعلى في درجة المعيار الأول للتحكيم', 'إن بقي التعادل: يتشارك المتسابقان المركز نفسه'],
};

function computeResults(s = getAllSettings()) {
  const mode = ['votes', 'judges', 'mixed'].includes(s.results_mode) ? s.results_mode : 'mixed';
  const jwRaw = Number(s.judge_weight) || 0, vwRaw = Number(s.vote_weight) || 0;
  const sumW = jwRaw + vwRaw || 100;
  const jw = jwRaw / sumW, vw = vwRaw / sumW;
  const usesVotes = mode !== 'judges', usesJudges = mode !== 'votes';
  const winners = Math.max(1, Number(s.winners_count) || 1);

  const rows = db.prepare(`SELECT c.id, c.entry_no, c.display_name, c.full_name, c.grade, c.section, c.title, c.created_at,
      (SELECT COUNT(*) FROM votes v WHERE v.contestant_id = c.id AND v.status = 'valid') AS votes
    FROM contestants c WHERE c.season = ? AND c.status = 'approved' ORDER BY c.entry_no`).all(s.season);
  const { summary } = usesJudges || s.judging_enabled ? judgingSummary(s) : { summary: new Map() };

  // التجميع: حسب الفئة أو على مستوى المدرسة
  const groups = new Map();
  for (const r of rows) {
    const cat = s.winner_scope === 'school' ? { id: 'school', name: 'على مستوى المدرسة' } : categoryOf(r.grade, s);
    if (!groups.has(cat.id)) groups.set(cat.id, { id: cat.id, name: cat.name, rows: [] });
    const j = summary.get(r.id) || { avg: null, complete: false, submitted: 0, required: 0, assigned: 0, first_criterion_pct: null, judge_scores: [] };
    groups.get(cat.id).rows.push({ ...r, category: cat.name, judge: j });
  }

  const issues = [];
  const ph = phases(s);
  if (!rows.length) issues.push('لا توجد مشاركات معتمدة.');
  if (usesVotes && ph.votingOpen) issues.push('التصويت ما زال مفتوحًا؛ يجب إغلاقه قبل اعتماد النتائج.');
  if (usesJudges && !s.judging_enabled) issues.push('وضع النتائج يعتمد على التحكيم لكن نظام التحكيم معطّل.');

  const out = [];
  for (const g of groups.values()) {
    const total = g.rows.reduce((a, r) => a + r.votes, 0);
    const top = Math.max(0, ...g.rows.map((r) => r.votes));
    for (const r of g.rows) {
      r.vote_pct = s.vote_normalization === 'top' ? (top ? (r.votes / top) * 100 : 0) : (total ? (r.votes / total) * 100 : 0);
      r.judge_pct = r.judge.avg;
      r.score = mode === 'votes' ? r.votes : mode === 'judges' ? r.judge_pct ?? 0 : jw * (r.judge_pct ?? 0) + vw * r.vote_pct;
      r.incomplete = usesJudges && !r.judge.complete;
      if (r.incomplete) issues.push(`التحكيم غير مكتمل للمشاركة رقم ${r.entry_no} (${r.judge.submitted} من ${r.judge.required} تقييم معتمد).`);
    }
    const keys = (r) => {
      const q = (x) => Math.round((x ?? -1) * 10000);
      if (mode === 'votes') return [r.votes, q(r.judge_pct), q(r.judge.first_criterion_pct)];
      if (mode === 'judges') return [q(r.judge_pct), q(r.judge.first_criterion_pct), r.votes];
      return [q(r.score), q(r.judge_pct), r.votes, q(r.judge.first_criterion_pct)];
    };
    const cmp = (a, b) => { const ka = keys(a), kb = keys(b); for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i]; return 0; };
    g.rows.sort((a, b) => cmp(a, b) || a.entry_no - b.entry_no);
    g.rows.forEach((r, i) => {
      r.rank = i > 0 && cmp(g.rows[i - 1], r) === 0 ? g.rows[i - 1].rank : i + 1;
      r.tied = (i > 0 && cmp(g.rows[i - 1], r) === 0) || (i < g.rows.length - 1 && cmp(g.rows[i + 1], r) === 0);
      r.winner = r.rank <= winners;
    });
    out.push({
      id: g.id, name: g.name, total_votes: total, top_votes: top,
      rows: g.rows.map((r) => ({
        id: r.id, entry_no: r.entry_no, display_name: r.display_name, full_name: r.full_name, grade: r.grade, section: r.section, title: r.title,
        category: r.category, votes: r.votes, vote_pct: r2(r.vote_pct), judge_pct: r2(r.judge_pct), score: mode === 'votes' ? r.votes : r2(r.score),
        judges_submitted: r.judge.submitted, judges_required: r.judge.required, judge_scores: r.judge.judge_scores,
        incomplete: r.incomplete, rank: r.rank, tied: r.tied, winner: r.winner,
        formula: mode === 'mixed' ? `${r2(jw * 100)}% × ${r2(r.judge_pct ?? 0)} + ${r2(vw * 100)}% × ${r2(r.vote_pct)} = ${r2(r.score)}`
          : mode === 'judges' ? `متوسط ${r.judge.submitted} تقييم = ${r2(r.judge_pct ?? 0)}` : `${r.votes} صوت صحيح`,
      })),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'ar'));

  const normText = s.vote_normalization === 'top'
    ? 'نسبة التصويت = (أصوات المتسابق ÷ أعلى عدد أصوات في فئته) × 100'
    : 'نسبة التصويت = (أصوات المتسابق ÷ مجموع الأصوات الصحيحة في فئته) × 100';
  const judgeText = 'درجة التحكيم = متوسط (مجموع درجات المحكّم ÷ الدرجة العظمى × 100) لجميع التقييمات المعتمدة نهائيًا من المحكّمين المكلّفين. لا تُحتسب المسودات، ويُعدّ التحكيم مكتملًا عندما يبلغ عدد التقييمات المعتمدة الحدَّ المطلوب.';
  const formula = mode === 'votes' ? ['الترتيب حسب عدد الأصوات الصحيحة فقط.']
    : mode === 'judges' ? [judgeText]
    : [judgeText, normText, `الدرجة النهائية = (${r2(jw * 100)}% × درجة التحكيم) + (${r2(vw * 100)}% × نسبة التصويت)`];

  return {
    mode, weights: { judge: r2(jw * 100), vote: r2(vw * 100) }, normalization: s.vote_normalization, scope: s.winner_scope,
    winners_count: winners, groups: out, issues: [...new Set(issues)], ready: issues.length === 0,
    formula, tie_rules: TIE_RULES[mode], generated_at: new Date().toISOString(),
    totals: { contestants: rows.length, valid_votes: rows.reduce((a, r) => a + r.votes, 0) },
  };
}

// النسخة المنشورة للجمهور: بلا الاسم الكامل أو أي بيانات خاصة.
// مستوى التفصيل: winners = الفائزون فقط بلا أرقام (افتراضي) | winners_scores = الفائزون مع درجاتهم | full = الترتيب الكامل بالأرقام
function publicSnapshot(data, s) {
  const { mediaUrls } = require('./logic');
  const detail = ['winners', 'winners_scores', 'full'].includes(s.public_results_detail) ? s.public_results_detail : 'winners';
  const nums = detail !== 'winners';
  const live = new Map(db.prepare("SELECT * FROM contestants WHERE season = ? AND status = 'approved'").all(s.season).map((c) => [c.id, c]));
  return {
    detail,
    competition_name: s.competition_name, school_name: s.school_name, season: s.season,
    groups: data.groups.map((g) => ({
      id: g.id, name: g.name,
      rows: g.rows.filter((r) => detail === 'full' || r.winner).map((r) => {
        const c = live.get(r.id);
        const m = c ? mediaUrls(c) : {};
        return {
          entry_no: r.entry_no, name: r.display_name, title: r.title,
          grade: s.show_class_publicly ? r.grade : null, section: s.show_class_publicly ? r.section : null,
          rank: r.rank, tied: r.tied, winner: r.winner,
          video: r.winner ? m.video || null : null, poster: r.winner ? m.poster || null : null,
          votes: nums && data.mode !== 'judges' ? r.votes : null,
          judge_pct: nums && data.mode !== 'votes' ? r.judge_pct : null,
          vote_pct: nums && data.mode === 'mixed' ? r.vote_pct : null,
          score: nums ? r.score : null,
        };
      }),
    })),
    mode: data.mode, weights: data.weights, scope: data.scope, winners_count: data.winners_count,
    formula: data.formula, tie_rules: data.tie_rules, approved_at: data.approved_at,
  };
}

function activeSnapshot(season) {
  const row = db.prepare('SELECT * FROM result_snapshots WHERE season = ? AND active = 1 ORDER BY id DESC LIMIT 1').get(season);
  if (!row) return null;
  const data = JSON.parse(row.data);
  data.approved_at = row.approved_at; data.snapshot_id = row.id; data.approved_by = row.approved_by;
  return data;
}

module.exports = { categoryOf, judgingSummary, computeResults, publicSnapshot, activeSnapshot, activeJudges, TIE_RULES };
