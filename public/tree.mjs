// Public tree profile: public_tree_profile (anon RPC) + tree-media (signed URLs for published photos).
// Strict CSP page: no inline script, every string escaped, images only from self or Supabase storage.
const SUPABASE_URL = 'https://riyvlhlhzxxerlwqoxsy.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_EVAY3Rwv13sU5ojXrvIIpg_SLzF-DiU';

const T = {
  ar: {
    facts: 'عن الشجرة', farmer: 'المزارع الشريك', timeline: 'يوميات الشجرة', shares: 'الحصص', pressing: 'آخر عصرة معتمدة', share: 'شارك',
    cta: 'احجز حصة الآن', copy: 'نسخ الرابط', copied: 'تم نسخ الرابط', footer: 'البيانات من تقارير ميدانية معتمدة وشهادات عصر مختبرية. لا وعد بعائد.',
    timeline_empty: 'لا توجد تقارير منشورة بعد. تظهر هنا بعد اعتماد أول تقرير ميداني من المدقق.',
    type: 'الصنف', planted: 'سنة الغرس', yieldKg: 'الإنتاج المقدّر', region: 'المنطقة', events: 'تقارير منشورة', pressings: 'عصرات معتمدة',
    available: 'متاح', of: 'من', sold_out: 'جميع الحصص محجوزة', per_share: 'للحصة',
    no_pressing: 'لم تُعتمد عصرة بعد لهذا الموسم.', evoo: 'زيت بكر ممتاز', acidity: 'الحموضة', peroxide: 'البيروكسيد', yieldL: 'الكمية', cert: 'شهادة المختبر',
    years: 'سنة في زراعة الزيتون', not_found: 'لم نجد هذه الشجرة.', unavailable: 'تعذّر تحميل بيانات الشجرة. حاول مجدداً.',
    ev: { watering: 'سقاية', pruning: 'تقليم', fertilizing: 'تسميد', pest_control: 'مكافحة آفات', harvest: 'قطاف', other: 'عناية', pressing_certified: 'عصرة معتمدة' }
  },
  en: {
    facts: 'About the tree', farmer: 'Partner farmer', timeline: 'Tree diary', shares: 'Shares', pressing: 'Latest certified pressing', share: 'Share',
    cta: 'Reserve a share', copy: 'Copy link', copied: 'Link copied', footer: 'Data from audited field reports and lab-certified pressings. No return is promised.',
    timeline_empty: 'No published reports yet. They appear here once the auditor approves the first field report.',
    type: 'Cultivar', planted: 'Planted', yieldKg: 'Est. yield', region: 'Region', events: 'published reports', pressings: 'certified pressings',
    available: 'available', of: 'of', sold_out: 'All shares reserved', per_share: 'per share',
    no_pressing: 'No certified pressing for this season yet.', evoo: 'Extra virgin', acidity: 'Acidity', peroxide: 'Peroxide', yieldL: 'Yield', cert: 'Lab certificate',
    years: 'years growing olives', not_found: 'We could not find this tree.', unavailable: 'The tree data could not be loaded. Please try again.',
    ev: { watering: 'Watering', pruning: 'Pruning', fertilizing: 'Fertilising', pest_control: 'Pest control', harvest: 'Harvest', other: 'Care', pressing_certified: 'Certified pressing' }
  }
};

