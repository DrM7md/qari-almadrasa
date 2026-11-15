(function () {
  'use strict';
  const { api, esc, $, $$, alertBox, setBusy, toast, fmtDate, toAscii } = window.Q;
  let cfg, creds;

  function step(n) {
    $$('#steps li').forEach((li, i) => { li.classList.toggle('on', i + 1 === n); li.classList.toggle('done', i + 1 < n); });
    [1, 2, 3, 4].forEach((i) => $('#step' + i).classList.toggle('hidden', i !== n));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function credsText() {
    return `منصة قارئ المدرسة\nرقم المشاركة: ${creds.entry_no}\nرمز المتابعة: ${creds.token}\nرابط المتابعة: ${location.origin}/track`;
  }

  function showErrors(errors) {
    $$('.field').forEach((f) => f.classList.remove('invalid'));
    $$('[data-err]').forEach((e) => { e.textContent = ''; });
    let first = null;
    for (const [k, v] of Object.entries(errors || {})) {
      const e = $(`[data-err="${k}"]`); if (!e) continue;
      e.textContent = v; e.closest('.field').classList.add('invalid');
      first = first || e.closest('.field');
    }
    if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function validate(d) {
    const e = {};
    if (d.full_name.split(/\s+/).filter(Boolean).length < 3) e.full_name = 'اكتب الاسم الثلاثي على الأقل.';
    else if (!/^[؀-ۿa-zA-Z\s'.\-]+$/.test(d.full_name)) e.full_name = 'الاسم يجب أن يحتوي على حروف فقط.';
    if (!/^[A-Za-z0-9\-]{3,20}$/.test(d.school_id)) e.school_id = 'أدخل رقمًا مدرسيًا صحيحًا (3–20 خانة).';
    if (d.title.length < 2) e.title = 'اكتب عنوان التلاوة أو اسم السورة.';
    if (!d.grade) e.grade = 'اختر الصف الدراسي.';
    if (!d.section) e.section = 'اختر الشعبة.';
    if (!d.terms) e.terms = 'يجب الموافقة على شروط المسابقة.';
    if (cfg.require_guardian_consent && !d.guardian) e.guardian = 'يلزم إقرار موافقة ولي الأمر.';
    return e;
  }

  function startUpload() {
    step(3);
    window.QUploader.mount($('#uploader'), {
      entry_no: creds.entry_no, token: creds.token, limits: cfg.limits,
      onDone: () => { localStorage.removeItem('qari_draft'); step(4); },
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    try { cfg = await window.Q.config(); } catch (e) { $('#form-msg').innerHTML = alertBox('err', esc(e.message)); return; }
    $('#grade').innerHTML += cfg.grades.map((g) => `<option>${esc(g)}</option>`).join('');
    $('#section').innerHTML += cfg.sections.map((g) => `<option>${esc(g)}</option>`).join('');
    if (!cfg.require_guardian_consent) $('#guardian-field').remove();
    else if (cfg.guardian_consent_text) $('#consent-text').textContent = cfg.guardian_consent_text;

    // تسجيل محفوظ على هذا الجهاز ولم يُرفع له فيديو بعد
    try {
      const saved = JSON.parse(localStorage.getItem('qari_draft') || 'null');
      if (saved && saved.entry_no && saved.token) {
        $('#form-msg').innerHTML = alertBox('info', `لديك تسجيل محفوظ على هذا الجهاز برقم المشاركة <b class="num">${saved.entry_no}</b>. <a href="/track">أكمل رفع التلاوة من هنا</a>.`);
      }
    } catch {}

    if (!cfg.registration.open) {
      $('#step1').classList.add('hidden'); $('#steps').classList.add('hidden');
      const soon = cfg.registration.mode === 'auto' && Date.parse(cfg.registration.start) > Date.now();
      $('#closed').classList.remove('hidden');
      $('#closed').innerHTML = alertBox('warn', soon ? `يبدأ التسجيل في <b>${fmtDate(cfg.registration.start, true)}</b>. ترقّبوا!` : 'التسجيل في المسابقة مغلق حاليًا.') +
        '<div class="center mt-3"><a class="btn btn-outline" href="/track">متابعة تسجيل سابق</a> <a class="btn" href="/contestants">أصوات تتلو القرآن</a></div>';
      return;
    }

    $('#school_id').addEventListener('input', (e) => { const v = toAscii(e.target.value); if (v !== e.target.value) e.target.value = v; });

    $('#step1').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = ev.target.elements;
      const d = {
        full_name: f.full_name.value.trim().replace(/\s+/g, ' '), school_id: toAscii(f.school_id.value.trim()),
        grade: f.grade.value, section: f.section.value, title: f.title.value.trim(),
        terms: f.terms.checked, guardian: f.guardian ? f.guardian.checked : false, website: f.website.value,
      };
      const errs = validate(d);
      showErrors(errs);
      if (Object.keys(errs).length) return;
      const btn = $('#submit1');
      setBusy(btn, true, 'جارٍ الحفظ…');
      $('#form-msg').innerHTML = '';
      try {
        const r = await api('/api/register', { method: 'POST', body: d });
        creds = { entry_no: r.entry_no, token: r.token };
        localStorage.setItem('qari_draft', JSON.stringify(creds));
        $$('[data-entry]').forEach((e) => { e.textContent = r.entry_no; });
        $('[data-token]').textContent = r.token;
        step(2);
      } catch (e) {
        setBusy(btn, false);
        showErrors(e.data && e.data.errors);
        $('#form-msg').innerHTML = alertBox('err', esc(e.message) + (e.status === 409 ? ' <a href="/track">متابعة التسجيل</a>' : ''));
      }
    });

    $('#copy').onclick = () => navigator.clipboard.writeText(credsText()).then(() => toast('تم نسخ البيانات', 'ok'), () => toast('تعذّر النسخ، دوّن البيانات يدويًا', 'err'));
    $('#download').onclick = () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(['﻿' + credsText()], { type: 'text/plain;charset=utf-8' }));
      a.download = `qari-entry-${creds.entry_no}.txt`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    };
    $('#print').onclick = () => window.print();
    $('#to-upload').onclick = startUpload;
  });
})();
