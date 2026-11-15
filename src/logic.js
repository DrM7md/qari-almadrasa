'use strict';
const { db, getAllSettings } = require('./db');
const { signPayload } = require('./security');

const t = (iso) => (iso ? Date.parse(iso) : NaN);

function windowOpen(mode, start, end, at = Date.now()) {
  if (mode === 'open') return true;
  if (mode === 'closed') return false;
  const s = t(start), e = t(end);
  return (!isNaN(s) ? at >= s : true) && (!isNaN(e) ? at < e : true);
}

function phases(s = getAllSettings()) {
  const at = Date.now();
  const registrationOpen = windowOpen(s.registration_mode, s.registration_start, s.registration_end, at);
  const votingOpen = windowOpen(s.voting_mode, s.voting_start, s.voting_end, at);
  const stages = (s.stages || []).map((st) => {
    let status = st.status;
    if (!['upcoming', 'active', 'done'].includes(status)) {
      const a = t(st.start), b = t(st.end);
      status = !isNaN(b) && at >= b ? 'done' : !isNaN(a) && at < a ? 'upcoming' : 'active';
    }
    return { id: st.id, title: st.title, description: st.description, start: st.start, end: st.end, status };
  });
  // العدّاد التنازلي: أقرب موعد قادم ذي صلة
  let countdown = null;
  const future = (iso) => !isNaN(t(iso)) && t(iso) > at;
  if (registrationOpen && s.registration_mode !== 'open' && future(s.registration_end)) countdown = { label: 'يُغلق التسجيل بعد', target: s.registration_end, kind: 'registration_end' };
  else if (!registrationOpen && s.registration_mode === 'auto' && future(s.registration_start)) countdown = { label: 'يبدأ التسجيل بعد', target: s.registration_start, kind: 'registration_start' };
  else if (votingOpen && s.voting_mode !== 'open' && future(s.voting_end)) countdown = { label: 'يُغلق التصويت بعد', target: s.voting_end, kind: 'voting_end' };
  else if (!votingOpen && s.voting_mode === 'auto' && future(s.voting_start)) countdown = { label: 'يبدأ التصويت بعد', target: s.voting_start, kind: 'voting_start' };
  return { registrationOpen, votingOpen, stages, countdown };
}

const VIDEO_TTL = 6 * 3600;
function mediaUrls(c) {
  const out = { video: null, poster: null };
  if (c.video_key) out.video = `/media/v/${c.entry_no}?s=${signPayload(`v:${c.id}:${c.video_key}`, VIDEO_TTL)}`;
  if (c.poster_key) out.poster = `/media/p/${c.entry_no}?s=${signPayload(`p:${c.id}:${c.poster_key}`, VIDEO_TTL)}`;
  return out;
}

// رابط خاص بصاحب المشاركة لمعاينة مقطعه قبل الاعتماد (لا يصلح للعرض العام)
function ownerVideoUrl(c) {
  return c.video_key ? `/media/o/${c.entry_no}?s=${signPayload(`o:${c.id}:${c.video_key}`, 2 * 3600)}` : null;
}

function validVotesMap(season) {
  const m = new Map();
  for (const r of db.prepare("SELECT contestant_id id, COUNT(*) n FROM votes WHERE season = ? AND status = 'valid' GROUP BY contestant_id").all(season)) m.set(r.id, r.n);
  return m;
}

// ما يراه الجمهور فقط — لا رقم مدرسي، لا اسم كامل، لا أي بيانات تواصل
function publicContestant(c, s, votes) {
  const media = mediaUrls(c);
  return {
    entry_no: c.entry_no,
    name: c.display_name,
    grade: s.show_class_publicly ? c.grade : null,
    section: s.show_class_publicly ? c.section : null,
    title: c.title,
    duration: c.video_duration ? Math.round(c.video_duration) : null,
    video: media.video,
    poster: media.poster,
    views: s.show_views ? c.views : null,
    votes: s.show_vote_counts && votes ? votes.get(c.id) || 0 : null,
    featured: !!c.featured,
  };
}

function formatEntry(n) { return String(n).padStart(3, '0'); }

module.exports = { phases, windowOpen, mediaUrls, ownerVideoUrl, publicContestant, validVotesMap, formatEntry };
