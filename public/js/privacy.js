(function () {
  'use strict';
  const { esc, $, alertBox, fmtDate } = window.Q;
  document.addEventListener('DOMContentLoaded', async () => {
    try {
      const c = await window.Q.config();
      $('#policy').innerHTML = (c.privacy_policy || []).map((p) => `<li>${esc(p)}</li>`).join('');
      const end = Date.parse(c.voting.end);
      $('#retention').innerHTML = alertBox('info', `<b>مدة الاحتفاظ بالمقاطع:</b> تُحتفظ بمقاطع التلاوة مدة <b>${c.retention_days} يومًا</b> بعد انتهاء التصويت${isNaN(end) ? '' : ` (أي حتى ${fmtDate(new Date(end + c.retention_days * 86400000).toISOString())} تقريبًا)`}، ثم تُحذف أو تُؤرشف، مع إمكانية الإبقاء على تلاوات الفائزين بموافقة أولياء الأمور. يمكن طلب الحذف المبكر في أي وقت عبر لجنة المسابقة.`);
    } catch (e) { $('#policy').innerHTML = alertBox('err', esc(e.message)); }
  });
})();
