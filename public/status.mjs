// Public status page: reads the coarse flags from public.public_status() (anon-callable, no counts,
// no error texts) and marks the API itself as down when the call does not answer within 8 s.
const SUPABASE_URL = 'https://riyvlhlhzxxerlwqoxsy.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_EVAY3Rwv13sU5ojXrvIIpg_SLzF-DiU';
const LABELS = {
  ok: 'يعمل · Operational',
  degraded: 'متدهور · Degraded',
  down: 'متوقف · Unavailable',
};

function setPill(id, state) {
  const el = document.getElementById(id);
  if (!el) return;
  el.dataset.state = state;
  el.textContent = LABELS[state] || LABELS.degraded;
}

function setOverall(state, text) {
  const box = document.getElementById('overall');
  const label = document.getElementById('overall-text');
  if (box) box.dataset.state = state;
  if (label) label.textContent = text;
}

async function fetchStatus() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/public_status`, {
      method: 'POST',
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY, 'content-type': 'application/json' },
      body: '{}',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`http ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function refresh() {
  try {
    const s = await fetchStatus();
    const api = s.api === 'ok' ? 'ok' : 'degraded';
    const jobs = s.jobs === 'ok' ? 'ok' : 'degraded';
    const email = s.email === 'ok' ? 'ok' : 'degraded';
    setPill('s-api', api);
    setPill('s-jobs', jobs);
    setPill('s-email', email);
    const allOk = api === 'ok' && jobs === 'ok' && email === 'ok';
    setOverall(allOk ? 'ok' : 'degraded', allOk ? 'جميع الأنظمة تعمل · All systems operational' : 'بعض الخدمات متدهورة · Some services degraded');
    const checked = document.getElementById('checked');
    const at = Number(s.checkedAt);
    if (checked && Number.isFinite(at)) {
      const d = new Date(at);
      checked.dateTime = d.toISOString();
      checked.textContent = d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    }
  } catch {
    setPill('s-api', 'down');
    setPill('s-jobs', 'degraded');
    setPill('s-email', 'degraded');
    setOverall('down', 'تعذّر الوصول إلى الخدمة · Service unreachable');
  }
}

refresh();
setInterval(refresh, 60000);
