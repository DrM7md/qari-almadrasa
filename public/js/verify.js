(function () {
  'use strict';
  const { api, esc, $, alertBox, fmtDate } = window.Q;
  const RANK = ['', 'الأول', 'الثاني', 'الثالث'];
  async function check(code) {
    try {
      const r = await api('/api/public/verify/' + encodeURIComponent(code.trim().toUpperCase()));
      $('#out').innerHTML = r.valid
        ? alertBox('ok', `<b>شهادة صحيحة ✓</b><br>${r.type === 'winner' ? `شهادة تفوّق — المركز ${RANK[r.rank] || r.rank}${r.category ? ' في ' + esc(r.category) : ''}` : 'شهادة مشاركة'}<br>القارئ: <b>${esc(r.name)}</b> · التلاوة: ${esc(r.title)}<br>${esc(r.competition_name)} ${r.school_name ? '— ' + esc(r.school_name) : ''} · الموسم ${esc(r.season)} · صدرت في ${fmtDate(r.issued_at)}`)
        : alertBox('err', 'لم يُعثر على شهادة بهذا الرمز. تأكد من كتابته كما هو مطبوع.');
    } catch (e) { $('#out').innerHTML = alertBox('err', esc(e.message)); }
  }
  document.addEventListener('DOMContentLoaded', () => {
    const c = new URLSearchParams(location.search).get('c');
    if (c) { $('#code').value = c; check(c); }
    $('#vf').onsubmit = (e) => { e.preventDefault(); if ($('#code').value.trim()) check($('#code').value); };
  });
})();
