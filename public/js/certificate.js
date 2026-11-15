/* إصدار شهادات المشاركة والفوز بصيغة PDF في المتصفح (رسم على Canvas ثم تغليفه في ملف PDF حقيقي) */
(function () {
  'use strict';
  const W = 2480, H = 1754; // A4 أفقي ≈ 212 نقطة/بوصة
  const RANK_AR = ['', 'الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 'السادس', 'السابع', 'الثامن', 'التاسع', 'العاشر'];
  const MEDAL = { 1: ['#fff3c4', '#d9b252', '#9c7a2b'], 2: ['#ffffff', '#c9ced3', '#868e96'], 3: ['#ffe1c2', '#c98a55', '#8a5326'] };

  const loadImg = (src) => new Promise((res) => { if (!src) return res(null); const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });

  function star(ctx, x, y, r, fill) {
    ctx.save(); ctx.translate(x, y); ctx.fillStyle = fill;
    for (const rot of [0, Math.PI / 4]) { ctx.save(); ctx.rotate(rot); ctx.fillRect(-r / 2, -r / 2, r, r); ctx.restore(); }
    ctx.restore();
  }

  function fitText(ctx, text, maxW, size, weight, family) {
    let s = size;
    do { ctx.font = `${weight} ${s}px ${family}`; s -= 4; } while (ctx.measureText(text).width > maxW && s > 30);
  }

  async function render(cert) {
    try { await Promise.all([document.fonts.load('700 90px "Reem Kufi"'), document.fonts.load('700 90px "Amiri"'), document.fonts.load('500 40px "Tajawal"')]); } catch {}
    const cfg = await window.Q.config().catch(() => ({}));
    const [logo, school, pattern] = await Promise.all([loadImg('/img/logo.svg'), loadImg(cfg.logo), loadImg('/img/pattern.svg')]);
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    const win = cert.type === 'winner';
    const DISPLAY = '"Reem Kufi", "Amiri", serif', QURAN = '"Amiri", "Traditional Arabic", serif', BODY = '"Tajawal", "Segoe UI", Tahoma, sans-serif';

    // الخلفية
    const g = ctx.createRadialGradient(W / 2, H / 2, 100, W / 2, H / 2, W * 0.7);
    g.addColorStop(0, '#fffdf6'); g.addColorStop(1, '#f1e6c9');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    if (pattern) { ctx.save(); ctx.globalAlpha = 0.07; const p = ctx.createPattern(pattern, 'repeat'); ctx.fillStyle = p; ctx.fillRect(0, 0, W, H); ctx.restore(); }
    // الإطارات
    ctx.fillStyle = '#052e23'; ctx.fillRect(0, 0, W, 70); ctx.fillRect(0, H - 70, W, 70); ctx.fillRect(0, 0, 70, H); ctx.fillRect(W - 70, 0, 70, H);
    const gold = ctx.createLinearGradient(0, 0, W, H); gold.addColorStop(0, '#f1dc9c'); gold.addColorStop(0.5, '#c9a44c'); gold.addColorStop(1, '#9c7a2b');
    ctx.strokeStyle = gold; ctx.lineWidth = 14; ctx.strokeRect(95, 95, W - 190, H - 190);
    ctx.lineWidth = 3; ctx.strokeRect(125, 125, W - 250, H - 250);
    for (const [x, y] of [[125, 125], [W - 125, 125], [125, H - 125], [W - 125, H - 125]]) { star(ctx, x, y, 58, '#c9a44c'); star(ctx, x, y, 30, '#052e23'); }

    ctx.direction = 'rtl'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    // الشعارات
    if (logo) ctx.drawImage(logo, W / 2 - 85, 175, 170, 170);
    if (school) { const h = 150, w = Math.min(320, (school.width / school.height) * h); ctx.drawImage(school, 230, 185, w, h); }
    ctx.fillStyle = '#9c7a2b'; ctx.font = `400 46px ${QURAN}`;
    ctx.fillText('بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ', W / 2, 420);

    // العنوان
    ctx.fillStyle = '#052e23'; ctx.font = `700 150px ${DISPLAY}`;
    ctx.fillText(win ? 'شهادة تفوّق' : 'شهادة مشاركة', W / 2, 600);
    ctx.fillStyle = '#4b5a52'; ctx.font = `500 50px ${BODY}`;
    ctx.fillText(`${cert.competition_name || 'مسابقة قارئ المدرسة'}${cert.school_name ? ' — ' + cert.school_name : ''}`, W / 2, 690);

    // الفاصل
    ctx.strokeStyle = gold; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(W / 2 - 420, 745); ctx.lineTo(W / 2 - 40, 745); ctx.moveTo(W / 2 + 40, 745); ctx.lineTo(W / 2 + 420, 745); ctx.stroke();
    star(ctx, W / 2, 745, 34, '#c9a44c');

    ctx.fillStyle = '#1b2620'; ctx.font = `500 56px ${BODY}`;
    ctx.fillText('تمنح لجنة المسابقة هذه الشهادة إلى', W / 2, 860);
    ctx.fillStyle = '#0a4636'; fitText(ctx, cert.full_name, W - 900, 135, 700, QURAN);
    ctx.fillText(cert.full_name, W / 2, 1030);
    ctx.fillStyle = '#4b5a52'; ctx.font = `500 48px ${BODY}`;
    ctx.fillText([cert.grade, cert.section ? `شعبة ${cert.section}` : ''].filter(Boolean).join(' · '), W / 2, 1110);

    ctx.fillStyle = '#1b2620'; ctx.font = `500 58px ${BODY}`;
    const line = win
      ? `تقديرًا لتحقيق المركز ${RANK_AR[cert.rank] || cert.rank} في ${cert.category || 'المسابقة'}`
      : 'تقديرًا للمشاركة المتميزة في المسابقة';
    ctx.fillText(line, W / 2, 1230);
    ctx.fillStyle = '#9c7a2b'; fitText(ctx, `بتلاوة: ${cert.title}`, W - 1000, 62, 400, QURAN);
    ctx.fillText(`بتلاوة: ${cert.title}`, W / 2, 1320);
    ctx.fillStyle = '#4b5a52'; ctx.font = `400 44px ${QURAN}`;
    ctx.fillText('سائلين الله أن يجعله من أهل القرآن الذين هم أهل الله وخاصّته', W / 2, 1400);

    // الوسام للفائزين
    if (win) {
      const [c1, c2, c3] = MEDAL[Math.min(cert.rank, 3)] || MEDAL[3];
      const mx = 430, my = 1260;
      ctx.fillStyle = '#0a4636'; ctx.beginPath(); ctx.moveTo(mx - 70, my - 200); ctx.lineTo(mx - 10, my - 40); ctx.lineTo(mx - 120, my - 60); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(mx + 70, my - 200); ctx.lineTo(mx + 10, my - 40); ctx.lineTo(mx + 120, my - 60); ctx.closePath(); ctx.fill();
      const mg = ctx.createRadialGradient(mx - 40, my - 40, 10, mx, my, 150); mg.addColorStop(0, c1); mg.addColorStop(0.6, c2); mg.addColorStop(1, c3);
      ctx.fillStyle = mg; ctx.beginPath(); ctx.arc(mx, my, 135, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = c3; ctx.lineWidth = 6; ctx.beginPath(); ctx.arc(mx, my, 112, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#052e23'; ctx.font = `700 120px ${DISPLAY}`; ctx.textBaseline = 'middle'; ctx.fillText(String(cert.rank), mx, my + 8); ctx.textBaseline = 'alphabetic';
    }

    // التوقيعات والتاريخ والتحقق
    ctx.fillStyle = '#1b2620'; ctx.font = `700 44px ${BODY}`;
    const sigY = 1545;
    for (const [x, label] of [[W - 560, 'رئيس لجنة المسابقة'], [560, 'مدير المدرسة']]) {
      ctx.strokeStyle = '#9c7a2b'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x - 230, sigY - 70); ctx.lineTo(x + 230, sigY - 70); ctx.stroke();
      ctx.fillText(label, x, sigY);
    }
    ctx.font = `500 38px ${BODY}`; ctx.fillStyle = '#4b5a52';
    ctx.fillText(`حُرِّرت في ${new Date(cert.issued_at).toLocaleDateString('ar-u-nu-latn', { day: 'numeric', month: 'long', year: 'numeric' })}`, W / 2, 1500);
    ctx.font = '500 34px ui-monospace, Menlo, monospace'; ctx.direction = 'ltr';
    ctx.fillText(`${cert.code}  ·  ${(cert.verify_url && cert.verify_url.startsWith('http') ? cert.verify_url : location.origin + '/verify?c=' + cert.code)}`, W / 2, 1572);
    ctx.direction = 'rtl'; ctx.font = `500 32px ${BODY}`;
    ctx.fillText('رمز التحقق من صحة الشهادة', W / 2, 1620);
    return cv;
  }

  // ———— كاتب PDF بسيط: صفحة A4 أفقية تحتوي صورة JPEG ————
  async function canvasToPdf(cv) {
    const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.92));
    const jpg = new Uint8Array(await blob.arrayBuffer());
    const enc = new TextEncoder();
    const PW = 842, PH = 595;
    const parts = []; const offsets = []; let len = 0;
    const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
    const obj = (n, body) => { offsets[n] = len; push(`${n} 0 obj\n`); body(); push('\nendobj\n'); };
    push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'.replace(/[\u0080-ÿ]/g, 'x'));
    const content = `q ${PW} 0 0 ${PH} 0 0 cm /Im0 Do Q`;
    obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
    obj(2, () => push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'));
    obj(3, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`));
    obj(4, () => { push(`<< /Type /XObject /Subtype /Image /Width ${cv.width} /Height ${cv.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`); push(jpg); push('\nendstream'); });
    obj(5, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
    obj(6, () => push('<< /Title (Qari Almadrasa Certificate) /Producer (Qari Almadrasa) >>'));
    const xref = len;
    push(`xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF`);
    return new Blob(parts, { type: 'application/pdf' });
  }

  async function download(cert) {
    const cv = await render(cert);
    const pdf = await canvasToPdf(cv);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(pdf);
    a.download = `${cert.type === 'winner' ? 'certificate-winner' : 'certificate'}-${cert.entry_no}.pdf`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return cv;
  }

  async function preview(cert) { const cv = await render(cert); return cv.toDataURL('image/jpeg', 0.8); }

  window.QCert = { render, download, preview, canvasToPdf };
})();
