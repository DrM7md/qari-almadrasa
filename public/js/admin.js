/* لوحة إدارة «قارئ المدرسة» */
(function () {
  'use strict';
  const { esc, $, $$, toast, alertBox, setBusy, fmtNum, fmtDate, fmtDuration, fmtBytes, modal, protectVideo } = window.Q;
  const RANK = { judge: 0, reviewer: 1, admin: 2, owner: 3 };
  const ROLE_AR = { judge: 'محكّم', reviewer: 'مراجع', admin: 'مدير', owner: 'المالك' };
  const STATUS = { draft: ['st-draft', 'مسودة — بلا فيديو'], pending: ['st-pending', 'بانتظار المراجعة'], approved: ['st-approved', 'معتمدة ومنشورة'], rejected: ['st-rejected', 'مرفوضة'], disqualified: ['st-rejected', 'مستبعدة'], archived: ['st-draft', 'مؤرشفة'] };
  const REJECT_PRESETS = ['الصوت غير واضح أو به ضوضاء عالية', 'وجود موسيقى أو مؤثرات صوتية', 'أخطاء في التلاوة أو أحكام التجويد', 'المقطع لا يطابق شروط المسابقة', 'ظهور غير مناسب في المقطع', 'التلاوة ليست بصوت الطالب'];
  const ATTEMPT_AR = { bad_pin: 'رمز شخصي خاطئ', unknown_student: 'طالب غير مدرج', locked: 'حساب مقفل', duplicate: 'محاولة تصويت مكرر', self_vote: 'تصويت للنفس', closed: 'تصويت خارج الموعد', category: 'تصويت خارج الفئة', rate_limited: 'طلبات آلية/كثيفة', bot: 'نشاط آلي (مصيدة)', unauthenticated: 'تصويت دون تحقق', oidc_failed: 'فشل الدخول المدرسي' };
  const MODE_AR = { votes: 'تصويت الطلاب فقط', judges: 'لجنة التحكيم فقط', mixed: 'نظام مختلط' };
  let me = null, csrf = '', cache = { settings: null };
  let pollTimer = null;
  const main = () => $('#main');

  async function api(url, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (opts.method && opts.method !== 'GET') headers['X-CSRF-Token'] = csrf;
    try { return await window.Q.api(url, { ...opts, headers }); }
    catch (e) { if (e.status === 401 && me) { me = null; showLogin('انتهت الجلسة، سجّل الدخول مجددًا.'); } throw e; }
  }
  const can = (role) => me && RANK[me.role] >= RANK[role];
  const canVotes = () => me && (me.role === 'owner' || me.can_manage_votes);
  const badge = (s) => `<span class="status-badge ${STATUS[s][0]}" style="font-size:.8rem;padding:3px 12px">${STATUS[s][1]}</span>`;
  const toLocalInput = (iso) => { if (!iso) return ''; const d = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
  const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);
  const getSettings = async (force) => (cache.settings && !force ? cache.settings : (cache.settings = (await api('/api/admin/settings')).settings));
  function downloadText(name, text, type = 'text/csv;charset=utf-8') {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + text], { type })); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const csvCell = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

  // ———— رسوم بيانية بسيطة (SVG/CSS) ————
  function bars(rows, label, val, sub) {
    const max = Math.max(1, ...rows.map(val));
    return rows.length ? `<div class="bars">${rows.map((r) => `<div class="bar-row"><span>${label(r)}${sub ? ` <span class="muted small">${sub(r)}</span>` : ''}</span><div class="t"><i style="width:${(val(r) / max) * 100}%"></i></div><span class="n num">${fmtNum(val(r))}</span></div>`).join('')}</div>` : '<p class="muted">لا توجد بيانات بعد.</p>';
  }
  function donut(parts, centerText, centerSub) {
    const total = parts.reduce((a, p) => a + p.v, 0) || 1;
    let acc = 0; const R = 54, C = 2 * Math.PI * R;
    const segs = parts.map((p) => { const len = (p.v / total) * C; const s = `<circle r="${R}" cx="70" cy="70" fill="none" stroke="${p.c}" stroke-width="18" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-acc}" transform="rotate(-90 70 70)"/>`; acc += len; return s; }).join('');
    return `<div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap"><svg viewBox="0 0 140 140" width="150" height="150" role="img"><circle r="${R}" cx="70" cy="70" fill="none" stroke="#efe8d6" stroke-width="18"/>${segs}
      <text x="70" y="68" text-anchor="middle" font-size="22" font-weight="700" fill="#052e23">${centerText}</text><text x="70" y="88" text-anchor="middle" font-size="11" fill="#4b5a52">${centerSub || ''}</text></svg>
      <div class="bars" style="flex:1;min-width:160px">${parts.map((p) => `<div class="gap-row small"><span style="width:12px;height:12px;border-radius:3px;background:${p.c};display:inline-block"></span>${p.l}: <b class="num">${fmtNum(p.v)}</b></div>`).join('')}</div></div>`;
  }

  // ———————— الدخول ————————
  function showLogin(msg) {
    $('#app').classList.add('hidden'); $('#login-view').classList.remove('hidden');
    $('#login-msg').innerHTML = msg ? alertBox('warn', esc(msg)) : '';
    $('#lu').focus();
  }
  async function boot() {
    try { const r = await window.Q.api('/api/admin/me'); me = r.admin; csrf = r.csrf; startApp(); }
    catch { showLogin(); }
  }
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const b = $('#login-btn'); setBusy(b, true, 'جارٍ الدخول…');
    try {
      await window.Q.api('/api/admin/login', { method: 'POST', body: { username: $('#lu').value.trim(), password: $('#lp').value } });
      $('#lp').value = '';
      const r = await window.Q.api('/api/admin/me'); me = r.admin; csrf = r.csrf;
      startApp();
    } catch (err) { $('#login-msg').innerHTML = alertBox('err', esc(err.message)); }
    finally { setBusy(b, false); }
  });

  function startApp() {
    $('#login-view').classList.add('hidden'); $('#app').classList.remove('hidden');
    $('#who-name').textContent = me.display_name; $('#who-role').textContent = ROLE_AR[me.role] + (me.can_manage_votes ? ' · إدارة الأصوات' : '');
    $$('.side .tab').forEach((t) => {
      if (t.dataset.min && !can(t.dataset.min)) t.remove();
      if (t.dataset.only && t.dataset.only !== me.role) t.remove();
    });
    go(location.hash.slice(1) || (me.role === 'judge' ? 'evals' : 'dashboard'));
    if (me.role !== 'judge') refreshCounts();
  }
  $('#logout').onclick = async () => { try { await api('/api/admin/logout', { method: 'POST', body: {} }); } catch {} location.reload(); };
  $('#side-toggle').onclick = () => $('#side').classList.toggle('open');
  $$('.side .tab').forEach((t) => t.addEventListener('click', () => { go(t.dataset.tab); $('#side').classList.remove('open'); }));
  window.addEventListener('hashchange', () => me && go(location.hash.slice(1)));

  const VIEWS = {};
  function go(tab) {
    clearInterval(pollTimer);
    if (!VIEWS[tab] || !$(`.side .tab[data-tab="${tab}"]`)) tab = $('.side .tab') ? $('.side .tab').dataset.tab : 'account';
    if (location.hash.slice(1) !== tab) history.replaceState(null, '', '#' + tab);
    $$('.side .tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === tab));
    main().innerHTML = '<div class="skeleton" style="min-height:300px"></div>';
    VIEWS[tab]().catch((e) => { main().innerHTML = alertBox('err', esc(e.message)); });
  }
  async function refreshCounts() {
    try {
      const d = await api('/api/admin/dashboard');
      const pc = $('#pending-count'); pc.textContent = d.contestants.pending; pc.classList.toggle('hidden', !d.contestants.pending);
      const ac = $('#attempt-count'); if (ac) { ac.textContent = d.attempts_24h; ac.classList.toggle('hidden', !d.attempts_24h); ac.title = 'محاولات مرفوضة خلال 24 ساعة'; }
    } catch {}
  }
  const head = (title, actions = '') => `<div class="main-head"><h1>${title}</h1><div class="gap-row">${actions}</div></div>`;
  const onOff = (b) => (b ? '<span class="tag valid">مفتوح</span>' : '<span class="tag void" style="text-decoration:none">مغلق</span>');

  // ═══════════════ لوحة الإحصائيات ═══════════════
  VIEWS.dashboard = async () => {
    const d = await api('/api/admin/dashboard');
    const ph = d.phases;
    main().innerHTML = head('لوحة الإحصائيات', `<span class="muted small">الموسم ${esc(d.season)}</span>`) + `
      <div class="kpis">
        <div class="kpi"><b>${fmtNum(d.registered)}</b><span>إجمالي المسجلين</span></div>
        <div class="kpi" style="--kc:#137257"><b>${fmtNum(d.uploaded)}</b><span>فيديو مرفوع</span></div>
        <div class="kpi" style="--kc:#1e7a4f"><b>${fmtNum(d.contestants.approved)}</b><span>مقبولة ومنشورة</span></div>
        <div class="kpi" style="--kc:#a8322d"><b>${fmtNum(d.contestants.rejected + d.contestants.disqualified)}</b><span>مرفوضة / مستبعدة</span></div>
        <div class="kpi" style="--kc:#b07a12"><b>${fmtNum(d.contestants.pending)}</b><span>بانتظار المراجعة</span></div>
        <div class="kpi"><b>${fmtNum(d.voters)}</b><span>طالب صوّت</span></div>
        <div class="kpi" style="--kc:#0e5a45"><b>${d.participation}%</b><span>نسبة المشاركة من ${fmtNum(d.eligible)} مؤهل</span></div>
        <div class="kpi" style="--kc:#8d8570"><b>${fmtNum(d.views)}</b><span>مشاهدة</span></div>
      </div>
      ${d.demo ? alertBox('warn', '<b>نسخة تجريبية:</b> هذه البيانات وهمية ومنفصلة تمامًا عن قاعدة بيانات المسابقة الحقيقية.') : ''}
      ${d.retention_due && Date.now() > Date.parse(d.retention_due) && d.uploaded && can('admin') ? alertBox('warn', `انتهت مدة الاحتفاظ بالمقاطع المعلنة في سياسة الخصوصية (${fmtDate(d.retention_due)}). راجع <a href="#data">إدارة البيانات</a> لحذف المقاطع أو أرشفتها.`) : ''}
      <div class="box"><div class="gap-row">
        <span>التسجيل: ${onOff(ph.registrationOpen)}</span><span>التصويت: ${onOff(ph.votingOpen)}</span>
        <span class="muted small">المرحلة الحالية: ${esc((ph.stages.find((s) => s.status === 'active') || {}).title || '—')}</span>
        <span class="muted small">التقييمات: ${fmtNum(d.evaluations.submitted)} معتمد · ${fmtNum(d.evaluations.draft)} مسودة</span>
        ${d.attempts_24h ? `<span class="tag flagged">${d.attempts_24h} محاولة تصويت مرفوضة (24 ساعة)</span>` : ''}
        ${d.eligible === 0 && can('admin') ? '<a href="#students" class="btn btn-sm" style="margin-inline-start:auto">استورد قائمة الطلاب المؤهلين</a>' : ''}
      </div></div>
      <div class="two mt-2">
        <div class="box"><h2>حالة المشاركات</h2>${donut([
          { l: 'معتمدة', v: d.contestants.approved, c: '#1e7a4f' }, { l: 'بانتظار المراجعة', v: d.contestants.pending, c: '#c9a44c' },
          { l: 'مرفوضة', v: d.contestants.rejected, c: '#a8322d' }, { l: 'مستبعدة', v: d.contestants.disqualified, c: '#5a1a17' }, { l: 'مسودات', v: d.contestants.draft, c: '#c9c1aa' }], fmtNum(d.registered), 'مسجّل')}</div>
        <div class="box"><h2>المشاركة في التصويت</h2>${donut([{ l: 'صوّتوا', v: d.voters, c: '#0e5a45' }, { l: 'لم يصوّتوا', v: Math.max(0, d.eligible - d.voters), c: '#e8dcbc' }], d.participation + '%', 'نسبة المشاركة')}
          <p class="muted small">صدرت رموز شخصية لـ ${fmtNum(d.with_pin)} من ${fmtNum(d.eligible)} طالبًا مؤهلًا.</p></div>
      </div>
      <div class="two mt-2">
        <div class="box"><h2>الأصوات الصحيحة لكل متسابق</h2>${bars(d.per_contestant, (r) => `${esc(r.display_name)} <span class="muted num">#${r.entry_no}</span>`, (r) => r.n, (r) => esc(r.category))}
          ${d.phases.votingOpen ? '<p class="muted small">هذه الأرقام تظهر للإدارة فقط؛ وهي مخفية عن الطلاب أثناء التصويت.</p>' : ''}</div>
        <div class="box"><h2>المشاركات حسب الفئة</h2>${bars(d.by_category, (r) => esc(r.name), (r) => r.n)}
          <h2 class="mt-2">حسب الصف</h2>${bars(d.by_grade, (r) => esc(r.grade), (r) => r.n)}</div>
      </div>
      <div class="box mt-2"><h2>الأصوات الصحيحة يوميًا</h2>
        ${d.votes_per_day.length ? `<div class="cols" style="margin-bottom:26px">${(() => { const m = Math.max(1, ...d.votes_per_day.map((x) => x.n)); return d.votes_per_day.map((x) => `<div style="height:${(x.n / m) * 100}%" title="${x.d}: ${x.n}"><em class="num">${x.n}</em><span class="num">${x.d.slice(5)}</span></div>`).join(''); })()}</div>` : '<p class="muted">لا توجد أصوات بعد.</p>'}
      </div>`;
  };

  // ═══════════════ إدارة المتسابقين ═══════════════
  let entriesFilter = { status: 'pending', q: '', grade: '' };
  VIEWS.entries = async () => {
    const s = await getSettings();
    const [all, d] = await Promise.all([api('/api/admin/contestants?' + new URLSearchParams(entriesFilter)), api('/api/admin/dashboard')]);
    const counts = { ...d.contestants, '': d.registered };
    const chip = (k, l) => `<button class="chip ${entriesFilter.status === k ? 'on' : ''}" data-st="${k}">${l}<b class="num">${counts[k] || 0}</b></button>`;
    main().innerHTML = head('إدارة المتسابقين', can('admin') ? '<a class="btn btn-sm" href="/api/admin/export/contestants.xlsx">تصدير Excel</a><a class="btn btn-sm btn-outline" href="/api/admin/export/contestants.csv">تصدير CSV</a>' : '') + `
      <div class="filters">
        <div class="chips">${chip('pending', 'بانتظار المراجعة')}${chip('approved', 'معتمدة')}${chip('rejected', 'مرفوضة')}${chip('disqualified', 'مستبعدة')}${chip('draft', 'مسودات')}${chip('archived', 'مؤرشفة')}${chip('', 'الكل')}</div>
        <input class="input" id="eq" type="search" placeholder="بحث بالاسم أو الرقم المدرسي أو رقم المشاركة" value="${esc(entriesFilter.q)}" style="flex:1">
        <select class="input" id="eg"><option value="">كل الصفوف</option>${s.grades.map((g) => `<option ${g === entriesFilter.grade ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select>
      </div>
      <div class="table-wrap"><table class="t">
        <thead><tr><th>رقم</th><th>الاسم الكامل</th><th>الاسم المعتمد</th><th>الرقم المدرسي</th><th>الصف/الشعبة</th><th>الفئة</th><th>التلاوة</th><th>المدة</th><th>الحالة</th><th>أصوات</th><th>التسجيل</th></tr></thead>
        <tbody>${all.items.map((c) => `<tr class="click" data-id="${c.id}">
          <td class="num"><b>${c.entry_no}</b>${c.featured ? ' ★' : ''}</td><td>${esc(c.full_name)}</td><td>${esc(c.display_name)}</td><td class="num">${esc(c.school_id)}</td>
          <td>${esc(c.grade)} / ${esc(c.section)}</td><td class="small">${esc(c.category)}</td><td>${esc(c.title)}</td><td class="num">${c.video_duration ? fmtDuration(c.video_duration) : '—'}</td>
          <td>${badge(c.status)}</td><td class="num">${c.votes_valid}</td><td class="small">${fmtDate(c.created_at)}</td></tr>`).join('') || '<tr><td colspan="11" class="center muted" style="padding:30px">لا توجد مشاركات في هذا التصنيف.</td></tr>'}</tbody>
      </table></div>`;
    const items = new Map(all.items.map((c) => [c.id, c]));
    $$('[data-st]').forEach((b) => b.onclick = () => { entriesFilter.status = b.dataset.st; go('entries'); });
    let t; $('#eq').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { entriesFilter.q = e.target.value.trim(); go('entries'); setTimeout(() => { const i = $('#eq'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 80); }, 450); };
    $('#eg').onchange = (e) => { entriesFilter.grade = e.target.value; go('entries'); };
    $$('tr[data-id]').forEach((tr) => tr.onclick = () => openEntry(items.get(Number(tr.dataset.id)), s));
  };

  function openEntry(c, s) {
    const m = modal(`<div class="review">
      <div class="vid">${c.video ? `<video controls preload="metadata" src="${c.video}" ${c.poster ? `poster="${c.poster}"` : ''}></video>` : '<p style="color:#fff;padding:20px">لم يُرفع فيديو بعد.</p>'}</div>
      <div class="info">
        <div class="spread"><b style="font-family:var(--f-display);font-size:1.3rem">مشاركة رقم <span class="num">${c.entry_no}</span></b>${badge(c.status)}</div>
        ${c.status === 'rejected' && c.reject_reason ? alertBox('err', 'سبب الرفض: ' + esc(c.reject_reason)) : ''}
        ${c.status === 'disqualified' ? alertBox('err', 'سبب الاستبعاد: ' + esc(c.disqualify_reason || '')) : ''}
        <dl>
          <dt>الاسم الكامل</dt><dd>${esc(c.full_name)}</dd>
          <dt>الرقم المدرسي</dt><dd class="num">${esc(c.school_id)}</dd>
          <dt>الفئة</dt><dd>${esc(c.category)}</dd>
          <dt>موافقة ولي الأمر</dt><dd>${c.guardian_consent ? 'نعم ✓' : 'لا'}</dd>
          <dt>الفيديو</dt><dd>${c.video_size ? `${fmtBytes(c.video_size)} · ${c.video_duration ? fmtDuration(c.video_duration) : '—'} · ${fmtDate(c.video_uploaded_at, true)}` : '—'}</dd>
          <dt>المشاهدات / الأصوات</dt><dd class="num">${fmtNum(c.views)} / ${fmtNum(c.votes_valid)}</dd>
          ${c.reviewed_by ? `<dt>راجعها</dt><dd>${esc(c.reviewed_by)} — ${fmtDate(c.reviewed_at, true)}</dd>` : ''}
        </dl>
        <form id="edit" class="form-grid" style="grid-template-columns:1fr 1fr;gap:10px">
          <div class="field full"><label>الاسم المعتمد للنشر</label><input class="input" name="display_name" value="${esc(c.display_name)}" maxlength="60"></div>
          <div class="field full"><label>عنوان التلاوة</label><input class="input" name="title" value="${esc(c.title)}" maxlength="100"></div>
          <div class="field"><label>الصف</label><select class="input" name="grade">${s.grades.map((g) => `<option ${g === c.grade ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select></div>
          <div class="field"><label>الشعبة</label><select class="input" name="section">${s.sections.map((g) => `<option ${g === c.section ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select></div>
          <label class="switch full"><span>تمييز التلاوة في الصفحة الرئيسية</span><input type="checkbox" name="featured" ${c.featured ? 'checked' : ''} ${c.status !== 'approved' ? 'disabled' : ''}></label>
          <div class="full"><button class="btn btn-sm btn-emerald" type="submit">حفظ التعديلات</button></div>
        </form>
        <hr style="border:0;border-top:1px solid var(--ivory-3);width:100%">
        <div class="gap-row">
          ${c.video && !['approved', 'disqualified'].includes(c.status) ? '<button class="btn btn-sm" data-act="approve">✓ اعتماد ونشر</button>' : ''}
          ${c.status === 'approved' ? '<button class="btn btn-sm btn-outline" data-act="pending">إلغاء النشر</button>' : ''}
          ${c.video && !['rejected', 'disqualified'].includes(c.status) ? '<button class="btn btn-sm btn-danger" data-act="open-reject">رفض</button>' : ''}
          ${can('admin') && c.status !== 'disqualified' ? '<button class="btn btn-sm btn-danger" data-act="open-dq">استبعاد</button>' : ''}
          ${can('admin') && c.status === 'disqualified' ? '<button class="btn btn-sm btn-outline" data-act="pending">إلغاء الاستبعاد</button>' : ''}
        </div>
        <div id="reason-box" class="hidden">
          <div class="field"><label id="reason-label">السبب</label><textarea class="input" id="reason" maxlength="500" style="min-height:80px"></textarea></div>
          <div class="presets mt-1" id="presets">${REJECT_PRESETS.map((p) => `<button type="button" data-preset="${esc(p)}">${esc(p)}</button>`).join('')}</div>
          <button class="btn btn-sm btn-danger mt-1" id="reason-go"></button>
        </div>
        <div class="gap-row small">
          <button class="btn btn-sm btn-outline" data-act="token">إعادة إصدار رمز المتابعة</button>
          ${c.status === 'approved' ? '<button class="btn btn-sm btn-outline" data-act="cert">شهادة PDF</button>' : ''}
          ${can('admin') && c.video ? '<button class="btn btn-sm btn-outline" style="color:var(--danger);border-color:var(--danger)" data-act="delvideo">حذف الفيديو فقط</button>' : ''}
          ${can('admin') ? '<button class="btn btn-sm btn-outline" style="color:var(--danger);border-color:var(--danger)" data-act="delete">حذف المشاركة نهائيًا</button>' : ''}
        </div>
        <div id="entry-msg"></div>
      </div></div>`);
    const v = $('video', m.el); if (v) protectVideo(v);
    const done = (msg) => { toast(msg, 'ok'); m.close(); go('entries'); refreshCounts(); };
    let reasonAct = null;
    $('#edit', m.el).onsubmit = async (e) => {
      e.preventDefault(); const f = e.target.elements;
      try {
        await api(`/api/admin/contestants/${c.id}`, { method: 'PATCH', body: { display_name: f.display_name.value, title: f.title.value, grade: f.grade.value, section: f.section.value, featured: f.featured.checked } });
        done('تم حفظ التعديلات');
      } catch (err) { $('#entry-msg', m.el).innerHTML = alertBox('err', esc(err.message)); }
    };
    m.el.addEventListener('click', async (e) => {
      const p = e.target.closest('[data-preset]'); if (p) { $('#reason', m.el).value = p.dataset.preset; return; }
      if (e.target.id === 'reason-go') {
        const a = e.target; setBusy(a, true);
        try { await api(`/api/admin/contestants/${c.id}/review`, { method: 'POST', body: { decision: reasonAct, reason: $('#reason', m.el).value } }); done(reasonAct === 'reject' ? 'تم رفض المشاركة وتسجيل السبب' : 'تم استبعاد المتسابق وإلغاء أصواته'); }
        catch (err) { setBusy(a, false); $('#entry-msg', m.el).innerHTML = alertBox('err', esc(err.message)); }
        return;
      }
      const a = e.target.closest('[data-act]'); if (!a) return;
      const act = a.dataset.act;
      try {
        if (act === 'open-reject' || act === 'open-dq') {
          reasonAct = act === 'open-reject' ? 'reject' : 'disqualify';
          $('#reason-box', m.el).classList.remove('hidden');
          $('#presets', m.el).classList.toggle('hidden', reasonAct !== 'reject');
          $('#reason-label', m.el).textContent = reasonAct === 'reject' ? 'سبب الرفض (يظهر للطالب)' : 'سبب الاستبعاد (يُسجَّل، وتُلغى أصوات المتسابق ويستعيد المصوّتون حقهم)';
          $('#reason-go', m.el).textContent = reasonAct === 'reject' ? 'تأكيد الرفض' : 'تأكيد الاستبعاد';
          $('#reason', m.el).focus(); return;
        }
        if (act === 'approve' || act === 'pending') {
          setBusy(a, true);
          await api(`/api/admin/contestants/${c.id}/review`, { method: 'POST', body: { decision: act } });
          return done(act === 'approve' ? 'تم اعتماد التلاوة ونشرها' : 'أُعيدت المشاركة إلى المراجعة');
        }
        if (act === 'token') {
          if (!confirm('سيُلغى رمز المتابعة القديم. متابعة؟')) return;
          const r = await api(`/api/admin/contestants/${c.id}/reset-token`, { method: 'POST', body: {} });
          $('#entry-msg', m.el).innerHTML = alertBox('ok', `رمز المتابعة الجديد للمشاركة <b class="num">${r.entry_no}</b>: <b dir="ltr" style="font-family:monospace;font-size:1.15rem;letter-spacing:.08em">${esc(r.token)}</b><br><span class="small">سلّمه للطالب؛ لن يظهر مرة أخرى.</span>`);
          return;
        }
        if (act === 'cert') {
          setBusy(a, true, 'جارٍ الإعداد…');
          const r = await api(`/api/admin/contestants/${c.id}/certificate`);
          let type = r.certificate.type;
          if (r.available.length > 1 && !confirm('هذا المتسابق من الفائزين. موافق = شهادة فوز، إلغاء = شهادة مشاركة')) {
            type = 'participation';
          }
          const cert = type === r.certificate.type ? r.certificate : (await api(`/api/admin/contestants/${c.id}/certificate?type=${type}`)).certificate;
          await window.QCert.download(cert);
          setBusy(a, false);
          $('#entry-msg', m.el).innerHTML = alertBox('ok', `صدرت الشهادة. رمز التحقق: <b dir="ltr">${esc(cert.code)}</b>`);
          return;
        }
        if (act === 'delvideo') {
          const reason = prompt('سبب حذف الفيديو (إلزامي، يُسجَّل). ستعود المشاركة إلى «مسودة» ويمكن للطالب رفع مقطع جديد إن كان التسجيل مفتوحًا:');
          if (!reason) return;
          await api(`/api/admin/contestants/${c.id}/delete-video`, { method: 'POST', body: { reason } });
          return done('تم حذف الفيديو من التخزين');
        }
        if (act === 'delete') {
          if (prompt(`للتأكيد اكتب رقم المشاركة (${c.entry_no}). سيُحذف الفيديو والأصوات والتقييمات نهائيًا.`) !== String(c.entry_no)) return;
          await api(`/api/admin/contestants/${c.id}`, { method: 'DELETE' });
          return done('تم حذف المشاركة');
        }
      } catch (err) { setBusy(a, false); $('#entry-msg', m.el).innerHTML = alertBox('err', esc(err.message)); }
    });
  }

  // ═══════════════ إدارة التصويت ═══════════════
  let votesFilter = { status: '', entry: '' };
  VIEWS.voting = async () => {
    const s = await getSettings(true);
    const [d, att, votes] = await Promise.all([api('/api/admin/dashboard'), api('/api/admin/vote-attempts'), api('/api/admin/votes?' + new URLSearchParams(votesFilter))]);
    const ph = d.phases;
    const modeBtn = (m, l) => `<button class="chip ${s.voting_mode === m ? 'on' : ''}" data-vmode="${m}">${l}</button>`;
    main().innerHTML = head('إدارة التصويت', '<a class="btn btn-sm" href="/api/admin/export/results.xlsx">تصدير النتائج Excel</a><a class="btn btn-sm btn-outline" href="/api/admin/export/results.csv">CSV</a>') + `
      <div class="box"><h2>حالة التصويت: ${onOff(ph.votingOpen)}</h2>
        <div class="filters"><span class="small muted">التحكم:</span><div class="chips">${modeBtn('auto', 'تلقائي حسب المواعيد')}${modeBtn('open', 'فتح الآن')}${modeBtn('closed', 'إغلاق الآن')}</div></div>
        <form id="vdates" class="settings-grid">
          <div class="field"><label>بداية التصويت</label><input class="input" type="datetime-local" name="voting_start" value="${toLocalInput(s.voting_start)}"></div>
          <div class="field"><label>نهاية التصويت (يُغلق تلقائيًا)</label><input class="input" type="datetime-local" name="voting_end" value="${toLocalInput(s.voting_end)}"></div>
          <div style="align-self:end"><button class="btn btn-sm btn-emerald" type="submit">حفظ المواعيد</button></div>
        </form>
        <p class="muted small">التحقق: ${s.voter_auth === 'oidc' ? 'حساب المدرسة (Google/Microsoft)' : 'الرقم المدرسي + رمز شخصي'} · ${s.prevent_self_vote ? 'التصويت للنفس ممنوع' : 'التصويت للنفس مسموح'} · ${s.allow_vote_change ? 'تعديل الصوت مسموح' : 'لا تعديل بعد الاعتماد'} · النتائج للجمهور: ${s.show_results ? 'معلنة' : 'مخفية'} — <a href="#settings">تعديل الإعدادات</a></p>
      </div>
      <div class="kpis mt-2" id="live">
        <div class="kpi"><b class="num" data-live="valid">${fmtNum(d.votes.valid)}</b><span>صوت صحيح</span></div>
        <div class="kpi"><b class="num" data-live="voters">${fmtNum(d.voters)}</b><span>طالب صوّت</span></div>
        <div class="kpi" style="--kc:#0e5a45"><b data-live="part">${d.participation}%</b><span>نسبة المشاركة</span></div>
        <div class="kpi" style="--kc:#8d8570"><b class="num">${fmtNum(d.votes.replaced + d.votes.void)}</b><span>معدّل / ملغى</span></div>
        <div class="kpi" style="--kc:#b07a12"><b class="num">${fmtNum(d.attempts_24h)}</b><span>محاولة مرفوضة (24 ساعة)</span></div>
      </div>
      <div class="two">
        <div class="box"><h2>ترتيب المتسابقين حسب الأصوات <span class="muted small">(يتحدّث كل 10 ثوانٍ)</span></h2><div id="live-rank">${bars(d.per_contestant, (r) => `${esc(r.display_name)} <span class="muted num">#${r.entry_no}</span>`, (r) => r.n, (r) => esc(r.category))}</div></div>
        <div class="box"><h2>الحالات المشتبه بها</h2>
          ${att.summary.length ? `<div class="bars">${att.summary.map((k) => `<div class="gap-row small"><span class="tag flagged">${esc(ATTEMPT_AR[k.kind] || k.kind)}</span><b class="num">${fmtNum(k.n)}</b></div>`).join('')}</div>` : '<p class="muted">لا توجد محاولات مرفوضة.</p>'}
          ${att.suspects.length ? `<h2 class="mt-2" style="font-size:1.05rem">طلاب بثلاث محاولات مرفوضة أو أكثر</h2><div class="table-wrap"><table class="t"><thead><tr><th>الطالب</th><th>الرقم</th><th>المحاولات</th><th>الأنواع</th></tr></thead><tbody>${att.suspects.map((x) => `<tr><td>${esc(x.full_name)}</td><td class="num">${esc(x.school_id)}</td><td class="num">${x.n}</td><td class="small">${esc(String(x.kinds).split(',').map((k) => ATTEMPT_AR[k] || k).join('، '))}</td></tr>`).join('')}</tbody></table></div>` : ''}
        </div>
      </div>
      <div class="box mt-2"><h2>سجل محاولات التصويت المرفوضة</h2>
        ${att.identities_visible ? '' : alertBox('info', 'هويات الطلاب مخفية جزئيًا. كشفها يتطلب صلاحية «إدارة الأصوات» التي يمنحها المالك.')}
        <div class="table-wrap mt-1" style="max-height:380px;overflow:auto"><table class="t"><thead><tr><th>الوقت</th><th>النوع</th><th>الطالب</th><th>المُدخل</th><th>المتسابق</th><th>شبكة</th></tr></thead>
        <tbody>${att.items.map((a) => `<tr><td class="small">${fmtDate(a.created_at, true)}</td><td><span class="tag flagged">${esc(ATTEMPT_AR[a.kind] || a.kind)}</span></td><td>${esc(a.full_name || '—')} <span class="muted num">${esc(a.school_id || '')}</span></td><td class="num small">${esc(a.entered_id || '')}</td><td class="num">${a.entry_no ? '#' + a.entry_no : ''}</td><td class="num small" dir="ltr">${a.ip}</td></tr>`).join('') || '<tr><td colspan="6" class="center muted" style="padding:20px">لا توجد محاولات.</td></tr>'}</tbody></table></div></div>
      <div class="box"><h2>سجل الأصوات</h2>
        ${votes.identities_visible ? alertBox('warn', 'لديك صلاحية إدارة الأصوات: تظهر لك هوية المصوّت. أي تعديل يتطلب سببًا ويُسجَّل في سجل العمليات.') : alertBox('info', 'سرّية الاقتراع: يظهر المصوّت كمعرّف مشفّر. تعديل الأصوات متاح لأصحاب صلاحية «إدارة الأصوات» فقط.')}
        <div class="filters mt-1"><div class="chips">${['', 'valid', 'replaced', 'void'].map((k) => `<button class="chip ${votesFilter.status === k ? 'on' : ''}" data-vs="${k}">${{ '': 'الكل', valid: 'صحيحة', replaced: 'معدّلة', void: 'ملغاة' }[k]}</button>`).join('')}</div>
          <input class="input" id="ve" placeholder="رقم المشاركة" value="${esc(votesFilter.entry)}" style="width:150px" inputmode="numeric">
          ${canVotes() ? '<span style="margin-inline-start:auto" class="gap-row"><button class="btn btn-sm btn-emerald" data-bulk="valid">استعادة المحدد</button><button class="btn btn-sm btn-danger" data-bulk="void">إلغاء المحدد</button></span>' : ''}</div>
        <div class="table-wrap" style="max-height:480px;overflow:auto"><table class="t"><thead><tr>${canVotes() ? '<th><input type="checkbox" id="vall"></th>' : ''}<th>#</th><th>الوقت</th><th>المتسابق</th><th>المصوّت</th><th>الحالة</th><th>السبب</th><th>التحقق</th></tr></thead>
        <tbody>${votes.items.map((v) => `<tr>${canVotes() ? `<td><input type="checkbox" data-vid="${v.id}"></td>` : ''}<td class="num">${v.id}</td><td class="small">${fmtDate(v.created_at, true)}</td><td>${esc(v.display_name)} <span class="muted num">#${v.entry_no}</span></td>
          <td>${votes.identities_visible ? `${esc(v.full_name)} <span class="muted num">${esc(v.school_id)}</span>` : `<span class="num muted" dir="ltr">${esc(v.student_ref)}</span> <span class="small muted">${esc(v.grade)}</span>`}</td>
          <td><span class="tag ${v.status === 'valid' ? 'valid' : 'void'}">${{ valid: 'صحيح', replaced: 'معدّل', void: 'ملغى' }[v.status]}</span></td><td class="small">${esc(v.status_reason || '')}</td><td class="small">${v.method === 'oidc' ? 'حساب مدرسي' : 'رمز شخصي'}</td></tr>`).join('') || '<tr><td colspan="8" class="center muted" style="padding:20px">لا توجد أصوات.</td></tr>'}</tbody></table></div></div>`;
    $$('[data-vmode]').forEach((b) => b.onclick = async () => {
      if (b.dataset.vmode !== 'auto' && !confirm(b.dataset.vmode === 'open' ? 'فتح التصويت الآن يدويًا (يتجاهل المواعيد)؟' : 'إغلاق التصويت الآن؟')) return;
      try { await api('/api/admin/voting/state', { method: 'POST', body: { mode: b.dataset.vmode } }); toast('تم تحديث حالة التصويت', 'ok'); cache.settings = null; go('voting'); } catch (e) { toast(e.message, 'err'); }
    });
    $('#vdates').onsubmit = async (e) => {
      e.preventDefault(); const f = e.target.elements;
      try { await api('/api/admin/settings', { method: 'PUT', body: { voting_start: fromLocalInput(f.voting_start.value), voting_end: fromLocalInput(f.voting_end.value) } }); cache.settings = null; toast('تم حفظ المواعيد', 'ok'); go('voting'); } catch (err) { toast(err.message, 'err'); }
    };
    $$('[data-vs]').forEach((b) => b.onclick = () => { votesFilter.status = b.dataset.vs; go('voting'); });
    $('#ve').onchange = (e) => { votesFilter.entry = e.target.value.replace(/\D/g, ''); go('voting'); };
    const all = $('#vall'); if (all) all.onchange = () => $$('[data-vid]').forEach((c) => { c.checked = all.checked; });
    $$('[data-bulk]').forEach((b) => b.onclick = async () => {
      const ids = $$('[data-vid]:checked').map((c) => Number(c.dataset.vid));
      if (!ids.length) return toast('حدّد أصواتًا أولًا', 'err');
      const reason = prompt(`سبب ${b.dataset.bulk === 'void' ? 'الإلغاء' : 'الاستعادة'} (إلزامي، يُسجَّل في سجل العمليات):`);
      if (!reason) return;
      try { const r = await api('/api/admin/votes/status', { method: 'POST', body: { ids, status: b.dataset.bulk, reason } }); toast(r.message, 'ok'); go('voting'); refreshCounts(); }
      catch (e) { toast(e.message, 'err'); }
    });
    // تحديث لحظي
    pollTimer = setInterval(async () => {
      if (!$('#live')) return clearInterval(pollTimer);
      try {
        const n = await api('/api/admin/dashboard');
        $('[data-live="valid"]').textContent = fmtNum(n.votes.valid); $('[data-live="voters"]').textContent = fmtNum(n.voters); $('[data-live="part"]').textContent = n.participation + '%';
        $('#live-rank').innerHTML = bars(n.per_contestant, (r) => `${esc(r.display_name)} <span class="muted num">#${r.entry_no}</span>`, (r) => r.n, (r) => esc(r.category));
      } catch {}
    }, 10000);
  };

  // ═══════════════ الطلاب المؤهلون ═══════════════
  let stuFilter = { q: '', grade: '', filter: '' };
  function parseCsv(text) {
    const rows = []; let row = [], cell = '', q = false;
    text = text.replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
      if (ch === '"') q = true;
      else if (ch === ',' || ch === ';' || ch === '\t') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((c) => c.trim()));
  }
  const HEADER_MAP = { school_id: ['الرقم المدرسي', 'رقم الطالب', 'school_id', 'id'], full_name: ['الاسم', 'اسم الطالب', 'الاسم الكامل', 'name', 'full_name'], grade: ['الصف', 'grade'], section: ['الشعبة', 'الفصل', 'section'], email: ['البريد', 'البريد الإلكتروني', 'البريد المدرسي', 'email'] };
  function printPins(pins) {
    const w = window.open('', '_blank');
    w.document.write(`<html dir="rtl"><head><meta charset="utf-8"><title>الرموز الشخصية للتصويت</title><style>body{font-family:Tahoma,sans-serif;margin:14px}.g{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.c{border:1.5px dashed #9c7a2b;border-radius:10px;padding:12px;page-break-inside:avoid;font-size:13px}.c b.p{display:block;font:700 22px monospace;letter-spacing:4px;direction:ltr;text-align:center;margin:8px 0;color:#052e23}.h{color:#9c7a2b;font-weight:700}</style></head><body><div class="g">${pins.map((p) => `<div class="c"><div class="h">قارئ المدرسة — رمز التصويت الشخصي</div>${esc(p.full_name)}<br>${esc(p.grade)} ${p.section ? '/ ' + esc(p.section) : ''}<br>الرقم المدرسي: <b>${esc(p.school_id)}</b><b class="p">${p.pin}</b><small>سرّي — لا تشاركه مع أحد. صوت واحد لكل طالب.</small></div>`).join('')}</div></body></html>`);
    w.document.close(); w.focus(); w.print();
  }
  function showPins(pins) {
    const m = modal(`<div class="modal-body" style="padding-top:38px"><h3>الرموز الشخصية (${pins.length})</h3>
      ${alertBox('warn', 'تظهر هذه الرموز <b>مرة واحدة فقط</b> ولا تُخزَّن إلا مشفّرة. اطبعها أو نزّلها الآن، ثم وزّعها على الطلاب بشكل فردي.')}
      <div class="gap-row mt-2"><button class="btn btn-sm" data-pr>طباعة البطاقات</button><button class="btn btn-sm btn-outline" data-dl>تنزيل CSV</button></div>
      <div class="table-wrap mt-2" style="max-height:320px;overflow:auto"><table class="t"><thead><tr><th>الرقم المدرسي</th><th>الاسم</th><th>الصف</th><th>الرمز</th></tr></thead><tbody>${pins.map((p) => `<tr><td class="num">${esc(p.school_id)}</td><td>${esc(p.full_name)}</td><td>${esc(p.grade)}</td><td class="num" dir="ltr"><b>${p.pin}</b></td></tr>`).join('')}</tbody></table></div></div>`);
    $('[data-pr]', m.el).onclick = () => printPins(pins);
    $('[data-dl]', m.el).onclick = () => downloadText('voting-pins.csv', 'الرقم المدرسي,الاسم,الصف,الشعبة,الرمز الشخصي\r\n' + pins.map((p) => [p.school_id, p.full_name, p.grade, p.section, p.pin].map(csvCell).join(',')).join('\r\n'));
  }
  VIEWS.students = async () => {
    const s = await getSettings();
    const r = await api('/api/admin/students?' + new URLSearchParams(stuFilter));
    const t = r.totals;
    main().innerHTML = head('الطلاب المؤهلون للتصويت', '<a class="btn btn-sm btn-outline" href="/api/admin/export/students.xlsx">تصدير Excel</a>') + `
      ${alertBox('info', `لا يصوّت إلا الطلاب المدرجون هنا. ${s.voter_auth === 'oidc' ? 'طريقة التحقق الحالية: <b>حساب المدرسة</b> — تأكد من إدخال البريد المدرسي لكل طالب.' : 'طريقة التحقق الحالية: <b>الرقم المدرسي + رمز شخصي سري</b> تصدره من هنا وتوزّعه على الطلاب.'}`)}
      <div class="kpis mt-2">
        <div class="kpi"><b class="num">${fmtNum(t.active || 0)}</b><span>طالب مؤهل نشط</span></div>
        <div class="kpi" style="--kc:#137257"><b class="num">${fmtNum(t.with_pin || 0)}</b><span>صدر له رمز</span></div>
        <div class="kpi" style="--kc:#0e5a45"><b class="num">${fmtNum(t.voted || 0)}</b><span>صوّت</span></div>
      </div>
      <div class="two">
        <div class="box"><h2>استيراد القائمة المعتمدة</h2>
          <p class="muted small">ملف CSV (احفظ ملف Excel بصيغة «CSV UTF-8»). الأعمدة: <b>الرقم المدرسي، الاسم، الصف، الشعبة، البريد المدرسي</b> (البريد اختياري). يجب أن تطابق أسماء الصفوف الإعدادات.</p>
          <div class="gap-row"><input type="file" id="csv" accept=".csv,text/csv,.txt" class="input" style="max-width:300px"><button class="btn btn-sm btn-outline" id="tpl">تنزيل نموذج</button></div>
          <label class="gap-row small mt-1"><input type="checkbox" id="deact"> تعطيل الطلاب غير الموجودين في الملف الجديد</label>
          <div id="imp-msg" class="mt-1"></div>
        </div>
        <div class="box"><h2>الرموز الشخصية</h2>
          <p class="muted small">يُخزَّن الرمز مشفّرًا ولا يمكن استرجاعه؛ إصدار رمز جديد يُلغي القديم فورًا. بعد 5 محاولات خاطئة يُقفل دخول الطالب 30 دقيقة.</p>
          <div class="gap-row"><button class="btn btn-sm" data-pins="missing">إصدار رموز لمن ليس لديه رمز</button><button class="btn btn-sm btn-outline" data-pins="selected">إصدار للمحددين</button><button class="btn btn-sm btn-outline" data-pins="all" style="color:var(--danger);border-color:var(--danger)">إعادة إصدار للجميع</button></div>
          <h2 class="mt-2" style="font-size:1.05rem">إضافة طالب يدويًا</h2>
          <form id="addstu" class="gap-row"><input class="input" name="school_id" placeholder="الرقم المدرسي" style="max-width:140px" dir="ltr"><input class="input" name="full_name" placeholder="الاسم" style="max-width:200px">
            <select class="input" name="grade" style="max-width:160px">${s.grades.map((g) => `<option>${esc(g)}</option>`).join('')}</select><input class="input" name="section" placeholder="الشعبة" style="max-width:90px"><button class="btn btn-sm btn-emerald">إضافة</button></form>
        </div>
      </div>
      <div class="box">
        <div class="filters"><input class="input" id="sq" type="search" placeholder="بحث بالاسم أو الرقم أو البريد" value="${esc(stuFilter.q)}" style="flex:1">
          <select class="input" id="sg"><option value="">كل الصفوف</option>${s.grades.map((g) => `<option ${g === stuFilter.grade ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select>
          <select class="input" id="sf">${[['', 'الكل'], ['voted', 'صوّتوا'], ['not_voted', 'لم يصوّتوا'], ['no_pin', 'بلا رمز'], ['locked', 'مقفلون'], ['inactive', 'معطّلون']].map(([v, l]) => `<option value="${v}" ${stuFilter.filter === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="table-wrap" style="max-height:560px;overflow:auto"><table class="t"><thead><tr><th><input type="checkbox" id="sall"></th><th>الرقم المدرسي</th><th>الاسم</th><th>الصف</th><th>الفئة</th><th>البريد</th><th>رمز</th><th>صوّت</th><th>الحالة</th><th></th></tr></thead>
        <tbody>${r.items.map((x) => `<tr><td><input type="checkbox" data-sid="${x.id}"></td><td class="num">${esc(x.school_id)}</td><td>${esc(x.full_name)}</td><td>${esc(x.grade)} ${x.section ? '/ ' + esc(x.section) : ''}</td><td class="small">${esc(x.category)}</td>
          <td class="small" dir="ltr">${esc(x.email || '')}</td><td>${x.has_pin ? '✓' : '—'}</td><td>${x.voted ? '<span class="tag valid">نعم</span>' : '—'}</td>
          <td>${!x.active ? '<span class="tag void">معطّل</span>' : x.locked ? '<span class="tag flagged">مقفل</span>' : '<span class="tag valid">نشط</span>'}</td>
          <td class="gap-row">${x.locked ? `<button class="btn btn-sm btn-outline" data-unlock="${x.id}">فك القفل</button>` : ''}<button class="btn btn-sm btn-outline" data-toggle="${x.id}" data-active="${x.active}">${x.active ? 'تعطيل' : 'تفعيل'}</button>
          <button class="btn btn-sm btn-outline" data-email="${x.id}" data-cur="${esc(x.email || '')}">البريد</button></td></tr>`).join('') || '<tr><td colspan="10" class="center muted" style="padding:30px">لا يوجد طلاب. ابدأ باستيراد القائمة المعتمدة.</td></tr>'}</tbody></table></div>
        <p class="muted small">يعرض حتى 3000 طالب. «صوّت» توضح المشاركة فقط ولا تكشف لمن صوّت الطالب.</p></div>`;
    $('#tpl').onclick = () => downloadText('students-template.csv', 'الرقم المدرسي,الاسم,الصف,الشعبة,البريد المدرسي\r\n20231001,أحمد محمد علي,' + s.grades[0] + ',أ,ahmed@school.edu\r\n');
    $('#csv').onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      const rows = parseCsv(await f.text());
      if (rows.length < 2) return ($('#imp-msg').innerHTML = alertBox('err', 'الملف فارغ.'));
      const hdr = rows[0].map((h) => h.trim().toLowerCase());
      const idx = {}; for (const [k, names] of Object.entries(HEADER_MAP)) idx[k] = hdr.findIndex((h) => names.map((n) => n.toLowerCase()).includes(h));
      if (idx.school_id < 0 || idx.full_name < 0 || idx.grade < 0) return ($('#imp-msg').innerHTML = alertBox('err', 'لم أجد الأعمدة المطلوبة (الرقم المدرسي، الاسم، الصف) في السطر الأول.'));
      const data = rows.slice(1).map((r) => Object.fromEntries(Object.entries(idx).map(([k, i]) => [k, i >= 0 ? (r[i] || '').trim() : ''])));
      if (!confirm(`استيراد ${data.length} طالب؟`)) return;
      try {
        const res = await api('/api/admin/students/import', { method: 'POST', body: { rows: data, deactivate_missing: $('#deact').checked } });
        toast(`أُضيف ${res.added} وحُدّث ${res.updated}`, 'ok');
        stuFilter = { q: '', grade: '', filter: '' };
        await VIEWS.students();
        if (res.errors.length) $('#imp-msg').innerHTML = alertBox('warn', `<b>${res.errors.length} سطر لم يُستورد:</b><br>${res.errors.slice(0, 30).map(esc).join('<br>')}`);
      } catch (err) { $('#imp-msg').innerHTML = alertBox('err', esc(err.message)); }
    };
    $$('[data-pins]').forEach((b) => b.onclick = async () => {
      const scope = b.dataset.pins;
      const ids = $$('[data-sid]:checked').map((c) => Number(c.dataset.sid));
      if (scope === 'selected' && !ids.length) return toast('حدّد طلابًا أولًا', 'err');
      if (scope !== 'missing' && !confirm('سيُلغى أي رمز سابق لهؤلاء الطلاب. متابعة؟')) return;
      try { const res = await api('/api/admin/students/pins', { method: 'POST', body: { scope: scope === 'selected' ? undefined : scope, ids } }); showPins(res.pins); }
      catch (e) { toast(e.message, 'err'); }
    });
    $('#addstu').onsubmit = async (e) => {
      e.preventDefault(); const f = e.target.elements;
      try { await api('/api/admin/students', { method: 'POST', body: { school_id: f.school_id.value, full_name: f.full_name.value, grade: f.grade.value, section: f.section.value } }); toast('تمت الإضافة', 'ok'); go('students'); }
      catch (err) { toast(err.message, 'err'); }
    };
    const sall = $('#sall'); sall.onchange = () => $$('[data-sid]').forEach((c) => { c.checked = sall.checked; });
    let tq; $('#sq').oninput = (e) => { clearTimeout(tq); tq = setTimeout(() => { stuFilter.q = e.target.value.trim(); go('students'); }, 450); };
    $('#sg').onchange = (e) => { stuFilter.grade = e.target.value; go('students'); };
    $('#sf').onchange = (e) => { stuFilter.filter = e.target.value; go('students'); };
    const patch = async (id, body) => { try { await api('/api/admin/students/' + id, { method: 'PATCH', body }); go('students'); } catch (e) { toast(e.message, 'err'); } };
    $$('[data-unlock]').forEach((b) => b.onclick = () => patch(b.dataset.unlock, { unlock: true }));
    $$('[data-toggle]').forEach((b) => b.onclick = () => patch(b.dataset.toggle, { active: b.dataset.active !== '1' }));
    $$('[data-email]').forEach((b) => b.onclick = () => { const v = prompt('البريد المدرسي للطالب:', b.dataset.cur); if (v !== null) patch(b.dataset.email, { email: v.trim() }); });
  };

  // ═══════════════ لجنة التحكيم (للإدارة) ═══════════════
  VIEWS.judging = async () => {
    const j = await api('/api/admin/judging');
    const maxT = j.criteria.reduce((a, c) => a + c.max, 0);
    const jn = new Map(j.judges.map((x) => [x.id, x.display_name]));
    main().innerHTML = head('لجنة التحكيم') + `
      ${!j.enabled ? alertBox('warn', 'نظام التحكيم معطّل حاليًا. فعّله من الإعدادات العامة.') : ''}
      <div class="two">
        <div class="box"><h2>معايير التقييم</h2>
          <div class="table-wrap"><table class="t"><thead><tr><th>المعيار</th><th>الدرجة</th></tr></thead><tbody>${j.criteria.map((c) => `<tr><td>${esc(c.name)}</td><td class="num">${c.max}</td></tr>`).join('')}<tr><td><b>الإجمالي</b></td><td class="num"><b>${maxT}</b></td></tr></tbody></table></div>
          <p class="muted small">تعديل المعايير والدرجات من <a href="#settings">الإعدادات العامة</a> (يُقفل بعد اعتماد أول تقييم).</p></div>
        <div class="box"><h2>طريقة الاحتساب</h2>
          <ul class="small" style="padding-inline-start:18px;margin:0">
            <li>درجة كل محكّم = (مجموع درجاته ÷ ${maxT}) × 100.</li>
            <li>درجة التحكيم للمتسابق = <b>متوسط</b> درجات المحكّمين الذين <b>اعتمدوا</b> تقييمهم نهائيًا. المسودات لا تُحتسب.</li>
            <li>التكليف: <b>${j.assignment === 'manual' ? 'يدوي — كل محكّم يقيّم المكلَّف بهم فقط' : 'كل محكّم يقيّم جميع التلاوات المعتمدة'}</b>.</li>
            <li>الاكتمال: ${j.completion === 'minimum' ? `يكفي <b>${j.min_required}</b> تقييم معتمد على الأقل لكل متسابق` : 'يجب أن يعتمد <b>جميع المحكّمين المكلّفين</b> تقييماتهم'}. لا تُعتمد النتائج ما لم يكتمل التحكيم لكل متسابق.</li>
            <li>لا يرى المحكّم تقييمات زملائه قبل اعتماد تقييمه، ولا يرى الرقم المدرسي أو الاسم الكامل.</li>
          </ul></div>
      </div>
      <div class="box"><h2>المحكّمون (${j.judges.length})</h2>
        ${j.judges.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>المحكّم</th><th>المكلَّف بها</th><th>معتمد</th><th>مسودة</th>${j.assignment === 'manual' && can('admin') ? '<th></th>' : ''}</tr></thead><tbody>${j.judges.map((x) => {
          const assigned = j.assignment === 'manual' ? j.assignments.filter((a) => a.judge_id === x.id).length : j.contestants.length;
          const ev = j.contestants.flatMap((c) => c.evaluations.filter((e) => e.judge_id === x.id));
          return `<tr><td>${esc(x.display_name)}</td><td class="num">${assigned}</td><td class="num">${ev.filter((e) => e.status === 'submitted').length}</td><td class="num">${ev.filter((e) => e.status === 'draft').length}</td>${j.assignment === 'manual' && can('admin') ? `<td><button class="btn btn-sm btn-outline" data-assign="${x.id}">تكليف</button></td>` : ''}</tr>`;
        }).join('')}</tbody></table></div>` : `<p class="muted">لا يوجد محكّمون. أضف حسابات بصلاحية «محكّم» من <a href="#admins">المشرفون والمحكّمون</a>.</p>`}</div>
      <div class="box"><h2>تقدّم التحكيم لكل متسابق</h2>
        <div class="table-wrap"><table class="t"><thead><tr><th>رقم</th><th>المتسابق</th><th>الفئة</th><th>المكلَّفون</th><th>معتمد / مطلوب</th><th>درجات المحكّمين</th><th>المتوسط /100</th><th>الحالة</th></tr></thead>
        <tbody>${j.contestants.map((c) => `<tr><td class="num">${c.entry_no}</td><td>${esc(c.display_name)}</td><td class="small">${esc(c.category)}</td><td class="num">${c.assigned}</td><td class="num">${c.submitted} / ${c.required}</td>
          <td class="small">${c.evaluations.map((e) => `<span class="tag ${e.status === 'submitted' ? 'valid' : 'flagged'}" title="${esc(jn.get(e.judge_id) || '')}">${esc(jn.get(e.judge_id) || '؟')}: ${e.status === 'submitted' ? e.pct : 'مسودة'}${e.status === 'submitted' && can('admin') ? ` <a href="#" data-reopen="${e.judge_id}:${c.id}" title="إعادة فتح">↺</a>` : ''}</span>`).join(' ') || '—'}</td>
          <td class="num"><b>${c.avg != null ? Math.round(c.avg * 100) / 100 : '—'}</b></td><td>${c.complete ? '<span class="tag valid">مكتمل</span>' : '<span class="tag flagged">ناقص</span>'}</td></tr>`).join('') || '<tr><td colspan="8" class="center muted" style="padding:24px">لا توجد تلاوات معتمدة بعد.</td></tr>'}</tbody></table></div></div>`;
    $$('[data-reopen]').forEach((a) => a.onclick = async (e) => {
      e.preventDefault();
      const [judge_id, contestant_id] = a.dataset.reopen.split(':').map(Number);
      const reason = prompt('سبب إعادة فتح التقييم (إلزامي، يُسجَّل):'); if (!reason) return;
      try { await api('/api/admin/evaluations/reopen', { method: 'POST', body: { judge_id, contestant_id, reason } }); toast('أُعيد فتح التقييم للمحكّم', 'ok'); go('judging'); } catch (err) { toast(err.message, 'err'); }
    });
    $$('[data-assign]').forEach((b) => b.onclick = () => {
      const jid = Number(b.dataset.assign);
      const cur = new Set(j.assignments.filter((a) => a.judge_id === jid).map((a) => a.contestant_id));
      const m = modal(`<div class="modal-body" style="padding-top:38px"><h3>تكليف ${esc(jn.get(jid))}</h3>
        <div class="gap-row mt-1"><button class="btn btn-sm btn-outline" data-allc>تحديد الكل</button><button class="btn btn-sm btn-outline" data-nonec>إلغاء الكل</button></div>
        <div style="max-height:50vh;overflow:auto;margin-top:12px">${j.contestants.map((c) => `<label class="check" style="margin-bottom:6px"><input type="checkbox" value="${c.id}" ${cur.has(c.id) ? 'checked' : ''}><span>#${c.entry_no} — ${esc(c.display_name)} <span class="muted small">${esc(c.category)}</span></span></label>`).join('')}</div>
        <button class="btn mt-2" data-save>حفظ التكليف</button></div>`, { size: 'sm' });
      $('[data-allc]', m.el).onclick = () => $$('input[type=checkbox]', m.el).forEach((x) => { x.checked = true; });
      $('[data-nonec]', m.el).onclick = () => $$('input[type=checkbox]', m.el).forEach((x) => { x.checked = false; });
      $('[data-save]', m.el).onclick = async () => {
        try { await api('/api/admin/judging/assign', { method: 'POST', body: { judge_id: jid, contestant_ids: $$('input:checked', m.el).map((x) => Number(x.value)) } }); m.close(); toast('تم حفظ التكليف', 'ok'); go('judging'); } catch (e) { toast(e.message, 'err'); }
      };
    });
  };

  // ═══════════════ واجهة المحكّم ═══════════════
  VIEWS.evals = async () => {
    const r = await api('/api/judge/assignments');
    const ST = { none: ['tag void', 'لم يبدأ'], draft: ['tag flagged', 'مسودة'], submitted: ['tag valid', 'معتمد'] };
    const done = r.items.filter((x) => x.status === 'submitted').length;
    main().innerHTML = head('تقييماتي', `<span class="muted">${done} من ${r.items.length} معتمد</span>`) + `
      ${alertBox('info', 'قيّم كل تلاوة وفق المعايير، واحفظ مسودة متى شئت. بعد «الاعتماد النهائي» يُقفل التقييم وتظهر لك تقييمات زملائك لهذه التلاوة.')}
      <div class="progress mt-2"><div class="track"><div class="fill" style="width:${r.items.length ? (done / r.items.length) * 100 : 0}%"></div></div></div>
      <div class="table-wrap mt-2"><table class="t"><thead><tr><th>رقم</th><th>القارئ</th><th>الفئة</th><th>التلاوة</th><th>المدة</th><th>حالة تقييمي</th><th>درجتي /100</th></tr></thead>
      <tbody>${r.items.map((x) => `<tr class="click" data-cid="${x.id}"><td class="num">${x.entry_no}</td><td>${esc(x.display_name)}</td><td class="small">${esc(x.category)}</td><td>${esc(x.title)}</td><td class="num">${x.duration ? fmtDuration(x.duration) : '—'}</td>
        <td><span class="${ST[x.status][0]}">${ST[x.status][1]}</span></td><td class="num">${x.pct ?? '—'}</td></tr>`).join('') || '<tr><td colspan="7" class="center muted" style="padding:30px">لا توجد تلاوات مكلَّف بتقييمها حاليًا.</td></tr>'}</tbody></table></div>`;
    $$('tr[data-cid]').forEach((tr) => tr.onclick = () => openEval(Number(tr.dataset.cid)));
  };

  async function openEval(cid) {
    let d;
    try { d = await api('/api/judge/evaluations/' + cid); } catch (e) { return toast(e.message, 'err'); }
    const ev = d.evaluation || { scores: {}, notes: '', status: 'none' };
    const locked = ev.status === 'submitted';
    const maxT = d.criteria.reduce((a, c) => a + c.max, 0);
    const m = modal(`<div class="review">
      <div class="vid"><video controls preload="metadata" src="${d.contestant.video}" ${d.contestant.poster ? `poster="${d.contestant.poster}"` : ''}></video></div>
      <form class="info" id="evf" novalidate>
        <div><b style="font-family:var(--f-display);font-size:1.3rem">${esc(d.contestant.display_name)}</b> <span class="muted num">#${d.contestant.entry_no}</span>
          <div style="font-family:var(--f-quran);color:var(--gold-lo);font-size:1.15rem">${esc(d.contestant.title)}</div></div>
        ${locked ? alertBox('ok', `اعتمدت هذا التقييم في ${fmtDate(ev.submitted_at, true)}. لا يمكن تعديله إلا إذا أعادت الإدارة فتحه.`) : ev.status === 'draft' ? alertBox('info', `مسودة محفوظة — آخر تعديل ${fmtDate(ev.updated_at, true)}`) : ''}
        ${d.criteria.map((c) => `<div class="field"><label>${esc(c.name)} <span class="muted small">(من ${c.max})</span></label>
          <div class="gap-row"><input type="range" min="0" max="${c.max}" step="0.5" data-r="${c.id}" value="${ev.scores[c.id] ?? 0}" ${locked ? 'disabled' : ''} style="flex:1;accent-color:var(--em-700)">
          <input class="input num" type="number" min="0" max="${c.max}" step="0.25" data-k="${c.id}" value="${ev.scores[c.id] ?? ''}" ${locked ? 'disabled' : ''} style="width:90px"></div></div>`).join('')}
        <div class="spread"><b>المجموع</b><b class="num" id="tot">0 / ${maxT}</b></div>
        <div class="field"><label>ملاحظات (للجنة فقط)</label><textarea class="input" name="notes" maxlength="2000" ${locked ? 'disabled' : ''}>${esc(ev.notes || '')}</textarea></div>
        ${locked ? '' : '<div class="gap-row"><button class="btn btn-sm btn-outline" type="button" data-save>حفظ مسودة</button><button class="btn btn-sm" type="button" data-submit>اعتماد التقييم نهائيًا</button></div>'}
        <div id="ev-msg"></div>
        ${d.others ? `<div class="box" style="padding:14px"><h2 style="font-size:1.05rem">تقييمات بقية المحكّمين المعتمدة (${d.others.length})</h2>
          ${d.others.length ? d.others.map((o) => `<div class="small" style="margin-bottom:8px"><b>${esc(o.judge)}</b>: <b class="num">${o.pct}</b>/100 — ${d.criteria.map((c) => `${esc(c.name)} ${o.scores[c.id] ?? '—'}`).join(' · ')}${o.notes ? `<br><span class="muted">${esc(o.notes)}</span>` : ''}</div>`).join('') : '<p class="muted small">لم يعتمد غيرك بعد.</p>'}</div>` : ''}
      </form></div>`);
    protectVideo($('video', m.el));
    const recalc = () => { let t = 0; $$('[data-k]', m.el).forEach((i) => { t += Number(i.value) || 0; }); $('#tot', m.el).textContent = `${Math.round(t * 100) / 100} / ${maxT} (${Math.round((t / maxT) * 10000) / 100}%)`; };
    $$('[data-r]', m.el).forEach((r) => r.oninput = () => { $(`[data-k="${r.dataset.r}"]`, m.el).value = r.value; recalc(); });
    $$('[data-k]', m.el).forEach((k) => k.oninput = () => { const r = $(`[data-r="${k.dataset.k}"]`, m.el); if (r) r.value = k.value; recalc(); });
    recalc();
    const send = async (submit, btn) => {
      const scores = {}; $$('[data-k]', m.el).forEach((i) => { if (i.value !== '') scores[i.dataset.k] = Number(i.value); });
      if (submit && !confirm('بعد الاعتماد النهائي لا يمكنك تعديل هذا التقييم. متابعة؟')) return;
      setBusy(btn, true);
      try {
        await api('/api/judge/evaluations/' + cid, { method: 'PUT', body: { scores, notes: $('[name=notes]', m.el).value, submit } });
        toast(submit ? 'تم اعتماد التقييم' : 'تم حفظ المسودة', 'ok');
        m.close(); go('evals'); if (submit) setTimeout(() => openEval(cid), 400);
      } catch (e) { setBusy(btn, false); $('#ev-msg', m.el).innerHTML = alertBox('err', esc(e.message)); }
    };
    const sv = $('[data-save]', m.el); if (sv) sv.onclick = () => send(false, sv);
    const sb = $('[data-submit]', m.el); if (sb) sb.onclick = () => send(true, sb);
  }

  // ═══════════════ النتائج والاعتماد ═══════════════
  VIEWS.results = async () => {
    const r = await api('/api/admin/results');
    const L = r.live, snap = r.snapshot;
    const table = (res) => res.groups.map((g) => `<div class="box"><h2>${esc(g.name)} <span class="muted small">— مجموع الأصوات الصحيحة في الفئة: ${fmtNum(g.total_votes)}</span></h2>
      <div class="table-wrap"><table class="t"><thead><tr><th>المركز</th><th>رقم</th><th>المتسابق</th><th>الاسم الكامل</th>${res.mode !== 'judges' ? '<th>الأصوات</th>' : ''}${res.mode === 'mixed' ? '<th>نسبة التصويت</th>' : ''}${res.mode !== 'votes' ? '<th>التحكيم /100</th><th>تقييمات</th>' : ''}<th>النهائية</th><th>المعادلة</th></tr></thead>
      <tbody>${g.rows.map((x) => `<tr style="${x.winner ? 'background:#fbf6e6' : ''}"><td><span class="rank ${x.rank <= 3 ? 'r' + x.rank : ''}">${x.rank}</span>${x.tied ? ' <span class="tag flagged" title="تعادل تام بعد تطبيق قواعد التعادل">تعادل</span>' : ''}${x.winner ? ' <span class="tag valid">فائز</span>' : ''}</td>
        <td class="num">${x.entry_no}</td><td><b>${esc(x.display_name)}</b></td><td class="small">${esc(x.full_name)}</td>${res.mode !== 'judges' ? `<td class="num">${fmtNum(x.votes)}</td>` : ''}${res.mode === 'mixed' ? `<td class="num">${x.vote_pct}%</td>` : ''}
        ${res.mode !== 'votes' ? `<td class="num">${x.judge_pct ?? '—'}</td><td class="num">${x.judges_submitted}/${x.judges_required}${x.incomplete ? ' <span class="tag flagged">ناقص</span>' : ''}</td>` : ''}<td class="num"><b>${x.score}</b></td><td class="small" dir="ltr" style="text-align:right;white-space:nowrap">${esc(x.formula)}</td></tr>`).join('')}</tbody></table></div></div>`).join('') || '<p class="muted">لا توجد مشاركات معتمدة.</p>';
    main().innerHTML = head('النتائج والاعتماد', '<a class="btn btn-sm" href="/api/admin/export/results.xlsx">تصدير Excel</a><a class="btn btn-sm btn-outline" href="/api/admin/export/results.csv">CSV</a>') + `
      <div class="box"><div class="spread"><div>
        <b>الوضع:</b> ${MODE_AR[L.mode]}${L.mode === 'mixed' ? ` (${L.weights.judge}% تحكيم + ${L.weights.vote}% تصويت)` : ''} · <b>الفائزون:</b> ${L.winners_count} ${L.scope === 'category' ? 'لكل فئة' : 'على مستوى المدرسة'}
        <div class="small muted">${can('admin') ? '<a href="#settings">تعديل طريقة الاحتساب</a>' : ''}</div></div>
        <div class="gap-row">
          ${snap ? `<span class="tag valid">معتمدة ${fmtDate(snap.approved_at, true)}</span>` : '<span class="tag flagged">غير معتمدة</span>'}
          ${r.show_results ? '<span class="tag valid">معلنة للجمهور</span>' : '<span class="tag void" style="text-decoration:none">غير معلنة</span>'}
        </div></div>
        <details class="mt-1"><summary class="small" style="cursor:pointer;font-weight:700">المعادلة وقواعد التعادل</summary>
          <ul class="small">${L.formula.map((f) => `<li>${esc(f)}</li>`).join('')}</ul><b class="small">قواعد التعادل:</b><ol class="small">${L.tie_rules.map((t) => `<li>${esc(t)}</li>`).join('')}</ol></details>
      </div>
      <div class="box">
        <h2>الجاهزية للاعتماد</h2>
        ${L.ready ? alertBox('ok', 'جميع الشروط مستوفاة: يمكن اعتماد النتائج.') : alertBox('warn', '<b>لا يمكن الاعتماد بعد:</b><br>' + L.issues.map(esc).join('<br>'))}
        ${can('admin') ? `<div class="gap-row mt-2">
          <button class="btn" id="approve" ${L.ready ? '' : 'disabled'}>${snap ? 'إعادة اعتماد النتائج الحالية' : 'اعتماد النتائج'}</button>
          ${snap ? `<button class="btn ${r.show_results ? 'btn-outline' : 'btn-emerald'}" id="publish">${r.show_results ? 'إخفاء النتائج عن الجمهور' : 'إعلان النتائج للجمهور'}</button><button class="btn btn-outline" id="revoke" style="color:var(--danger);border-color:var(--danger)">إلغاء الاعتماد</button>` : ''}
        </div><p class="muted small">الاعتماد يحفظ لقطة ثابتة من النتائج؛ ما يُعلن للجمهور هو اللقطة المعتمدة وليس الاحتساب الحي.</p>` : ''}
      </div>
      <h2 style="font-family:var(--f-display);color:var(--em-900);margin:22px 0 10px">الاحتساب الحي</h2>${table(L)}
      ${snap ? `<h2 style="font-family:var(--f-display);color:var(--em-900);margin:22px 0 10px">اللقطة المعتمدة</h2>${table(snap.data)}` : ''}`;
    const ap = $('#approve'); if (ap) ap.onclick = async () => {
      if (!confirm('اعتماد النتائج بصورتها الحالية؟ سيُسجَّل ذلك باسمك.')) return;
      try { await api('/api/admin/results/approve', { method: 'POST', body: {} }); toast('تم اعتماد النتائج', 'ok'); go('results'); } catch (e) { toast(e.message, 'err'); }
    };
    const pb = $('#publish'); if (pb) pb.onclick = async () => {
      try { await api('/api/admin/results/publish', { method: 'POST', body: { publish: !r.show_results } }); toast(r.show_results ? 'أُخفيت النتائج' : 'أُعلنت النتائج للجمهور', 'ok'); cache.settings = null; go('results'); } catch (e) { toast(e.message, 'err'); }
    };
    const rv = $('#revoke'); if (rv) rv.onclick = async () => {
      if (!confirm('إلغاء اعتماد النتائج وإخفاؤها عن الجمهور؟')) return;
      try { await api('/api/admin/results/revoke', { method: 'POST', body: {} }); toast('أُلغي الاعتماد', 'ok'); cache.settings = null; go('results'); } catch (e) { toast(e.message, 'err'); }
    };
  };

  // ═══════════════ الإعدادات العامة ═══════════════
  VIEWS.settings = async () => {
    const s = await getSettings(true);
    const sw = (k, label) => `<label class="switch"><span>${label}</span><input type="checkbox" data-k="${k}" ${s[k] ? 'checked' : ''}></label>`;
    const sel = (k, opts) => `<select class="input" data-k="${k}">${opts.map(([v, l]) => `<option value="${v}" ${String(s[k]) === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    const modeSel = (k) => sel(k, [['auto', 'تلقائي حسب المواعيد'], ['open', 'مفتوح يدويًا'], ['closed', 'مغلق يدويًا']]);
    const dt = (k) => `<input class="input" type="datetime-local" data-k="${k}" data-dt value="${toLocalInput(s[k])}">`;
    const num = (k, min, max) => `<input class="input" type="number" min="${min}" max="${max}" data-k="${k}" data-num value="${s[k]}">`;
    const stageRow = (st) => `<div class="stage-edit" data-stage>
      <div class="field"><label class="small">عنوان المرحلة</label><input class="input" data-sf="title" value="${esc(st.title)}"></div>
      <div class="field"><label class="small">البداية</label><input class="input" type="datetime-local" data-sf="start" value="${toLocalInput(st.start)}"></div>
      <div class="field"><label class="small">النهاية</label><input class="input" type="datetime-local" data-sf="end" value="${toLocalInput(st.end)}"></div>
      <div class="field"><label class="small">الحالة</label><select class="input" data-sf="status">${[['auto', 'تلقائي'], ['upcoming', 'قادمة'], ['active', 'جارية'], ['done', 'منتهية']].map(([v, l]) => `<option value="${v}" ${st.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <button type="button" class="btn btn-sm btn-outline" data-del-row title="حذف">✕</button>
      <div class="field full"><input class="input" data-sf="description" value="${esc(st.description || '')}" placeholder="وصف مختصر"><input type="hidden" data-sf="id" value="${esc(st.id)}"></div></div>`;
    const critRow = (c) => `<div class="gap-row" data-crit style="margin-bottom:8px"><input class="input" data-cf="name" value="${esc(c.name)}" placeholder="اسم المعيار" style="flex:1"><input class="input num" type="number" data-cf="max" min="1" max="1000" value="${c.max}" style="width:100px"><input type="hidden" data-cf="id" value="${esc(c.id)}"><button type="button" class="btn btn-sm btn-outline" data-del-row>✕</button></div>`;
    const catRow = (c) => `<div class="stage-edit" data-cat style="grid-template-columns:1fr 2fr auto"><div class="field"><label class="small">اسم الفئة</label><input class="input" data-gf="name" value="${esc(c.name)}"><input type="hidden" data-gf="id" value="${esc(c.id)}"></div>
      <div class="field"><label class="small">الصفوف التابعة</label><div class="gap-row small">${s.grades.map((g) => `<label class="gap-row" style="gap:3px"><input type="checkbox" data-gg value="${esc(g)}" ${c.grades.includes(g) ? 'checked' : ''}>${esc(g)}</label>`).join('')}</div></div>
      <button type="button" class="btn btn-sm btn-outline" data-del-row>✕</button></div>`;
    main().innerHTML = head('الإعدادات العامة') + `
      <div class="box"><h2>هوية المسابقة</h2>
        <div class="form-grid">
          <div class="field"><label>اسم المدرسة</label><input class="input" data-k="school_name" value="${esc(s.school_name)}"></div>
          <div class="field"><label>اسم المسابقة</label><input class="input" data-k="competition_name" value="${esc(s.competition_name)}"></div>
          <div class="field full"><label>شعار المدرسة</label><div class="gap-row">${s.school_logo ? `<img src="/media/logo?v=${esc(s.school_logo.v)}" alt="" style="height:56px;border-radius:8px;border:1px solid var(--ivory-3);background:#fff;padding:3px">` : '<span class="muted small">لا يوجد شعار</span>'}
            <input type="file" id="logo" accept="image/png,image/jpeg,image/webp" class="input" style="max-width:280px">${s.school_logo ? '<button type="button" class="btn btn-sm btn-outline" id="logo-del">إزالة</button>' : ''}</div><div class="hint">PNG أو JPG أو WEBP حتى 1 م.ب. يظهر بجانب شعار المنصة في أعلى الموقع.</div></div>
          <div class="field full"><label>العنوان الفرعي في البانر</label><input class="input" data-k="hero_subtitle" value="${esc(s.hero_subtitle)}"></div>
          <div class="field full"><label>وصف المسابقة</label><textarea class="input" data-k="about_text">${esc(s.about_text)}</textarea></div>
          <div class="field"><label>رمز الموسم</label><input class="input" data-k="season" value="${esc(s.season)}"><div class="hint">تغييره يبدأ مسابقة جديدة فارغة (تبقى بيانات المواسم السابقة محفوظة).</div></div>
          <div class="field"><label>نص التذييل</label><input class="input" data-k="footer_note" value="${esc(s.footer_note)}"></div>
        </div></div>

      <div class="box"><h2>المواعيد</h2>
        <div class="settings-grid">
          <div class="field"><label>التسجيل</label>${modeSel('registration_mode')}</div>
          <div class="field"><label>بداية التسجيل</label>${dt('registration_start')}</div>
          <div class="field"><label>نهاية التسجيل</label>${dt('registration_end')}</div>
          <div class="field"><label>التصويت</label>${modeSel('voting_mode')}</div>
          <div class="field"><label>بداية التصويت</label>${dt('voting_start')}</div>
          <div class="field"><label>نهاية التصويت (إغلاق تلقائي)</label>${dt('voting_end')}</div>
        </div><p class="muted small">الأوقات بتوقيت جهازك الحالي.</p></div>

      <div class="box"><h2>مراحل المسابقة</h2><div id="stages">${(s.stages || []).map(stageRow).join('')}</div>
        <button type="button" class="btn btn-sm btn-outline" id="add-stage">+ إضافة مرحلة</button></div>

      <div class="box"><h2>الصفوف والفئات المشاركة</h2>
        <div class="form-grid">
          <div class="field"><label>الصفوف الدراسية (صف في كل سطر)</label><textarea class="input" data-k="grades" data-lines>${esc(s.grades.join('\n'))}</textarea></div>
          <div class="field"><label>الشعب (شعبة في كل سطر)</label><textarea class="input" data-k="sections" data-lines>${esc(s.sections.join('\n'))}</textarea></div>
        </div>
        <h2 class="mt-2" style="font-size:1.05rem">الفئات (تُحدَّد النتائج والفائزون لكل فئة)</h2>
        <div id="cats">${(s.categories || []).map(catRow).join('')}</div>
        <button type="button" class="btn btn-sm btn-outline" id="add-cat">+ إضافة فئة</button>
        <p class="muted small">بعد تعديل قائمة الصفوف احفظ أولًا ثم وزّعها على الفئات.</p></div>

      <div class="box"><h2>الفيديو والرفع</h2>
        <div class="settings-grid">
          <div class="field"><label>الحد الأقصى للحجم (م.ب)</label>${num('max_video_mb', 5, 2048)}</div>
          <div class="field"><label>الحد الأقصى للمدة (ثانية)</label>${num('max_video_seconds', 20, 3600)}</div>
          <div class="field"><label>الحد الأدنى للمدة (ثانية)</label>${num('min_video_seconds', 0, 600)}</div>
          <div class="field"><label>الصيغ المسموحة</label><div class="gap-row">${['mp4', 'mov', 'm4v', 'webm', 'mpeg', 'mpg', 'mp3'].map((f) => `<label class="gap-row small" style="gap:4px"><input type="checkbox" data-fmt="${f}" ${s.allowed_formats.includes(f) ? 'checked' : ''}> ${f.toUpperCase()}</label>`).join('')}</div></div>
          ${sw('allow_replace', 'السماح باستبدال الفيديو قبل الاعتماد')}
          ${sw('allow_resubmit_rejected', 'السماح بإعادة الرفع بعد الرفض')}
          ${sw('require_guardian_consent', 'إلزام إقرار موافقة ولي الأمر')}
        </div>
        <h2 class="mt-2" style="font-size:1.05rem">شروط المشاركة (شرط في كل سطر)</h2>
        <textarea class="input" data-k="terms" data-lines style="min-height:150px">${esc(s.terms.join('\n'))}</textarea>
        <h2 class="mt-2" style="font-size:1.05rem">أهداف المسابقة (هدف في كل سطر)</h2>
        <textarea class="input" data-k="goals" data-lines>${esc(s.goals.join('\n'))}</textarea></div>

      <div class="box"><h2>التصويت والتحقق من الهوية</h2>
        <div class="settings-grid">
          <div class="field"><label>طريقة التحقق من المصوّت</label>${sel('voter_auth', [['pin', 'الرقم المدرسي + رمز شخصي سري'], ['oidc', 'حساب المدرسة (Google / Microsoft)']])}<div class="hint">حساب المدرسة يتطلب ضبط متغيرات OIDC على الخادم (انظر الدليل).</div></div>
          ${sw('prevent_self_vote', 'منع الطالب من التصويت لنفسه')}
          ${sw('allow_vote_change', 'السماح بتعديل الصوت قبل إغلاق التصويت')}
          ${sw('vote_restrict_to_category', 'يصوّت الطالب لمتسابقي فئته فقط')}
        </div></div>

      <div class="box"><h2>لجنة التحكيم</h2>
        <div class="settings-grid">
          ${sw('judging_enabled', 'تفعيل نظام لجنة التحكيم')}
          <div class="field"><label>تكليف المحكّمين</label>${sel('judging_assignment', [['all', 'كل محكّم يقيّم جميع التلاوات'], ['manual', 'تكليف يدوي لكل محكّم']])}</div>
          <div class="field"><label>شرط اكتمال التحكيم</label>${sel('judging_completion', [['all_assigned', 'اعتماد جميع المحكّمين المكلّفين'], ['minimum', 'حد أدنى من التقييمات المعتمدة']])}</div>
          <div class="field"><label>الحد الأدنى للتقييمات</label>${num('min_judges_required', 1, 20)}</div>
        </div>
        <h2 class="mt-2" style="font-size:1.05rem">معايير التقييم ودرجاتها</h2>
        <div id="crits">${s.judging_criteria.map(critRow).join('')}</div>
        <div class="spread"><button type="button" class="btn btn-sm btn-outline" id="add-crit">+ إضافة معيار</button><b>الإجمالي: <span class="num" id="crit-total"></span></b></div></div>

      <div class="box"><h2>تحديد الفائزين</h2>
        <div class="settings-grid">
          <div class="field"><label>وضع النتائج</label>${sel('results_mode', [['mixed', 'مختلط (تحكيم + تصويت)'], ['judges', 'لجنة التحكيم فقط'], ['votes', 'تصويت الطلاب فقط']])}</div>
          <div class="field"><label>وزن لجنة التحكيم %</label>${num('judge_weight', 0, 100)}</div>
          <div class="field"><label>وزن تصويت الطلاب %</label>${num('vote_weight', 0, 100)}</div>
          <div class="field"><label>تحويل الأصوات إلى نسبة</label>${sel('vote_normalization', [['share', 'من مجموع أصوات الفئة'], ['top', 'نسبة إلى الأعلى أصواتًا في الفئة']])}<div class="hint">«من المجموع» هو المعتمد في الشروط. «نسبة إلى الأعلى» تعطي الأول 100% وتمنح التصويت أثرًا أوضح عند كثرة المتسابقين.</div></div>
          <div class="field"><label>نطاق الفائزين</label>${sel('winner_scope', [['category', 'فائزون لكل فئة'], ['school', 'على مستوى المدرسة']])}</div>
          <div class="field"><label>عدد الفائزين</label>${num('winners_count', 1, 20)}</div>
        </div></div>

      <div class="box"><h2>الخصوصية والنشر</h2>
        <div class="settings-grid">
          ${sw('show_class_publicly', 'إظهار الصف والشعبة للعامة')}
          ${sw('show_views', 'إظهار عدد المشاهدات')}
          ${sw('show_vote_counts', 'إظهار عدد الأصوات للعامة بعد إغلاق التصويت')}
          ${sw('certificates_enabled', 'إتاحة تنزيل الشهادات للطلاب')}
          <div class="field"><label>تفاصيل النتائج المعلنة للجمهور</label>${sel('public_results_detail', [['winners', 'الفائزون فقط دون أرقام (موصى به)'], ['winners_scores', 'الفائزون مع درجاتهم'], ['full', 'الترتيب الكامل بالأرقام']])}</div>
          <div class="field"><label>مدة الاحتفاظ بالمقاطع بعد التصويت (يوم)</label>${num('retention_days', 7, 3650)}</div>
        </div><p class="muted small">أعداد الأصوات مخفية دائمًا أثناء التصويت. لا تُعرض هويات المصوّتين للجمهور مطلقًا. إعلان النتائج يتم من تبويب «النتائج والاعتماد».</p>
        <div class="field mt-2"><label>نص إقرار موافقة ولي الأمر (يظهر في نموذج التسجيل)</label><textarea class="input" data-k="guardian_consent_text" style="min-height:70px">${esc(s.guardian_consent_text || '')}</textarea></div>
        <div class="field mt-1"><label>سياسة الخصوصية (بند في كل سطر — تظهر في صفحة «سياسة الخصوصية»)</label><textarea class="input" data-k="privacy_policy" data-lines style="min-height:160px">${esc((s.privacy_policy || []).join('\n'))}</textarea></div></div>
      <div class="save-bar"><span id="save-msg" class="muted small" style="margin-inline-end:auto;align-self:center"></span><button class="btn" id="save">حفظ جميع الإعدادات</button></div>`;
    const critTotal = () => { $('#crit-total').textContent = $$('[data-crit] [data-cf="max"]').reduce((a, i) => a + (Number(i.value) || 0), 0); };
    critTotal(); $('#crits').addEventListener('input', critTotal);
    ['#stages', '#crits', '#cats'].forEach((sel) => $(sel).addEventListener('click', (e) => { const b = e.target.closest('[data-del-row]'); if (b && confirm('حذف هذا العنصر؟')) { b.closest('[data-stage],[data-crit],[data-cat]').remove(); critTotal(); } }));
    $('#add-stage').onclick = () => $('#stages').insertAdjacentHTML('beforeend', stageRow({ id: 's' + Date.now().toString(36), title: 'مرحلة جديدة', status: 'auto' }));
    $('#add-crit').onclick = () => { $('#crits').insertAdjacentHTML('beforeend', critRow({ id: 'k' + Date.now().toString(36), name: '', max: 10 })); critTotal(); };
    $('#add-cat').onclick = () => $('#cats').insertAdjacentHTML('beforeend', catRow({ id: 'c' + Date.now().toString(36), name: 'فئة جديدة', grades: [] }));
    $('#logo').onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      if (f.size > 1048576) return toast('حجم الشعار أكبر من 1 م.ب', 'err');
      try {
        const res = await fetch('/api/admin/logo', { method: 'POST', headers: { 'X-CSRF-Token': csrf, 'Content-Type': 'application/octet-stream' }, body: f, credentials: 'same-origin' });
        const j = await res.json(); if (!res.ok) throw new Error(j.error);
        toast('تم تحديث الشعار', 'ok'); go('settings');
      } catch (err) { toast(err.message, 'err'); }
    };
    const ld = $('#logo-del'); if (ld) ld.onclick = async () => { try { await api('/api/admin/logo', { method: 'DELETE' }); go('settings'); } catch (e) { toast(e.message, 'err'); } };
    $('#save').onclick = async () => {
      const body = {};
      $$('[data-k]', main()).forEach((el) => {
        const k = el.dataset.k;
        if (el.type === 'checkbox') body[k] = el.checked;
        else if ('dt' in el.dataset) body[k] = fromLocalInput(el.value);
        else if ('num' in el.dataset) body[k] = Number(el.value);
        else if ('lines' in el.dataset) body[k] = el.value.split('\n').map((x) => x.trim()).filter(Boolean);
        else body[k] = el.value;
      });
      body.allowed_formats = $$('[data-fmt]:checked').map((c) => c.dataset.fmt);
      body.stages = $$('[data-stage]').map((row) => { const g = (f) => $(`[data-sf="${f}"]`, row).value; return { id: g('id'), title: g('title'), description: g('description'), start: fromLocalInput(g('start')), end: fromLocalInput(g('end')), status: g('status') }; });
      body.judging_criteria = $$('[data-crit]').map((row) => ({ id: $('[data-cf="id"]', row).value, name: $('[data-cf="name"]', row).value, max: Number($('[data-cf="max"]', row).value) }));
      body.categories = $$('[data-cat]').map((row) => ({ id: $('[data-gf="id"]', row).value, name: $('[data-gf="name"]', row).value, grades: $$('[data-gg]:checked', row).map((x) => x.value) }));
      if (body.results_mode === 'mixed' && body.judge_weight + body.vote_weight !== 100 && !confirm(`مجموع الأوزان ${body.judge_weight + body.vote_weight}% وليس 100%. ستُطبَّع الأوزان تلقائيًا. متابعة؟`)) return;
      const dupGrades = body.categories.flatMap((c) => c.grades).filter((g, i, a) => a.indexOf(g) !== i);
      if (dupGrades.length) return toast(`الصف «${dupGrades[0]}» موزّع على أكثر من فئة.`, 'err');
      if (body.season !== s.season && !confirm('تغيير رمز الموسم سيبدأ مسابقة جديدة ويُخفي المشاركات الحالية. هل أنت متأكد؟')) return;
      const b = $('#save'); setBusy(b, true, 'جارٍ الحفظ…');
      try { const r = await api('/api/admin/settings', { method: 'PUT', body }); cache.settings = r.settings; toast('تم حفظ الإعدادات', 'ok'); $('#save-msg').textContent = 'آخر حفظ: ' + new Date().toLocaleTimeString('ar-u-nu-latn'); }
      catch (e) { toast(e.message, 'err'); }
      finally { setBusy(b, false); }
    };
  };

  // ═══════════════ المشرفون والمحكّمون ═══════════════
  VIEWS.admins = async () => {
    const r = await api('/api/admin/admins');
    main().innerHTML = head('المشرفون والمحكّمون') + `
      <div class="box"><h2>إضافة حساب</h2>
        <form id="add" class="settings-grid" autocomplete="off">
          <div class="field"><label>اسم المستخدم (لاتيني)</label><input class="input" name="username" dir="ltr" required></div>
          <div class="field"><label>الاسم الظاهر</label><input class="input" name="display_name"></div>
          <div class="field"><label>كلمة المرور</label><input class="input" name="password" type="password" dir="ltr" autocomplete="new-password" required><div class="hint">10 أحرف على الأقل، أحرف وأرقام.</div></div>
          <div class="field"><label>الصلاحية</label><select class="input" name="role"><option value="judge">محكّم — تقييم التلاوات المكلَّف بها فقط</option><option value="reviewer">مراجع — مراجعة المشاركات</option>${me.role === 'owner' ? '<option value="admin">مدير — إدارة كاملة عدا المالك</option>' : ''}</select></div>
          <div><button class="btn btn-sm" type="submit">إضافة</button></div>
        </form></div>
      <div class="box"><h2>الصلاحيات</h2><ul class="small" style="margin:0;padding-inline-start:18px">
        <li><b>المالك</b>: كل الصلاحيات، ومنح صلاحية «إدارة الأصوات».</li>
        <li><b>المدير</b>: الإعدادات، التصويت، الطلاب المؤهلون، النتائج، الاستبعاد، التصدير. لا يعدّل الأصوات إلا بصلاحية «إدارة الأصوات».</li>
        <li><b>المراجع</b>: مراجعة المشاركات واعتمادها أو رفضها، ومتابعة التحكيم والنتائج.</li>
        <li><b>المحكّم</b>: يرى التلاوات المكلَّف بها فقط ويقيّمها، دون أي بيانات شخصية.</li></ul></div>
      <div class="box"><h2>الحسابات</h2><div class="table-wrap"><table class="t"><thead><tr><th>المستخدم</th><th>الاسم</th><th>الصلاحية</th><th>إدارة الأصوات</th><th>الحالة</th><th>آخر دخول</th><th></th></tr></thead>
      <tbody>${r.items.map((a) => `<tr><td dir="ltr" style="text-align:right">${esc(a.username)}</td><td>${esc(a.display_name)}</td>
        <td>${me.role === 'owner' && a.role !== 'owner' ? `<select class="input" data-role="${a.id}" style="padding:6px 10px;width:auto">${['judge', 'reviewer', 'admin'].map((x) => `<option value="${x}" ${a.role === x ? 'selected' : ''}>${ROLE_AR[x]}</option>`).join('')}</select>` : ROLE_AR[a.role]}</td>
        <td>${a.role === 'owner' ? '✓' : a.role === 'admin' && me.role === 'owner' ? `<input type="checkbox" data-cmv="${a.id}" ${a.can_manage_votes ? 'checked' : ''}>` : a.can_manage_votes ? '✓' : '—'}</td>
        <td>${a.active ? '<span class="tag valid">نشط</span>' : '<span class="tag void">معطّل</span>'}</td><td class="small">${a.last_login_at ? fmtDate(a.last_login_at, true) : '—'}</td>
        <td class="gap-row">${a.role !== 'owner' && a.id !== me.id ? `<button class="btn btn-sm btn-outline" data-toggle="${a.id}" data-active="${a.active}">${a.active ? 'تعطيل' : 'تفعيل'}</button>` : ''}
        ${a.role !== 'owner' || me.role === 'owner' ? `<button class="btn btn-sm btn-outline" data-pw="${a.id}">كلمة مرور جديدة</button>` : ''}</td></tr>`).join('')}</tbody></table></div></div>`;
    const patch = async (id, body, msg) => { try { await api('/api/admin/admins/' + id, { method: 'PATCH', body }); toast(msg || 'تم التحديث', 'ok'); go('admins'); } catch (e) { toast(e.message, 'err'); go('admins'); } };
    $('#add').onsubmit = async (e) => {
      e.preventDefault(); const f = e.target.elements;
      try { await api('/api/admin/admins', { method: 'POST', body: { username: f.username.value.trim(), display_name: f.display_name.value.trim(), password: f.password.value, role: f.role.value } }); toast('تمت إضافة الحساب', 'ok'); go('admins'); }
      catch (err) { toast(err.message, 'err'); }
    };
    $$('[data-toggle]').forEach((b) => b.onclick = () => patch(b.dataset.toggle, { active: b.dataset.active !== '1' }));
    $$('[data-role]').forEach((s) => s.onchange = () => patch(s.dataset.role, { role: s.value }, 'تم تغيير الصلاحية'));
    $$('[data-cmv]').forEach((c) => c.onchange = () => { if (c.checked && !confirm('منح صلاحية إدارة الأصوات (كشف هوية المصوّتين وتعديل الأصوات)؟')) { c.checked = false; return; } patch(c.dataset.cmv, { can_manage_votes: c.checked }); });
    $$('[data-pw]').forEach((b) => b.onclick = async () => { const p = prompt('كلمة المرور الجديدة (10 أحرف على الأقل، أحرف وأرقام):'); if (p) patch(b.dataset.pw, { password: p }, 'تم تغيير كلمة المرور'); });
  };

  // ═══════════════ الخصوصية وإدارة البيانات ═══════════════
  VIEWS.data = async () => {
    const d = await api('/api/admin/data');
    const ST = { draft: 'مسودات', pending: 'بانتظار المراجعة', approved: 'معتمدة', rejected: 'مرفوضة', disqualified: 'مستبعدة', archived: 'مؤرشفة' };
    const total = d.by_status.reduce((a, x) => a + x.bytes, 0);
    main().innerHTML = head('الخصوصية وإدارة البيانات') + `
      ${alertBox('info', 'المنصة تخدم طلابًا قاصرين: احذف ما لا يلزم من بيانات بعد انتهاء المسابقة، والتزم بالمدة المعلنة في <a href="/privacy" target="_blank">سياسة الخصوصية</a>. كل عملية حذف نهائية وتُسجَّل في سجل العمليات.')}
      ${d.retention_passed ? alertBox('warn', `انتهت مدة الاحتفاظ المعلنة (${d.retention_days} يومًا بعد التصويت) في ${fmtDate(d.retention_due)}.`) : d.retention_due ? `<p class="muted small mt-1">موعد انتهاء الاحتفاظ بالمقاطع: <b>${fmtDate(d.retention_due)}</b> (${d.retention_days} يومًا بعد نهاية التصويت).</p>` : ''}
      <div class="box mt-2"><h2>محتوى الموسم الحالي (${esc(d.season)})</h2>
        <div class="table-wrap"><table class="t"><thead><tr><th>الحالة</th><th>المشاركات</th><th>مقاطع مخزّنة</th><th>الحجم</th></tr></thead>
        <tbody>${d.by_status.map((x) => `<tr><td>${ST[x.status] || x.status}</td><td class="num">${fmtNum(x.n)}</td><td class="num">${fmtNum(x.videos)}</td><td class="num">${fmtBytes(x.bytes)}</td></tr>`).join('') || '<tr><td colspan="4" class="center muted">لا توجد بيانات.</td></tr>'}
        <tr><td><b>الإجمالي</b></td><td></td><td></td><td class="num"><b>${fmtBytes(total)}</b></td></tr></tbody></table></div></div>
      <div class="two">
        <div class="box"><h2>تنظيف دوري</h2>
          <div class="bars">
            <div class="spread"><span>حذف مقاطع المشاركات المرفوضة والمستبعدة (تبقى السجلات)</span><button class="btn btn-sm btn-outline" data-purge="rejected_videos">تنفيذ</button></div>
            <div class="spread"><span>حذف التسجيلات المهجورة بلا فيديو (أقدم من 14 يومًا): <b class="num">${d.stale_drafts}</b></span><button class="btn btn-sm btn-outline" data-purge="stale_drafts">تنفيذ</button></div>
            <div class="spread"><span>حذف سجلات محاولات التصويت الأقدم من 90 يومًا</span><button class="btn btn-sm btn-outline" data-purge="old_attempts">تنفيذ</button></div>
          </div></div>
        <div class="box"><h2>بعد انتهاء المسابقة</h2>
          <p class="small muted">أرشفة الموسم: تُحذف المقاطع من التخزين وتبقى أسماء المشاركين والنتائج المعتمدة والشهادات للتحقق.</p>
          <label class="gap-row small"><input type="checkbox" id="keepw" ${d.has_snapshot ? 'checked' : 'disabled'}> الإبقاء على تلاوات الفائزين${d.has_snapshot ? '' : ' (يتطلب نتائج معتمدة)'}</label>
          <button class="btn btn-sm btn-danger mt-1" data-purge="archive_videos">أرشفة مقاطع الموسم ${esc(d.season)}</button>
        </div>
      </div>
      <div class="box"><h2>جميع المواسم</h2>
        <div class="table-wrap"><table class="t"><thead><tr><th>الموسم</th><th>المشاركات</th><th>المقاطع</th><th>الحجم</th><th>الطلاب المؤهلون</th><th>الأصوات</th><th></th></tr></thead>
        <tbody>${d.seasons.map((x) => `<tr><td><b>${esc(x.season)}</b>${x.season === d.season ? ' <span class="tag valid">الحالي</span>' : ''}</td><td class="num">${fmtNum(x.contestants)}</td><td class="num">${fmtNum(x.videos)}</td><td class="num">${fmtBytes(x.bytes)}</td><td class="num">${fmtNum(x.students)}</td><td class="num">${fmtNum(x.votes)}</td>
          <td>${me.role === 'owner' ? `<button class="btn btn-sm btn-outline" style="color:var(--danger);border-color:var(--danger)" data-wipe="${esc(x.season)}">حذف الموسم بالكامل</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="center muted">لا توجد مواسم.</td></tr>'}</tbody></table></div>
        <p class="muted small">«حذف الموسم بالكامل» يحذف المشاركات والمقاطع والطلاب والأصوات والتقييمات والنتائج والشهادات لهذا الموسم نهائيًا (للمالك فقط). صدّر ما تحتاجه أولًا.</p></div>
      <div id="purge-msg"></div>`;
    const run = async (body, label) => {
      try { const r = await api('/api/admin/data/purge', { method: 'POST', body }); toast(`${label}: ${JSON.stringify(r.summary)}`, 'ok'); go('data'); }
      catch (e) { toast(e.message, 'err'); }
    };
    $$('[data-purge]').forEach((b) => b.onclick = () => {
      const action = b.dataset.purge;
      if (action === 'archive_videos') {
        const c = prompt(`للتأكيد اكتب رمز الموسم (${d.season}). ستُحذف المقاطع نهائيًا من التخزين.`);
        if (c !== d.season) return;
        return run({ action, season: d.season, confirm: c, keep_winners: $('#keepw').checked }, 'تمت الأرشفة');
      }
      if (!confirm('تنفيذ عملية الحذف؟ لا يمكن التراجع.')) return;
      run({ action, season: d.season }, 'تم');
    });
    $$('[data-wipe]').forEach((b) => b.onclick = () => {
      const c = prompt(`حذف نهائي لكل بيانات الموسم ${b.dataset.wipe}. للتأكيد اكتب رمز الموسم:`);
      if (c !== b.dataset.wipe) return;
      run({ action: 'season_all', season: c, confirm: c }, 'حُذف الموسم');
    });
  };

  // ═══════════════ سجل العمليات ═══════════════
  const ACT = { login: 'تسجيل دخول', lockout: 'قفل حساب مشرف', approve: 'اعتماد مشاركة', reject: 'رفض مشاركة', unpublish: 'إلغاء نشر', disqualify: 'استبعاد متسابق', reinstate: 'إلغاء استبعاد', contestant_edit: 'تعديل مشاركة', contestant_delete: 'حذف مشاركة', reset_token: 'إعادة إصدار رمز متابعة', settings_update: 'تحديث الإعدادات', vote_valid: 'استعادة صوت', vote_void: 'إلغاء صوت', voting_open: 'فتح التصويت يدويًا', voting_closed: 'إغلاق التصويت يدويًا', voting_auto: 'التصويت حسب المواعيد', students_import: 'استيراد الطلاب', student_add: 'إضافة طالب', student_update: 'تعديل طالب', student_delete: 'حذف طالب', pins_issue: 'إصدار رموز شخصية', judge_assign: 'تكليف محكّم', evaluation_submit: 'اعتماد تقييم', evaluation_reopen: 'إعادة فتح تقييم', results_approve: 'اعتماد النتائج', results_revoke: 'إلغاء اعتماد النتائج', results_publish: 'إعلان النتائج', results_hide: 'إخفاء النتائج', logo_update: 'تحديث الشعار', logo_remove: 'إزالة الشعار', admin_create: 'إضافة حساب', admin_update: 'تعديل حساب', password_change: 'تغيير كلمة المرور', export_contestants: 'تصدير المتسابقين', export_results: 'تصدير النتائج', export_students: 'تصدير الطلاب', bootstrap_owner: 'إنشاء المالك', certificate_issue: 'إصدار شهادة', video_delete: 'حذف فيديو', data_purge: 'حذف بيانات' };
  VIEWS.audit = async () => {
    const r = await api('/api/admin/audit');
    main().innerHTML = head('سجل العمليات') + `<div class="table-wrap"><table class="t"><thead><tr><th>الوقت</th><th>المشرف</th><th>العملية</th><th>الهدف</th><th>تفاصيل</th></tr></thead>
      <tbody>${r.items.map((l) => `<tr><td class="small">${fmtDate(l.created_at, true)}</td><td>${esc(l.admin_name || '—')}</td><td>${esc(ACT[l.action] || l.action)}</td><td class="num">${esc(l.target || '')}</td><td class="small" style="max-width:340px;word-break:break-word">${esc(l.details || '')}</td></tr>`).join('')}</tbody></table></div>`;
  };

  // ═══════════════ حسابي ═══════════════
  VIEWS.account = async () => {
    main().innerHTML = head('حسابي') + `<div class="box" style="max-width:520px"><h2>تغيير كلمة المرور</h2>
      <form id="pw" class="form-grid" style="grid-template-columns:1fr">
        <div class="field"><label>كلمة المرور الحالية</label><input class="input" type="password" name="current" dir="ltr" autocomplete="current-password" required></div>
        <div class="field"><label>كلمة المرور الجديدة</label><input class="input" type="password" name="next" dir="ltr" autocomplete="new-password" required></div>
        <div class="field"><label>تأكيد كلمة المرور الجديدة</label><input class="input" type="password" name="again" dir="ltr" autocomplete="new-password" required></div>
        <div><button class="btn btn-sm" type="submit">تغيير</button></div></form></div>`;
    $('#pw').onsubmit = async (e) => {
      e.preventDefault(); const f = e.target.elements;
      if (f.next.value !== f.again.value) return toast('كلمتا المرور غير متطابقتين', 'err');
      try { await api('/api/admin/password', { method: 'POST', body: { current: f.current.value, next: f.next.value } }); toast('تم تغيير كلمة المرور', 'ok'); e.target.reset(); }
      catch (err) { toast(err.message, 'err'); }
    };
  };

  document.addEventListener('DOMContentLoaded', boot);
})();
