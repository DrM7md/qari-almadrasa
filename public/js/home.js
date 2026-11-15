(function () {
  'use strict';
  const { api, esc, $, $$, ICONS, fmtNum, fmtDate, reveal } = window.Q;

  function animateNum(el, to) {
    const start = performance.now(), dur = 1400;
    const step = (t) => { const p = Math.min(1, (t - start) / dur); el.textContent = fmtNum(Math.round(to * (1 - Math.pow(1 - p, 3)))); if (p < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }

  function countdown(cd, serverNow) {
    const box = $('#countdown');
    if (!cd) return box.classList.add('hidden');
    const skew = Date.parse(serverNow) - Date.now();
    box.classList.remove('hidden');
    $('.label', box).textContent = cd.label;
    const target = Date.parse(cd.target);
    const tick = () => {
      let d = Math.max(0, target - (Date.now() + skew));
      if (d === 0) { clearInterval(iv); setTimeout(() => location.reload(), 1500); }
      const u = { d: Math.floor(d / 86400000), h: Math.floor(d / 3600000) % 24, m: Math.floor(d / 60000) % 60, s: Math.floor(d / 1000) % 60 };
      for (const k in u) $(`[data-u="${k}"]`, box).textContent = String(u[k]).padStart(2, '0');
    };
    const iv = setInterval(tick, 1000); tick();
  }

  const STATUS = { active: ['pill-active', 'جارية الآن'], upcoming: ['pill-upcoming', 'قادمة'], done: ['pill-done', 'منتهية'] };

  async function loadStats() {
    try {
      const s = await api('/api/public/stats');
      $$('[data-stat]').forEach((el) => animateNum(el, s[el.dataset.stat] || 0));
    } catch { /* تجاهل */ }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    $$('[data-icon]').forEach((el) => { el.innerHTML = ICONS[el.dataset.icon] || ''; });
    let cfg;
    try { cfg = await window.Q.config(); } catch (e) { window.Q.toast(e.message, 'err'); return; }

    $$('[data-bind]').forEach((el) => { if (cfg[el.dataset.bind]) el.textContent = cfg[el.dataset.bind]; });
    if (cfg.competition_name) $('.bismillah').insertAdjacentHTML('afterend', `<p class="eyebrow" style="color:var(--gold-hi);justify-content:center;display:flex">${esc(cfg.competition_name)}${cfg.school_name ? ' — ' + esc(cfg.school_name) : ''}</p>`);
    if (cfg.results_published) $('.hero-cta').insertAdjacentHTML('afterbegin', '<a class="btn" href="/results">النتائج النهائية</a>');
    $('#goals').innerHTML = (cfg.goals || []).map((g, i) => `<li><i>${i + 1}</i><span>${esc(g)}</span></li>`).join('');
    $('#terms-list').innerHTML = (cfg.terms || []).map((t) => `<li>${esc(t)}</li>`).join('');
    $('#stages-list').innerHTML = cfg.stages.map((s) => {
      const [cls, label] = STATUS[s.status] || STATUS.upcoming;
      return `<div class="stage ${s.status} reveal"><span class="pill ${cls}">${label}</span><h3>${esc(s.title)}</h3><p>${esc(s.description || '')}</p>
        <div class="dates">${s.start ? fmtDate(s.start) : ''}${s.end ? ' ← ' + fmtDate(s.end) : ''}</div></div>`;
    }).join('');

    if (!cfg.registration.open) {
      ['#cta-register', '#cta-register-2'].forEach((id) => { const b = $(id); b.textContent = 'التسجيل مغلق — تابع تسجيلك'; b.href = '/track'; });
    }
    countdown(cfg.countdown, cfg.now);
    loadStats();
    document.addEventListener('q:voted', loadStats);

    // أبرز التلاوات: المميزة أولًا ثم عشوائيًا
    const grid = $('#featured-grid');
    await window.QCards.init(cfg);
    try {
      let { items } = await api('/api/public/contestants?featured=1&limit=6');
      if (items.length < 3) {
        const more = await api('/api/public/contestants?sort=random&limit=6');
        const seen = new Set(items.map((i) => i.entry_no));
        items = items.concat(more.items.filter((i) => !seen.has(i.entry_no))).slice(0, 6);
      }
      grid.innerHTML = items.length ? items.map(window.QCards.card).join('')
        : `<div class="empty" style="grid-column:1/-1"><img src="/img/avatar.svg" alt=""><p>ستظهر التلاوات المشاركة هنا فور اعتمادها من لجنة المسابقة.</p><a class="btn btn-emerald" href="/register">كن أول المشاركين</a></div>`;
      window.QCards.bind(grid);
    } catch { grid.innerHTML = ''; }
    reveal();
  });
})();
