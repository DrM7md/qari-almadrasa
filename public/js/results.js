/* صفحة إعلان الفائزين */
(function () {
  'use strict';
  const { api, esc, $, $$, alertBox, fmtDate, fmtNum, ICONS, modal, protectVideo } = window.Q;
  const RANK_AR = ['', 'المركز الأول', 'المركز الثاني', 'المركز الثالث'];
  const MEDAL = { 1: ['#fff3c4', '#d9b252', '#9c7a2b', 'ذهبي'], 2: ['#ffffff', '#c9ced3', '#868e96', 'فضي'], 3: ['#ffe1c2', '#c98a55', '#8a5326', 'برونزي'] };
  let uid = 0;

  function medal(rank) {
    const [a, b, c, name] = MEDAL[Math.min(rank, 3)];
    const id = 'm' + (++uid);
    return `<svg class="medal" viewBox="0 0 120 142" role="img" aria-label="وسام ${name}">
      <defs><radialGradient id="${id}" cx="38%" cy="32%" r="75%"><stop offset="0" stop-color="${a}"/><stop offset=".55" stop-color="${b}"/><stop offset="1" stop-color="${c}"/></radialGradient></defs>
      <path d="M34 0 L58 56 L40 62 L14 4 Z" fill="#0a4636"/><path d="M86 0 L62 56 L80 62 L106 4 Z" fill="#0e5a45"/>
      <path d="M40 0 L54 34" stroke="#c9a44c" stroke-width="3"/><path d="M80 0 L66 34" stroke="#c9a44c" stroke-width="3"/>
      <circle cx="60" cy="92" r="46" fill="url(#${id})"/>
      <circle cx="60" cy="92" r="38" fill="none" stroke="${c}" stroke-width="2.5"/>
      <g transform="translate(60 92)" fill="${c}" opacity=".35"><rect x="-26" y="-26" width="52" height="52"/><rect x="-26" y="-26" width="52" height="52" transform="rotate(45)"/></g>
      <text x="60" y="104" text-anchor="middle" font-family="Reem Kufi, Amiri, serif" font-size="36" font-weight="700" fill="#052e23">${rank}</text>
      <ellipse class="shine" cx="46" cy="76" rx="14" ry="7" fill="#fff" transform="rotate(-30 46 76)"/>
    </svg>`;
  }

  // مؤثرات احتفالية: نجوم ثمانية ذهبية ولمعات تتساقط بهدوء لثوانٍ معدودة (بلا صوت)
  function celebrate() {
    const cv = $('#celebrate');
    if (!cv || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const ctx = cv.getContext('2d');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const size = () => { cv.width = cv.offsetWidth * dpr; cv.height = cv.offsetHeight * dpr; };
    size(); addEventListener('resize', size);
    const colors = ['#ecd58f', '#c9a44c', '#fff5d2', '#9fe0bd'];
    const N = Math.min(90, Math.round(cv.offsetWidth / 12));
    const parts = Array.from({ length: N }, () => ({
      x: Math.random() * cv.width, y: -Math.random() * cv.height, r: (4 + Math.random() * 9) * dpr, vy: (0.6 + Math.random() * 1.4) * dpr,
      vx: (Math.random() - 0.5) * 0.6 * dpr, rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.03, c: colors[(Math.random() * colors.length) | 0], tw: Math.random() * 6,
    }));
    const t0 = performance.now(); const DURATION = 9000;
    const draw = (t) => {
      const el = t - t0;
      ctx.clearRect(0, 0, cv.width, cv.height);
      const fade = el > DURATION ? Math.max(0, 1 - (el - DURATION) / 2000) : 1;
      for (const p of parts) {
        p.y += p.vy; p.x += p.vx + Math.sin((t / 900) + p.tw) * 0.3 * dpr; p.rot += p.vr;
        if (p.y > cv.height + 20 && el < DURATION) { p.y = -20; p.x = Math.random() * cv.width; }
        ctx.save(); ctx.globalAlpha = fade * (0.55 + 0.45 * Math.sin(t / 300 + p.tw)); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.c;
        ctx.fillRect(-p.r / 2, -p.r / 2, p.r, p.r); ctx.rotate(Math.PI / 4); ctx.fillRect(-p.r / 2, -p.r / 2, p.r, p.r);
        ctx.restore();
      }
      if (fade > 0) requestAnimationFrame(draw); else ctx.clearRect(0, 0, cv.width, cv.height);
    };
    requestAnimationFrame(draw);
  }

  function play(x) {
    const m = modal(`<div class="player"><video controls preload="metadata" ${x.poster ? `poster="${esc(x.poster)}"` : ''} src="${esc(x.video)}"></video></div>
      <div class="modal-body"><h3>${esc(x.name)}</h3><div class="muted">${RANK_AR[x.rank] || 'المركز ' + x.rank} · ${esc(x.title)}</div></div>`);
    const v = m.el.querySelector('video'); protectVideo(v); v.play().catch(() => {});
  }

  document.addEventListener('DOMContentLoaded', async () => {
    const box = $('#res');
    let cfg = {};
    try { cfg = await window.Q.config(); if (cfg.competition_name) $('#comp-name').textContent = cfg.competition_name; } catch {}
    let r;
    try { r = await api('/api/public/results'); }
    catch {
      $('#win-title').textContent = 'النتائج لم تُعلن بعد';
      $('#res-sub').textContent = 'تُعلن النتائج بعد إغلاق التصويت واكتمال التحكيم واعتمادها رسميًا من لجنة المسابقة.';
      $('#win-actions').innerHTML = '<a class="btn" href="/contestants">أصوات تتلو القرآن</a>';
      $('.win-ayah').remove();
      box.innerHTML = '';
      return;
    }
    $('#print-title').textContent = `نتائج ${r.competition_name || 'مسابقة قارئ المدرسة'}${r.school_name ? ' — ' + r.school_name : ''}`;
    $('#print-date').textContent = `اعتُمدت في ${fmtDate(r.approved_at, true)}`;
    if (!cfg.certificates_enabled) $('#win-actions a[href^="/track"]').remove();
    const scoreTxt = (x) => {
      if (x.score == null) return '';
      if (r.mode === 'votes') return `${fmtNum(x.votes)} صوت`;
      return `${x.score} / 100`;
    };
    const vids = new Map();
    box.innerHTML = r.groups.map((g) => {
      const winners = g.rows.filter((x) => x.winner);
      const top = winners.filter((x) => x.rank <= 3);
      const rest = winners.filter((x) => x.rank > 3);
      return `<section class="cat-block">
        <h2 class="cat-title">${esc(g.name)}</h2>
        <p class="cat-sub">${winners.length ? `الفائزون (${winners.length})` : 'لا يوجد فائزون في هذه الفئة.'}</p>
        <div class="podium">${top.map((x) => { vids.set(x.entry_no, x); return `<div class="pod p${x.rank}">
          <div class="pod-card">${medal(x.rank)}
            <div class="place">${RANK_AR[x.rank]}${x.tied ? ' (مشترك)' : ''}</div>
            <h3>${esc(x.name)}</h3>
            <div class="cls">${esc([x.grade, x.section ? 'شعبة ' + x.section : ''].filter(Boolean).join(' · '))}</div>
            <div class="surah">${esc(x.title)}</div>
            ${scoreTxt(x) ? `<div class="score">${scoreTxt(x)}</div>` : ''}
            ${x.video ? `<button class="btn btn-sm btn-outline no-print" data-watch="${x.entry_no}">${ICONS.play.replace('<svg', '<svg width="16" height="16"')} شاهد التلاوة</button>` : ''}
          </div><div class="pod-base">${x.rank}</div></div>`; }).join('')}</div>
        ${rest.length ? `<div class="honor">${rest.map((x) => { vids.set(x.entry_no, x); return `<div><b class="r num">${x.rank}</b><span><b>${esc(x.name)}</b><br><span class="muted small">${esc(x.title)}</span></span>${x.video ? `<button class="btn btn-sm btn-outline no-print" style="margin-inline-start:auto" data-watch="${x.entry_no}">شاهد</button>` : ''}</div>`; }).join('')}</div>` : ''}
        ${r.detail === 'full' ? `<details class="fold mt-3"><summary>الترتيب الكامل (${g.rows.length})</summary>
          <div style="padding:0 16px 16px;overflow-x:auto"><table class="res-table"><thead><tr><th>المركز</th><th>القارئ</th><th>التلاوة</th>
            ${r.mode !== 'votes' ? '<th>التحكيم</th>' : ''}${r.mode !== 'judges' ? '<th>الأصوات</th>' : ''}${r.mode === 'mixed' ? '<th>النهائية</th>' : ''}</tr></thead>
          <tbody>${g.rows.map((x) => `<tr><td>${x.rank}${x.tied ? '=' : ''}</td><td>${esc(x.name)}</td><td>${esc(x.title)}</td>
            ${r.mode !== 'votes' ? `<td>${x.judge_pct ?? '—'}</td>` : ''}${r.mode !== 'judges' ? `<td>${fmtNum(x.votes)}</td>` : ''}${r.mode === 'mixed' ? `<td><b>${x.score}</b></td>` : ''}</tr>`).join('')}</tbody></table></div></details>` : ''}
      </section>`;
    }).join('') + `<section class="cat-block"><details class="fold" style="border:0"><summary>كيف حُدِّد الفائزون؟</summary>
        <div style="padding:0 22px 8px"><p>طريقة الاحتساب: <b>${{ votes: 'تصويت الطلاب', judges: 'لجنة التحكيم', mixed: `نظام مختلط (${r.weights.judge}% لجنة التحكيم + ${r.weights.vote}% تصويت الطلاب)` }[r.mode]}</b> · ${r.scope === 'category' ? 'فائزون لكل فئة' : 'على مستوى المدرسة'} · اعتُمدت في ${fmtDate(r.approved_at, true)}</p>
        <ul>${r.formula.map((f) => `<li>${esc(f)}</li>`).join('')}</ul><b>قواعد التعادل المعلنة:</b><ol>${r.tie_rules.map((t) => `<li>${esc(t)}</li>`).join('')}</ol></div></details></section>`;
    box.addEventListener('click', (e) => { const b = e.target.closest('[data-watch]'); if (b) play(vids.get(Number(b.dataset.watch))); });
    $('#print-btn').onclick = () => { $$('details', box).forEach((d) => { d.open = true; }); window.print(); };
    celebrate();
  });
})();
