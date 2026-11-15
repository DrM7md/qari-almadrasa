/* مكوّن رفع التلاوة: معاينة، تحقق، رفع مجزّأ قابل للاستئناف مع شريط تقدّم */
(function () {
  'use strict';
  const { esc, ICONS, api, alertBox, fmtBytes, fmtDuration, protectVideo, $ } = window.Q;

  function mount(root, opts) {
    const { entry_no, token, limits } = opts;
    const exts = limits.formats.map((f) => '.' + f).join(',');
    root.innerHTML = `
      <div class="dropzone" tabindex="0" role="button" aria-label="اختر ملف الفيديو">
        <div class="ico">${ICONS.upload}</div>
        <b>اسحب ملف التلاوة هنا أو اضغط للاختيار</b>
        <small>الصيغ: ${limits.formats.map((f) => f.toUpperCase()).join('، ')} · الحد الأقصى ${limits.max_mb} م.ب · المدة من ${limits.min_seconds} ثانية حتى ${fmtDuration(limits.max_seconds)} دقيقة</small>
        <input type="file" accept="${exts},video/*,audio/mpeg" hidden>
      </div>
      <div data-msg class="mt-2"></div>
      <div data-preview class="preview hidden"><video controls preload="metadata"></video><div class="file-meta" data-meta></div></div>
      <div data-progress class="progress hidden" aria-live="polite">
        <div class="track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="fill"></div></div>
        <div class="row"><span data-pct>0%</span><span data-rate></span></div>
      </div>
      <div class="gap-row mt-2" data-actions>
        <button class="btn hidden" data-send>${ICONS.upload.replace('<svg', '<svg width="20" height="20"')} إرسال التلاوة</button>
        <button class="btn btn-outline hidden" data-change>اختيار ملف آخر</button>
        <button class="btn btn-outline hidden" data-pause>إيقاف مؤقت</button>
        <button class="btn hidden" data-resume>استئناف الرفع</button>
      </div>`;
    const dz = $('.dropzone', root), input = $('input', dz), msg = $('[data-msg]', root), pv = $('[data-preview]', root), video = $('video', pv);
    const bar = $('[data-progress]', root), fill = $('.fill', bar), track = $('.track', bar);
    const B = (k) => $(`[data-${k}]`, root);
    protectVideo(video);

    let file = null, duration = null, uploading = false, paused = false, objUrl = null;
    const show = (el, on) => el.classList.toggle('hidden', !on);
    const say = (type, html) => { msg.innerHTML = html ? alertBox(type, html) : ''; };
    const auth = { 'X-Entry-No': String(entry_no), 'X-Entry-Token': token };
    window.addEventListener('beforeunload', (e) => { if (uploading) { e.preventDefault(); e.returnValue = ''; } });

    dz.addEventListener('click', () => !uploading && input.click());
    dz.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && !uploading) { e.preventDefault(); input.click(); } });
    ['dragenter', 'dragover'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
    dz.addEventListener('drop', (e) => { if (!uploading && e.dataTransfer.files[0]) pick(e.dataTransfer.files[0]); });
    input.addEventListener('change', () => input.files[0] && pick(input.files[0]));
    B('change').onclick = () => input.click();

    function pick(f) {
      say('', '');
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      if (!limits.formats.includes(ext)) return say('err', `صيغة الملف «${esc(ext.toUpperCase() || 'غير معروفة')}» غير مسموحة. الصيغ المتاحة: ${limits.formats.map((x) => x.toUpperCase()).join('، ')}.`);
      if (f.size > limits.max_mb * 1048576) return say('err', `حجم الملف ${fmtBytes(f.size)} يتجاوز الحد المسموح (${limits.max_mb} م.ب). جرّب ضغط المقطع أو قصّه.`);
      if (f.size < 10240) return say('err', 'الملف فارغ أو تالف.');
      file = f; duration = null;
      if (objUrl) URL.revokeObjectURL(objUrl);
      objUrl = URL.createObjectURL(f);
      video.src = objUrl;
      show(pv, true); show(dz, false); show(B('change'), true); show(B('send'), true); B('send').disabled = true;
      $('[data-meta]', root).innerHTML = `<span>الملف: <b>${esc(f.name)}</b></span><span>الحجم: <b class="num">${fmtBytes(f.size)}</b></span><span data-dur>المدة: جارٍ القراءة…</span>`;
      let settled = false;
      const done = (ok) => {
        if (settled) return; settled = true;
        const d = $('[data-dur]', root);
        if (ok && isFinite(video.duration)) {
          duration = video.duration;
          d.innerHTML = `المدة: <b class="num">${fmtDuration(duration)}</b>`;
          if (duration > limits.max_seconds + 1) { B('send').disabled = true; return say('err', `مدة المقطع (${fmtDuration(duration)}) أطول من الحد المسموح (${fmtDuration(limits.max_seconds)}). يرجى قصّ المقطع.`); }
          if (duration < limits.min_seconds) { B('send').disabled = true; return say('err', `مدة المقطع قصيرة جدًا؛ الحد الأدنى ${limits.min_seconds} ثانية.`); }
          say('info', 'شاهد المعاينة وتأكّد من وضوح الصوت، ثم اضغط «إرسال التلاوة».');
        } else {
          d.innerHTML = 'المدة: <b>تُتحقق بعد الرفع</b>';
          say('warn', 'تعذّرت معاينة هذا الملف في متصفحك، لكن يمكنك إرساله وسيتحقق النظام منه تلقائيًا.');
        }
        B('send').disabled = false;
      };
      video.onloadedmetadata = () => done(true);
      video.onerror = () => done(false);
      setTimeout(() => done(false), 8000);
    }

    function setProgress(received, total, rate) {
      const p = total ? Math.floor((received / total) * 100) : 0;
      fill.style.width = p + '%'; track.setAttribute('aria-valuenow', p);
      $('[data-pct]', bar).textContent = `${p}% — ${fmtBytes(received)} من ${fmtBytes(total)}`;
      if (rate) {
        const eta = (total - received) / rate;
        $('[data-rate]', bar).textContent = `${fmtBytes(rate)}/ث · متبقٍّ ${eta > 60 ? Math.ceil(eta / 60) + ' دقيقة' : Math.ceil(eta) + ' ثانية'}`;
      }
    }

    function putChunk(url, blob, onProgress) {
      return new Promise((resolve, reject) => {
        const x = new XMLHttpRequest();
        x.open('PUT', url);
        for (const [k, v] of Object.entries(auth)) x.setRequestHeader(k, v);
        x.setRequestHeader('Content-Type', 'application/octet-stream');
        x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded);
        x.onload = () => { let d = {}; try { d = JSON.parse(x.responseText); } catch {} resolve({ status: x.status, data: d }); };
        x.onerror = () => reject(Object.assign(new Error('net'), { network: true }));
        x.ontimeout = x.onerror;
        x.onabort = x.onerror;
        x.timeout = 120000;
        current = x;
        x.send(blob);
      });
    }
    let current = null;

    async function upload() {
      if (!file) return;
      uploading = true; paused = false;
      show(B('send'), false); show(B('change'), false); show(B('resume'), false); show(B('pause'), true); show(bar, true);
      say('info', 'جارٍ رفع التلاوة… يُرجى عدم إغلاق الصفحة. إذا انقطع الاتصال يمكنك الاستئناف من حيث توقفت.');
      let init;
      try {
        init = await api('/api/uploads/init', { method: 'POST', headers: auth, body: { entry_no, token, filename: file.name, size: file.size, mime: file.type, duration, last_modified: String(file.lastModified) } });
      } catch (e) { return fail(e.message, !e.network ? 'fatal' : 'net'); }
      let received = init.received;
      const size = init.chunk_size;
      if (init.resumed) say('info', `تم العثور على رفع سابق غير مكتمل؛ يُستأنف من ${Math.floor(received / file.size * 100)}%.`);
      const t0 = performance.now(), r0 = received;
      let retries = 0;
      while (received < file.size) {
        if (paused) return stopped();
        const blob = file.slice(received, Math.min(received + size, file.size));
        try {
          const r = await putChunk(`/api/uploads/${encodeURIComponent(init.upload_id)}/chunk?offset=${received}`, blob, (loaded) => {
            const rate = (received + loaded - r0) / ((performance.now() - t0) / 1000);
            setProgress(received + loaded, file.size, rate);
          });
          if (r.status === 200) { received = r.data.received; retries = 0; }
          else if (r.status === 409 && r.data.received != null) { received = r.data.received; }
          else return fail(r.data.error || 'تعذّر رفع جزء من الملف.', r.status === 404 ? 'restart' : 'fatal');
          setProgress(received, file.size);
        } catch (e) {
          if (paused) return stopped();
          if (++retries > 6) return fail('انقطع الاتصال أثناء الرفع. تحقّق من الإنترنت ثم اضغط «استئناف الرفع».', 'net');
          say('warn', `انقطع الاتصال… إعادة المحاولة تلقائيًا (${retries}/6)`);
          await new Promise((r) => setTimeout(r, Math.min(15000, 1000 * 2 ** retries)));
          try { const st = await api(`/api/uploads/${encodeURIComponent(init.upload_id)}`, { headers: auth }); received = st.received; } catch { /* سنحاول مجددًا */ }
        }
      }
      show(B('pause'), false);
      say('info', 'اكتمل الرفع، جارٍ التحقق من المقطع ومعالجته…');
      $('[data-rate]', bar).textContent = '';
      try {
        const r = await api(`/api/uploads/${encodeURIComponent(init.upload_id)}/complete`, { method: 'POST', headers: auth, body: {} });
        uploading = false;
        if (objUrl) URL.revokeObjectURL(objUrl);
        opts.onDone && opts.onDone(r);
      } catch (e) {
        if (e.network) return fail('انقطع الاتصال أثناء إنهاء الرفع. اضغط «استئناف الرفع».', 'net');
        fail(e.message, 'fatal');
      }
    }

    function stopped() {
      uploading = false;
      show(B('pause'), false); show(B('resume'), true);
      say('warn', 'تم إيقاف الرفع مؤقتًا. اضغط «استئناف الرفع» للمتابعة من حيث توقفت.');
    }
    function fail(text, kind) {
      uploading = false;
      show(B('pause'), false);
      if (kind === 'net' || kind === 'restart') { show(B('resume'), true); show(B('change'), true); }
      else { show(B('change'), true); show(bar, false); show(B('send'), false); }
      say('err', esc(text));
    }
    B('send').onclick = upload;
    B('resume').onclick = upload;
    B('pause').onclick = () => { paused = true; if (current) current.abort(); };
  }

  window.QUploader = { mount };
})();
