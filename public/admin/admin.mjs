// Faseela admin panel (separate page, same backend API and the same server-side authorisation as the app).
// Every list is rendered with textContent only; nothing from the server is ever inserted as HTML.
// The page holds no privileges of its own: each call is checked by the database (roles, four-eyes, screening).
import '../supabase-client.mjs';

const SUPABASE_ORIGIN = 'https://riyvlhlhzxxerlwqoxsy.supabase.co';
const IDLE_LIMIT_MS = 30 * 60 * 1000;
const ROLES = ['investor', 'farmer', 'mill_operator', 'finance_admin', 'quality_auditor', 'admin'];
const ROLE_LABEL = { investor: 'Baumpate', farmer: 'Landwirt', mill_operator: 'Ölmühle', mill_owner: 'Ölmühle', finance_admin: 'Finanz-Admin', quality_auditor: 'Qualitätsprüfer', admin: 'Admin' };
const CHANNEL_TYPES = ['syriatel_cash', 'mtn_cash', 'bank_iban', 'exchange_office', 'other'];
const CHANNEL_LABEL = { syriatel_cash: 'Syriatel Cash', mtn_cash: 'MTN Cash', bank_iban: 'Bankkonto / IBAN', exchange_office: 'Wechselstube', other: 'Sonstiges' };
const FINANCE_COLUMNS = ['requestId', 'createdAt', 'status', 'payerName', 'payerEmail', 'userId', 'treeId', 'shareCount', 'includesLand', 'amountMinor', 'currency'];
const ERROR_TEXT = {
  'unauthenticated': 'Die Sitzung ist abgelaufen. Bitte neu anmelden.',
  'permission-denied': 'Dafür fehlt diesem Konto die Berechtigung (oder es ist ein eigener Vorgang, den ein anderes Konto prüfen muss).',
  'resource-exhausted': 'Zu viele Anfragen. Bitte kurz warten.',
  'screening-required': 'Freigabe nicht möglich: Es fehlt eine aktuelle Sanktionsprüfung mit Ergebnis „unauffällig".',
  'screening-blocked': 'Freigabe gesperrt: Die letzte Sanktionsprüfung ist nicht „unauffällig".',
  'failed-precondition': 'Der Vorgang ist in diesem Zustand nicht möglich (bereits entschieden oder Voraussetzung fehlt).',
  'invalid-argument': 'Die Eingabe ist ungültig. Bitte Felder prüfen.',
  'not-found': 'Der Eintrag wurde nicht gefunden.',
  'mfa-required': 'Für dieses Konto ist eine Bestätigung mit der Authenticator-App nötig.',
  'mfa-invalid-code': 'Der Code wurde nicht akzeptiert. Bitte den aktuellen Code aus der App eingeben.',
  'already-exists': 'Der Eintrag existiert bereits.',
  'shop-closed': 'Der Hofladen ist geschlossen.',
  'auth/invalid-credential': 'E-Mail oder Passwort stimmt nicht.',
  'auth/invalid-credentials': 'E-Mail oder Passwort stimmt nicht.',
  'auth/invalid_credentials': 'E-Mail oder Passwort stimmt nicht.',
  'auth/email-not-verified': 'Die E-Mail-Adresse ist noch nicht bestätigt. Eine neue Bestätigungsmail wurde gesendet.'
};

const TABS = [
  { id: 'tasks', label: 'Aufgaben', roles: ['admin', 'finance_admin'] },
  { id: 'overview', label: 'Übersicht', roles: ['admin'] },
  { id: 'payments', label: 'Zahlungen', roles: ['admin', 'finance_admin'] },
  { id: 'reviews', label: 'Weitere Prüfungen', roles: ['admin', 'finance_admin'] },
  { id: 'roles', label: 'Rollenanträge', roles: ['admin'] },
  { id: 'investments', label: 'Patenschaften', roles: ['admin', 'finance_admin'] },
  { id: 'trees', label: 'Bäume', roles: ['admin', 'finance_admin'] },
  { id: 'master', label: 'Stammdaten', roles: ['admin'] },
  { id: 'market', label: 'Marktplatz', roles: ['admin', 'finance_admin'] },
  { id: 'register', label: 'Besitzregister', roles: ['admin', 'finance_admin'] },
  { id: 'users', label: 'Nutzer', roles: ['admin'] },
  { id: 'accounts', label: 'Empfangskonten', roles: ['admin'] },
  { id: 'export', label: 'Finanz-Export', roles: ['admin', 'finance_admin'] },
  { id: 'mail', label: 'E-Mails', roles: ['admin'] },
  { id: 'automation', label: 'Automationen', roles: ['admin'] },
  { id: 'errors', label: 'Fehler', roles: ['admin'] },
  { id: 'audit', label: 'Audit-Log', roles: ['admin'] },
  { id: 'settings', label: 'Einstellungen', roles: ['admin'] },
  { id: 'readiness', label: 'Go-Live', roles: ['admin'] },
  { id: 'system', label: 'System', roles: ['admin'] }
];
const STATUS_LABEL = { awaiting_payment: 'wartet auf Zahlung', under_review: 'in Prüfung', approved: 'freigegeben', rejected: 'abgelehnt', cancelled: 'storniert', expired: 'abgelaufen' };
const STATUS_TONE = { approved: 'badge-ok', under_review: 'badge-warn', awaiting_payment: 'badge-warn', rejected: 'badge-bad' };
const REVIEW_QUEUES = {
  admin: ['farmer_updates', 'pressing_batches', 'oil_requests', 'oil_fulfilment'],
  finance_admin: ['oil_requests', 'oil_fulfilment']
};
const QUEUE_LABEL = { farmer_updates: 'Feldberichte', pressing_batches: 'Pressungen', oil_requests: 'Ölanfragen', oil_fulfilment: 'Öl-Auslieferung' };
const SVG_NS = 'http://www.w3.org/2000/svg';

const session = { user: null, tab: '', idleTimer: 0, loadToken: 0 };
const api = () => window.FaseelaBackend;
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- helpers
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'on') for (const [name, handler] of Object.entries(value)) node.addEventListener(name, handler);
    else if (key === 'disabled' || key === 'hidden' || key === 'selected' || key === 'required') node[key] = value === true;
    else node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}
