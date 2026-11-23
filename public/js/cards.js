/* بطاقات المتسابقين + المشغّل + التصويت الموثّق (مشترك بين الرئيسية وصفحة المتسابقين) */
(function () {
  'use strict';
  const { esc, ICONS, api, toast, modal, protectVideo, fmtNum, fmtDuration, setBusy, alertBox, toAscii } = window.Q;
  const ic = (name, size = 18) => ICONS[name].replace('<svg', `<svg width="${size}" height="${size}"`);

  const state = { cfg: null, me: { authenticated: false }, items: new Map() };

  async function refreshMe() {
    try { state.me = await api('/api/vote/me'); } catch { state.me = { authenticated: false }; }
    document.dispatchEvent(new CustomEvent('q:me', { detail: state.me }));
    return state.me;
  }
  async function init(cfg) { state.cfg = cfg; await refreshMe(); }

  // يحدد ما يظهر على زر التصويت — الحكم النهائي دائمًا للخادم
  function voteButton(c) {
    const me = state.me;
    if (!me.voting_open) return '';
    if (me.authenticated) {
      if (me.voted && me.voted.entry_no === c.entry_no) return `<button class="btn btn-sm voted-badge" disabled>${ic('ok')} صوتك هنا</button>`;
      if (me.prevent_self_vote && me.own_entry === c.entry_no) return '<button class="btn btn-sm btn-outline" disabled title="لا يمكن التصويت لمشاركتك">مشاركتك</button>';
      if (me.restrict_category && c.category_id && me.student && me.student.category_id !== c.category_id) return '';
      if (me.voted && !me.allow_change) return '';
      if (me.voted) return `<button class="btn btn-sm btn-outline" data-vote="${c.entry_no}">نقل صوتي لهذا القارئ</button>`;
    }
    return `<button class="btn btn-sm" data-vote="${c.entry_no}">${ic('heart')} صوّت لهذا القارئ</button>`;
  }

  function card(c) {
    state.items.set(c.entry_no, c);
    const cls = [c.grade, c.section ? `شعبة ${c.section}` : ''].filter(Boolean).join(' · ');
    return `<article class="card reveal" data-entry="${c.entry_no}">
      <div class="card-media" data-play="${c.entry_no}" role="button" tabindex="0" aria-label="استمع لتلاوة ${esc(c.name)}">
        <div class="pattern-layer"></div>
        ${c.poster ? `<img class="poster" src="${esc(c.poster)}" alt="" loading="lazy">` : ''}
        ${c.featured ? '<span class="featured-ribbon">تلاوة مميزة</span>' : ''}
        <span class="entry">رقم <span class="num">${c.entry_no}</span></span>
        <span class="play">${ICONS.play}</span>
        ${c.duration ? `<span class="dur num">${fmtDuration(c.duration)}</span>` : ''}
        <img class="avatar" src="/img/avatar.svg" alt="" width="78" height="78">
      </div>
      <div class="card-body">
        <h3>${esc(c.name)}</h3>
        ${cls ? `<div class="meta">${esc(cls)}</div>` : ''}
        <div class="surah">${esc(c.title)}</div>
        ${(c.views != null || c.votes != null) ? `<div class="card-stats">
          ${c.views != null ? `<span>${ICONS.eye} <span class="num">${fmtNum(c.views)}</span> مشاهدة</span>` : ''}
          ${c.votes != null ? `<span>${ICONS.heart} <span class="num">${fmtNum(c.votes)}</span> صوت</span>` : ''}
        </div>` : ''}
        <div class="card-foot">
          <button class="btn btn-sm btn-outline" data-play="${c.entry_no}">${ic('play', 16)} استمع للتلاوة</button>
          ${voteButton(c)}
        </div>
      </div>
    </article>`;
  }

  function refreshAll() {
    for (const [k, c] of state.items) {
      const el = document.querySelector(`.card[data-entry="${k}"]`);
      if (!el) continue;
      const tmp = document.createElement('div'); tmp.innerHTML = card(c);
      const n = tmp.firstElementChild; n.classList.add('in'); el.replaceWith(n);
    }
  }
  document.addEventListener('q:me', refreshAll);

  function openPlayer(entry) {
    const c = state.items.get(entry);
    if (!c) return;
    const cls = [c.grade, c.section ? `شعبة ${c.section}` : ''].filter(Boolean).join(' · ');
    const m = modal(`<div class="player"><video controls preload="metadata" ${c.poster ? `poster="${esc(c.poster)}"` : ''} src="${esc(c.video)}"></video></div>
      <div class="modal-body">
        <div class="spread"><div><h3>${esc(c.name)}</h3><div class="muted">${esc(cls)} ${cls ? '·' : ''} رقم المشاركة <span class="num">${c.entry_no}</span></div>
          <div style="font-family:var(--f-quran);font-size:1.3rem;color:var(--gold-lo)">${esc(c.title)}</div></div>
          <div class="gap-row"><span data-mvote>${voteButton(c)}</span><button class="btn btn-sm btn-outline" data-share>مشاركة الرابط</button></div>
        </div></div>`);
    const v = m.el.querySelector('video');
    protectVideo(v);
    let counted = false, played = 0, last = 0;
    v.addEventListener('timeupdate', () => {
      if (counted) return;
      const t = v.currentTime; if (t > last && t - last < 1.5) played += t - last; last = t;
      if (played >= 5) { counted = true; api(`/api/public/contestants/${entry}/view`, { method: 'POST', body: {} }).catch(() => {}); }
    });
    v.addEventListener('error', () => { if (v.error) toast('تعذّر تشغيل المقطع. حدّث الصفحة وحاول مجددًا.', 'err'); });
    v.play().catch(() => {});
    const onMe = () => { const s = m.el.querySelector('[data-mvote]'); if (s) s.innerHTML = voteButton(c); };
    document.addEventListener('q:me', onMe);
    m.el.addEventListener('click', (e) => {
      const vb = e.target.closest('[data-vote]');
      if (vb) { v.pause(); vote(Number(vb.dataset.vote), vb); }
      if (e.target.closest('[data-share]')) {
        const url = `${location.origin}/contestants?e=${entry}`;
        if (navigator.share) navigator.share({ title: `تلاوة ${c.name} — قارئ المدرسة`, url }).catch(() => {});
        else navigator.clipboard.writeText(url).then(() => toast('تم نسخ الرابط', 'ok'));
      }
    });
  }

  // ———— التحقق من هوية المصوّت ————
  function login() {
    return new Promise((resolve) => {
      const me = state.me;
      let done = false;
      if (me.auth === 'oidc') {
        const m = modal(`<div class="modal-body" style="padding-top:38px">
          <h3>التحقق من هويتك</h3>
          <p class="muted">التصويت متاح لطلاب المدرسة فقط. سجّل الدخول بحساب المدرسة الرسمي للمتابعة.</p>
          ${me.oidc_available ? `<a class="btn btn-block" href="/auth/school/start?return=${encodeURIComponent(location.pathname + location.search)}">${esc(me.oidc_label)}</a>` : alertBox('warn', 'الدخول بحساب المدرسة غير مهيأ بعد. تواصل مع لجنة المسابقة.')}
        </div>`, { size: 'sm', onClose: () => !done && resolve(false) });
        return m;
      }
      const idOnly = me.auth === 'id';
      const m = modal(`<form class="modal-body" style="padding-top:38px" novalidate>
        <h3>التحقق من هويتك</h3>
        <p class="muted" style="margin-top:4px">التصويت لطلاب المدرسة المسجلين فقط، ولكل طالب صوت واحد. ${idOnly ? 'أدخل رقمك الشخصي للمتابعة.' : 'أدخل رقمك الشخصي والرمز الشخصي الذي استلمته من المدرسة.'}</p>
        <div class="field"><label for="v-sid">الرقم الشخصي</label><input id="v-sid" class="input" inputmode="numeric" dir="ltr" style="text-align:right" autocomplete="username" maxlength="20"></div>
        ${idOnly ? '' : `<div class="field mt-1"><label for="v-pin">الرمز الشخصي</label><input id="v-pin" class="input" dir="ltr" autocomplete="one-time-code" placeholder="XXX-XXX" maxlength="9" style="text-align:right;letter-spacing:.15em;text-transform:uppercase"></div>`}
        <input type="text" name="website" class="sr-only" tabindex="-1" autocomplete="off" aria-hidden="true">
        <div data-msg class="mt-1"></div>
        <button class="btn btn-block mt-2" type="submit">تحقّق ومتابعة</button>
        ${idOnly ? '' : '<p class="muted small" style="font-size:.85rem;margin-bottom:0">لم تستلم رمزًا؟ راجع لجنة المسابقة في المدرسة.</p>'}
      </form>`, { size: 'sm', onClose: () => !done && resolve(false) });
      const f = m.el.querySelector('form');
      setTimeout(() => m.el.querySelector('#v-sid').focus(), 120);
      f.onsubmit = async (e) => {
        e.preventDefault();
        const btn = f.querySelector('button[type=submit]');
        setBusy(btn, true, 'جارٍ التحقق…');
        try {
          await api('/api/vote/login', { method: 'POST', body: { school_id: toAscii(f.querySelector('#v-sid').value.trim()), pin: idOnly ? '' : f.querySelector('#v-pin').value.trim(), website: f.website.value } });
          await refreshMe();
          done = true; m.close(); resolve(true);
        } catch (err) { setBusy(btn, false); f.querySelector('[data-msg]').innerHTML = alertBox('err', esc(err.message)); }
      };
    });
  }

  function confirmVote(c) {
    return new Promise((resolve) => {
      let done = false;
      const me = state.me;
      const change = !!me.voted;
      const m = modal(`<div class="modal-body center" style="padding-top:38px">
        <img src="/img/avatar.svg" alt="" width="84" height="84" style="margin:0 auto 10px">
        <h3>${change ? 'تأكيد نقل صوتك' : 'تأكيد التصويت'}</h3>
        <p style="margin:6px 0 2px">${change ? `سيُنقل صوتك من «${esc(me.voted.name)}» إلى:` : 'أنت على وشك التصويت للقارئ:'}</p>
        <p style="font-family:var(--f-display);font-size:1.45rem;color:var(--em-900);margin:0">${esc(c.name)} <span class="muted num" style="font-size:1rem">#${c.entry_no}</span></p>
        <p style="font-family:var(--f-quran);color:var(--gold-lo);margin:0 0 12px">${esc(c.title)}</p>
        ${alertBox('warn', me.allow_change ? 'لكل طالب صوت واحد فقط في المسابقة.' : 'لكل طالب صوت واحد فقط، <b>ولا يمكن تعديله بعد التأكيد</b>.')}
        <div class="gap-row mt-2" style="justify-content:center"><button class="btn" data-yes>نعم، أؤكد صوتي</button><button class="btn btn-outline" data-no>تراجع</button></div>
      </div>`, { size: 'sm', onClose: () => !done && resolve(false) });
      m.el.querySelector('[data-yes]').onclick = () => { done = true; resolve(true); m.close(); };
      m.el.querySelector('[data-no]').onclick = () => { done = true; resolve(false); m.close(); };
    });
  }

  function success(msg, c) {
    modal(`<div class="modal-body center" style="padding:40px 26px 30px">
      <div class="success-mark">${ICONS.ok}</div>
      <h3 style="font-size:1.8rem">${esc(msg)}</h3>
      <p class="muted">صوتك للقارئ «${esc(c.name)}». جزاك الله خيرًا على مشاركتك.</p>
      <p class="muted small" style="font-size:.88rem">تُعلن النتائج بعد إغلاق التصويت واعتمادها من لجنة المسابقة.</p>
    </div>`, { size: 'sm' });
  }

  let busy = false;
  async function vote(entry, btn) {
    const c = state.items.get(entry);
    if (!c || busy) return;
    busy = true;
    try {
      if (!state.me.authenticated && !(await login())) return;
      const me = state.me;
      if (me.voted && me.voted.entry_no === entry) return toast('صوتك مسجّل لهذا القارئ بالفعل.', 'ok');
      if (me.voted && !me.allow_change) return toast('لقد سجّلت صوتك مسبقًا، ولا يمكن تعديله.', 'err');
      if (!(await confirmVote(c))) return;
      if (btn && document.body.contains(btn)) setBusy(btn, true, 'جارٍ التسجيل…');
      const r = await api('/api/vote', { method: 'POST', body: { entry_no: entry, website: '' } });
      await refreshMe();
      success(r.message, c);
      document.dispatchEvent(new CustomEvent('q:voted'));
    } catch (e) {
      if (btn) setBusy(btn, false);
      if (e.data && e.data.need_login) { await refreshMe(); toast('انتهت جلستك، تحقق من هويتك مجددًا.', 'err'); }
      else toast(e.message, 'err');
      refreshMe();
    } finally { busy = false; }
  }

  async function logout() {
    try { await api('/api/vote/logout', { method: 'POST', body: {} }); } catch {}
    await refreshMe();
    toast('تم تسجيل الخروج من التصويت.', 'ok');
  }

  function bind(container) {
    container.addEventListener('click', (e) => {
      const p = e.target.closest('[data-play]');
      if (p) return openPlayer(Number(p.dataset.play));
      const v = e.target.closest('[data-vote]');
      if (v) vote(Number(v.dataset.vote), v);
    });
    container.addEventListener('keydown', (e) => {
      const p = e.target.closest('.card-media[data-play]');
      if (p && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openPlayer(Number(p.dataset.play)); }
    });
  }

  window.QCards = { init, card, bind, openPlayer, state, login, logout, refreshMe };
})();
