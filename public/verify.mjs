// Public certificate verifier: calls public.verify_certificate(serial) as anon. The RPC answers with
// non-personal facts only (tree, shares, issue date, status, holder initials).
const SUPABASE_URL = 'https://riyvlhlhzxxerlwqoxsy.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_EVAY3Rwv13sU5ojXrvIIpg_SLzF-DiU';
const SERIAL_RE = /^FSL-\d{4}-[0-9A-F]{16}$/;

const input = document.getElementById('serial');
const button = document.getElementById('check');
const result = document.getElementById('result');

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function show(state, html) {
  result.dataset.state = state;
  result.innerHTML = html;
}

async function verify(serialRaw) {
  const serial = String(serialRaw || '').trim().toUpperCase();
  if (!SERIAL_RE.test(serial)) {
    show('bad', '<h2>صيغة غير صالحة · Invalid format</h2><p class="en">A serial looks like FSL-2026-XXXXXXXXXXXXXXXX.</p>');
    return;
  }
  button.disabled = true;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/verify_certificate`, {
      method: 'POST',
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ payload: { serial } }),
    });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const v = await res.json();
    if (!v.valid) {
      show('bad', '<h2>غير معروفة · Not found</h2><p>لا توجد شهادة كفالة بهذا الرقم. لا تعتمد عليها.</p><p class="en">No sponsorship certificate with this serial exists. Do not rely on it.</p>');
      return;
    }
    const issued = new Date(Number(v.issuedAt)).toISOString().slice(0, 10);
    show('ok', `<h2>شهادة كفالة صحيحة · Genuine sponsorship certificate</h2>
      <dl>
        <dt>Serial</dt><dd class="en">${esc(v.serial)}</dd>
        <dt>Tree · الشجرة</dt><dd>${esc(v.treeNameAr)} <span class="en">(${esc(v.treeName)} · ${esc(v.treeId)})</span></dd>
        <dt>Shares · الحصص</dt><dd class="en">${esc(v.shareCount)} / ${esc(v.totalShares)}</dd>
        <dt>Sponsor · الكافل</dt><dd class="en">${esc(v.holderInitials)}</dd>
        <dt>Issued · تاريخ الإصدار</dt><dd class="en">${esc(issued)}</dd>
        <dt>Status · الحالة</dt><dd class="en">${esc(v.status)}</dd>
      </dl>`);
  } catch {
    show('bad', '<h2>تعذّر التحقق · Verification unavailable</h2><p class="en">The service did not answer. Try again in a minute.</p>');
  } finally {
    button.disabled = false;
  }
}

button.addEventListener('click', () => verify(input.value));
input.addEventListener('keydown', (e) => { if (e.key === 'Enter') verify(input.value); });

const fromUrl = new URLSearchParams(location.search).get('serial');
if (fromUrl) {
  input.value = fromUrl.toUpperCase();
  verify(fromUrl);
}
