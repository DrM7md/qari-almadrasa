(function () {
  'use strict';
  const { api, esc, $, alertBox, setBusy, toAscii, protectVideo, fmtDate } = window.Q;
  const BADGE = {
    draft: ['st-draft', 'بانتظار رفع الفيديو'], pending: ['st-pending', 'بانتظار المراجعة'],
    approved: ['st-approved', 'معتمدة ومنشورة'], rejected: ['st-rejected', 'مرفوضة'],
    disqualified: ['st-rejected', 'مستبعدة'], archived: ['st-draft', 'مؤرشفة'],
  };
  let creds = null;

  function render(s) {
    $('#login').classList.add('hidden');
    $('#view').classList.remove('hidden');
    ['entry_no', 'display_name', 'title'].forEach((k) => { $(`[data-f="${k}"]`).textContent = s[k]; });
    const [cls, label] = BADGE[s.status];
    $('#badge').innerHTML = `<span class="status-badge ${cls}">${label}</span>`;
    const msgs = {
      draft: alertBox('warn', 'تسجيلك محفوظ، لكن لم يُرفع مقطع التلاوة بعد. ارفعه الآن لإكمال المشاركة.'),
      pending: alertBox('info', `تم استلام تلاوتك ${s.video_uploaded_at ? 'في ' + fmtDate(s.video_uploaded_at, true) : ''}، وهي قيد مراجعة لجنة المسابقة.`),
      approved: alertBox('ok', 'مبارك! اعتمدت لجنة المسابقة تلاوتك، وهي منشورة الآن في صفحة «أصوات تتلو القرآن».'),
      rejected: alertBox('err', `<b>لم تُعتمد التلاوة.</b> سبب الرفض: ${esc(s.reject_reason || '—')}`),
      disqualified: alertBox('err', `<b>استُبعدت المشاركة.</b> ${esc(s.reject_reason || '')}`),
      archived: alertBox('info', 'انتهت المسابقة وأُرشفت المشاركة وفق سياسة الاحتفاظ بالبيانات.'),
    };
    $('#status-msg').innerHTML = msgs[s.status] + (s.upload_block_reason && s.status !== 'approved' ? alertBox('warn', esc(s.upload_block_reason)).replace('class="alert', 'style="margin-top:10px" class="alert') : '');

    const mv = $('#my-video');
    if (s.video) { const v = $('video', mv); protectVideo(v); v.src = s.video; mv.classList.remove('hidden'); }
    else mv.classList.add('hidden');

    const cb = $('#certificate');
    if (s.status === 'approved' && s.certificates_enabled) {
      cb.classList.remove('hidden');
      cb.innerHTML = `<div class="ticket" style="text-align:start"><div class="pattern-layer"></div>
        <h3 style="font-family:var(--f-display);margin:0;color:var(--gold-hi);font-weight:500">شهادتك</h3>
        <p style="margin:6px 0 14px;color:rgba(251,246,234,.8)">${s.results_published ? 'أُعلنت النتائج. نزّل شهادتك بصيغة PDF.' : 'يمكنك تنزيل شهادة المشاركة الآن، وتظهر شهادة الفوز هنا إن كنت من الفائزين بعد إعلان النتائج.'}</p>
        <div class="gap-row" data-certs><button class="btn btn-sm" data-cert="auto">تنزيل الشهادة (PDF)</button></div>
        <div data-cert-msg class="mt-1"></div></div>`;
      cb.onclick = async (e) => {
        const b = e.target.closest('[data-cert]'); if (!b) return;
        setBusy(b, true, 'جارٍ إعداد الشهادة…');
        try {
          const r = await api('/api/entry/certificate', { method: 'POST', body: { entry_no: creds.entry_no, token: creds.token, type: b.dataset.cert } });
          await window.QCert.download(r.certificate);
          if (r.available.length > 1 && !cb.querySelector('[data-cert="participation"]')) {
            cb.querySelector('[data-certs]').insertAdjacentHTML('beforeend', '<button class="btn btn-sm btn-ghost" data-cert="participation">شهادة المشاركة</button>');
            b.dataset.cert = 'winner'; b.dataset.label = 'تنزيل شهادة الفوز (PDF)';
          }
          cb.querySelector('[data-cert-msg]').innerHTML = `<span style="color:rgba(251,246,234,.75);font-size:.9rem">رمز التحقق: <b dir="ltr">${esc(r.certificate.code)}</b> — يمكن لأي جهة التحقق من صحة الشهادة عبر صفحة <a href="/verify?c=${encodeURIComponent(r.certificate.code)}" style="color:var(--gold-hi)">التحقق</a>.</span>`;
        } catch (err) { cb.querySelector('[data-cert-msg]').innerHTML = alertBox('err', esc(err.message)); }
        finally { setBusy(b, false); }
      };
    } else cb.classList.add('hidden');

    if (s.can_upload) {
      $('#upload-wrap').classList.remove('hidden');
      $('#upload-title').textContent = s.has_video ? (s.status === 'rejected' ? 'إعادة رفع التلاوة' : 'استبدال مقطع التلاوة (قبل الاعتماد)') : 'رفع مقطع التلاوة';
      window.QUploader.mount($('#uploader'), {
        entry_no: s.entry_no, token: creds.token, limits: s.limits,
        onDone: (r) => { render(r.status); window.scrollTo({ top: 0, behavior: 'smooth' }); window.Q.toast(r.message, 'ok'); },
      });
    } else $('#upload-wrap').classList.add('hidden');
  }

  async function open(entry_no, token, btn) {
    setBusy(btn, true, 'جارٍ التحقق…');
    try {
      const s = await api('/api/entry/status', { method: 'POST', body: { entry_no, token } });
      creds = { entry_no: s.entry_no, token };
      sessionStorage.setItem('qari_track', JSON.stringify(creds));
      if (s.status !== 'draft') localStorage.removeItem('qari_draft');
      render(s);
    } catch (e) {
      $('#login-msg').innerHTML = alertBox('err', esc(e.message));
    } finally { setBusy(btn, false); }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const saved = (() => { try { return JSON.parse(sessionStorage.getItem('qari_track') || localStorage.getItem('qari_draft') || 'null'); } catch { return null; } })();
    if (saved) { $('#entry_no').value = saved.entry_no; $('#token').value = saved.token; open(saved.entry_no, saved.token, $('#login-btn')); }
    $('#entry_no').addEventListener('input', (e) => { e.target.value = toAscii(e.target.value).replace(/\D/g, ''); });
    $('#token').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });
    $('#login').addEventListener('submit', (e) => {
      e.preventDefault();
      const n = $('#entry_no').value.trim(), t = $('#token').value.trim();
      if (!n || t.length < 8) { $('#login-msg').innerHTML = alertBox('err', 'أدخل رقم المشاركة ورمز المتابعة كاملين.'); return; }
      open(Number(n), t, $('#login-btn'));
    });
    $('#logout').onclick = () => { sessionStorage.removeItem('qari_track'); localStorage.removeItem('qari_draft'); location.reload(); };
  });
})();