const params = new URLSearchParams(location.search);
const treeId = (params.get('id') || params.get('tree') || '').trim();
let lang = params.get('lang') === 'en' ? 'en' : 'ar';
let profile = null;
let media = { events: {}, farmerPhoto: null };

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const t = (k) => T[lang][k];
const money = (minor, cur) => `${(Number(minor || 0) / 100).toFixed(2)} ${esc(cur || 'USD')}`;
const day = (ms) => Number.isFinite(ms) ? new Date(ms).toLocaleDateString(lang === 'en' ? 'en-GB' : 'ar-SY', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
const safeImg = (src) => /^(images\/[A-Za-z0-9._-]+|https:\/\/riyvlhlhzxxerlwqoxsy\.supabase\.co\/[^\s"']+)$/.test(String(src || '')) ? src : '';

function applyStatic() {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'en' ? 'ltr' : 'rtl';
  document.querySelectorAll('[data-t]').forEach((el) => { el.textContent = t(el.dataset.t); });
  document.querySelectorAll('[data-lang]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
}

function render() {
  if (!profile) return;
  const tr = profile.tree;
  const name = lang === 'en' ? (tr.nameEn || tr.name || tr.treeId) : (tr.name || tr.nameEn || tr.treeId);
  const region = lang === 'en' ? (tr.regionEn || tr.region) : (tr.region || tr.regionEn);
  const type = lang === 'en' ? (tr.treeTypeEn || tr.treeType) : (tr.treeType || tr.treeTypeEn);
  document.title = `${name} · Faseela`;
  $('tree-name').textContent = name;
  $('tree-sub').textContent = [type, region ? `${region}, ${lang === 'en' ? 'Syria' : 'سوريا'}` : (lang === 'en' ? 'Syria' : 'سوريا')].filter(Boolean).join(' · ');
  const hero = safeImg((tr.images || [])[0]);
  if (hero) { $('hero-img').src = hero; $('hero-img').alt = name; }

  const facts = [
    [t('type'), type], [t('planted'), tr.plantedYear], [t('yieldKg'), tr.estimatedAnnualYieldKg ? `${tr.estimatedAnnualYieldKg} kg` : null],
    [t('region'), region], [t('events'), profile.stats?.publishedEvents], [t('pressings'), profile.stats?.certifiedPressings]
  ].filter(([, v]) => v !== null && v !== undefined && v !== '');
  $('facts').innerHTML = facts.map(([k, v]) => `<div class="fact"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('');

  // Farmer (only present when consented server-side)
  const f = profile.farmer;
  $('farmer-card').hidden = !f;
  if (f) {
    $('farmer-name').textContent = f.displayName || '';
    const meta = [f.village, f.region, f.yearsFarming ? `${f.yearsFarming} ${t('years')}` : ''].filter(Boolean);
    $('farmer-meta').textContent = meta.join(' · ');
    $('farmer-bio').textContent = (lang === 'en' ? (f.bioEn || f.bio) : (f.bio || f.bioEn)) || '';
    const photo = safeImg(media.farmerPhoto);
    $('farmer-photo').hidden = !photo; $('farmer-ph').hidden = !!photo;
    if (photo) { $('farmer-photo').src = photo; $('farmer-photo').alt = f.displayName || ''; }
    $('farmer-ph').textContent = (f.displayName || '?').trim().charAt(0);
  }

  // Timeline
  const events = profile.events || [];
  $('timeline-empty').hidden = events.length > 0;
  $('timeline').innerHTML = events.map((e) => {
    const label = t('ev')[e.eventType] || esc(e.eventType);
    const photos = (media.events?.[e.id] || []).map(safeImg).filter(Boolean);
    const lab = e.eventType === 'pressing_certified'
      ? `<div class="meta"><span class="badge ${Number(e.acidityPct) <= 0.8 && Number(e.peroxideValue) <= 20 ? 'ok' : ''}">${e.oilYieldLiters ?? '?'} L · ${t('acidity')} ${e.acidityPct ?? '?'} % · ${t('peroxide')} ${e.peroxideValue ?? '?'}</span><span class="badge">${esc(e.certificateSerial || '')}</span></div>`
      : '';
    return `<li><div class="meta"><span class="badge">${esc(label)}</span><span>${esc(day(e.eventDate))}</span>${e.mediaCount ? `<span>📷 ${esc(e.mediaCount)}</span>` : ''}</div>
      ${e.notes ? `<p style="margin:.35rem 0 0">${esc(e.notes)}</p>` : ''}${lab}
      ${photos.length ? `<div class="photos">${photos.map((p) => `<img src="${esc(p)}" alt="${esc(label)}" loading="lazy" width="112" height="112">`).join('')}</div>` : ''}</li>`;
  }).join('');

  // Shares
  const avail = Number(tr.availableShares || 0), total = Number(tr.totalShares || 4);
  $('shares-text').innerHTML = avail > 0
    ? `<strong>${avail}</strong> ${esc(t('of'))} ${total} ${esc(t('available'))}`
    : `<strong>${esc(t('sold_out'))}</strong>`;
  $('shares-bar').style.width = `${Math.round(((total - avail) / total) * 100)}%`;
  $('price').innerHTML = `<div>${money(tr.pricePerShareMinor, tr.currency)} <span style="color:var(--muted)">${esc(t('per_share'))}</span></div>`;
  $('cta').href = `./?tree=${encodeURIComponent(tr.treeId)}#marketplace`;
  $('cta').setAttribute('aria-disabled', String(avail <= 0 || tr.status !== 'listed'));

  // Last pressing
  const p = profile.lastPressing;
  $('pressing').innerHTML = p
    ? `<div>${p.extraVirgin ? `<span class="badge ok">${esc(t('evoo'))}</span>` : ''} <span class="badge">${esc(day(p.certifiedAt))}</span></div>
       <div class="facts" style="margin-top:.6rem"><div class="fact"><span>${esc(t('yieldL'))}</span><strong>${esc(p.oilYieldLiters)} L</strong></div><div class="fact"><span>${esc(t('acidity'))}</span><strong>${esc(p.acidityPct)} %</strong></div><div class="fact"><span>${esc(t('peroxide'))}</span><strong>${esc(p.peroxideValue)}</strong></div></div>
       <div style="font-size:.8rem;color:var(--muted);margin-top:.5rem">${esc(t('cert'))}: <span class="en">${esc(p.certificateSerial || '')}</span></div>`
    : `<p class="empty">${esc(t('no_pressing'))}</p>`;

  // Share
  const url = `${location.origin}${location.pathname}?id=${encodeURIComponent(tr.treeId)}&lang=${lang}`;
  $('wa').href = `https://wa.me/?text=${encodeURIComponent(`${name} · ${url}`)}`;
  $('main').setAttribute('aria-busy', 'false');
}

async function load() {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(treeId)) { fail(t('not_found')); return; }
  try {
    const [pRes, mRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/rpc/public_tree_profile`, { method: 'POST', headers: { apikey: SUPABASE_PUBLISHABLE_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ payload: { treeId } }) }),
      fetch(`${SUPABASE_URL}/functions/v1/tree-media?treeId=${encodeURIComponent(treeId)}`).catch(() => null)
    ]);
    if (pRes.status === 400 || pRes.status === 404) { fail(t('not_found')); return; }
    if (!pRes.ok) throw new Error(`http ${pRes.status}`);
    profile = await pRes.json();
    if (mRes && mRes.ok) media = await mRes.json();
    render();
  } catch {
    fail(t('unavailable'));
  }
}

function fail(msg) {
  $('error').textContent = msg; $('error').hidden = false;
  $('main').setAttribute('aria-busy', 'false');
}

document.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => {
  lang = b.dataset.lang;
  const u = new URL(location.href); u.searchParams.set('lang', lang); history.replaceState(null, '', u);
  applyStatic(); render();
}));
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(location.href); $('copy').textContent = t('copied'); setTimeout(() => { $('copy').textContent = t('copy'); }, 1500); } catch { /* clipboard blocked: nothing to do */ }
});

applyStatic();
load();
