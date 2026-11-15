(function () {
  'use strict';
  const { api, esc, $, ICONS, fmtNum, fmtDate, alertBox, reveal, toast } = window.Q;
  let cfg, timer;

  function banner() {
    const b = $('#vote-banner');
    const me = window.QCards.state.me;
    let html;
    if (cfg.voting.open) {
      let who = '';
      if (me.authenticated) {
        who = `<div class="voter-bar mt-1"><span>مرحبًا <b>${esc(me.student.first_name)}</b> (${esc(me.student.grade)})${me.voted ? ` — صوتك مسجّل للقارئ <b>${esc(me.voted.name)}</b> <span class="num">#${me.voted.entry_no}</span>${me.allow_change ? '، ويمكنك نقله قبل إغلاق التصويت' : ''}.` : ' — لم تصوّت بعد.'}</span>
          <button class="btn btn-sm btn-outline" data-logout>خروج</button></div>`;
      } else {
        who = `<div class="voter-bar mt-1"><span>التصويت لطلاب المدرسة المسجلين فقط، ولكل طالب صوت واحد.</span><button class="btn btn-sm" data-login>التحقق من هويتي للتصويت</button></div>`;
      }
      html = alertBox('ok', `<b>التصويت مفتوح الآن</b> حتى ${fmtDate(cfg.voting.end, true)}.${me.restrict_category ? ' يصوّت كل طالب لمتسابقي فئته.' : ''}${who}`);
    } else if (cfg.voting.start && Date.parse(cfg.voting.start) > Date.now() && cfg.voting.mode === 'auto') {
      html = alertBox('info', `يبدأ تصويت الطلاب في <b>${fmtDate(cfg.voting.start, true)}</b>. يمكنك الاستماع إلى التلاوات الآن.`);
    } else {
      html = alertBox('info', `التصويت مغلق حاليًا.${cfg.results_published ? ' <a href="/results">اطّلع على النتائج المعلنة</a>.' : ''}`);
    }
    b.innerHTML = html;
    b.style.marginBottom = '16px';
  }

  async function load() {
    const grid = $('#grid');
    const p = new URLSearchParams({ q: $('#q').value.trim(), grade: $('#grade').value, sort: $('#sort').value, limit: 200 });
    try {
      let { items } = await api('/api/public/contestants?' + p);
      const cat = $('#cat') && $('#cat').value;
      if (cat) items = items.filter((i) => i.category_id === cat);
      $('#count').textContent = items.length ? `عدد التلاوات: ${fmtNum(items.length)}` : '';
      grid.innerHTML = items.length ? items.map(window.QCards.card).join('')
        : `<div class="empty" style="grid-column:1/-1"><img src="/img/avatar.svg" alt=""><p>${p.get('q') || p.get('grade') || cat ? 'لا توجد نتائج مطابقة لبحثك.' : 'لم تُنشر أي تلاوة بعد. ستظهر هنا فور اعتمادها.'}</p></div>`;
      reveal();
    } catch (e) { grid.innerHTML = alertBox('err', esc(e.message)); }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    $('[data-icon="search"]').innerHTML = ICONS.search;
    try { cfg = await window.Q.config(); } catch (e) { $('#grid').innerHTML = alertBox('err', esc(e.message)); return; }
    if (cfg.show_class) {
      $('#grade').innerHTML += cfg.grades.map((g) => `<option>${esc(g)}</option>`).join('');
      if (cfg.categories.length > 1) {
        const sel = document.createElement('select');
        sel.id = 'cat'; sel.className = 'input'; sel.setAttribute('aria-label', 'الفئة');
        sel.innerHTML = '<option value="">جميع الفئات</option>' + cfg.categories.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
        $('#grade').parentElement.before(Object.assign(document.createElement('div'), { className: 'cat-wrap' }));
        $('.cat-wrap').appendChild(sel);
        $('.toolbar').style.gridTemplateColumns = window.matchMedia('(max-width:760px)').matches ? '' : '1fr 190px 190px 220px';
        sel.addEventListener('change', load);
      }
    } else $('#grade').parentElement.remove();
    if (cfg.voting.open) $('#vote-hint').textContent = '، وصوّت لأجمل الأصوات.';
    await window.QCards.init(cfg);
    banner();
    document.addEventListener('q:me', banner);
    $('#vote-banner').addEventListener('click', (e) => {
      if (e.target.closest('[data-login]')) window.QCards.login();
      if (e.target.closest('[data-logout]')) window.QCards.logout();
    });
    window.QCards.bind($('#grid'));
    $('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 300); });
    $('#grade').addEventListener('change', load);
    $('#sort').addEventListener('change', load);
    await load();
    const params = new URLSearchParams(location.search);
    if (params.get('login_error')) toast(params.get('login_error'), 'err');
    const e = Number(params.get('e'));
    if (e) {
      if (!window.QCards.state.items.has(e)) {
        try { const c = await api(`/api/public/contestants/${e}`); window.QCards.state.items.set(c.entry_no, c); } catch { return; }
      }
      window.QCards.openPlayer(e);
    }
  });
})();
