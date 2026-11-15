/* أدوات مشتركة لجميع صفحات «قارئ المدرسة» */
(function () {
  'use strict';

  const ICONS = {
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="14" height="14" rx="2"/><path d="m22 8-6 4 6 4V8z"/></svg>',
    vote: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 12 2 2 4-4"/><path d="M5 7c0-1.1.9-2 2-2h10a2 2 0 0 1 2 2v12H5V7z"/><path d="M22 19H2"/></svg>',
    heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L7.5 3.64A1 1 0 0 0 6 4.5z"/></svg>',
    upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
    ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
    star8: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 1.5l2.6 4.2 4.8-1.1-1.1 4.8 4.2 2.6-4.2 2.6 1.1 4.8-4.8-1.1L12 22.5l-2.6-4.2-4.8 1.1 1.1-4.8L1.5 12l4.2-2.6-1.1-4.8 4.8 1.1z"/></svg>',
    menu: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>',
  };

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const LOCALE = 'ar-u-nu-latn';
  const fmtNum = (n) => Number(n || 0).toLocaleString(LOCALE);
  const fmtDate = (iso, withTime) => {
    if (!iso) return '—';
    const d = new Date(iso);
    const o = { day: 'numeric', month: 'long', year: 'numeric' };
    if (withTime) Object.assign(o, { hour: 'numeric', minute: '2-digit' });
    return d.toLocaleString(LOCALE, o);
  };
  const fmtDuration = (s) => { s = Math.round(s || 0); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const fmtBytes = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} م.ب` : `${Math.ceil(b / 1024)} ك.ب`);
  const toAscii = (s) => String(s || '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));

  let cfgPromise = null;
  const config = () => (cfgPromise ||= api('/api/public/config').catch((e) => { cfgPromise = null; throw e; }));

  async function api(url, opts = {}) {
    const o = { method: opts.method || 'GET', headers: { Accept: 'application/json', ...(opts.headers || {}) }, credentials: 'same-origin' };
    if (opts.body !== undefined) { o.body = JSON.stringify(opts.body); o.headers['Content-Type'] = 'application/json'; }
    let res;
    try { res = await fetch(url, o); } catch (e) { const err = new Error('تعذّر الاتصال بالخادم، تحقّق من الإنترنت وحاول مجددًا.'); err.network = true; throw err; }
    let data = null;
    try { data = await res.json(); } catch { /* ليس JSON */ }
    if (!res.ok) { const err = new Error((data && data.error) || `خطأ (${res.status})`); err.status = res.status; err.data = data || {}; throw err; }
    return data;
  }

  function toast(msg, type = '') {
    let box = $('.toasts');
    if (!box) { box = document.createElement('div'); box.className = 'toasts'; box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
    const t = document.createElement('div');
    t.className = `toast ${type}`; t.textContent = msg; box.appendChild(t);
    setTimeout(() => { t.style.transition = 'opacity .4s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 400); }, 4200);
  }

  function alertBox(type, html) {
    const icon = { ok: ICONS.ok, err: ICONS.warn, warn: ICONS.warn, info: ICONS.info }[type];
    return `<div class="alert alert-${type}" role="${type === 'err' ? 'alert' : 'status'}">${icon}<div>${html}</div></div>`;
  }

  function setBusy(btn, busy, label) {
    if (!btn) return;
    if (busy) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="spin"></span> ${label || 'جارٍ التنفيذ…'}`; }
    else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
  }

  // ———— الرأس والتذييل ————
  function chrome() {
    const page = document.body.dataset.page || '';
    const link = (href, label, key) => `<a href="${href}"${page === key ? ' aria-current="page"' : ''}>${label}</a>`;
    const header = document.createElement('header');
    header.className = 'site-header';
    header.innerHTML = `<div class="container bar">
      <a class="brand" href="/" aria-label="قارئ المدرسة — الصفحة الرئيسية"><img src="/img/logo.svg" alt="" width="46" height="46"><span><b>قارئ المدرسة</b><small>مسابقة التلاوة القرآنية</small></span></a>
      <button class="menu-btn" aria-label="القائمة" aria-expanded="false" aria-controls="mainnav">${ICONS.menu}</button>
      <nav class="nav" id="mainnav" aria-label="القائمة الرئيسية">
        ${link('/', 'الرئيسية', 'home')}
        ${link('/contestants', 'أصوات تتلو القرآن', 'contestants')}
        ${link('/#terms', 'الشروط والأحكام', '')}
        ${link('/track', 'متابعة التسجيل', 'track')}
        <a href="/results" data-results-link class="hidden"${page === 'results' ? ' aria-current="page"' : ''}>النتائج</a>
        <a class="btn btn-sm" href="/register">سجّل الآن</a>
        <a class="btn btn-sm btn-ghost" href="/admin">🔒 دخول الإدارة</a>
      </nav></div>`;
    document.body.prepend(header);
    const btn = $('.menu-btn', header), nav = $('.nav', header);
    btn.addEventListener('click', () => { const o = nav.classList.toggle('open'); btn.setAttribute('aria-expanded', o); });
    $$('a', nav).forEach((a) => a.addEventListener('click', () => nav.classList.remove('open')));

    const footer = document.createElement('footer');
    footer.className = 'site-footer';
    footer.innerHTML = `<div class="pattern-layer"></div><div class="container">
      <div class="foot-grid">
        <a class="brand" href="/"><img src="/img/logo.svg" alt="" width="46" height="46"><span><b>قارئ المدرسة</b><small>رتّل وارتقِ… واجعل صوتك بالقرآن يتألّق</small></span></a>
        <nav aria-label="روابط التذييل"><a href="/contestants">المتسابقون</a><a href="/register">التسجيل</a><a href="/track">متابعة التسجيل</a><a href="/#terms">الشروط والأحكام</a><a href="/privacy">سياسة الخصوصية</a><a href="/verify">التحقق من شهادة</a><a href="/admin">🔒 دخول الإدارة</a></nav>
      </div>
      <div class="copy"><span data-footer-note>لجنة مسابقة «قارئ المدرسة»</span> · جميع الحقوق محفوظة © <span class="num">${new Date().getFullYear()}</span></div>
    </div>`;
    document.body.appendChild(footer);
    config().then((c) => {
      if (c.results_published) $$('[data-results-link]').forEach((a) => a.classList.remove('hidden'));
      if (c.demo) {
        const d = document.createElement('div');
        d.className = 'demo-banner'; d.setAttribute('role', 'note');
        d.textContent = 'نسخة تجريبية — جميع الأسماء والتلاوات والأصوات في هذه النسخة وهمية لأغراض التجربة فقط.';
        document.body.prepend(d);
      }
      if (c.footer_note) $$('[data-footer-note]').forEach((el) => { el.textContent = c.footer_note; });
      if (c.logo) {
        const img = document.createElement('img');
        img.src = c.logo; img.alt = c.school_name || 'شعار المدرسة'; img.className = 'school-logo';
        $('.site-header .brand').after(img);
      }
    }).catch(() => {});
  }

  function reveal() {
    const els = $$('.reveal:not(.in)');
    if (!('IntersectionObserver' in window)) { els.forEach((e) => e.classList.add('in')); return; }
    const io = new IntersectionObserver((entries) => entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: .12, rootMargin: '0px 0px -40px' });
    els.forEach((e) => io.observe(e));
  }

  // ———— نافذة منبثقة ————
  function modal(html, { size = '', onClose } = {}) {
    const m = document.createElement('div');
    m.className = 'modal';
    m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true');
    m.innerHTML = `<div class="backdrop"></div><div class="dialog ${size}"><button class="close" aria-label="إغلاق">×</button>${html}</div>`;
    document.body.appendChild(m);
    const prev = document.activeElement;
    const close = () => {
      m.classList.remove('open');
      $$('video', m).forEach((v) => { v.pause(); v.removeAttribute('src'); v.load(); });
      setTimeout(() => m.remove(), 300);
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      if (prev && prev.focus) prev.focus();
      onClose && onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    $('.backdrop', m).onclick = close; $('.close', m).onclick = close;
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => { m.classList.add('open'); $('.close', m).focus(); });
    return { el: m, close };
  }

  // حماية خفيفة من التنزيل: لا قائمة سياقية ولا زر تنزيل
  function protectVideo(v) {
    v.setAttribute('controlsList', 'nodownload noremoteplayback noplaybackrate');
    v.setAttribute('disablePictureInPicture', '');
    v.setAttribute('playsinline', '');
    v.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // بصمة جهاز بسيطة غير تتبعية (تُستخدم فقط لرصد التصويت المتكرر)
  async function deviceFingerprint() {
    const parts = [navigator.language, navigator.platform, screen.width + 'x' + screen.height, screen.colorDepth, Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.hardwareConcurrency || '', navigator.maxTouchPoints || 0];
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('|')));
    return Array.from(new Uint8Array(buf)).slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  window.Q = { ICONS, esc, $, $$, api, config, toast, alertBox, setBusy, fmtNum, fmtDate, fmtDuration, fmtBytes, toAscii, modal, protectVideo, deviceFingerprint, reveal };

  document.addEventListener('DOMContentLoaded', () => {
    if (!document.body.hasAttribute('data-no-chrome')) chrome();
    reveal();
  });
})();
