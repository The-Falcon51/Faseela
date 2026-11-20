// Password recovery page logic (no inline script; CSP script-src 'self').
// The Supabase recovery link signs the user in with a short-lived recovery session (PKCE code
// exchanged by supabase-client.mjs); this page then sets the new password.
const form = document.getElementById('form');
const status = document.getElementById('status');
const pw1 = document.getElementById('pw1');
const pw2 = document.getElementById('pw2');
const save = document.getElementById('save');

function show(kind, text) {
  status.dataset.kind = kind;
  status.textContent = text;
}

function backend() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (window.FaseelaBackend) return resolve(window.FaseelaBackend);
      if (Date.now() - started > 8000) return reject(new Error('backend unavailable'));
      return setTimeout(tick, 50);
    };
    tick();
  });
}

// The form opens only for a recovery session: the client stores a marker on PASSWORD_RECOVERY, or the
// recovery link itself carries type=recovery. An ordinary signed-in session must not change the password here
// (audit run-1 lead: password change without re-authentication).
function isRecoveryContext() {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  const query = new URLSearchParams(location.search);
  if (hash.get('type') === 'recovery' || query.get('type') === 'recovery') return true;
  try {
    const marker = Number(sessionStorage.getItem('faseela_recovery') || 0);
    return marker > 0 && Date.now() - marker < 15 * 60 * 1000;
  } catch { return false; }
}

let ready = false;
window.addEventListener('faseela-auth-state', (event) => {
  if (event.detail && !ready && !isRecoveryContext()) {
    ready = true;
    show('error', 'هذه الصفحة تعمل فقط عبر رابط استعادة كلمة المرور. اطلب رابطاً جديداً من شاشة الدخول. · This page only works from a password-recovery link. Request a new link from the sign-in screen.');
    return;
  }
  if (event.detail && !ready) {
    ready = true;
    form.hidden = false;
    show('', '');
    pw1.focus();
  }
});

setTimeout(() => {
  if (!ready) show('error', 'الرابط غير صالح أو منتهي الصلاحية. اطلب رابطاً جديداً. · The link is invalid or expired. Request a new one.');
}, 8000);

save.addEventListener('click', async () => {
  if (pw1.value.length < 10) { show('error', 'كلمة المرور قصيرة جداً (10 خانات على الأقل). · The password is too short (at least 10 characters).'); pw1.focus(); return; }
  if (pw1.value !== pw2.value) { show('error', 'كلمتا المرور غير متطابقتين. · The passwords do not match.'); pw2.focus(); return; }
  save.disabled = true;
  show('', 'جارٍ الحفظ… · Saving…');
  try {
    const api = await backend();
    await api.updatePassword(pw1.value);
    pw1.value = '';
    pw2.value = '';
    try { sessionStorage.removeItem('faseela_recovery'); } catch { /* ignore */ }
    form.hidden = true;
    show('ok', 'تم تغيير كلمة المرور. يمكنك الآن العودة إلى التطبيق. · Password changed. You can return to the app.');
  } catch (error) {
    show('error', `تعذر حفظ كلمة المرور. · Could not save the password. (${error.code || 'error'})`);
  } finally {
    save.disabled = false;
  }
});