const fmtDate = (ms) => Number.isFinite(ms) ? new Date(ms).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '–';
const fmtMoney = (major) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'USD' }).format(Number(major) || 0);
function errorText(error) {
  const code = String((error && error.code) || '');
  return ERROR_TEXT[code] || ERROR_TEXT[code.replace(/^auth\//, '')] || 'Das hat nicht funktioniert. Bitte erneut versuchen.';
}
function logError(where, error) {
  console.error(`[faseela-admin] ${where}:`, (error && (error.code || error.message)) || error);
}
let toastTimer = 0;
function toast(message, isError = false) {
  const node = $('toast');
  node.textContent = message;
  node.classList.toggle('is-error', isError);
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 5000);
}
function stateBlock(kind, text, retry) {
  return el('div', { class: 'state', role: kind === 'error' ? 'alert' : 'status' }, [
    el('p', { text }),
    retry ? el('button', { type: 'button', class: 'btn btn-ghost', text: 'Erneut laden', on: { click: retry } }) : null
  ]);
}
function field(labelText, control) {
  const id = control.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  control.id = id;
  return el('div', { class: 'field' }, [el('label', { for: id, text: labelText }), control]);
}

/** Modal dialog. `build(body)` may add inputs; `onConfirm()` may throw to keep the dialog open with the message. */
function openDialog({ title, text, confirmLabel = 'Bestätigen', danger = false, build, onConfirm }) {
  const dialog = $('dialog');
  const body = $('dialog-body');
  const ok = $('dialog-ok');
  const cancel = $('dialog-cancel');
  const error = $('dialog-error');
  $('dialog-title').textContent = title;
  body.replaceChildren();
  if (text) body.append(el('p', { text }));
  if (build) build(body);
  ok.textContent = confirmLabel;
  ok.className = danger ? 'btn btn-danger' : 'btn btn-primary';
  ok.disabled = false;
  error.hidden = true;
  return new Promise((resolve) => {
    const close = (result) => {
      ok.removeEventListener('click', confirm);
      cancel.removeEventListener('click', abort);
      dialog.removeEventListener('cancel', abort);
      dialog.close();
      resolve(result);
    };
    const abort = (event) => { if (event) event.preventDefault(); close(false); };
    const confirm = async () => {
      ok.disabled = true;
      error.hidden = true;
      try {
        await onConfirm();
        close(true);
      } catch (err) {
        logError('dialog', err);
        error.textContent = err && err.userMessage ? err.userMessage : errorText(err);
        error.hidden = false;
        ok.disabled = false;
      }
    };
    ok.addEventListener('click', confirm);
    cancel.addEventListener('click', abort);
    dialog.addEventListener('cancel', abort);
    dialog.showModal();
  });
}
const userError = (message) => Object.assign(new Error(message), { userMessage: message });

function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text; // spreadsheet formula injection
  return /[",\n\r;]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

// ---------------------------------------------------------------- views
const fmtInt = (value) => new Intl.NumberFormat('de-DE').format(Number(value) || 0);
const fmtMinor = (minor) => fmtMoney((Number(minor) || 0) / 100);
const monthLabel = (ym) => { const [y, m] = String(ym).split('-').map(Number); return new Date(y, (m || 1) - 1, 1).toLocaleDateString('de-DE', { month: 'short', year: '2-digit' }); };
function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

/**
 * Single-series bar chart (one measure, one axis). Bars are keyboard-focusable and show a tooltip on hover/focus;
 * the same numbers are available as a table. Only the highest bar carries a direct label.
 */
function barChart({ title, points, format }) {
  const W = 520, H = 180, left = 8, right = 8, top = 18, bottom = 24;
  const max = Math.max(1, ...points.map((pt) => pt.value));
  const slot = (W - left - right) / points.length;
  const barW = Math.max(6, Math.min(24, slot - 2));
  const plotH = H - top - bottom;
  const peak = points.reduce((best, pt, i) => (pt.value > points[best].value ? i : best), 0);
  const tip = el('div', { class: 'chart-tip', role: 'status', hidden: true });
  const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': `${title}. Höchstwert ${format(points[peak].value)} im ${points[peak].label}.`, class: 'chart-svg' });
  chart.append(svg('line', { x1: left, x2: W - right, y1: H - bottom, y2: H - bottom, class: 'chart-axis' }));
  points.forEach((pt, i) => {
    const h = pt.value > 0 ? Math.max(2, (pt.value / max) * plotH) : 0;
    const x = left + i * slot + (slot - barW) / 2;
    const y = H - bottom - h;
    const r = Math.min(4, barW / 2, h);
    const group = svg('g', { tabindex: 0, role: 'img', 'aria-label': `${pt.label}: ${format(pt.value)}`, class: 'chart-bar' });
    // Rounded only at the data end; the base sits flat on the axis.
    group.append(svg('path', { d: `M${x},${H - bottom} V${y + r} Q${x},${y} ${x + r},${y} H${x + barW - r} Q${x + barW},${y} ${x + barW},${y + r} V${H - bottom} Z` }));
    group.append(svg('rect', { x: left + i * slot, y: top, width: slot, height: plotH, class: 'chart-hit' }));
    const showTip = () => { tip.textContent = `${pt.label}: ${format(pt.value)}`; tip.hidden = false; };
    const hideTip = () => { tip.hidden = true; };
    group.addEventListener('pointerenter', showTip); group.addEventListener('pointerleave', hideTip);
    group.addEventListener('focus', showTip); group.addEventListener('blur', hideTip);
    chart.append(group);
    if (i % 2 === (points.length - 1) % 2) { const label = svg('text', { x: x + barW / 2, y: H - 8, 'text-anchor': 'middle', class: 'chart-tick' }); label.textContent = pt.short; chart.append(label); }
    if (i === peak && pt.value > 0) { const label = svg('text', { x: Math.min(Math.max(x + barW / 2, 40), W - 40), y: Math.max(y - 5, 12), 'text-anchor': 'middle', class: 'chart-value' }); label.textContent = format(pt.value); chart.append(label); }
  });
  const empty = points.every((pt) => pt.value === 0);
  return el('section', { class: 'item chart' }, [
    el('h3', { text: title }),
    empty ? el('p', { class: 'muted', text: 'Noch keine Daten in den letzten zwölf Monaten.' }) : chart,
    tip,
    el('details', {}, [el('summary', { text: 'Als Tabelle' }), el('div', { class: 'table-wrap' }, [el('table', {}, [
      el('thead', {}, [el('tr', {}, [el('th', { scope: 'col', text: 'Monat' }), el('th', { scope: 'col', text: 'Wert' })])]),
      el('tbody', {}, points.map((pt) => el('tr', {}, [el('td', { text: pt.label }), el('td', { text: format(pt.value) })])))])])])
  ]);
}

/** Rule-based hints from the dashboard figures. Deterministic rules, no AI model involved. */
function buildHints(d) {
  const ops = d.operations || {}; const queues = ops.reviewQueues || {}; const req = d.requests || {}; const inv = d.inventory || {};
  const users = d.users || {}; const mail = d.mail || {}; const errors = d.errors || {}; const push = d.push || {};
  const hints = [];
  const add = (level, text, tab, action) => hints.push({ level, text, tab, action });
  if (!ops.paymentAccountsConfigured) add('bad', 'Es sind keine Empfangskonten hinterlegt. Der Checkout zeigt deshalb keine Zahlungsanweisung und niemand kann bezahlen.', 'accounts', 'Konten eintragen');
  if (req.overdue > 0) add('bad', `${fmtInt(req.overdue)} Zahlung(en) liegen länger als die Prüffrist in der Warteschlange.`, 'payments', 'Jetzt prüfen');
  if ((mail.sent || 0) === 0) add('bad', 'Es wurde noch nie eine E-Mail versendet. Ohne Mail-Anbieter erhalten Kunden keine Bestätigungen.', 'system', 'System ansehen');
  else if (mail.failed7d > 0) add('warn', `${fmtInt(mail.failed7d)} E-Mail(s) sind in den letzten 7 Tagen fehlgeschlagen.`, 'system', 'System ansehen');
  if (queues.payments > 0 && !(req.overdue > 0)) add('warn', `${fmtInt(queues.payments)} Zahlung(en) warten auf Prüfung.`, 'payments', 'Zahlungen öffnen');
  if (queues.roleApplications > 0) add('warn', `${fmtInt(queues.roleApplications)} Rollenantrag/-anträge offen.`, 'roles', 'Anträge öffnen');
  if ((queues.farmerUpdates || 0) + (queues.pressingBatches || 0) + (queues.oilRequests || 0) > 0) add('warn', `${fmtInt((queues.farmerUpdates || 0) + (queues.pressingBatches || 0) + (queues.oilRequests || 0))} weitere Prüfung(en) offen (Feldberichte, Pressungen, Öl).`, 'reviews', 'Prüfungen öffnen');
  if (req.expiring24h > 0) add('info', `${fmtInt(req.expiring24h)} Reservierung(en) laufen in den nächsten 24 Stunden ab, falls kein Beleg eingeht.`, 'investments', 'Investitionen ansehen');
  if (ops.adminCount < 2) add('warn', 'Es gibt nur einen Admin. Das Vier-Augen-Prinzip für Empfangskonten ist damit nicht aktiv.', 'users', 'Nutzer öffnen');
  const free = (inv.totalShares || 0) - (inv.soldShares || 0) - (inv.reservedShares || 0);
  if (inv.totalShares > 0 && free / inv.totalShares <= 0.1) add('warn', `Nur noch ${fmtInt(free)} von ${fmtInt(inv.totalShares)} Anteilen frei. Neue Bäume einplanen.`, 'trees', 'Bäume ansehen');
  if (inv.trees > 0 && inv.listed === 0) add('bad', 'Kein Baum ist im Katalog sichtbar.', 'trees', 'Bäume ansehen');
  if (errors.last24h > 0) add('warn', `${fmtInt(errors.last24h)} App-Fehler in den letzten 24 Stunden gemeldet.`, 'errors', 'Fehler ansehen');
  if ((users.total || 0) - (users.confirmed || 0) > 0) add('info', `${fmtInt(users.total - users.confirmed)} Konto/Konten haben die E-Mail-Adresse noch nicht bestätigt.`, 'users', 'Nutzer öffnen');
  if (!push.enabled) add('info', 'Push-Benachrichtigungen sind ausgeschaltet (erst nach der Firebase-Einrichtung einschalten).', 'settings', 'Einstellungen');
  const rank = { bad: 0, warn: 1, info: 2 };
  return hints.map((hint, index) => ({ hint, index })).sort((x, y) => rank[x.hint.level] - rank[y.hint.level] || x.index - y.index).map((entry) => entry.hint);
}

/** Change of the headline figures against the snapshot of about a week ago (or the oldest one there is). */
function trendBlock(history) {
  const section = el('section', { class: 'item' }, [el('h3', { text: 'Entwicklung' })]);
  if (history.length < 2) {
    section.append(el('p', { class: 'muted', text: 'Die Kennzahlen werden seit heute jeden Tag gesichert. Ab morgen steht hier der Vergleich mit dem Vortag, später mit der Vorwoche.' }));
    return section;
  }
  const now = history[history.length - 1];
  const then = history[Math.max(0, history.length - 8)];
  const days = Math.round((new Date(now.day) - new Date(then.day)) / 86400000);
  const rows = [
    ['Konten', now.users, then.users, fmtInt], ['Bestätigte Konten', now.confirmedUsers, then.confirmedUsers, fmtInt],
    ['Besitzer', now.owners, then.owners, fmtInt], ['Verkaufte Anteile', now.soldShares, then.soldShares, fmtInt],
    ['Freigegebenes Volumen', now.approvedMinor, then.approvedMinor, fmtMinor]
  ];
  section.append(el('div', { class: 'table-wrap' }, [el('table', {}, [
    el('thead', {}, [el('tr', {}, ['Kennzahl', 'Heute', `Vor ${days} Tag${days === 1 ? '' : 'en'}`, 'Veränderung'].map((text) => el('th', { scope: 'col', text })))]),
    el('tbody', {}, rows.map(([label, a, b, format]) => {
      const delta = (Number(a) || 0) - (Number(b) || 0);
      return el('tr', {}, [el('th', { scope: 'row', text: label }), el('td', { text: format(a) }), el('td', { text: format(b) }),
        el('td', {}, [el('span', { class: `badge ${delta > 0 ? 'badge-ok' : delta < 0 ? 'badge-bad' : ''}`, text: delta === 0 ? 'unverändert' : `${delta > 0 ? '+' : '−'}${format(Math.abs(delta))}` })])]);
    }))
  ])]));
  return section;
}

const TASK_TEXT = {
  payments_overdue: 'Zahlung(en) über der Prüffrist von 72 Stunden', payments_review: 'Zahlung(en) warten auf Prüfung', oil_requests: 'Ölanfrage(n) offen',
  role_applications: 'Rollenantrag/-anträge offen', farmer_updates: 'Feldbericht(e) warten auf Freigabe', pressing_batches: 'Pressung(en) warten auf Zertifizierung',
  mail_failed: 'E-Mail(s) in 7 Tagen fehlgeschlagen', client_errors: 'App-Fehler in den letzten 24 Stunden', trees_without_farmer: 'sichtbare(r) Baum/Bäume ohne Landwirt',
  trees_without_mill: 'sichtbare(r) Baum/Bäume ohne Ölmühle', trees_sold_out: 'Baum/Bäume ausverkauft', payment_accounts_missing: 'Es sind keine Empfangskonten hinterlegt – niemand kann bezahlen',
  single_admin: 'Es gibt nur ein Admin-Konto – das Vier-Augen-Prinzip greift nicht', jobs_failing: 'Hintergrundjob(s) in 24 Stunden fehlgeschlagen'
};
const TASK_SEVERITY = { critical: ['Dringend', 'badge-bad'], high: ['Wichtig', 'badge-warn'], normal: ['Offen', ''], info: ['Hinweis', ''] };
const TASK_NO_COUNT = new Set(['payment_accounts_missing', 'single_admin']);

/** Landing page: everything that needs a person, most urgent first, plus the search across the platform. */
async function viewTasks(view) {
  const { data } = await api().adminTasks();
  const tasks = Array.isArray(data) ? data : [];
  const allowed = new Set(TABS.filter((tab) => tab.roles.includes(session.user.role)).map((tab) => tab.id));
  view.append(el('h2', { text: 'Aufgaben' }));
  if (session.user.role === 'admin') view.append(searchBlock());
  if (!tasks.length) { view.append(stateBlock('empty', 'Nichts offen. Alle Prüfungen und Betriebspunkte sind erledigt.')); return; }
  view.append(el('ul', { class: 'plain-list task-list' }, tasks.map((task) => {
    const [word, tone] = TASK_SEVERITY[task.severity] || TASK_SEVERITY.normal;
    const label = TASK_TEXT[task.key] || task.key;
    return el('li', { class: 'item row row-between' }, [
      el('div', {}, [
        el('div', { class: 'row' }, [el('span', { class: `badge ${tone}`, text: word }), el('strong', { text: TASK_NO_COUNT.has(task.key) ? label : `${fmtInt(task.count)} ${label}` })]),
        task.oldestAt ? el('div', { class: 'item-meta', text: `Ältester Eintrag: ${fmtDate(task.oldestAt)}` }) : null
      ]),
      allowed.has(task.tab) ? el('button', { type: 'button', class: 'btn btn-sm btn-primary', text: 'Öffnen', 'aria-label': `${label} öffnen`, on: { click: () => show(task.tab) } }) : null
    ]);
  })));
}

function searchBlock() {
  const input = el('input', { type: 'search', maxlength: 80, placeholder: 'Name, E-Mail, Baum oder Anfragenummer', 'aria-label': 'Plattform durchsuchen' });
  const results = el('div', { role: 'status', 'aria-live': 'polite' });
  const run = async () => {
    const q = input.value.trim();
    if (q.length < 2) { results.replaceChildren(el('p', { class: 'muted', text: 'Bitte mindestens 2 Zeichen eingeben.' })); return; }
    results.replaceChildren(el('p', { class: 'muted', text: 'Suche läuft …' }));
    try {
      const { data } = await api().adminSearch({ q });
      const users = (data && data.users) || []; const requests = (data && data.requests) || []; const trees = (data && data.trees) || [];
      if (!users.length && !requests.length && !trees.length) { results.replaceChildren(el('p', { class: 'muted', text: 'Kein Treffer.' })); return; }
      const group = (title, rows) => rows.length ? el('div', {}, [el('h4', { text: title }), el('ul', { class: 'plain-list' }, rows)]) : null;
      results.replaceChildren(
        group('Konten', users.map((user) => el('li', { class: 'row row-between' }, [el('span', {}, [user.name || '–', ' ', el('span', { class: 'mono item-meta', text: user.email || '' })]),
          el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Details', 'aria-label': `Details zu ${user.name || user.email}`, on: { click: () => openUserDetail({ id: user.id, name: user.name || '', email: user.email || '' }) } })]))),
        group('Bäume', trees.map((tree) => el('li', { class: 'row row-between' }, [el('span', {}, [tree.name || '–', ' ', el('span', { class: 'mono item-meta', text: tree.treeId })]),
          el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Bearbeiten', 'aria-label': `${tree.treeId} bearbeiten`, on: { click: () => editTree(tree.treeId) } })]))),
        group('Anfragen', requests.map((request) => el('li', { class: 'row row-between' }, [el('span', {}, [el('span', { class: 'mono', text: String(request.id).slice(0, 12) }), ` · ${request.treeId} · ${fmtMinor(request.amountMinor)} `,
          el('span', { class: `badge ${STATUS_TONE[request.status] || ''}`, text: STATUS_LABEL[request.status] || request.status })]),
          el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Zu den Investitionen', on: { click: () => show('investments') } })])))
      );
    } catch (error) {
      logError('search', error);
      results.replaceChildren(el('p', { class: 'alert alert-error', text: errorText(error) }));
    }
  };
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') run(); });
  return el('section', { class: 'item' }, [el('div', { class: 'row' }, [input, el('button', { type: 'button', class: 'btn btn-ghost', text: 'Suchen', on: { click: run } })]), results]);
}

const RULE_TEXT = {
  review_reminder: ['Erinnerung an liegengebliebene Prüfungen', 'Liegt ein Rollenantrag, Feldbericht, eine Pressung oder Ölanfrage länger als die eingestellten Tage, bekommen die zuständigen Konten einmal täglich eine E-Mail.', 'Tage bis zur Erinnerung'],
  sold_out_unlist: ['Ausverkaufte Bäume ausblenden', 'Ein Baum, der vollständig verkauft ist, verschwindet nach den eingestellten Tagen aus dem Katalog. Besitzer behalten alles und sehen ihren Baum weiter.', 'Tage nach dem Ausverkauf']
};
const JOB_TEXT = {
  'faseela-expire-reservations': 'Abgelaufene Reservierungen freigeben', 'faseela-flag-overdue-reviews': 'Überfällige Zahlungsprüfungen markieren', 'faseela-onboarding': 'Begrüßungs-E-Mails',
  'faseela-ops-check': 'Betriebsprüfung und Alarm', 'faseela-purge-storage': 'Gelöschte Dateien entfernen', 'faseela-rate-limits-reset': 'Anfrage-Zähler zurücksetzen',
  'faseela-send-emails': 'E-Mail-Versand', 'faseela-send-push': 'Push-Versand', 'faseela-kpi-snapshot': 'Tägliche Kennzahlen sichern', 'faseela-automations': 'Automationsregeln ausführen'
};
const JOB_CRITICAL = { 'faseela-expire-reservations': 'Ohne diesen Job bleiben unbezahlte Reservierungen bestehen und blockieren Anteile.', 'faseela-send-emails': 'Ohne diesen Job geht keine E-Mail mehr hinaus, auch keine Zahlungsbestätigung.', 'faseela-flag-overdue-reviews': 'Ohne diesen Job werden überfällige Zahlungsprüfungen nicht mehr gemeldet.' };

async function viewAutomation(view) {
  const { data } = await api().adminAutomationState();
  const rules = (data && data.rules) || []; const jobs = (data && data.jobs) || []; const log = (data && data.log) || [];
  view.append(el('h2', { text: 'Automationen' }),
    el('p', { class: 'muted', text: 'Regeln arbeiten nach festen Bedingungen und laufen stündlich. Es entscheidet kein KI-Modell. Jede Änderung steht im Audit-Log.' }),
    el('h3', { text: 'Regeln' }));
  view.append(el('div', { class: 'grid' }, rules.map((rule) => {
    const [title, text, daysLabel] = RULE_TEXT[rule.key] || [rule.key, '', 'Tage'];
    const days = el('input', { type: 'text', inputmode: 'numeric', maxlength: 2, value: String(rule.days) });
    const result = rule.lastResult;
    const save = (enabled) => {
      const value = Number(days.value.trim());
      if (!Number.isInteger(value) || value < 1 || value > 90) { toast('Tage: eine ganze Zahl von 1 bis 90.', true); return; }
      openDialog({
        title: enabled ? (rule.enabled ? 'Regel speichern' : 'Regel einschalten') : 'Regel ausschalten',
        text: `${title}: ${enabled ? `aktiv mit ${value} Tag(en).` : 'wird ausgeschaltet.'}${enabled && rule.key === 'review_reminder' ? ' Solange kein E-Mail-Anbieter verbunden ist, schlagen die Erinnerungen fehl.' : ''}`,
        confirmLabel: enabled ? 'Speichern' : 'Ausschalten', danger: !enabled,
        onConfirm: () => api().adminSetAutomationRule({ key: rule.key, enabled, days: value })
      }).then((ok) => { if (ok) { toast('Regel gespeichert.'); show('automation'); } });
    };
    return el('section', { class: 'item' }, [
      el('div', { class: 'row row-between' }, [el('h4', { text: title }), el('span', { class: `badge ${rule.enabled ? 'badge-ok' : ''}`, text: rule.enabled ? 'aktiv' : 'aus' })]),
      el('p', { class: 'muted', text }),
      el('div', { class: 'row' }, [field(daysLabel, days),
        el('button', { type: 'button', class: 'btn btn-sm btn-primary', text: rule.enabled ? 'Speichern' : 'Einschalten', 'aria-label': `${title}: ${rule.enabled ? 'speichern' : 'einschalten'}`, on: { click: () => save(true) } }),
        rule.enabled ? el('button', { type: 'button', class: 'btn btn-sm btn-danger', text: 'Ausschalten', 'aria-label': `${title}: ausschalten`, on: { click: () => save(false) } }) : null]),
      el('p', { class: 'item-meta', text: rule.lastRunAt ? `Letzter Lauf: ${fmtDate(rule.lastRunAt)} · ${result && result.ok === false ? `Fehler: ${result.error || 'unbekannt'}` : `${fmtInt(((result && result.done) || []).length)} Aktion(en)`}` : 'Noch nicht gelaufen.' })
    ]);
  })));
  view.append(el('h3', { text: 'Hintergrundjobs' }), el('div', { class: 'table-wrap' }, [el('table', {}, [
    el('thead', {}, [el('tr', {}, ['Job', 'Zeitplan', 'Zustand', 'Letzter Lauf', 'Dauer', 'Fehler (24 h)', 'Aktion'].map((text) => el('th', { scope: 'col', text })))]),
    el('tbody', {}, jobs.map((job) => {
      const label = JOB_TEXT[job.name] || job.name;
      const toggle = () => openDialog({
        title: job.active ? 'Job pausieren' : 'Job fortsetzen',
        text: `${label}${job.active && JOB_CRITICAL[job.name] ? `. Achtung: ${JOB_CRITICAL[job.name]}` : job.active ? ' läuft bis zum Fortsetzen nicht mehr.' : ' läuft wieder nach Zeitplan.'}`,
        confirmLabel: job.active ? 'Pausieren' : 'Fortsetzen', danger: job.active,
        onConfirm: () => api().adminSetJobActive({ name: job.name, active: !job.active })
      }).then((ok) => { if (ok) { toast('Job geändert.'); show('automation'); } });
      return el('tr', {}, [
        el('td', {}, [el('div', { text: label }), el('div', { class: 'mono item-meta', text: job.name })]), el('td', { class: 'mono', text: job.schedule }),
        el('td', {}, [el('span', { class: `badge ${job.active ? 'badge-ok' : 'badge-warn'}`, text: job.active ? 'läuft' : 'pausiert' })]),
        el('td', {}, [job.lastStart ? fmtDate(job.lastStart) : '–', ' ', job.lastStatus ? el('span', { class: `badge ${job.lastStatus === 'succeeded' ? 'badge-ok' : job.lastStatus === 'failed' ? 'badge-bad' : ''}`, text: job.lastStatus === 'succeeded' ? 'ok' : job.lastStatus === 'failed' ? 'Fehler' : job.lastStatus }) : null]),
        el('td', { text: Number.isFinite(job.lastDurationMs) ? `${fmtInt(job.lastDurationMs)} ms` : '–' }),
        el('td', {}, [el('span', { class: `badge ${job.failures24h > 0 ? 'badge-bad' : ''}`, text: fmtInt(job.failures24h) })]),
        el('td', {}, [el('button', { type: 'button', class: `btn btn-sm ${job.active ? 'btn-danger' : 'btn-primary'}`, text: job.active ? 'Pausieren' : 'Fortsetzen', 'aria-label': `${label} ${job.active ? 'pausieren' : 'fortsetzen'}`, on: { click: toggle } })])
      ]);
    }))
  ])]));
  view.append(el('h3', { text: 'Letzte automatische Aktionen' }), log.length
    ? el('ul', { class: 'plain-list' }, log.map((entry) => el('li', { text: `${fmtDate(entry.at)} · ${(RULE_TEXT[entry.rule] || [entry.rule])[0]} · ${entry.subject}` })))
    : el('p', { class: 'muted', text: 'Noch keine automatische Aktion.' }));
}

const READY_AUTO = {
  payment_accounts: ['Empfangskonten sind hinterlegt', 'accounts'], mail_delivered: ['Mindestens eine E-Mail wurde zugestellt', 'mail'], two_admins: ['Zwei Admin-Konten (Vier-Augen-Prinzip)', 'users'],
  finance_admin: ['Ein Finanz-Admin ist benannt', 'users'], trees_listed: ['Mindestens ein Baum mit freien Anteilen ist sichtbar', 'trees'], trees_have_farmer: ['Jeder sichtbare Baum hat einen Landwirt', 'trees'],
  trees_have_mill: ['Jeder sichtbare Baum hat eine Ölmühle', 'trees'], jobs_healthy: ['Kein Hintergrundjob ist in 24 Stunden fehlgeschlagen', 'automation'], no_client_errors: ['Keine App-Fehler in 24 Stunden', 'errors']
};
const READY_MANUAL = {
  legal_opinion: 'Rechtsgutachten liegt vor (Vermögensanlage, Sanktionen, Verbraucherrecht)', legal_texts: 'Impressum, Datenschutzerklärung und AGB sind ohne Platzhalter',
  sanctions_process: 'Ablauf der Sanktionsprüfung ist festgelegt und geübt', mail_domain: 'Absender-Domain ist eingerichtet (SPF, DKIM, DMARC)',
  test_purchase: 'Testkauf von der Reservierung bis zur Freigabe bestanden', restore_test: 'Wiederherstellung aus dem Backup geprobt',
  store_accounts: 'App-Store-Konten und Signierung sind vorhanden', support_contact: 'Support-Adresse ist erreichbar und besetzt'
};

async function viewReadiness(view) {
  const { data } = await api().adminReadiness();
  const auto = (data && data.auto) || []; const manual = (data && data.manual) || [];
  const done = auto.filter((item) => item.ok).length + manual.filter((item) => item.done).length;
  const total = auto.length + manual.length;
  view.append(el('h2', { text: 'Go-Live-Checkliste' }),
    el('p', {}, [el('strong', { text: `${done} von ${total} Punkten erfüllt.` }), ' Die oberen Punkte prüft das System selbst, die unteren bestätigst du.']),
    el('progress', { max: total, value: done, 'aria-label': 'Fortschritt der Checkliste' }),
    el('h3', { text: 'Vom System geprüft' }),
    el('ul', { class: 'plain-list' }, auto.map((item) => {
      const [label, tabId] = READY_AUTO[item.key] || [item.key, ''];
      return el('li', { class: 'item row row-between' }, [
        el('div', { class: 'row' }, [el('span', { class: `badge ${item.ok ? 'badge-ok' : 'badge-warn'}`, text: item.ok ? 'erfüllt' : 'offen' }), el('span', { text: label })]),
        !item.ok && tabId ? el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Beheben', 'aria-label': `${label}: beheben`, on: { click: () => show(tabId) } }) : null
      ]);
    })),
    el('h3', { text: 'Von dir bestätigt' }),
    el('ul', { class: 'plain-list' }, manual.map((item) => {
      const label = READY_MANUAL[item.key] || item.key;
      const note = el('textarea', { rows: 3, maxlength: 500, text: item.note || '' });
      const change = () => openDialog({
        title: item.done ? 'Punkt wieder öffnen' : 'Punkt als erledigt bestätigen', text: label, confirmLabel: item.done ? 'Wieder öffnen' : 'Bestätigen',
        build: (body) => body.append(field('Notiz (optional, z. B. Datum oder Ablageort – keine personenbezogenen Daten)', note)),
        onConfirm: () => api().adminSetReadiness({ key: item.key, done: !item.done, note: note.value.trim() })
      }).then((ok) => { if (ok) { toast('Checkliste aktualisiert.'); show('readiness'); } });
      return el('li', { class: 'item row row-between' }, [
        el('div', {}, [el('div', { class: 'row' }, [el('span', { class: `badge ${item.done ? 'badge-ok' : 'badge-warn'}`, text: item.done ? 'bestätigt' : 'offen' }), el('span', { text: label })]),
          item.note || item.updatedAt ? el('div', { class: 'item-meta', text: [item.note, item.updatedAt ? `geändert ${fmtDate(item.updatedAt)}` : ''].filter(Boolean).join(' · ') }) : null]),
        el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: item.done ? 'Wieder öffnen' : 'Bestätigen', 'aria-label': `${label}: ${item.done ? 'wieder öffnen' : 'bestätigen'}`, on: { click: change } })
      ]);
    })));
}

async function viewOverview(view) {
  const { data } = await api().adminDashboard();
  const d = data || {};
  const req = d.requests || {}; const inv = d.inventory || {}; const users = d.users || {}; const queues = (d.operations && d.operations.reviewQueues) || {};
  const openReviews = (queues.payments || 0) + (queues.roleApplications || 0) + (queues.farmerUpdates || 0) + (queues.pressingBatches || 0) + (queues.oilRequests || 0);
  const tiles = [
    ['Freigegebenes Volumen', fmtMinor(req.approvedMinor), ''],
    ['Offenes Volumen', fmtMinor(req.openMinor), req.openMinor > 0 ? 'is-warn' : ''],
    ['Verkaufte Anteile', `${fmtInt(inv.soldShares)} / ${fmtInt(inv.totalShares)}`, ''],
    ['Reservierte Anteile', fmtInt(inv.reservedShares), ''],
    [`Konten (+${fmtInt(users.new30d)} in 30 Tagen)`, fmtInt(users.total), ''],
    ['Offene Prüfungen', fmtInt(openReviews), req.overdue > 0 ? 'is-bad' : (openReviews > 0 ? 'is-warn' : '')],
    ['Bäume im Katalog', `${fmtInt(inv.listed)} / ${fmtInt(inv.trees)}`, inv.trees > 0 && inv.listed === 0 ? 'is-bad' : ''],
    ['App-Fehler (24 h)', fmtInt(d.errors && d.errors.last24h), d.errors && d.errors.last24h > 0 ? 'is-warn' : '']
  ];
  view.append(el('h2', { text: 'Übersicht' }),
    el('div', { class: 'grid kpis' }, tiles.map(([label, value, tone]) => el('div', { class: `kpi ${tone}` }, [el('b', { text: value }), el('span', { class: 'muted', text: label })]))));

  const history = await api().adminKpiHistory().then((res) => (Array.isArray(res.data) ? res.data : [])).catch((error) => { logError('kpi history', error); return []; });
  view.append(trendBlock(history));

  const hints = buildHints(d);
  const tone = { bad: 'alert-error', warn: 'alert-warn', info: 'alert-info' };
  const word = { bad: 'Dringend', warn: 'Wichtig', info: 'Hinweis' };
  view.append(el('section', { class: 'item' }, [
    el('h3', { text: 'Handlungsempfehlungen' }),
    el('p', { class: 'muted', text: 'Automatisch aus den Kennzahlen abgeleitet (feste Regeln, kein KI-Modell).' }),
    hints.length ? el('ul', { class: 'hints' }, hints.map((hint) => el('li', { class: `alert ${tone[hint.level]}` }, [
      el('span', {}, [el('strong', { text: `${word[hint.level]}: ` }), hint.text]),
      el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: hint.action, on: { click: () => show(hint.tab) } })])))
      : el('p', { class: 'alert alert-ok', text: 'Nichts zu tun: Keine der Regeln schlägt an.' })
  ]));

  const months = Array.isArray(d.months) ? d.months : [];
  if (months.length) {
    const series = (key, scale = 1) => months.map((m) => ({ label: monthLabel(m.month), short: monthLabel(m.month).split(' ')[0], value: (Number(m[key]) || 0) / scale }));
    view.append(el('div', { class: 'grid charts' }, [
      barChart({ title: 'Freigegebenes Volumen pro Monat (USD)', points: series('approvedMinor', 100), format: fmtMoney }),
      barChart({ title: 'Neue Anfragen pro Monat', points: series('requests'), format: fmtInt }),
      barChart({ title: 'Registrierungen pro Monat', points: series('signups'), format: fmtInt })
    ]));
  }
  const funnel = d.funnel || {};
  const steps = [['E-Mail bestätigt', funnel.confirmed], ['Anteile angefragt', funnel.requested], ['Beleg hochgeladen', funnel.proof], ['Besitzt Anteile', funnel.owners]];
  const base = Math.max(1, Number(funnel.confirmed) || 0);
  view.append(el('section', { class: 'item' }, [el('h3', { text: 'Weg zum Kauf (Anzahl Konten)' }), el('div', { class: 'funnel' }, steps.map(([label, value]) => {
    const share = Math.min(100, Math.round(((Number(value) || 0) / base) * 100));
    const bar = el('div', { class: 'funnel-bar' }); bar.style.width = `${Math.max(share, 1)}%`;
    return el('div', { class: 'funnel-row' }, [el('span', { text: label }), el('div', { class: 'funnel-track' }, [bar]), el('strong', { text: `${fmtInt(value)} · ${share} %` })]);
  }))]));
  const mini = (title, obj, labels) => el('section', { class: 'item' }, [el('h3', { text: title }), el('p', { class: 'muted', text: Object.keys(labels).map((key) => `${labels[key]}: ${fmtInt(obj && obj[key])}`).join(' · ') })]);
  view.append(el('div', { class: 'grid cols-2' }, [
    mini('Geschenke', d.gifts, { open: 'offen', redeemed: 'eingelöst', cancelled: 'storniert', expired: 'abgelaufen' }),
    mini('Empfehlungen', d.referrals, { pending: 'offen', rewarded: 'belohnt', void: 'verfallen' }),
    mini('Olivenöl', d.oil, { requestsPending: 'Anfragen offen', requestsApproved: 'freigegeben' }),
    mini('Rollen', d.roles, { investor: 'Baumpaten', farmer: 'Landwirte', mill_operator: 'Ölmühlen', finance_admin: 'Finanz-Admins', quality_auditor: 'Qualitätsprüfer', admin: 'Admins' })
  ]));
  view.append(el('p', { class: 'muted', text: `Stand ${fmtDate(d.generatedAt)}` }));
}

async function viewPayments(view) {
  const items = await api().listReviewQueueMapped('payments');
  view.append(el('h2', { text: 'Zahlungen zur Prüfung' }));
  if (!items.length) { view.append(stateBlock('empty', 'Keine offenen Zahlungen.')); return; }
  const list = el('div', { class: 'stack' });
  for (const item of items) list.append(paymentCard(item));
  view.append(list);
}

function paymentCard(item) {
  const screening = el('p', { class: 'item-meta', text: 'Sanktionsprüfung: wird geladen …' });
  const refreshScreening = async () => {
    try {
      const { data } = await api().paymentScreeningState({ requestId: item.id });
      if (!data) { screening.textContent = 'Sanktionsprüfung: noch keine erfasst.'; return; }
      const label = { clear: 'unauffällig', hit: 'Treffer', unclear: 'unklar' }[data.result] || data.result;
      screening.textContent = `Sanktionsprüfung: ${label} · ${data.listsChecked || ''} · ${fmtDate(data.checkedAt)}${data.checkedBySelf ? ' · von Ihnen' : ''}`;
    } catch (error) {
      logError('screening state', error);
      screening.textContent = 'Sanktionsprüfung: Stand konnte nicht geladen werden.';
    }
  };
  refreshScreening();
  const act = (label, cls, handler) => el('button', { type: 'button', class: `btn btn-sm ${cls}`, text: label, on: { click: handler } });
  return el('article', { class: 'item' }, [
    el('div', { class: 'row row-between' }, [el('h3', { text: item.user_name || 'Unbekannt' }), el('strong', { text: fmtMoney(item.amount_usd) })]),
    el('p', { class: 'item-meta', text: `${item.notes || ''} · eingegangen ${item.date || '–'}` }),
    el('p', { class: 'mono item-meta', text: `Anfrage ${String(item.id).slice(0, 16)}…` }),
    screening,
    el('div', { class: 'row' }, [
      act('Beleg ansehen', 'btn-ghost', () => openProof(item)),
      act('Prüfung erfassen', 'btn-ghost', () => recordScreening(item, refreshScreening)),
      act('Freigeben', 'btn-primary', () => decidePayment(item, true)),
      act('Ablehnen', 'btn-danger', () => decidePayment(item, false))
    ])
  ]);
}

async function openProof(item) {
  try {
    const { data } = await api().getPaymentProofUrl({ requestId: item.id });
    const url = String((data && data.url) || '');
    if (!url.startsWith(`${SUPABASE_ORIGIN}/storage/`)) throw new Error('unexpected proof url');
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch (error) {
    logError('proof', error);
    toast(error && error.code === 'not-found' ? 'Zu dieser Anfrage wurde kein Beleg hochgeladen.' : errorText(error), true);
  }
}

function recordScreening(item, done) {
  const result = el('select', {}, [['clear', 'unauffällig'], ['unclear', 'unklar'], ['hit', 'Treffer']].map(([value, text]) => el('option', { value, text })));
  const lists = el('input', { type: 'text', maxlength: 300, placeholder: 'z. B. EU, UN, OFAC' });
  const reference = el('input', { type: 'text', maxlength: 120 });
  const note = el('textarea', { maxlength: 500 });
  return openDialog({
    title: 'Sanktionsprüfung erfassen',
    text: `Zahler: ${item.user_name || 'Unbekannt'}. Erfasst wird, dass und gegen welche Listen geprüft wurde.`,
    confirmLabel: 'Speichern',
    build: (body) => body.append(field('Ergebnis', result), field('Geprüfte Listen', lists), field('Referenz (optional)', reference), field('Notiz (Pflicht bei „unklar" oder „Treffer")', note)),
    onConfirm: async () => {
      if (lists.value.trim().length < 3) throw userError('Bitte angeben, welche Listen geprüft wurden.');
      if (result.value !== 'clear' && note.value.trim().length < 3) throw userError('Bei „unklar" oder „Treffer" ist eine Notiz nötig.');
      await api().recordPaymentScreening({ requestId: item.id, result: result.value, listsChecked: lists.value.trim(), reference: reference.value.trim() || undefined, note: note.value.trim() || undefined });
    }
  }).then((ok) => { if (ok) { toast('Prüfung gespeichert.'); done(); } });
}

function decidePayment(item, approve) {
  const note = el('textarea', { maxlength: 500 });
  return openDialog({
    title: approve ? 'Zahlung freigeben' : 'Zahlung ablehnen',
    text: `${item.user_name || 'Unbekannt'} · ${fmtMoney(item.amount_usd)} · ${item.notes || ''}. ${approve ? 'Die Anteile werden damit zugeteilt.' : 'Die Reservierung wird aufgehoben.'} Das lässt sich nicht rückgängig machen.`,
    confirmLabel: approve ? 'Freigeben' : 'Ablehnen',
    danger: !approve,
    build: (body) => body.append(field(approve ? 'Notiz (optional)' : 'Begründung für den Zahler', note)),
    onConfirm: async () => {
      if (!approve && note.value.trim().length < 3) throw userError('Bitte eine kurze Begründung angeben.');
      await api().reviewInvestmentRequest({ requestId: item.id, decision: approve ? 'approve' : 'reject', note: note.value.trim() });
    }
  }).then((ok) => { if (ok) { toast(approve ? 'Zahlung freigegeben.' : 'Zahlung abgelehnt.'); show('payments'); } });
}

async function viewRoles(view) {
  const items = await api().listReviewQueueMapped('role_applications');
  view.append(el('h2', { text: 'Rollenanträge' }));
  if (!items.length) { view.append(stateBlock('empty', 'Keine offenen Rollenanträge.')); return; }
  const decide = (item, approve) => {
    const note = el('textarea', { maxlength: 500 });
    return openDialog({
      title: approve ? 'Rolle vergeben' : 'Antrag ablehnen',
      text: `${item.user_name || 'Unbekannt'} beantragt die Rolle „${ROLE_LABEL[item.role] || item.role || '?'}".`,
      confirmLabel: approve ? 'Vergeben' : 'Ablehnen', danger: !approve,
      build: (body) => body.append(field('Notiz (optional)', note)),
      onConfirm: () => api().reviewRoleApplication({ userId: item.id, decision: approve ? 'approve' : 'reject', note: note.value.trim() })
    }).then((ok) => { if (ok) { toast('Antrag entschieden.'); show('roles'); } });
  };
  view.append(el('div', { class: 'stack' }, items.map((item) => el('article', { class: 'item' }, [
    el('div', { class: 'row row-between' }, [el('h3', { text: item.user_name || 'Unbekannt' }), el('span', { class: 'badge', text: ROLE_LABEL[item.role] || item.role || '?' })]),
    el('p', { class: 'item-meta', text: `eingegangen ${item.date || '–'}` }),
    el('div', { class: 'row' }, [
      el('button', { type: 'button', class: 'btn btn-sm btn-primary', text: 'Vergeben', on: { click: () => decide(item, true) } }),
      el('button', { type: 'button', class: 'btn btn-sm btn-danger', text: 'Ablehnen', on: { click: () => decide(item, false) } })
    ])
  ]))));
}

async function viewUsers(view) {
  const users = await api().adminListUsers();
  const search = el('input', { type: 'search', placeholder: 'Name oder E-Mail', 'aria-label': 'Nutzer suchen' });
  const body = el('tbody');
  const count = el('p', { class: 'muted' });
  const render = () => {
    const term = search.value.trim().toLowerCase();
    const rows = users.filter((u) => !term || `${u.name} ${u.email}`.toLowerCase().includes(term));
    count.textContent = `${rows.length} von ${users.length} Konten`;
    body.replaceChildren(...(rows.length ? rows.map(userRow) : [el('tr', {}, [el('td', { colspan: 6, class: 'state', text: 'Kein Konto passt zur Suche.' })])]));
  };
  search.addEventListener('input', render);
  view.append(el('h2', { text: 'Nutzer und Rollen' }), el('div', { class: 'row row-between' }, [el('div', { class: 'field' }, [search]), count]),
    el('div', { class: 'table-wrap' }, [el('table', {}, [
      el('thead', {}, [el('tr', {}, ['Name', 'E-Mail', 'Rolle', 'Status', 'Seit', 'Aktion'].map((text) => el('th', { scope: 'col', text })))]), body])]));
  render();
}

function userRow(user) {
  const isSelf = session.user && user.id === session.user.uid;
  const serverRole = user.role === 'mill_owner' ? 'mill_operator' : (user.role || 'investor');
  const select = el('select', { 'aria-label': `Rolle von ${user.name}`, disabled: isSelf }, ROLES.map((role) => el('option', { value: role, text: ROLE_LABEL[role], selected: role === serverRole })));
  select.addEventListener('change', () => {
    const next = select.value;
    openDialog({
      title: 'Rolle ändern',
      text: `${user.name} (${user.email}) erhält die Rolle „${ROLE_LABEL[next]}" statt „${ROLE_LABEL[serverRole]}".${next === 'admin' ? ' Ein Admin hat vollen Zugriff auf alle Daten und Freigaben.' : ''}`,
      confirmLabel: 'Rolle ändern', danger: next === 'admin',
      onConfirm: () => api().adminSetUserRole({ userId: user.id, role: next })
    }).then((ok) => { if (ok) { toast('Rolle geändert.'); show('users'); } else select.value = serverRole; });
  });
  const suspended = user.status === 'suspended';
  const toggle = el('button', { type: 'button', class: `btn btn-sm ${suspended ? 'btn-ghost' : 'btn-danger'}`, text: suspended ? 'Entsperren' : 'Sperren', disabled: isSelf, on: { click: () => openDialog({
    title: suspended ? 'Konto entsperren' : 'Konto sperren',
    text: `${user.name} (${user.email}) ${suspended ? 'kann sich danach wieder anmelden.' : 'wird abgemeldet und kann sich nicht mehr anmelden.'}`,
    confirmLabel: suspended ? 'Entsperren' : 'Sperren', danger: !suspended,
    onConfirm: () => api().adminSetUserStatus({ userId: user.id, status: suspended ? 'active' : 'suspended' })
  }).then((ok) => { if (ok) { toast('Kontostatus geändert.'); show('users'); } }) } });
  return el('tr', {}, [
    el('td', { text: user.name + (isSelf ? ' (Sie)' : '') }), el('td', { class: 'mono', text: user.email }), el('td', {}, [select]),
    el('td', {}, [el('span', { class: `badge ${suspended ? 'badge-bad' : (user.verified ? 'badge-ok' : 'badge-warn')}`, text: suspended ? 'gesperrt' : (user.verified ? 'aktiv' : 'unbestätigt') })]),
    el('td', { text: user.joined_date || '–' }),
    el('td', {}, [el('div', { class: 'row' }, [toggle, el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Details', 'aria-label': `Details zu ${user.name}`, on: { click: () => openUserDetail(user) } })])])
  ]);
}

/** One person's record with requests, shares and field assignments. Opening it is audit-logged by the server. */
async function openUserDetail(user) {
  let detail;
  try {
    ({ data: detail } = await api().adminUserDetail({ userId: user.id }));
  } catch (error) {
    logError('user detail', error);
    toast(errorText(error), true);
    return;
  }
  const status = el('p', { class: 'muted', role: 'status' });
  const assignments = el('div');
  const change = async (kind, action, targetId) => {
    status.textContent = 'Wird gespeichert …';
    try {
      await api().adminAssign({ userId: user.id, kind, action, targetId });
      detail.assignments = await api().adminListAssignments(user.id);
      status.textContent = action === 'add' ? 'Zuweisung gespeichert.' : 'Zuweisung entfernt.';
      renderAssignments();
    } catch (error) {
      logError('assign', error);
      status.textContent = errorText(error);
    }
  };
  const assignmentBlock = (title, kind, ids, placeholder) => {
    const input = el('input', { type: 'text', maxlength: 80, placeholder, autocomplete: 'off', 'aria-label': `${title}: Kennung` });
    const add = () => {
      const id = input.value.trim();
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) { status.textContent = 'Die Kennung darf nur Buchstaben, Ziffern, _ und - enthalten.'; return; }
      change(kind, 'add', id);
    };
    return el('div', {}, [
      el('h4', { text: title }),
      ids.length ? el('ul', { class: 'plain-list' }, ids.map((id) => el('li', { class: 'row row-between' }, [
        el('span', { class: 'mono', text: id }),
        el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Entfernen', 'aria-label': `${id} entfernen`, on: { click: () => change(kind, 'remove', id) } })
      ]))) : el('p', { class: 'muted', text: 'Keine Zuweisung.' }),
      el('div', { class: 'row' }, [input, el('button', { type: 'button', class: 'btn btn-sm btn-primary', text: 'Zuweisen', on: { click: add } })])
    ]);
  };
  const renderAssignments = () => {
    const trees = (detail.assignments && detail.assignments.trees) || [];
    const mills = (detail.assignments && detail.assignments.mills) || [];
    const isFarmer = detail.role === 'farmer' || trees.length > 0;
    const isMill = detail.role === 'mill_operator' || detail.role === 'mill_owner' || mills.length > 0;
    assignments.replaceChildren(
      isFarmer ? assignmentBlock('Betreute Bäume', 'farmer_tree', trees, 'z. B. tree_01') : null,
      isMill ? assignmentBlock('Ölmühlen', 'mill', mills, 'z. B. mill_01') : null,
      !isFarmer && !isMill ? el('p', { class: 'muted', text: 'Zuweisungen gibt es nur für Landwirte und Ölmühlen. Dafür zuerst die Rolle ändern.' }) : null
    );
  };
  const facts = [
    ['E-Mail', detail.email || '–'], ['Telefon', detail.phone || '–'], ['Region', detail.region || '–'],
    ['Rolle', ROLE_LABEL[detail.role] || detail.role], ['Beantragte Rolle', ROLE_LABEL[detail.requestedRole] || detail.requestedRole || '–'],
    ['Registriert', fmtDate(detail.createdAt)], ['E-Mail bestätigt', detail.emailConfirmedAt ? fmtDate(detail.emailConfirmedAt) : 'nein'],
    ['Letzte Anmeldung', detail.lastSignInAt ? fmtDate(detail.lastSignInAt) : 'nie'], ['Status', detail.suspended ? 'gesperrt' : 'aktiv'],
    ['Newsletter', detail.marketingOptIn ? 'eingewilligt' : 'nein'], ['Push-Geräte', fmtInt(detail.counts && detail.counts.pushDevices)],
    ['Geworbene Personen', fmtInt(detail.counts && detail.counts.referralsMade)], ['Öl zugeteilt', `${fmtInt(Math.round((Number(detail.counts && detail.counts.oilAllocatedMl) || 0) / 1000))} l`]
  ];
  const requests = detail.requests || [];
  const shares = detail.shares || [];
  await openDialog({
    title: detail.displayName || user.name || 'Nutzer', confirmLabel: 'Schließen',
    build: (body) => {
      renderAssignments();
      body.append(
        el('dl', { class: 'facts' }, facts.flatMap(([term, value]) => [el('dt', { text: term }), el('dd', { text: value })])),
        el('h3', { text: `Anteile (${shares.length})` }),
        shares.length ? el('ul', { class: 'plain-list' }, shares.map((share) => el('li', { text: `${share.treeId}: ${fmtInt(share.shareCount)} Anteil(e)${share.includesLand ? ' + Parzelle' : ''} · seit ${fmtDate(share.createdAt)}` }))) : el('p', { class: 'muted', text: 'Hält keine Anteile.' }),
        el('h3', { text: `Anfragen (${fmtInt(detail.counts && detail.counts.requests)})` }),
        requests.length ? el('ul', { class: 'plain-list' }, requests.map((request) => el('li', {}, [
          `${fmtDate(request.createdAt)} · ${request.treeId} · ${fmtInt(request.shareCount)} × · ${fmtMinor(request.amountMinor)} `,
          el('span', { class: `badge ${STATUS_TONE[request.status] || ''}`, text: STATUS_LABEL[request.status] || request.status })
        ]))) : el('p', { class: 'muted', text: 'Keine Anfragen.' }),
        el('h3', { text: 'Zuweisungen' }), assignments, status
      );
    },
    onConfirm: async () => {}
  });
}

function channelList(channels) {
  if (!channels || !channels.length) return el('p', { class: 'muted', text: 'Keine Konten hinterlegt.' });
  return el('ul', {}, channels.map((ch) => el('li', {}, [el('strong', { text: `${CHANNEL_LABEL[ch.id] || ch.id}: ` }), el('span', { class: 'mono', text: ch.account || '' }), ` · ${ch.titleEn || ''} · ${ch.titleAr || ''}`])));
}

async function viewAccounts(view) {
  const { data } = await api().adminPaymentState();
  const live = (data && data.live) || null;
  const pending = (data && data.pending) || null;
  view.append(el('h2', { text: 'Empfangskonten' }));
  view.append(el('p', { class: `alert ${data && data.fourEyes ? 'alert-ok' : 'alert-warn'}`, text: data && data.fourEyes
    ? `Vier-Augen-Prinzip aktiv (${data.adminCount} Admins): Eine Änderung gilt erst, wenn ein zweiter Admin sie bestätigt.`
    : 'Nur ein Admin vorhanden: Änderungen gelten sofort. Ein zweiter Admin aktiviert das Vier-Augen-Prinzip.' }));
  view.append(el('section', { class: 'item' }, [el('h3', { text: 'Aktuell gültig' }), channelList(live && live.channels),
    el('p', { class: 'item-meta', text: live && live.updatedAt ? `Stand ${fmtDate(live.updatedAt)}` : 'Solange nichts hinterlegt ist, sperrt der Checkout die Zahlungsanweisung.' })]));
  if (pending) {
    const review = (decision) => openDialog({
      title: decision === 'approve' ? 'Änderung bestätigen' : (pending.proposedBySelf ? 'Vorschlag zurückziehen' : 'Änderung ablehnen'),
      text: decision === 'approve' ? 'Die vorgeschlagenen Konten werden damit für alle Kunden gültig. Bitte jede Kontonummer mit einer unabhängigen Quelle vergleichen.' : 'Der Vorschlag wird verworfen; die bisherigen Konten bleiben gültig.',
      confirmLabel: decision === 'approve' ? 'Bestätigen' : 'Verwerfen', danger: decision !== 'approve',
      onConfirm: () => api().adminReviewPaymentInstructions({ decision })
    }).then((ok) => { if (ok) { toast('Entscheidung gespeichert.'); show('accounts'); } });
    view.append(el('section', { class: 'item' }, [
      el('h3', { text: 'Offener Änderungsvorschlag' }), channelList(pending.channels),
      el('p', { class: 'item-meta', text: `${pending.proposedBySelf ? 'Von Ihnen vorgeschlagen' : 'Von einem anderen Admin vorgeschlagen'} · ${fmtDate(pending.proposedAt)}` }),
      el('div', { class: 'row' }, [
        el('button', { type: 'button', class: 'btn btn-sm btn-primary', text: 'Bestätigen', disabled: pending.proposedBySelf === true, on: { click: () => review('approve') } }),
        el('button', { type: 'button', class: 'btn btn-sm btn-danger', text: pending.proposedBySelf ? 'Zurückziehen' : 'Ablehnen', on: { click: () => review('reject') } })
      ]),
      pending.proposedBySelf ? el('p', { class: 'muted', text: 'Den eigenen Vorschlag kann nur ein anderer Admin bestätigen.' }) : null
    ]));
  }
  const rows = [0, 1, 2].map((i) => {
    const current = (live && live.channels && live.channels[i]) || {};
    return {
      type: el('select', {}, [el('option', { value: '', text: '— nicht verwendet —' })].concat(CHANNEL_TYPES.map((id) => el('option', { value: id, text: CHANNEL_LABEL[id], selected: current.id === id })))),
      titleEn: el('input', { type: 'text', maxlength: 80, value: current.titleEn || '' }), titleAr: el('input', { type: 'text', maxlength: 80, dir: 'rtl', lang: 'ar', value: current.titleAr || '' }),
      account: el('input', { type: 'text', maxlength: 60, class: 'mono', value: current.account || '', autocomplete: 'off' }),
      hintEn: el('input', { type: 'text', maxlength: 200, value: current.hintEn || '' }), hintAr: el('input', { type: 'text', maxlength: 200, dir: 'rtl', lang: 'ar', value: current.hintAr || '' })
    };
  });
  const formError = el('p', { class: 'alert alert-error', role: 'alert', hidden: true });
  const save = el('button', { type: 'button', class: 'btn btn-primary', text: data && data.fourEyes ? 'Änderung vorschlagen' : 'Speichern' });
  save.addEventListener('click', () => {
    const channels = rows.filter((r) => r.type.value).map((r) => ({ id: r.type.value, titleAr: r.titleAr.value.trim(), titleEn: r.titleEn.value.trim(), account: r.account.value.trim(), hintAr: r.hintAr.value.trim() || undefined, hintEn: r.hintEn.value.trim() || undefined }));
    const invalid = channels.length === 0 || channels.some((ch) => ch.titleAr.length < 2 || ch.titleEn.length < 2 || !/^[A-Za-z0-9 +./-]{3,60}$/.test(ch.account));
    formError.hidden = !invalid;
    if (invalid) { formError.textContent = 'Mindestens ein Konto mit beiden Bezeichnungen und einer gültigen Kontonummer (3–60 Zeichen: Buchstaben, Ziffern, Leerzeichen, + . / -).'; return; }
    openDialog({
      title: 'Empfangskonten ändern',
      text: 'An diese Konten überweisen Kunden ihr Geld. Bitte jede Nummer Zeichen für Zeichen prüfen.',
      confirmLabel: save.textContent, danger: true,
      build: (body) => body.append(channelList(channels)),
      onConfirm: () => api().adminSetPaymentInstructions({ channels })
    }).then((ok) => { if (ok) { toast('Gespeichert.'); show('accounts'); } });
  });
  view.append(el('section', { class: 'item stack' }, [el('h3', { text: 'Konten ändern' })].concat(rows.map((r, i) => el('fieldset', { class: 'grid cols-2' }, [
    el('legend', { text: `Konto ${i + 1}` }), field('Art', r.type), field('Kontonummer / IBAN', r.account), field('Bezeichnung (Englisch)', r.titleEn), field('Bezeichnung (Arabisch)', r.titleAr), field('Hinweis (Englisch, optional)', r.hintEn), field('Hinweis (Arabisch, optional)', r.hintAr)
  ])), [formError, save])));
}

async function viewExport(view) {
  const now = new Date();
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const from = el('input', { type: 'date', value: iso(new Date(now.getFullYear(), now.getMonth(), 1)) });
  const to = el('input', { type: 'date', value: iso(now) });
  const info = el('p', { class: 'muted', role: 'status' });
  const button = el('button', { type: 'button', class: 'btn btn-primary', text: 'CSV herunterladen' });
  button.addEventListener('click', async () => {
    if (!from.value || !to.value || from.value > to.value) { toast('Bitte einen gültigen Zeitraum wählen.', true); return; }
    button.disabled = true;
    info.textContent = 'Export wird erstellt …';
    try {
      const { data } = await api().financeExport({ from: from.value, to: to.value });
      const rows = (data && data.rows) || [];
      const lines = [FINANCE_COLUMNS.concat('amountMajor').join(',')];
      for (const row of rows) lines.push(FINANCE_COLUMNS.map((col) => csvCell(row[col])).concat(csvCell(Number.isSafeInteger(row.amountMinor) ? (row.amountMinor / 100).toFixed(2) : '')).join(','));
      const url = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' }));
      const link = el('a', { href: url, download: `faseela-finanzen-${from.value}_${to.value}.csv` });
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      info.textContent = `${rows.length} Zeilen exportiert${data && data.truncated ? ' (gekürzt – bitte Zeitraum verkleinern)' : ''}.`;
    } catch (error) {
      logError('export', error);
      info.textContent = '';
      toast(errorText(error), true);
    } finally {
      button.disabled = false;
    }
  });
  view.append(el('h2', { text: 'Finanz-Export' }), el('p', { class: 'muted', text: 'Der Export enthält Namen und E-Mail-Adressen der Zahler. Jeder Abruf wird im Audit-Log festgehalten. Datei nur auf geschützten Geräten speichern.' }),
    el('section', { class: 'item' }, [el('div', { class: 'grid cols-2' }, [field('Von', from), field('Bis', to)]), button, info]));
}

async function viewAudit(view) {
  const rows = await api().adminListAuditLogs(150);
  view.append(el('h2', { text: 'Audit-Log (letzte 150 Einträge)' }));
  if (!rows.length) { view.append(stateBlock('empty', 'Noch keine Einträge.')); return; }
  view.append(el('div', { class: 'table-wrap' }, [el('table', {}, [
    el('thead', {}, [el('tr', {}, ['Zeit', 'Aktion', 'Ziel', 'Akteur', 'Details'].map((text) => el('th', { scope: 'col', text })))]),
    el('tbody', {}, rows.map((row) => el('tr', {}, [
      el('td', { text: fmtDate(row.createdAt) }), el('td', { text: row.action }), el('td', { class: 'mono', text: String(row.target || '').slice(0, 60) }),
      el('td', { class: 'mono', text: row.actorUid ? String(row.actorUid).slice(0, 8) : 'System' }), el('td', { class: 'mono', text: JSON.stringify(row.details || {}).slice(0, 160) })
    ])))
  ])]));
}

async function viewSystem(view) {
  const [status, pub] = await Promise.all([api().adminSystemStatus(), api().publicStatus().catch((error) => { logError('public status', error); return null; })]);
  const kv = (title, obj) => el('section', { class: 'item' }, [el('h3', { text: title }), el('div', { class: 'table-wrap' }, [el('table', {}, [el('tbody', {}, Object.entries(obj || {}).map(([key, value]) =>
    el('tr', {}, [el('th', { scope: 'row', text: key }), el('td', { class: 'mono', text: typeof value === 'object' && value !== null ? JSON.stringify(value).slice(0, 300) : String(value) })])))])])]);
  view.append(el('h2', { text: 'System' }));
  if (pub) view.append(kv('Öffentlicher Status', pub));
  view.append(kv('E-Mail-Warteschlange', status && status.outbox), kv('Offene Prüfungen', status && status.reviews), kv('App-Fehler', status && status.clientErrors));
  const jobs = (status && Array.isArray(status.jobs)) ? status.jobs : [];
  view.append(el('section', { class: 'item' }, [el('h3', { text: 'Hintergrundjobs' }), jobs.length
    ? el('div', { class: 'table-wrap' }, [el('table', {}, [el('tbody', {}, jobs.map((job) => el('tr', {}, [el('th', { scope: 'row', text: job.name || '?' }), el('td', { class: 'mono', text: JSON.stringify(Object.fromEntries(Object.entries(job).filter(([key]) => key !== 'name'))).slice(0, 200) })])))])])
    : el('p', { class: 'muted', text: 'Keine Jobdaten.' })]));
}

async function viewReviews(view) {
  const queues = REVIEW_QUEUES[session.user.role] || [];
  const results = await Promise.allSettled(queues.map((queue) => api().listReviewQueueMapped(queue)));
  view.append(el('h2', { text: 'Weitere Prüfungen' }));
  let total = 0;
  results.forEach((result, index) => {
    const queue = queues[index];
    const section = el('section', { class: 'stack' }, [el('h3', { text: QUEUE_LABEL[queue] })]);
    if (result.status === 'rejected') { logError(`queue ${queue}`, result.reason); section.append(el('p', { class: 'alert alert-error', role: 'alert', text: errorText(result.reason) })); }
    else if (!result.value.length) section.append(el('p', { class: 'muted', text: 'Nichts offen.' }));
    else { total += result.value.length; for (const item of result.value) section.append(reviewCard(queue, item)); }
    view.append(section);
  });
  if (total === 0 && results.every((result) => result.status === 'fulfilled')) view.append(stateBlock('empty', 'Alle Warteschlangen sind leer.'));
}

function reviewCard(queue, item) {
  const media = el('div', { class: 'row' });
  if (queue === 'farmer_updates' && Array.isArray(item.mediaPaths) && item.mediaPaths.length) {
    media.append(el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: `${item.mediaPaths.length} Foto(s) ansehen`, on: { click: async () => {
      try {
        const signed = await api().signFieldMedia(item.mediaPaths);
        const usable = signed.filter((entry) => entry.url && String(entry.url).startsWith(`${SUPABASE_ORIGIN}/storage/`));
        if (!usable.length) { toast('Die Fotos konnten nicht geladen werden.', true); return; }
        media.replaceChildren(...usable.map((entry, i) => el('a', { href: entry.url, target: '_blank', rel: 'noopener noreferrer', class: 'btn btn-sm btn-ghost', text: `Foto ${i + 1} öffnen` })));
        if (usable.length < item.mediaPaths.length) media.append(el('span', { class: 'badge badge-bad', text: `${item.mediaPaths.length - usable.length} nicht ladbar` }));
      } catch (error) { logError('media', error); toast(errorText(error), true); }
    } } }));
  }
  const verbs = { farmer_updates: ['Veröffentlichen', 'publish'], pressing_batches: ['Zertifizieren', 'certify'], oil_requests: ['Freigeben', 'approve'], oil_fulfilment: ['Als ausgeliefert markieren', 'fulfil'] }[queue];
  const decide = (approve) => {
    const note = el('textarea', { maxlength: 500 });
    const serial = el('input', { type: 'text', maxlength: 60 });
    return openDialog({
      title: approve ? verbs[0] : 'Ablehnen',
      text: `${QUEUE_LABEL[queue]} · ${item.user_name || 'Unbekannt'} · ${String(item.notes || '').slice(0, 200)}`,
      confirmLabel: approve ? verbs[0] : 'Ablehnen', danger: !approve,
      build: (body) => { if (queue === 'pressing_batches' && approve) body.append(field('Nummer des Laborzertifikats', serial)); body.append(field(approve ? 'Notiz (optional)' : 'Begründung', note)); },
      onConfirm: async () => {
        const text = note.value.trim();
        if (!approve && text.length < 3) throw userError('Bitte eine kurze Begründung angeben.');
        const decision = approve ? verbs[1] : 'reject';
        if (queue === 'farmer_updates') await api().reviewFarmerUpdate({ updateId: item.id, decision, note: text });
        else if (queue === 'pressing_batches') {
          if (approve && serial.value.trim().length < 3) throw userError('Zum Zertifizieren wird die Nummer des Laborzertifikats benötigt.');
          await api().certifyPressingBatch({ batchId: item.id, decision, certificateSerial: serial.value.trim() || undefined, note: text });
        } else await api().reviewOilRequest({ requestId: item.id, decision, note: text });
      }
    }).then((ok) => { if (ok) { toast('Entscheidung gespeichert.'); show('reviews'); } });
  };
  return el('article', { class: 'item' }, [
    el('div', { class: 'row row-between' }, [el('h3', { text: item.user_name || 'Unbekannt' }), el('span', { class: 'badge', text: item.channel || QUEUE_LABEL[queue] })]),
    el('p', { text: String(item.notes || '') }),
    el('p', { class: 'item-meta', text: `${item.treeId ? `Baum ${item.treeId} · ` : ''}eingegangen ${item.date || '–'}${Number.isFinite(item.gpsLat) && Number.isFinite(item.gpsLng) ? ` · GPS ${item.gpsLat.toFixed(4)}, ${item.gpsLng.toFixed(4)}` : ''}` }),
    media,
    el('div', { class: 'row' }, [
      el('button', { type: 'button', class: 'btn btn-sm btn-primary', text: verbs[0], on: { click: () => decide(true) } }),
      el('button', { type: 'button', class: 'btn btn-sm btn-danger', text: 'Ablehnen', on: { click: () => decide(false) } })
    ])
  ]);
}

const investmentFilter = { status: '', offset: 0 };
async function viewInvestments(view) {
  const PAGE = 25;
  const { data } = await api().adminListInvestments({ status: investmentFilter.status || undefined, limit: PAGE, offset: investmentFilter.offset });
  const rows = (data && data.rows) || [];
  const total = (data && data.total) || 0;
  const select = el('select', { 'aria-label': 'Nach Status filtern' }, [el('option', { value: '', text: 'Alle Status' })].concat(Object.keys(STATUS_LABEL).map((key) => el('option', { value: key, text: STATUS_LABEL[key], selected: key === investmentFilter.status }))));
  select.addEventListener('change', () => { investmentFilter.status = select.value; investmentFilter.offset = 0; show('investments'); });
  const pager = el('div', { class: 'row' }, [
    el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Zurück', disabled: investmentFilter.offset === 0, on: { click: () => { investmentFilter.offset = Math.max(0, investmentFilter.offset - PAGE); show('investments'); } } }),
    el('span', { class: 'muted', text: total ? `${investmentFilter.offset + 1}–${Math.min(investmentFilter.offset + rows.length, total)} von ${total}` : '0 Einträge' }),
    el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Weiter', disabled: investmentFilter.offset + rows.length >= total, on: { click: () => { investmentFilter.offset += PAGE; show('investments'); } } })
  ]);
  view.append(el('h2', { text: 'Patenschaften' }), el('div', { class: 'row row-between' }, [el('div', { class: 'field' }, [select]), pager]));
  if (!rows.length) { view.append(stateBlock('empty', investmentFilter.status ? 'Keine Anfragen mit diesem Status.' : 'Noch keine Investitionsanfragen.')); return; }
  view.append(el('div', { class: 'table-wrap' }, [el('table', {}, [
    el('thead', {}, [el('tr', {}, ['Datum', 'Zahler', 'Baum', 'Anteile', 'Betrag', 'Status', 'Beleg'].map((text) => el('th', { scope: 'col', text })))]),
    el('tbody', {}, rows.map((row) => el('tr', {}, [
      el('td', { text: fmtDate(row.createdAt) }),
      el('td', {}, [el('div', { text: row.payerName || '–' }), el('div', { class: 'mono item-meta', text: row.payerEmail || '' })]),
      el('td', { class: 'mono', text: row.treeId }), el('td', { text: `${fmtInt(row.shareCount)}${row.includesLand ? ' + Parzelle' : ''}` }),
      el('td', { text: new Intl.NumberFormat('de-DE', { style: 'currency', currency: /^[A-Z]{3}$/.test(row.currency) ? row.currency : 'USD' }).format((Number(row.amountMinor) || 0) / 100) }),
      el('td', {}, [el('span', { class: `badge ${STATUS_TONE[row.status] || ''}`, text: STATUS_LABEL[row.status] || row.status }), row.slaBreached && row.status === 'under_review' ? el('span', { class: 'badge badge-bad', text: 'überfällig' }) : null]),
      el('td', {}, [row.hasProof ? el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Ansehen', on: { click: () => openProof({ id: row.id }) } }) : el('span', { class: 'muted', text: '–' })])
    ])))
  ])]));
}

/** Countries, farms and mills: the records trees point to. Planned countries stay invisible to visitors. */
async function viewMaster(view) {
  const { data } = await api().adminListMasterData();
  const master = data || {};
  const countries = Array.isArray(master.countries) ? master.countries : [];
  const countryLabel = (code) => { const c = countries.find((x) => x.code === code); return c ? `${c.nameDe || c.nameEn} (${code})` : code; };
  view.append(el('h2', { text: 'Stammdaten' }),
    el('p', { class: 'muted', text: 'Länder, Höfe und Mühlen, auf die Bäume verweisen. Ein geplantes Land ist für Besucher unsichtbar, bis es aktiviert wird. Höfe und Mühlen starten ausgeblendet.' }));

  view.append(el('h3', { text: 'Herkunftsländer' }));
  view.append(el('div', { class: 'table-wrap' }, [el('table', {}, [
    el('thead', {}, [el('tr', {}, ['Land', 'Angebotswährung', 'Bäume', 'Status'].map((text) => el('th', { scope: 'col', text })))]),
    el('tbody', {}, countries.map((c) => {
      const active = c.status === 'active';
      const toggle = el('button', { type: 'button', class: `btn btn-sm ${active ? 'btn-ghost' : 'btn-primary'}`, text: active ? 'Zurückstellen' : 'Aktivieren', 'aria-label': `${c.nameDe || c.code} ${active ? 'zurückstellen' : 'aktivieren'}`, on: { click: () => openDialog({
        title: active ? 'Land zurückstellen' : 'Land aktivieren',
        text: `${c.nameDe || c.nameEn} (${c.code}): ${active ? 'Das Land verschwindet aus dem Länderfilter. Das geht nur, solange dort kein Baum im Katalog steht.' : 'Das Land erscheint für Besucher, sobald dort ein Baum im Katalog steht.'}`,
        confirmLabel: active ? 'Zurückstellen' : 'Aktivieren',
        onConfirm: () => api().adminSetCountryStatus({ code: c.code, status: active ? 'planned' : 'active' })
      }).then((ok) => { if (ok) { toast('Status des Landes geändert.'); show('master'); } }) } });
      return el('tr', {}, [
        el('td', {}, [el('div', { text: c.nameDe || c.nameEn || c.code }), el('div', { class: 'mono item-meta', text: c.code })]),
        el('td', { class: 'mono', text: c.currency || '–' }), el('td', { text: fmtInt(c.trees) }),
        el('td', {}, [el('div', { class: 'row' }, [el('span', { class: `badge ${active ? 'badge-ok' : 'badge-warn'}`, text: active ? 'aktiv' : 'geplant' }), toggle])])
      ]);
    }))
  ])]));

  const siteTable = (kind, title, addLabel, items) => {
    const idKey = kind === 'farm' ? 'farmId' : 'millId';
    view.append(el('div', { class: 'row row-between' }, [el('h3', { text: title }),
      el('button', { type: 'button', class: 'btn btn-primary', text: addLabel, on: { click: () => editSite(kind, null, countries) } })]));
    if (!items.length) { view.append(stateBlock('empty', kind === 'farm' ? 'Noch keine Höfe angelegt.' : 'Noch keine Mühlen angelegt.')); return; }
    view.append(el('div', { class: 'table-wrap' }, [el('table', {}, [
      el('thead', {}, [el('tr', {}, ['Name', 'Land', 'Region', 'Bäume', 'Sichtbarkeit'].map((text) => el('th', { scope: 'col', text })))]),
      el('tbody', {}, items.map((site) => el('tr', {}, [
        el('td', {}, [el('div', { text: site.nameEn || site.name || '(ohne Namen)' }), el('div', { class: 'mono item-meta', text: site[idKey] })]),
        el('td', { text: countryLabel(site.countryCode) }), el('td', { text: site.regionEn || site.region || '–' }), el('td', { text: fmtInt(site.trees) }),
        el('td', {}, [el('div', { class: 'row' }, [el('span', { class: `badge ${site.status === 'listed' ? 'badge-ok' : 'badge-warn'}`, text: site.status === 'listed' ? 'sichtbar' : 'ausgeblendet' }),
          el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Bearbeiten', 'aria-label': `${site.nameEn || site[idKey]} bearbeiten`, on: { click: () => editSite(kind, site, countries) } })])])
      ])))
    ])]));
  };
  siteTable('farm', 'Höfe', 'Neuer Hof', Array.isArray(master.farms) ? master.farms : []);
  siteTable('mill', 'Mühlen', 'Neue Mühle', Array.isArray(master.mills) ? master.mills : []);
}

async function editSite(kind, site, countries) {
  const isFarm = kind === 'farm';
  const noun = isFarm ? 'Hof' : 'Mühle';
  const idKey = isFarm ? 'farmId' : 'millId';
  const text = (value, extra = {}) => el('input', { type: 'text', maxlength: 120, value: value || '', autocomplete: 'off', ...extra });
  const f = {
    id: text('', { maxlength: 40, placeholder: isFarm ? 'farm_04' : 'mill_03' }),
    country: el('select', {}, countries.map((c) => el('option', { value: c.code, text: `${c.nameDe || c.nameEn || c.code} (${c.code})${c.status === 'planned' ? ' – geplant' : ''}`, selected: c.code === ((site && site.countryCode) || 'SY') }))),
    name: text(site && site.name, { dir: 'rtl', lang: 'ar' }), nameEn: text(site && site.nameEn),
    region: text(site && site.region, { dir: 'rtl', lang: 'ar' }), regionEn: text(site && site.regionEn),
    listed: el('input', { type: 'checkbox', checked: site && site.status === 'listed' ? 'checked' : null })
  };
  const readText = (control, label, required) => {
    const value = control.value.trim();
    if (!value && !required) return '';
    if (value.length < 2 || /[<>]/.test(value)) throw userError(`${label} fehlt oder enthält unzulässige Zeichen.`);
    return value;
  };
  const ok = await openDialog({
    title: site ? `${noun} bearbeiten: ${site[idKey]}` : (isFarm ? 'Neuer Hof' : 'Neue Mühle'), confirmLabel: site ? 'Änderungen speichern' : `${noun} anlegen`,
    build: (body) => {
      body.append(
        site ? null : field('Kennung (klein, a–z, 0–9, _ ; später nicht änderbar)', f.id),
        el('div', { class: 'form-grid' }, [
          field('Land', f.country), el('span'),
          field('Name (Arabisch)', f.name), field('Name (Englisch)', f.nameEn),
          field('Region (Arabisch, optional)', f.region), field('Region (Englisch, optional)', f.regionEn)
        ]),
        el('label', { class: 'row' }, [f.listed, el('span', { text: 'Für Besucher sichtbar' })])
      );
    },
    onConfirm: async () => {
      const id = site ? site[idKey] : f.id.value.trim();
      if (!site && !/^[a-z0-9_]{3,40}$/.test(id)) throw userError('Kennung: 3 bis 40 Zeichen, nur Kleinbuchstaben, Ziffern und _.');
      const payload = {
        [idKey]: id, countryCode: f.country.value,
        name: readText(f.name, 'Name (Arabisch)', true), nameEn: readText(f.nameEn, 'Name (Englisch)', true),
        region: readText(f.region, 'Region (Arabisch)', false), regionEn: readText(f.regionEn, 'Region (Englisch)', false),
        status: f.listed.checked ? 'listed' : 'unlisted'
      };
      await (isFarm ? api().adminUpsertFarm(payload) : api().adminUpsertMill(payload));
    }
  });
  if (ok) { toast(`${noun} gespeichert.`); show('master'); }
}

const ORDER_STATUS = {
  awaiting_payment: ['wartet auf Zahlung', 'badge-warn'], under_review: ['Zahlung gemeldet', 'badge-warn'], paid: ['bezahlt', 'badge-ok'],
  shipped: ['versandt', 'badge-ok'], delivered: ['zugestellt', 'badge-ok'], cancelled: ['storniert', ''], expired: ['abgelaufen', ''], rejected: ['abgelehnt', 'badge-bad'], refunded: ['erstattet', 'badge-bad']
};
const PRODUCT_STATUS = { pending_review: ['wartet auf Prüfung', 'badge-warn'], listed: ['im Shop', 'badge-ok'], unlisted: ['ausgeblendet', ''], rejected: ['abgelehnt', 'badge-bad'] };
const PRODUCT_CATEGORY = { oil: 'Öl', olives: 'Oliven', dates: 'Datteln', nuts: 'Nüsse', fruit: 'Obst', preserves: 'Eingemachtes', other: 'Sonstiges' };
/** Minor units per currency as Intl knows them (EUR 2, TND 3, JPY 0). */
const unitFactor = (currency) => { try { return 10 ** new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits; } catch (error) { return 100; } };
const fmtPrice = (minor, currency) => { const code = /^[A-Z]{3}$/.test(currency) ? currency : 'EUR'; return new Intl.NumberFormat('de-DE', { style: 'currency', currency: code }).format((Number(minor) || 0) / unitFactor(code)); };
const SCREENING_LABEL = { clear: 'unauffällig', unclear: 'unklar', hit: 'Treffer' };
const fmtPercent = (bps) => `${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 2 }).format((Number(bps) || 0) / 100)} %`;
const asList = (value) => (Array.isArray(value) ? value : []);
const statusBadge = (map, status) => { const [text, tone] = map[status] || [status, '']; return el('span', { class: `badge ${tone}`, text }); };

/** Marketplace: orders with their payment decision and shipping, the farms' products, fee, shipping prices, farm access. */
async function viewMarket(view) {
  const isAdmin = session.user.role === 'admin';
  const [{ data }, users] = await Promise.all([api().adminListMarketplace(), isAdmin ? api().adminListUsers() : Promise.resolve([])]);
  const market = data || {};
  const farms = asList(market.farms);
  const farmLabel = (farmId) => { const farm = farms.find((f) => f.farmId === farmId); return farm ? (farm.nameEn || farm.name || farmId) : farmId; };
  const done = (message) => (ok) => { if (ok) { toast(message); show('market'); } };

  view.append(el('h2', { text: 'Marktplatz' }),
    el('p', { class: 'muted', text: `Höfe bieten Produkte an, Kunden bestellen und zahlen per Überweisung. Die Servicegebühr von ${fmtPercent(market.feeBps)} ist im Produktpreis enthalten: Der Kunde zahlt den angezeigten Preis plus Versand, der Hof erhält den Preis abzüglich der Gebühr. Umsatzsteuer wird hier noch nicht berechnet.` }));

  // ---- the switch that lets customers order at all
  const shopOpen = market.shopOpen === true;
  view.append(el('div', { class: 'item row row-between', id: 'shop-switch' }, [
    el('div', {}, [el('div', { class: 'row' }, [el('strong', { text: 'Hofladen' }), el('span', { class: `badge ${shopOpen ? 'badge-ok' : 'badge-warn'}`, text: shopOpen ? 'geöffnet' : 'geschlossen' })]),
      el('div', { class: 'item-meta', text: shopOpen ? 'Kunden können bestellen.' : 'Niemand kann bestellen. Höfe können Produkte einreichen, Sie können sie prüfen und Versandpreise hinterlegen.' })]),
    isAdmin ? el('button', { type: 'button', class: `btn ${shopOpen ? 'btn-danger' : 'btn-primary'}`, text: shopOpen ? 'Hofladen schließen' : 'Hofladen öffnen', on: { click: () => openDialog({
      title: shopOpen ? 'Hofladen schließen' : 'Hofladen öffnen', confirmLabel: shopOpen ? 'Schließen' : 'Jetzt öffnen', danger: shopOpen,
      text: shopOpen ? 'Neue Bestellungen sind danach nicht mehr möglich. Bestehende Bestellungen laufen weiter.'
        : 'Ab dann können Kunden verbindlich bestellen. Bitte erst öffnen, wenn rechtlich geklärt ist: Umsatzsteuer und Preisangabe, Widerrufsbelehrung und AGB für den Warenverkauf, wer Verkäufer ist (Hof oder Plattform), und wenn Empfangskonto und Versandpreise hinterlegt sind.',
      onConfirm: () => api().adminSetShopOpen({ open: !shopOpen })
    }).then(done(shopOpen ? 'Hofladen geschlossen.' : 'Hofladen geöffnet.')) } }) : null
  ]));

  // ---- orders
  const orders = asList(market.orders);
  view.append(el('h3', { text: 'Bestellungen' }));
  if (!orders.length) view.append(stateBlock('empty', 'Noch keine Bestellungen.'));
  else view.append(el('div', { class: 'table-wrap' }, [el('table', {}, [
    el('thead', {}, [el('tr', {}, ['Bestellung', 'Hof', 'Artikel', 'Ware', 'davon Gebühr', 'Hof erhält', 'Versand', 'Gesamt', 'Status', 'Aktionen'].map((text) => el('th', { scope: 'col', text })))]),
    el('tbody', {}, orders.map((order) => {
      const ref = order.paymentReference || String(order.orderId).slice(0, 10);
      const money = (minor) => fmtPrice(minor, order.currency);
      const button = (text, tone, handler) => el('button', { type: 'button', class: `btn btn-sm ${tone}`, text, 'aria-label': `${text}: ${ref}`, on: { click: handler } });
      const actions = [];
      if (order.status === 'awaiting_payment' || order.status === 'under_review') {
        actions.push(button('Prüfung erfassen', 'btn-ghost', async () => {
          let payer;
          try { payer = (await api().orderPayer({ orderId: order.orderId })).data || {}; } catch (error) { logError('order payer', error); toast(errorText(error), true); return; }
          const result = el('select', {}, Object.entries(SCREENING_LABEL).map(([value, text]) => el('option', { value, text })));
          const lists = el('input', { type: 'text', maxlength: 300, placeholder: 'z. B. EU, UN, OFAC' });
          const reference = el('input', { type: 'text', maxlength: 120 });
          const note = el('textarea', { maxlength: 500 });
          openDialog({
            title: `Sanktionsprüfung ${ref}`, confirmLabel: 'Speichern',
            text: `Besteller: ${payer.deliveryName || 'unbekannt'}${payer.accountName && payer.accountName !== payer.deliveryName ? ` (Konto: ${payer.accountName})` : ''}, Lieferland ${payer.country || '–'}. Erfasst wird, dass und gegen welche Listen geprüft wurde.`,
            build: (body) => body.append(field('Ergebnis', result), field('Geprüfte Listen', lists), field('Referenz (optional)', reference), field('Notiz (Pflicht bei „unklar" oder „Treffer")', note)),
            onConfirm: () => {
              if (lists.value.trim().length < 3) throw userError('Bitte angeben, welche Listen geprüft wurden.');
              if (result.value !== 'clear' && note.value.trim().length < 3) throw userError('Bei „unklar" oder „Treffer" ist eine Notiz nötig.');
              return api().recordOrderScreening({ orderId: order.orderId, result: result.value, listsChecked: lists.value.trim(), reference: reference.value.trim() || undefined, note: note.value.trim() || undefined });
            }
          }).then(done('Prüfung gespeichert.'));
        }));
        actions.push(button('Zahlung bestätigen', 'btn-primary', () => openDialog({
          title: 'Zahlung bestätigen', confirmLabel: 'Zahlung ist eingegangen',
          text: `Ist die Überweisung über ${money(order.totalMinor)} mit dem Verwendungszweck ${ref} auf dem Konto eingegangen? Danach wird dem Hof ${money(order.farmNetMinor)} gutgeschrieben und die Bestellung geht in den Versand.`,
          onConfirm: () => api().reviewOrderPayment({ orderId: order.orderId, decision: 'approve' })
        }).then(done('Zahlung bestätigt.'))));
        actions.push(button('Ablehnen', 'btn-danger', () => {
          const note = el('textarea', { rows: 3, maxlength: 500 });
          openDialog({
            title: 'Zahlung ablehnen', confirmLabel: 'Bestellung ablehnen', danger: true,
            text: `Bestellung ${ref} wird storniert, die Ware geht zurück in den Bestand. Der Kunde bekommt die Begründung per E-Mail.`,
            build: (body) => body.append(field('Begründung für den Kunden', note)),
            onConfirm: () => {
              if (note.value.trim().length < 3) throw userError('Bitte eine Begründung angeben.');
              return api().reviewOrderPayment({ orderId: order.orderId, decision: 'reject', note: note.value.trim() });
            }
          }).then(done('Bestellung abgelehnt.'));
        }));
      }
      if (order.status === 'paid' || order.status === 'shipped') {
        actions.push(button('Lieferadresse', 'btn-ghost', async () => {
          try {
            const contact = ((await api().adminOrderContact({ orderId: order.orderId })).data || {}).contact || {};
            const lines = [contact.name, contact.addressLine1, contact.addressLine2, [contact.postalCode, contact.city].filter(Boolean).join(' '), contact.country, contact.phone ? `Tel. ${contact.phone}` : '']
              .filter((line) => typeof line === 'string' && line.trim());
            await openDialog({
              title: `Lieferadresse ${ref}`, confirmLabel: 'Schließen',
              text: 'Nur für den Versand dieser Bestellung verwenden. Der Abruf wird im Audit-Log festgehalten.',
              build: (body) => body.append(el('address', { class: 'item' }, lines.map((line) => el('div', { text: line })))),
              onConfirm: async () => {}
            });
          } catch (error) { logError('order contact', error); toast(errorText(error), true); }
        }));
      }
      if (order.status === 'paid') {
        actions.push(button('Erstatten', 'btn-danger', () => {
          const note = el('textarea', { rows: 3, maxlength: 300 });
          openDialog({
            title: `Bestellung ${ref} erstatten`, confirmLabel: 'Erstattung buchen', danger: true,
            text: `Die Ware geht zurück in den Bestand und die Gutschrift des Hofs über ${money(order.farmNetMinor)} wird zurückgenommen. Bitte überweisen Sie dem Kunden ${money(order.totalMinor)} zurück – das geschieht nicht automatisch.`,
            build: (body) => body.append(field('Grund (der Kunde erhält ihn per E-Mail)', note)),
            onConfirm: () => {
              if (note.value.trim().length < 3) throw userError('Bitte einen Grund angeben.');
              return api().refundOrder({ orderId: order.orderId, note: note.value.trim() });
            }
          }).then(done('Erstattung gebucht.'));
        }));
        actions.push(button('Als versandt markieren', 'btn-primary', () => {
          const tracking = el('input', { type: 'text', maxlength: 80, autocomplete: 'off' });
          openDialog({
            title: 'Versand eintragen', confirmLabel: 'Versandt',
            text: `Bestellung ${ref} wurde dem Versanddienst übergeben. Der Kunde wird benachrichtigt.`,
            build: (body) => body.append(field('Sendungsnummer (optional)', tracking)),
            onConfirm: () => api().adminSetOrderFulfilment({ orderId: order.orderId, step: 'shipped', trackingCode: tracking.value.trim() })
          }).then(done('Versand eingetragen.'));
        }));
      }
      if (order.status === 'shipped') {
        actions.push(button('Als zugestellt markieren', 'btn-primary', () => openDialog({
          title: 'Zustellung eintragen', confirmLabel: 'Zugestellt',
          text: `Bestellung ${ref} ist beim Kunden angekommen. Danach ist die Lieferadresse nicht mehr abrufbar.`,
          onConfirm: () => api().adminSetOrderFulfilment({ orderId: order.orderId, step: 'delivered' })
        }).then(done('Zustellung eingetragen.'))));
      }
      return el('tr', {}, [
        el('td', {}, [el('div', { class: 'mono', text: ref }), el('div', { class: 'item-meta', text: `${fmtDate(order.createdAt)} · nach ${order.destCountry || '–'}` }),
          order.trackingCode ? el('div', { class: 'item-meta', text: `Sendung: ${order.trackingCode}` }) : null,
          order.reviewNote ? el('div', { class: 'item-meta', text: `Notiz: ${order.reviewNote}` }) : null]),
        el('td', { text: farmLabel(order.farmId) }),
        el('td', {}, asList(order.lines).map((line) => el('div', { text: `${fmtInt(line.quantity)} × ${line.name} (${line.unit})` }))),
        el('td', { text: money(order.itemsMinor) }),
        el('td', {}, [el('div', { text: money(order.feeMinor) }), el('div', { class: 'item-meta', text: fmtPercent(order.feeBps) })]),
        el('td', { text: money(order.farmNetMinor) }),
        el('td', { text: money(order.shippingMinor) }),
        el('td', {}, [el('strong', { text: money(order.totalMinor) })]),
        el('td', {}, [statusBadge(ORDER_STATUS, order.status),
          order.status === 'awaiting_payment' ? el('div', { class: 'item-meta', text: `bis ${fmtDate(order.expiresAt)}` }) : null,
          order.status === 'awaiting_payment' || order.status === 'under_review'
            ? el('div', { class: 'item-meta', text: order.screening ? `Sanktionsprüfung: ${SCREENING_LABEL[order.screening.result] || order.screening.result}${order.screening.current ? '' : ' (älter als 30 Tage)'}` : 'Sanktionsprüfung: noch keine erfasst' }) : null]),
        el('td', {}, [el('div', { class: 'row' }, actions)])
      ]);
    }))
  ])]));

  // ---- products
  const products = asList(market.products);
  view.append(el('h3', { text: 'Produkte der Höfe' }));
  if (!products.length) view.append(stateBlock('empty', 'Noch kein Hof hat ein Produkt eingereicht.'));
  else view.append(el('div', { class: 'table-wrap' }, [el('table', {}, [
    el('thead', {}, [el('tr', {}, ['Produkt', 'Hof', 'Preis', 'Bestand', 'Status', isAdmin ? 'Aktionen' : null].filter(Boolean).map((text) => el('th', { scope: 'col', text })))]),
    el('tbody', {}, products.map((product) => {
      const title = product.nameEn || product.name;
      const review = (decision, label, tone, text, needsNote) => el('button', { type: 'button', class: `btn btn-sm ${tone}`, text: label, 'aria-label': `${label}: ${title}`, on: { click: () => {
        const note = el('textarea', { rows: 3, maxlength: 500 });
        openDialog({
          title: `${label}: ${title}`, confirmLabel: label, danger: decision !== 'list', text,
          build: (body) => { if (decision !== 'list') body.append(field(needsNote ? 'Begründung für den Hof' : 'Notiz für den Hof (optional)', note)); },
          onConfirm: () => {
            if (needsNote && note.value.trim().length < 3) throw userError('Bitte eine Begründung angeben.');
            return api().adminReviewProduct({ productId: product.productId, decision, note: note.value.trim() });
          }
        }).then(done('Produkt aktualisiert.'));
      } } });
      const actions = [];
      if (product.status !== 'listed') actions.push(review('list', 'Freigeben', 'btn-primary', `Das Produkt erscheint danach mit ${fmtPrice(product.priceMinor, product.currency)} je ${product.unit} im Shop, sofern der Hof sichtbar ist.`, false));
      if (product.status === 'pending_review') actions.push(review('reject', 'Ablehnen', 'btn-danger', 'Der Hof sieht die Begründung und kann das Produkt überarbeiten.', true));
      if (product.status === 'listed') actions.push(review('unlist', 'Ausblenden', 'btn-danger', 'Das Produkt verschwindet aus dem Shop. Bestehende Bestellungen bleiben unberührt.', false));
      return el('tr', {}, [
        el('td', {}, [el('div', { text: title }), el('div', { class: 'item-meta', text: `${PRODUCT_CATEGORY[product.category] || product.category} · ${product.unit}` }),
          product.reviewNote ? el('div', { class: 'item-meta', text: `Notiz: ${product.reviewNote}` }) : null]),
        el('td', { text: product.farmNameEn || product.farmName || product.farmId }),
        el('td', { text: fmtPrice(product.priceMinor, product.currency) }),
        el('td', { text: fmtInt(product.stockUnits) }),
        el('td', {}, [statusBadge(PRODUCT_STATUS, product.status)]),
        isAdmin ? el('td', {}, [el('div', { class: 'row' }, actions)]) : null
      ]);
    }))
  ])]));

  // ---- what the platform owes the farms
  const balances = asList(market.balances);
  view.append(el('h3', { text: 'Guthaben der Höfe' }),
    el('p', { class: 'muted', text: 'Preis der bezahlten Ware abzüglich Servicegebühr, Erstattungen und gebuchter Auszahlungen. Eine Auszahlung wird hier gebucht, nachdem sie per Bank überwiesen wurde.' }));
  if (!balances.length) view.append(stateBlock('empty', 'Noch keine Gutschriften.'));
  else view.append(el('div', { class: 'table-wrap' }, [el('table', {}, [
    el('thead', {}, [el('tr', {}, ['Hof', 'Guthaben', 'Aktion'].map((text) => el('th', { scope: 'col', text })))]),
    el('tbody', {}, balances.map((b) => el('tr', {}, [el('td', { text: farmLabel(b.farmId) }), el('td', { text: fmtPrice(b.amountMinor, b.currency) }),
      el('td', {}, [Number(b.amountMinor) > 0 ? el('button', { type: 'button', class: 'btn btn-sm btn-primary', text: 'Auszahlung buchen', 'aria-label': `Auszahlung buchen: ${farmLabel(b.farmId)}`, on: { click: () => {
        const amount = el('input', { type: 'number', min: 0, step: 'any', inputmode: 'decimal', value: (Number(b.amountMinor) || 0) / unitFactor(b.currency) });
        const reference = el('input', { type: 'text', maxlength: 80, autocomplete: 'off' });
        const note = el('input', { type: 'text', maxlength: 300 });
        openDialog({
          title: `Auszahlung an ${farmLabel(b.farmId)}`, confirmLabel: 'Auszahlung buchen',
          text: `Guthaben: ${fmtPrice(b.amountMinor, b.currency)}. Bitte erst überweisen, dann hier mit der Referenz der Banküberweisung buchen. Jede Referenz kann nur einmal gebucht werden.`,
          build: (body) => body.append(field(`Betrag in ${b.currency}`, amount), field('Referenz der Banküberweisung', reference), field('Notiz (optional)', note)),
          onConfirm: () => {
            const value = Math.round(Number(String(amount.value).replace(',', '.')) * unitFactor(b.currency));
            if (!Number.isFinite(value) || value < 1) throw userError('Bitte einen Betrag größer als null eingeben.');
            if (value > Number(b.amountMinor)) throw userError('Der Betrag ist höher als das Guthaben des Hofs.');
            if (reference.value.trim().length < 3) throw userError('Bitte die Referenz der Banküberweisung angeben.');
            return api().recordFarmPayout({ farmId: b.farmId, amountMinor: value, currency: b.currency, reference: reference.value.trim(), note: note.value.trim() });
          }
        }).then(done('Auszahlung gebucht.'));
      } } }) : null])])))
  ])]));

  if (!isAdmin) return;

  // ---- fee
  view.append(el('div', { class: 'row row-between' }, [el('h3', { text: `Servicegebühr: ${fmtPercent(market.feeBps)}` }),
    el('button', { type: 'button', class: 'btn btn-ghost', text: 'Gebühr ändern', on: { click: () => {
      const percent = el('input', { type: 'number', min: 0, max: 30, step: 0.5, value: (Number(market.feeBps) || 0) / 100, inputmode: 'decimal' });
      openDialog({
        title: 'Servicegebühr ändern', confirmLabel: 'Gebühr speichern',
        text: 'Gilt für neue Bestellungen. Bestehende Bestellungen behalten den Satz, mit dem sie aufgegeben wurden.',
        build: (body) => body.append(field('Servicegebühr in Prozent des Warenwerts (0 bis 30)', percent)),
        onConfirm: () => {
          const value = Number(String(percent.value).replace(',', '.'));
          if (!Number.isFinite(value) || value < 0 || value > 30 || Math.round(value * 100) !== value * 100) throw userError('Bitte einen Wert zwischen 0 und 30 mit höchstens zwei Nachkommastellen eingeben.');
          return api().adminSetPlatformFee({ feeBps: Math.round(value * 100) });
        }
      }).then(done('Servicegebühr gespeichert.'));
    } } })]));

  // ---- shipping prices
  const rates = asList(market.shippingRates);
  const editRate = (rate) => {
    const origins = [...new Set(farms.map((farm) => farm.countryCode).filter(Boolean))];
    const f = {
      origin: el('select', {}, origins.map((code) => el('option', { value: code, text: code, selected: rate ? code === rate.originCountry : false }))),
      dest: el('input', { type: 'text', maxlength: 2, value: rate ? rate.destCountry : '', placeholder: 'DE', autocomplete: 'off' }),
      amount: el('input', { type: 'number', min: 0, step: 'any', value: rate ? (Number(rate.amountMinor) || 0) / unitFactor(rate.currency) : '', inputmode: 'decimal' }),
      currency: el('input', { type: 'text', maxlength: 3, value: rate ? rate.currency : 'EUR', autocomplete: 'off' }),
      active: el('input', { type: 'checkbox', checked: !rate || rate.active ? 'checked' : null })
    };
    openDialog({
      title: rate ? `Versandpreis ${rate.originCountry} → ${rate.destCountry}` : 'Neuer Versandpreis', confirmLabel: 'Versandpreis speichern',
      text: 'Pauschale je Bestellung. Ohne aktiven Versandpreis kann in ein Land nicht bestellt werden.',
      build: (body) => body.append(el('div', { class: 'form-grid' }, [
        field('Herkunftsland des Hofs', f.origin), field('Zielland (zwei Buchstaben, z. B. DE)', f.dest),
        field('Preis je Bestellung', f.amount), field('Währung (drei Buchstaben)', f.currency)
      ]), el('label', { class: 'row' }, [f.active, el('span', { text: 'Aktiv' })])),
      onConfirm: () => {
        const dest = f.dest.value.trim().toUpperCase();
        const currency = f.currency.value.trim().toUpperCase();
        const amount = Number(String(f.amount.value).replace(',', '.'));
        if (!f.origin.value) throw userError('Bitte zuerst einen Hof anlegen: das Herkunftsland kommt vom Hof.');
        if (!/^[A-Z]{2}$/.test(dest)) throw userError('Zielland: bitte den zweibuchstabigen Ländercode eingeben, z. B. DE.');
        if (!/^[A-Z]{3}$/.test(currency)) throw userError('Währung: bitte den dreibuchstabigen Code eingeben, z. B. EUR.');
        if (f.amount.value === '' || !Number.isFinite(amount) || amount < 0) throw userError('Bitte einen Preis eingeben (0 für kostenlosen Versand).');
        return api().adminSetShippingRate({ originCountry: f.origin.value, destCountry: dest, amountMinor: Math.round(amount * unitFactor(currency)), currency, active: f.active.checked });
      }
    }).then(done('Versandpreis gespeichert.'));
  };
  view.append(el('div', { class: 'row row-between' }, [el('h3', { text: 'Versandpreise' }),
    el('button', { type: 'button', class: 'btn btn-primary', text: 'Neuer Versandpreis', on: { click: () => editRate(null) } })]));
  if (!rates.length) view.append(stateBlock('empty', 'Noch kein Versandpreis hinterlegt – niemand kann bestellen.'));
  else view.append(el('div', { class: 'table-wrap' }, [el('table', {}, [
    el('thead', {}, [el('tr', {}, ['Von', 'Nach', 'Preis je Bestellung', 'Status'].map((text) => el('th', { scope: 'col', text })))]),
    el('tbody', {}, rates.map((rate) => el('tr', {}, [
      el('td', { class: 'mono', text: rate.originCountry }), el('td', { class: 'mono', text: rate.destCountry }), el('td', { text: fmtPrice(rate.amountMinor, rate.currency) }),
      el('td', {}, [el('div', { class: 'row' }, [el('span', { class: `badge ${rate.active ? 'badge-ok' : ''}`, text: rate.active ? 'aktiv' : 'inaktiv' }),
        el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Bearbeiten', 'aria-label': `Versandpreis ${rate.originCountry} nach ${rate.destCountry} bearbeiten`, on: { click: () => editRate(rate) } })])])
    ])))
  ])]));

  // ---- which accounts act for a farm
  const members = asList(market.members);
  const farmers = asList(users).filter((user) => user.role === 'farmer');
  view.append(el('div', { class: 'row row-between' }, [el('h3', { text: 'Zugänge der Höfe' }),
    el('button', { type: 'button', class: 'btn btn-primary', text: 'Zugang vergeben', on: { click: () => {
      const farm = el('select', {}, farms.map((f) => el('option', { value: f.farmId, text: `${f.nameEn || f.name || f.farmId} (${f.farmId})` })));
      const account = el('select', {}, farmers.map((user) => el('option', { value: user.id, text: `${user.name} · ${user.email}` })));
      openDialog({
        title: 'Zugang zu einem Hof vergeben', confirmLabel: 'Zugang vergeben',
        text: 'Das Konto darf danach Produkte dieses Hofs einreichen, den Bestand pflegen und die Bestellungen des Hofs ohne Kundendaten sehen. Nur Konten mit der Rolle Landwirt stehen zur Auswahl.',
        build: (body) => body.append(field('Hof', farm), field('Konto', account)),
        onConfirm: () => {
          if (!farm.value || !account.value) throw userError('Es braucht einen Hof und ein Konto mit der Rolle Landwirt.');
          return api().adminSetFarmMember({ farmId: farm.value, userId: account.value, active: true });
        }
      }).then(done('Zugang vergeben.'));
    } } })]));
  if (!members.length) view.append(stateBlock('empty', 'Noch kein Konto ist einem Hof zugeordnet.'));
  else view.append(el('div', { class: 'table-wrap' }, [el('table', {}, [
    el('thead', {}, [el('tr', {}, ['Hof', 'Konto', 'Seit', 'Aktion'].map((text) => el('th', { scope: 'col', text })))]),
    el('tbody', {}, members.map((member) => {
      const name = member.displayName || member.userId;
      return el('tr', {}, [
        el('td', { text: farmLabel(member.farmId) }), el('td', { text: name }), el('td', { text: fmtDate(member.addedAt) }),
        el('td', {}, [el('button', { type: 'button', class: 'btn btn-sm btn-danger', text: 'Entziehen', 'aria-label': `Zugang entziehen: ${name}`, on: { click: () => openDialog({
          title: 'Zugang entziehen', confirmLabel: 'Entziehen', danger: true,
          text: `${name} kann danach für ${farmLabel(member.farmId)} keine Produkte mehr pflegen und sieht dessen Bestellungen nicht mehr.`,
          onConfirm: () => api().adminSetFarmMember({ farmId: member.farmId, userId: member.userId, active: false })
        }).then(done('Zugang entzogen.')) } })])
      ]);
    }))
  ])]));
}

async function viewTrees(view) {
  const { data } = await api().adminListTrees();
  const trees = Array.isArray(data) ? data : [];
  const isAdmin = session.user.role === 'admin';
  view.append(el('div', { class: 'row row-between' }, [
    el('h2', { text: 'Bäume und Bestand' }),
    isAdmin ? el('button', { type: 'button', class: 'btn btn-primary', text: 'Neuer Baum', on: { click: () => editTree(null) } }) : null
  ]));
  if (!trees.length) { view.append(stateBlock('empty', 'Noch keine Bäume angelegt.')); return; }
  view.append(el('div', { class: 'table-wrap' }, [el('table', {}, [
    el('thead', {}, [el('tr', {}, ['Baum', 'Region', 'Verkauft', 'Reserviert', 'Frei', 'Preis je Anteil', 'Umsatz', 'Besitzer', 'Landwirte', 'Katalog'].map((text) => el('th', { scope: 'col', text })))]),
    el('tbody', {}, trees.map((tree) => {
      const listed = tree.status === 'listed';
      const money = (minor) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: /^[A-Z]{3}$/.test(tree.currency) ? tree.currency : 'USD' }).format((Number(minor) || 0) / 100);
      const toggle = el('button', { type: 'button', class: `btn btn-sm ${listed ? 'btn-danger' : 'btn-primary'}`, text: listed ? 'Ausblenden' : 'Einblenden', on: { click: () => openDialog({
        title: listed ? 'Baum aus dem Katalog nehmen' : 'Baum im Katalog zeigen',
        text: `${tree.nameEn || tree.name || tree.treeId}: ${listed ? 'Neue Käufer sehen den Baum nicht mehr. Bestehende Anteile und offene Anfragen bleiben unberührt.' : 'Der Baum ist danach für alle Besucher sichtbar und kaufbar.'}`,
        confirmLabel: listed ? 'Ausblenden' : 'Einblenden', danger: listed,
        onConfirm: () => api().adminSetTreeStatus({ treeId: tree.treeId, status: listed ? 'unlisted' : 'listed' })
      }).then((ok) => { if (ok) { toast('Sichtbarkeit geändert.'); show('trees'); } }) } });
      return el('tr', {}, [
        el('td', {}, [el('div', { text: tree.nameEn || tree.name || tree.treeId }), el('div', { class: 'mono item-meta', text: tree.treeId })]),
        el('td', { text: tree.regionEn || tree.region || '–' }),
        el('td', { text: `${fmtInt(tree.soldShares)} / ${fmtInt(tree.totalShares)}` }), el('td', { text: fmtInt(tree.reservedShares) }),
        el('td', {}, [el('span', { class: `badge ${tree.availableShares === 0 ? 'badge-bad' : ''}`, text: fmtInt(tree.availableShares) })]),
        el('td', { text: money(tree.pricePerShareMinor) }), el('td', { text: money(tree.revenueMinor) }),
        el('td', { text: fmtInt(tree.holders) }), el('td', {}, [el('span', { class: `badge ${tree.farmers === 0 ? 'badge-warn' : ''}`, text: fmtInt(tree.farmers) })]),
        el('td', {}, [el('div', { class: 'row' }, [el('span', { class: `badge ${listed ? 'badge-ok' : 'badge-warn'}`, text: listed ? 'sichtbar' : 'ausgeblendet' }), isAdmin ? toggle : null,
          isAdmin ? el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Bearbeiten', 'aria-label': `${tree.nameEn || tree.treeId} bearbeiten`, on: { click: () => editTree(tree.treeId) } }) : null])])
      ]);
    }))
  ])]));
  view.append(el('p', { class: 'muted', text: 'Ein neuer Baum startet ausgeblendet und wird erst nach Kontrolle eingeblendet. Ein neuer Preis gilt nur für künftige Anfragen; offene Anfragen behalten ihren Betrag. Die Anteilszahl kann nie unter „verkauft + reserviert" sinken.' }));
}

const TREE_IMAGE = /^images\/[A-Za-z0-9_-]{1,80}\.(webp|png|jpg|jpeg)$/;
// Same list as the database check constraint (trees_public_crop_category_check).
const TREE_CROPS = [['olive', 'Olive'], ['pistachio', 'Pistazie'], ['almond', 'Mandel'], ['pomegranate', 'Granatapfel'], ['date', 'Dattelpalme'], ['walnut', 'Walnuss']];
/** Create (treeId = null) or edit a tree. The server validates again; this form only catches obvious slips early. */
async function editTree(treeId) {
  let tree = null;
  let master = { countries: [], farms: [], mills: [] };
  try {
    master = (await api().adminListMasterData()).data || master;
    if (treeId) {
      ({ data: tree } = await api().adminGetTree({ treeId }));
      const mill = await api().adminGetTreeMill({ treeId });
      tree.millId = (mill.data && mill.data.millId) || '';
      const crop = await api().adminGetTreeCrop({ treeId });
      tree.cropCategory = (crop.data && crop.data.cropCategory) || 'olive';
      const origin = await api().adminGetTreeOrigin({ treeId });
      tree.countryCode = (origin.data && origin.data.countryCode) || 'SY';
      tree.farmId = (origin.data && origin.data.farmId) || '';
    }
  } catch (error) {
    logError('tree load', error);
    toast(errorText(error), true);
    return;
  }
  const countries = Array.isArray(master.countries) ? master.countries : [];
  const farms = Array.isArray(master.farms) ? master.farms : [];
  // The server refuses a parcel option while the land offer is off, so the form does not offer one then.
  const landOffered = master.landOfferEnabled === true || Boolean(tree && tree.hasLandOption);
  const text = (value, extra = {}) => el('input', { type: 'text', maxlength: 120, value: value || '', autocomplete: 'off', ...extra });
  const number = (value, extra = {}) => el('input', { type: 'text', inputmode: 'decimal', value: value === null || value === undefined ? '' : String(value), autocomplete: 'off', ...extra });
  const hasLand = el('input', { type: 'checkbox', checked: tree && tree.hasLandOption ? 'checked' : null, disabled: Boolean(tree) });
  // The crop is fixed once anything is sold or reserved (the server refuses the change as well).
  const cropLocked = Boolean(tree) && (Number(tree.soldShares) + Number(tree.reservedShares)) > 0;
  const currentCrop = (tree && tree.cropCategory) || 'olive';
  const currentCountry = (tree && tree.countryCode) || 'SY';
  const currentFarm = (tree && tree.farmId) || '';
  const countrySelect = el('select', { disabled: cropLocked }, countries.map((c) => el('option', { value: c.code, text: `${c.nameDe || c.nameEn || c.code} (${c.code})${c.status === 'planned' ? ' – geplant' : ''}`, selected: c.code === currentCountry })));
  const farmSelect = el('select', {});
  // Only farms of the chosen country can be picked; the server enforces the same rule.
  const fillFarms = (keep) => {
    farmSelect.replaceChildren(el('option', { value: '', text: '— kein Hof —' }),
      ...farms.filter((f) => f.countryCode === countrySelect.value).map((f) => el('option', { value: f.farmId, text: `${f.nameEn || f.name || f.farmId} (${f.farmId})`, selected: f.farmId === keep })));
  };
  fillFarms(currentFarm);
  countrySelect.addEventListener('change', () => fillFarms(''));
  const f = {
    treeId: text('', { maxlength: 40, placeholder: 'tree_04' }),
    name: text(tree && tree.name, { dir: 'rtl', lang: 'ar' }), nameEn: text(tree && tree.nameEn),
    region: text(tree && tree.region, { dir: 'rtl', lang: 'ar' }), regionEn: text(tree && tree.regionEn),
    treeType: text(tree && tree.treeType, { dir: 'rtl', lang: 'ar' }), treeTypeEn: text(tree && tree.treeTypeEn),
    totalShares: number(tree && tree.totalShares, { inputmode: 'numeric' }),
    price: number(tree ? (Number(tree.pricePerShareMinor) / 100).toFixed(2) : ''),
    plantedYear: number(tree && tree.plantedYear, { inputmode: 'numeric' }),
    yieldKg: number(tree && tree.estimatedAnnualYieldKg),
    landPrice: number(tree && tree.hasLandOption ? (Number(tree.landPriceMinor) / 100).toFixed(2) : ''),
    landArea: number(tree && tree.hasLandOption ? tree.landAreaSqm : ''),
    millId: text(tree && tree.millId, { maxlength: 80, placeholder: 'mill_01' }),
    crop: el('select', { disabled: cropLocked }, TREE_CROPS.map(([value, label]) => el('option', { value, text: label, selected: value === currentCrop }))),
    images: el('textarea', { rows: 3, class: 'mono', text: ((tree && tree.images) || ['images/olive_branches_macro.webp']).join('\n') })
  };
  const landFields = el('div', { class: 'form-grid', hidden: !(tree && tree.hasLandOption) }, [field('Preis der Parzelle (USD)', f.landPrice), field('Fläche der Parzelle (m²)', f.landArea)]);
  hasLand.addEventListener('change', () => { landFields.hidden = !hasLand.checked; });
  const readNumber = (control, label, { integer = false, optional = false, min = 0 } = {}) => {
    const raw = control.value.trim().replace(',', '.');
    if (!raw) { if (optional) return undefined; throw userError(`${label} fehlt.`); }
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) throw userError(`${label} ist keine gültige Zahl.`);
    return value;
  };
  const readText = (control, label) => {
    const value = control.value.trim();
    if (value.length < 2 || /[<>]/.test(value)) throw userError(`${label} fehlt oder enthält unzulässige Zeichen.`);
    return value;
  };
  const cropValue = () => {
    const value = f.crop.value;
    if (!TREE_CROPS.some(([id]) => id === value)) throw userError('Kultur: Bitte eine der angebotenen Kulturen wählen.');
    return value;
  };
  const collect = () => {
    const images = f.images.value.split('\n').map((line) => line.trim()).filter(Boolean);
    if (images.length < 1 || images.length > 6 || !images.every((path) => TREE_IMAGE.test(path))) throw userError('Bilder: 1 bis 6 Pfade der Form images/name.webp (nur Bilder, die mit der App ausgeliefert werden).');
    const payload = {
      name: readText(f.name, 'Name (Arabisch)'), nameEn: readText(f.nameEn, 'Name (Englisch)'),
      region: readText(f.region, 'Region (Arabisch)'), regionEn: readText(f.regionEn, 'Region (Englisch)'),
      treeType: readText(f.treeType, 'Sorte (Arabisch)'), treeTypeEn: readText(f.treeTypeEn, 'Sorte (Englisch)'),
      totalShares: readNumber(f.totalShares, 'Anzahl Anteile', { integer: true, min: 1 }),
      pricePerShareMinor: Math.round(readNumber(f.price, 'Preis je Anteil', { min: 1 }) * 100),
      plantedYear: readNumber(f.plantedYear, 'Pflanzjahr', { integer: true, optional: true, min: 1000 }),
      estimatedAnnualYieldKg: readNumber(f.yieldKg, 'Ertrag', { optional: true }),
      images
    };
    if (hasLand.checked) {
      payload.landPriceMinor = Math.round(readNumber(f.landPrice, 'Preis der Parzelle', { min: 1 }) * 100);
      payload.landAreaSqm = readNumber(f.landArea, 'Fläche der Parzelle', { min: 1 });
    }
    for (const key of Object.keys(payload)) if (payload[key] === undefined) delete payload[key];
    return payload;
  };
  const ok = await openDialog({
    title: tree ? `Baum bearbeiten: ${tree.treeId}` : 'Neuer Baum', confirmLabel: tree ? 'Änderungen speichern' : 'Baum anlegen',
    build: (body) => {
      body.append(
        tree ? el('p', { class: 'muted', text: `Verkauft: ${fmtInt(tree.soldShares)} · reserviert: ${fmtInt(tree.reservedShares)}. Die Anteilszahl muss mindestens ${fmtInt(tree.soldShares + tree.reservedShares)} betragen.` })
          : field('Kennung (klein, a–z, 0–9, _ ; später nicht änderbar)', f.treeId),
        el('div', { class: 'form-grid' }, [
          field('Name (Arabisch)', f.name), field('Name (Englisch)', f.nameEn),
          field('Region (Arabisch)', f.region), field('Region (Englisch)', f.regionEn),
          field(cropLocked ? 'Kultur (nach dem ersten Verkauf nicht änderbar)' : 'Kultur', f.crop), el('span'),
          field(cropLocked ? 'Herkunftsland (nach dem ersten Verkauf nicht änderbar)' : 'Herkunftsland', countrySelect), field('Hof', farmSelect),
          field('Sorte (Arabisch)', f.treeType), field('Sorte (Englisch)', f.treeTypeEn),
          field('Anzahl Anteile', f.totalShares), field('Preis je Anteil (USD)', f.price),
          field('Pflanzjahr (optional)', f.plantedYear), field('Ertrag pro Jahr in kg (optional)', f.yieldKg)
        ]),
        field('Bilder (ein Pfad je Zeile)', f.images),
        tree ? field('Ölmühle (Kennung, leer = keine)', f.millId) : null,
        landOffered ? el('label', { class: 'row' }, [hasLand, el('span', { text: tree ? 'Mit Parzellen-Option (nach dem Anlegen nicht änderbar)' : 'Mit Parzellen-Option' })]) : null,
        landOffered ? landFields : null
      );
    },
    onConfirm: async () => {
      const payload = collect();
      if (!tree) {
        const id = f.treeId.value.trim();
        if (!/^[a-z0-9_]{3,40}$/.test(id)) throw userError('Kennung: 3 bis 40 Zeichen, nur Kleinbuchstaben, Ziffern und _.');
        const crop = cropValue();
        await api().adminCreateTree({ ...payload, treeId: id, hasLandOption: hasLand.checked });
        // New trees are stored as olive; any other crop is set in a second, separately audited step.
        if (crop !== 'olive') await api().adminSetTreeCrop({ treeId: id, cropCategory: crop });
        // Likewise the origin: a new tree is stored for Syria without a farm.
        if (countrySelect.value && (countrySelect.value !== 'SY' || farmSelect.value)) await api().adminSetTreeOrigin({ treeId: id, countryCode: countrySelect.value, farmId: farmSelect.value || null });
        return;
      }
      // Send only what changed, so the audit log names the real change.
      const changed = {};
      for (const [key, value] of Object.entries(payload)) {
        if (value !== undefined && JSON.stringify(value) !== JSON.stringify(tree[key])) changed[key] = value;
      }
      const millId = f.millId.value.trim();
      if (millId && !/^[A-Za-z0-9_-]{1,80}$/.test(millId)) throw userError('Ölmühle: Die Kennung darf nur Buchstaben, Ziffern, _ und - enthalten.');
      const millChanged = millId !== (tree.millId || '');
      const crop = cropValue();
      const cropChanged = !cropLocked && crop !== currentCrop;
      const originChanged = Boolean(countrySelect.value) && (countrySelect.value !== currentCountry || farmSelect.value !== currentFarm);
      if (!Object.keys(changed).length && !millChanged && !cropChanged && !originChanged) throw userError('Es wurde nichts geändert.');
      if (cropChanged) await api().adminSetTreeCrop({ treeId: tree.treeId, cropCategory: crop });
      if (originChanged) await api().adminSetTreeOrigin({ treeId: tree.treeId, countryCode: countrySelect.value, farmId: farmSelect.value || null });
      if (Object.keys(changed).length) await api().adminUpdateTree({ ...changed, treeId: tree.treeId });
      if (millChanged) await api().adminSetTreeMill({ treeId: tree.treeId, millId: millId || null });
    }
  });
  if (ok) { toast(tree ? 'Baum gespeichert.' : 'Baum angelegt (noch ausgeblendet).'); show('trees'); }
}

const registerFilter = { treeId: '', offset: 0 };
async function viewRegister(view) {
  const PAGE = 50;
  const { data } = await api().adminListShares({ treeId: registerFilter.treeId || undefined, limit: PAGE, offset: registerFilter.offset });
  const rows = (data && data.rows) || [];
  const total = (data && data.total) || 0;
  const input = el('input', { type: 'search', maxlength: 80, placeholder: 'Baum-Kennung, z. B. tree_01', value: registerFilter.treeId, 'aria-label': 'Nach Baum filtern' });
  const apply = () => {
    const id = input.value.trim();
    if (id && !/^[A-Za-z0-9_-]{1,80}$/.test(id)) { toast('Die Baum-Kennung enthält unzulässige Zeichen.', true); return; }
    registerFilter.treeId = id; registerFilter.offset = 0; show('register');
  };
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') apply(); });
  const pager = el('div', { class: 'row' }, [
    el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Zurück', disabled: registerFilter.offset === 0, on: { click: () => { registerFilter.offset = Math.max(0, registerFilter.offset - PAGE); show('register'); } } }),
    el('span', { class: 'muted', text: total ? `${registerFilter.offset + 1}–${Math.min(registerFilter.offset + rows.length, total)} von ${total}` : '0 Einträge' }),
    el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Weiter', disabled: registerFilter.offset + rows.length >= total, on: { click: () => { registerFilter.offset += PAGE; show('register'); } } })
  ]);
  view.append(el('h2', { text: 'Besitzregister' }),
    el('p', { class: 'muted', text: 'Wer hält welche Anteile. Ein Eintrag entsteht ausschließlich durch eine freigegebene Zahlung.' }),
    el('div', { class: 'row row-between' }, [el('div', { class: 'row' }, [input, el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Filtern', on: { click: apply } })]), pager]));
  if (!rows.length) { view.append(stateBlock('empty', registerFilter.treeId ? 'Für diesen Baum sind keine Anteile vergeben.' : 'Es sind noch keine Anteile vergeben.')); return; }
  view.append(el('div', { class: 'table-wrap' }, [el('table', {}, [
    el('thead', {}, [el('tr', {}, ['Seit', 'Besitzer', 'Baum', 'Anteile', 'Kaufpreis', 'Status'].map((text) => el('th', { scope: 'col', text })))]),
    el('tbody', {}, rows.map((row) => el('tr', {}, [
      el('td', { text: fmtDate(row.createdAt) }),
      el('td', {}, [el('div', { text: row.ownerName || '–' }), el('div', { class: 'mono item-meta', text: row.ownerEmail || '' })]),
      el('td', { class: 'mono', text: row.treeId }), el('td', { text: `${fmtInt(row.shareCount)}${row.includesLand ? ' + Parzelle' : ''}` }),
      el('td', { text: fmtMinor(row.purchasePriceMinor) }),
      el('td', {}, [el('span', { class: `badge ${row.status === 'active' ? 'badge-ok' : ''}`, text: row.status === 'active' ? 'aktiv' : row.status })])
    ])))
  ])]));
}

const MAIL_STATUS = { pending: 'wartet', sending: 'wird gesendet', sent: 'gesendet', failed: 'fehlgeschlagen', skipped: 'übersprungen' };
async function viewMail(view) {
  const { data } = await api().adminListOutbox();
  const counts = (data && data.counts) || {};
  const rows = (data && data.rows) || [];
  const failed = Number(counts.failed) || 0;
  const retry = (payload, question) => openDialog({
    title: 'E-Mails erneut einreihen', text: `${question} Solange kein E-Mail-Anbieter hinterlegt ist, schlagen sie erneut fehl.`, confirmLabel: 'Erneut einreihen',
    onConfirm: () => api().adminRetryEmail(payload)
  }).then((ok) => { if (ok) { toast('In die Warteschlange gestellt.'); show('mail'); } });
  view.append(el('div', { class: 'row row-between' }, [
    el('h2', { text: 'E-Mail-Warteschlange' }),
    el('button', { type: 'button', class: 'btn btn-ghost', text: 'Alle fehlgeschlagenen erneut einreihen', disabled: failed === 0, on: { click: () => retry({ all: true }, 'Alle fehlgeschlagenen E-Mails der letzten 7 Tage werden neu versucht.') } })
  ]),
  el('div', { class: 'grid kpis' }, [
    el('div', { class: 'kpi' }, [el('b', { text: fmtInt(counts.sent) }), 'gesendet']),
    el('div', { class: `kpi ${Number(counts.pending) > 0 ? 'is-warn' : ''}` }, [el('b', { text: fmtInt((Number(counts.pending) || 0) + (Number(counts.sending) || 0)) }), 'in der Warteschlange']),
    el('div', { class: `kpi ${failed > 0 ? 'is-bad' : ''}` }, [el('b', { text: fmtInt(failed) }), 'fehlgeschlagen'])
  ]));
  if (!rows.length) { view.append(stateBlock('empty', 'Es wurde noch keine E-Mail erzeugt.')); return; }
  view.append(el('div', { class: 'table-wrap' }, [el('table', {}, [
    el('thead', {}, [el('tr', {}, ['Erzeugt', 'Vorlage', 'Empfänger', 'Status', 'Versuche', 'Letzter Fehler', 'Aktion'].map((text) => el('th', { scope: 'col', text })))]),
    el('tbody', {}, rows.map((row) => el('tr', {}, [
      el('td', { text: fmtDate(row.createdAt) }), el('td', { class: 'mono', text: row.template }), el('td', { class: 'mono', text: row.recipient }),
      el('td', {}, [el('span', { class: `badge ${row.status === 'sent' ? 'badge-ok' : row.status === 'failed' ? 'badge-bad' : 'badge-warn'}`, text: MAIL_STATUS[row.status] || row.status })]),
      el('td', { text: fmtInt(row.attempts) }), el('td', { class: 'item-meta', text: row.lastError || '–' }),
      el('td', {}, [row.status === 'failed' ? el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Erneut', 'aria-label': `E-Mail ${row.id} erneut einreihen`, on: { click: () => retry({ id: row.id }, 'Diese E-Mail wird neu versucht.') } }) : el('span', { class: 'muted', text: '–' })])
    ])))
  ])]));
  view.append(el('p', { class: 'muted', text: 'Empfänger sind hier bewusst gekürzt. Es werden die letzten 100 E-Mails gezeigt.' }));
}

async function viewErrors(view) {
  const { data } = await api().adminListClientErrors();
  const rows = Array.isArray(data) ? data : [];
  view.append(el('h2', { text: 'App-Fehler (letzte 14 Tage)' }));
  if (!rows.length) { view.append(stateBlock('empty', 'Keine Fehler gemeldet.')); return; }
  view.append(el('div', { class: 'table-wrap' }, [el('table', {}, [
    el('thead', {}, [el('tr', {}, ['Meldung', 'Anzahl', 'Betroffene Konten', 'Seite', 'Version', 'Zuletzt'].map((text) => el('th', { scope: 'col', text })))]),
    el('tbody', {}, rows.map((row) => el('tr', {}, [
      el('td', { class: 'mono', text: row.message || '' }), el('td', { text: fmtInt(row.count) }), el('td', { text: fmtInt(row.users) }),
      el('td', { class: 'mono', text: row.page || '' }), el('td', { class: 'mono', text: row.release || '' }), el('td', { text: fmtDate(row.lastSeen) })
    ])))
  ])]));
}

/**
 * Second factor of the signed-in account: confirm a code when an authenticator is set up, otherwise set one up
 * (QR code and key for the app, then a first code to prove it works). Used when the server answers
 * 'mfa-required' and in the settings.
 */
function mfaPanel({ required = false, onDone }) {
  const box = el('section', { class: 'item stack' }, [el('h3', { text: 'Zwei-Faktor-Anmeldung' }), el('p', { class: 'muted', text: 'Wird geladen …' })]);
  const fail = (target, error) => { logError('mfa', error); target.textContent = errorText(error); target.hidden = false; };
  const codeForm = (factorId, intro, extra = []) => {
    const code = el('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, pattern: '[0-9]{6}' });
    const error = el('p', { class: 'form-error', role: 'alert', hidden: true });
    const submit = el('button', { type: 'submit', class: 'btn btn-primary', text: 'Code bestätigen' });
    // novalidate: the message below replaces the browser's own tooltip, so the hint is the same everywhere.
    const form = el('form', { class: 'stack', novalidate: 'novalidate', on: { submit: async (event) => {
      event.preventDefault();
      error.hidden = true;
      if (!/^[0-9]{6}$/.test(code.value.trim())) { error.textContent = 'Bitte den sechsstelligen Code aus der App eingeben.'; error.hidden = false; return; }
      submit.disabled = true;
      try {
        await api().mfaVerify(factorId, code.value.trim());
        toast('Zweiter Faktor bestätigt.');
        if (onDone) onDone();
      } catch (err) {
        fail(error, err);
      } finally {
        submit.disabled = false;
      }
    } } }, [el('p', { text: intro }), ...extra, field('Sechsstelliger Code', code), error, submit]);
    return form;
  };
  const render = async () => {
    let status;
    try {
      status = await api().mfaStatus();
    } catch (error) {
      box.replaceChildren(el('h3', { text: 'Zwei-Faktor-Anmeldung' }), stateBlock('error', errorText(error), render));
      return;
    }
    const head = el('h3', { text: 'Zwei-Faktor-Anmeldung' });
    if (status.factorId && status.currentLevel === 'aal2') {
      box.replaceChildren(head, el('p', {}, [el('span', { class: 'badge badge-ok', text: 'eingerichtet' }), ' · Diese Sitzung ist mit der Authenticator-App bestätigt.']));
      return;
    }
    if (status.factorId) {
      box.replaceChildren(head, codeForm(status.factorId, required
        ? 'Für dieses Konto ist ein zweiter Faktor vorgeschrieben. Bitte den aktuellen Code aus Ihrer Authenticator-App eingeben.'
        : 'Ein Authenticator ist eingerichtet. Mit dem aktuellen Code bestätigen Sie diese Sitzung.'));
      return;
    }
    const error = el('p', { class: 'form-error', role: 'alert', hidden: true });
    const start = el('button', { type: 'button', class: 'btn btn-primary', text: 'Authenticator einrichten', on: { click: async () => {
      start.disabled = true;
      error.hidden = true;
      try {
        const enrolment = await api().mfaEnroll();
        // The QR code arrives as an SVG data URL; anything else is not shown as an image.
        const qr = typeof enrolment.qr === 'string' && enrolment.qr.startsWith('data:image/svg+xml') ? el('img', { src: enrolment.qr, alt: 'QR-Code für die Authenticator-App', width: 180, height: 180, class: 'qr' }) : null;
        box.replaceChildren(head, codeForm(enrolment.factorId, 'Scannen Sie den QR-Code mit einer Authenticator-App (oder geben Sie den Schlüssel von Hand ein) und bestätigen Sie mit dem angezeigten Code.',
          [qr, el('p', {}, ['Schlüssel: ', el('code', { class: 'mono', text: String(enrolment.secret || '') })])]));
      } catch (err) {
        fail(error, err);
        start.disabled = false;
      }
    } } });
    box.replaceChildren(head, el('p', { text: required
      ? 'Für dieses Konto ist ein zweiter Faktor vorgeschrieben, es ist aber noch keiner eingerichtet. Richten Sie jetzt eine Authenticator-App ein, um weiterzuarbeiten.'
      : 'Noch nicht eingerichtet. Ein zweiter Faktor schützt Freigaben und Kontodaten, falls das Passwort in falsche Hände gerät.' }), error, start);
  };
  render();
  return box;
}

async function viewSettings(view) {
  const { data } = await api().adminDashboard();
  const push = (data && data.push) || {};
  const ops = (data && data.operations) || {};
  const toggle = el('button', { type: 'button', class: `btn ${push.enabled ? 'btn-danger' : 'btn-primary'}`, 'aria-pressed': push.enabled ? 'true' : 'false', text: push.enabled ? 'Push ausschalten' : 'Push einschalten', on: { click: () => openDialog({
    title: push.enabled ? 'Push ausschalten' : 'Push einschalten',
    text: push.enabled ? 'Die App bietet Push dann nicht mehr an und nimmt keine neuen Geräte auf.' : 'Nur einschalten, wenn die Firebase-Datei in der App liegt und der Schlüssel FCM_SERVICE_ACCOUNT in Supabase gesetzt ist. Sonst kann die App beim Aktivieren abstürzen.',
    confirmLabel: push.enabled ? 'Ausschalten' : 'Einschalten', danger: true,
    onConfirm: () => api().adminSetPushEnabled({ enabled: !push.enabled })
  }).then((ok) => { if (ok) { toast('Einstellung gespeichert.'); show('settings'); } }) } });
  const security = (await api().staffSecurityState()).data || {};
  const mfaOn = security.mfaRequired === true;
  const mfaToggle = el('button', { type: 'button', class: `btn ${mfaOn ? 'btn-danger' : 'btn-primary'}`, 'aria-pressed': mfaOn ? 'true' : 'false', text: mfaOn ? 'Pflicht aufheben' : 'Für alle Team-Konten verlangen', on: { click: () => openDialog({
    title: mfaOn ? 'Zwei-Faktor-Pflicht aufheben' : 'Zwei-Faktor-Pflicht einschalten',
    text: mfaOn ? 'Admin-, Finanz- und Prüferkonten können danach wieder mit dem Passwort allein arbeiten.' : 'Admin-, Finanz- und Prüferkonten brauchen danach bei jeder Anmeldung einen Code aus ihrer Authenticator-App. Wer noch keinen eingerichtet hat, wird beim nächsten Aufruf dazu aufgefordert. Einschalten können Sie die Pflicht nur, wenn Ihre eigene Sitzung bereits mit einem Code bestätigt ist.',
    confirmLabel: mfaOn ? 'Aufheben' : 'Einschalten', danger: true,
    onConfirm: () => api().adminSetStaffMfa({ required: !mfaOn })
  }).then((ok) => { if (ok) { toast('Einstellung gespeichert.'); show('settings'); } }) } });
  view.append(el('h2', { text: 'Einstellungen' }),
    mfaPanel({ required: mfaOn, onDone: () => show('settings') }),
    el('section', { class: 'item stack' }, [el('h3', { text: 'Zwei-Faktor-Pflicht für das Team' }),
      el('p', {}, [el('span', { class: `badge ${mfaOn ? 'badge-ok' : 'badge-warn'}`, text: mfaOn ? 'eingeschaltet' : 'ausgeschaltet' }), ' · gilt für Admin-, Finanz- und Prüferkonten']), mfaToggle]),
    el('section', { class: 'item stack' }, [el('h3', { text: 'Push-Benachrichtigungen' }),
      el('p', {}, [el('span', { class: `badge ${push.enabled ? 'badge-ok' : 'badge-warn'}`, text: push.enabled ? 'eingeschaltet' : 'ausgeschaltet' }), ` · ${fmtInt(push.activeDevices)} aktive Geräte`]), toggle]),
    el('section', { class: 'item' }, [el('h3', { text: 'Betrieb' }), el('ul', {}, [
      el('li', { text: `Admins: ${fmtInt(ops.adminCount)} · Finanz-Admins: ${fmtInt(ops.financeAdminCount)}` }),
      el('li', { text: `Empfangskonten: ${ops.paymentAccountsConfigured ? 'hinterlegt' : 'fehlen'}` }),
      el('li', { text: 'Google-Anmeldung: ausgeschaltet (wird im Code zusammen mit dem Anbieter in Supabase aktiviert)' }),
      el('li', { text: 'Mail-Anbieter, Schlüssel und Weiterleitungsadressen werden im Supabase-Dashboard gepflegt, nicht hier.' })
    ])]));
}

const VIEWS = { master: viewMaster, market: viewMarket, tasks: viewTasks, automation: viewAutomation, readiness: viewReadiness, overview: viewOverview, payments: viewPayments, reviews: viewReviews, roles: viewRoles, investments: viewInvestments, trees: viewTrees, register: viewRegister, users: viewUsers, accounts: viewAccounts, export: viewExport, mail: viewMail, errors: viewErrors, audit: viewAudit, settings: viewSettings, system: viewSystem };

// ---------------------------------------------------------------- shell
async function show(tabId) {
  const allowed = TABS.filter((tab) => session.user && tab.roles.includes(session.user.role));
  const tab = allowed.find((entry) => entry.id === tabId) || allowed[0];
  if (!tab) return;
  session.tab = tab.id;
  const token = ++session.loadToken; // a slower earlier load must not overwrite a newer view
  for (const button of $('tablist').children) button.setAttribute('aria-selected', button.dataset.tab === tab.id ? 'true' : 'false');
  const view = $('view');
  view.setAttribute('aria-busy', 'true');
  view.replaceChildren(stateBlock('loading', 'Wird geladen …'));
  const fresh = document.createDocumentFragment();
  try {
    await VIEWS[tab.id](fresh);
    if (token !== session.loadToken) return;
    view.replaceChildren(fresh);
  } catch (error) {
    if (token !== session.loadToken) return;
    logError(`view ${tab.id}`, error);
    // The server demands a second factor: offer the code prompt (or the set-up) right here instead of a dead end.
    if (error && error.code === 'mfa-required') view.replaceChildren(mfaPanel({ required: true, onDone: () => show(tab.id) }));
    else view.replaceChildren(stateBlock('error', errorText(error), () => show(tab.id)));
    if (error && error.code === 'unauthenticated') signOut();
  } finally {
    if (token === session.loadToken) view.setAttribute('aria-busy', 'false');
  }
}

function screen(name) {
  for (const id of ['screen-boot', 'screen-login', 'screen-panel']) $(id).hidden = id !== `screen-${name}`;
}

function resetIdle() {
  clearTimeout(session.idleTimer);
  if (session.user) session.idleTimer = setTimeout(() => { toast('Automatisch abgemeldet (30 Minuten ohne Eingabe).'); signOut(); }, IDLE_LIMIT_MS);
}

async function signOut() {
  clearTimeout(session.idleTimer);
  try {
    await api().signOut();
  } catch (error) {
    logError('sign-out', error);
    toast('Abmelden fehlgeschlagen. Bitte das Fenster schließen.', true);
  }
}

function onAuth(user) {
  if (!user) {
    session.user = null;
    $('view').replaceChildren();
    $('login-password').value = '';
    screen('login');
    return;
  }
  if (!['admin', 'finance_admin'].includes(user.role)) {
    session.user = null;
    screen('login');
    const error = $('login-error');
    error.textContent = 'Dieses Konto hat keinen Zugriff auf das Admin-Panel.';
    error.hidden = false;
    signOut();
    return;
  }
  session.user = { uid: user.uid, email: user.email, role: user.role };
  $('who').textContent = `${user.email} · ${ROLE_LABEL[user.role]}`;
  const tablist = $('tablist');
  tablist.replaceChildren(...TABS.filter((tab) => tab.roles.includes(user.role)).map((tab) => {
    const button = el('button', { type: 'button', class: 'tab', role: 'tab', 'aria-selected': 'false', text: tab.label, on: { click: () => show(tab.id) } });
    button.dataset.tab = tab.id;
    return button;
  }));
  screen('panel');
  resetIdle();
  show(session.tab || '');
}

async function submitLogin() {
  const email = $('login-email').value.trim().toLowerCase();
  const password = $('login-password').value;
  const error = $('login-error');
  const button = $('login-submit');
  $('login-info').hidden = true;
  error.hidden = true;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password) {
    error.textContent = 'Bitte E-Mail und Passwort eingeben.';
    error.hidden = false;
    return;
  }
  button.disabled = true;
  button.textContent = 'Anmeldung läuft …';
  try {
    await api().signIn(email, password); // the auth-state event switches the screen
  } catch (err) {
    logError('sign-in', err);
    error.textContent = errorText(err);
    error.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = 'Anmelden';
  }
}

async function forgotPassword() {
  const email = $('login-email').value.trim().toLowerCase();
  const info = $('login-info');
  const error = $('login-error');
  error.hidden = true;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    error.textContent = 'Bitte zuerst die E-Mail-Adresse des Kontos eingeben.';
    error.hidden = false;
    $('login-email').focus();
    return;
  }
  try {
    await api().requestPasswordReset(email);
    info.textContent = 'Falls ein Konto mit dieser Adresse existiert, wurde ein Link zum Zurücksetzen gesendet. Bitte den Link in diesem Browser öffnen.';
    info.hidden = false;
  } catch (err) {
    logError('password reset', err);
    error.textContent = err && err.code === 'auth/over_email_send_rate_limit' ? 'Zu viele E-Mails in kurzer Zeit. Bitte in einer Stunde erneut versuchen.' : 'Die E-Mail konnte nicht gesendet werden. Bitte später erneut versuchen.';
    error.hidden = false;
  }
}

function initTheme() {
  let stored = '';
  try { stored = localStorage.getItem('faseela_admin_theme') || ''; } catch (error) { stored = ''; }
  const dark = stored ? stored === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  const apply = (isDark) => {
    document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
    $('theme-toggle').setAttribute('aria-pressed', isDark ? 'true' : 'false');
    $('theme-toggle').textContent = isDark ? 'Hell' : 'Dunkel';
  };
  apply(dark);
  $('theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme !== 'dark';
    apply(next);
    try { localStorage.setItem('faseela_admin_theme', next ? 'dark' : 'light'); } catch (error) { logError('theme', error); }
  });
}

initTheme();
$('login-submit').addEventListener('click', submitLogin);
$('login-forgot').addEventListener('click', forgotPassword);
$('login-password').addEventListener('keydown', (event) => { if (event.key === 'Enter') submitLogin(); });
$('sign-out').addEventListener('click', signOut);
for (const name of ['click', 'keydown', 'pointerdown']) document.addEventListener(name, resetIdle, { passive: true });
window.addEventListener('faseela-auth-state', (event) => onAuth(event.detail));
if (api() && api().implicitLinkRejected) {
  const info = $('login-info');
  info.textContent = 'Dieser Anmeldelink wird hier nicht unterstützt. Bitte mit Passwort anmelden oder „Passwort vergessen?" nutzen.';
  info.hidden = false;
}
// If the backend never reports a session state (network down), fall back to the sign-in form.
setTimeout(() => { if (!$('screen-boot').hidden) screen('login'); }, 6000);
