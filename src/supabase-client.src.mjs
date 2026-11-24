// SOURCE of public/supabase-client.mjs (bundled by scripts/build-web.cjs). Edit this file, then run `npm run build:web`.
//
// Supabase backend client for Faseela. It keeps the API surface of the former Firebase client
// (`window.FaseelaFirebase`, callables resolve to `{ data }`, listeners return an unsubscribe
// function) so public/index.html works unchanged. All authorization happens server-side:
// RLS for reads, SECURITY DEFINER RPCs for writes (see supabase/migrations).
import { createClient } from '@supabase/supabase-js';
import * as mappers from '../public/data-mappers.mjs';

// Public by design (like a Firebase web API key): it only identifies the project. Access is
// enforced by Row Level Security and the RPC role checks. Never put a secret/service key here.
const SUPABASE_URL = 'https://riyvlhlhzxxerlwqoxsy.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_EVAY3Rwv13sU5ojXrvIIpg_SLzF-DiU';

const PROOF_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];
const PROOF_MAX_BYTES = 5 * 1024 * 1024;
const SIGNED_URL_TTL_SECONDS = 600;
const RELOAD_DEBOUNCE_MS = 250;
const POLL_FALLBACK_MS = 30000;

// Implicit-flow links (for example "Send magic link" in the Supabase dashboard) return session tokens in the URL
// fragment. This client accepts PKCE only, so such a link can never sign anyone in here. The tokens are removed
// from the address bar and the history at once (they must not linger there) and the visitor is told what to do.
const arrivedWithImplicitTokens = /[#&](access_token|refresh_token)=/.test(location.hash);
if (arrivedWithImplicitTokens) {
  history.replaceState(null, '', location.pathname + location.search);
  window.addEventListener('load', () => setTimeout(() => {
    if (typeof window.showToast !== 'function') return;
    window.showToast(document.documentElement.lang === 'ar'
      ? 'هذا النوع من روابط الدخول غير مدعوم. استخدم «نسيت كلمة المرور؟» لتعيين كلمة مرور جديدة.'
      : 'This kind of sign-in link is not supported here. Use "Forgot Password?" to set a new password.');
  }, 1200));
}

// Google sign-in stays hidden until the provider is enabled in Supabase Auth (otherwise the redirect ends on an
// error page). Flip to true together with the provider configuration.
const GOOGLE_AUTH_ENABLED = false;

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    flowType: 'pkce',
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
});

const roleNames = {
  investor: { ar: 'كافل شجرة', en: 'Tree Sponsor' },
  farmer: { ar: 'مزارع شريك', en: 'Partner Farmer' },
  mill_operator: { ar: 'صاحب معصرة', en: 'Mill Operator' },
  finance_admin: { ar: 'مدقق مالي', en: 'Finance Administrator' },
  quality_auditor: { ar: 'مدقق جودة', en: 'Quality Auditor' },
  admin: { ar: 'إدارة المنصة', en: 'Platform Administrator' }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Error with a stable `code` (server RPC hint, e.g. 'permission-denied'). */
class BackendError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'BackendError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

let secondFactorAnnouncedAt = 0;
/** A team account without a confirmed second factor gets one clear message in the app instead of generic errors. */
function announceSecondFactorNeeded() {
  if (Date.now() - secondFactorAnnouncedAt < 15000) return;
  secondFactorAnnouncedAt = Date.now();
  window.dispatchEvent(new CustomEvent('faseela-toast', { detail: {
    ar: 'هذا الحساب يحتاج إلى تأكيد بعامل ثانٍ. افتح لوحة الإدارة (‎/admin/‎) وأكّد برمز تطبيق المصادقة.',
    en: 'This account needs a second factor. Open the admin panel (/admin/) and confirm with your authenticator app.',
    de: 'Dieses Konto braucht einen zweiten Faktor. Öffnen Sie den Admin-Bereich (/admin/) und bestätigen Sie mit Ihrer Authenticator-App.'
  } }));
}

function toBackendError(error, fallbackCode = 'internal') {
  if (error instanceof BackendError) return error;
  // RPC business errors use SQLSTATE P0001 with the stable code in `hint`.
  if (error && error.code === 'P0001' && typeof error.hint === 'string' && error.hint) {
    if (error.hint === 'mfa-required') announceSecondFactorNeeded();
    return new BackendError(error.hint, error.message, error);
  }
  if (error && error.code === '42501') {
    return new BackendError('permission-denied', 'This operation is not permitted for this account.', error);
  }
  const message = (error && error.message) || 'The request could not be completed.';
  return new BackendError((error && error.code) || fallbackCode, message, error);
}

const camelKey = (key) => key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

/** Deep snake_case -> camelCase so server rows match the mapper field names. */
function camelize(value) {
  if (Array.isArray(value)) return value.map(camelize);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [camelKey(key), camelize(inner)]));
  }
  return value;
}

function dispatchAuthState(detail) {
  window.dispatchEvent(new CustomEvent('faseela-auth-state', { detail }));
}

const isNative = Boolean(window.Capacitor?.isNativePlatform?.());
// Custom scheme registered in AndroidManifest.xml / Info.plist (capacitor.config.json iosScheme).
const NATIVE_SCHEME = 'faseela://app/';

/** URL of a page inside this app (web origin or the native WebView origin). */
// Paths such as 'auth/reset.html' are resolved against the app root, i.e. the folder this module is served from,
// not against the page that happens to call it. Resolving against the page sent the password-reset link requested
// from /admin/ to /admin/auth/reset.html, which does not exist.
const APP_ROOT = new URL('./', import.meta.url).toString();
function webUrl(pathname = '') {
  return pathname ? new URL(pathname, APP_ROOT).toString() : `${location.origin}${location.pathname}`;
}

/** Where Supabase sends the browser after an e-mail link or OAuth: back into the app. */
function appRedirect(pathname = '') {
  if (isNative) return `${NATIVE_SCHEME}${pathname ? pathname.replace(/\.html$/, '') : 'callback'}`;
  return webUrl(pathname);
}

// Native apps: the deep link `faseela://app/...?code=...` arrives via the App plugin (registered by
// the native runtime); exchange the PKCE code here because detectSessionInUrl cannot see it.
if (isNative && window.Capacitor?.Plugins?.App?.addListener) {
  window.Capacitor.Plugins.App.addListener('appUrlOpen', ({ url }) => {
    let parsed;
    try { parsed = new URL(url); } catch (error) { return; }
    const code = parsed.searchParams.get('code');
    if (!code) return;
    supabase.auth.exchangeCodeForSession(code).then(({ error }) => {
      if (error) console.warn('[faseela] native code exchange failed:', error.code || error.message);
    });
  });
}

/** Callable-compatible RPC: resolves to `{ data }`, rejects with BackendError. */
function callable(name) {
  return async (payload = {}) => {
    const { data, error } = await supabase.rpc(name, { payload: payload || {} });
    if (error) throw toBackendError(error);
    return { data: camelize(data) };
  };
}

async function requireUser() {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) throw new BackendError('unauthenticated', 'Sign in is required.', error);
  return data.user;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------
let currentUser = null;
let publishing = null;
let publishedKey = '';
let registrationInProgress = false;

async function maybeSubmitRoleApplication(profile) {
  const role = profile?.requestedRole;
  if (!['farmer', 'mill_operator'].includes(role) || profile.role !== 'investor') return;
  const { data, error } = await supabase.from('role_applications').select('status').eq('user_id', profile.uid).maybeSingle();
  if (error) {
    console.warn('[faseela] role application lookup failed:', error.code || error.message);
    return;
  }
  if (data) return; // pending, approved or rejected: never auto-resubmit
  try {
    await callable('submit_role_application')({ requestedRole: role, region: profile.region || '' });
  } catch (submitError) {
    // Region missing or too short: the user can apply later from the portal.
    console.warn('[faseela] role application not submitted:', submitError.code || submitError.message);
  }
}

async function publishSessionNow(user) {
  if (!user) {
    currentUser = null;
    publishedKey = '';
    dispatchAuthState(null);
    return;
  }
  if (!user.email_confirmed_at && user.app_metadata?.provider === 'email') {
    if (!registrationInProgress) await supabase.auth.signOut({ scope: 'local' });
    return;
  }

  const { data } = await callable('ensure_profile')({});
  const profile = data.profile || {};
  await maybeSubmitRoleApplication(profile);
  const consent = await supabase.from('profiles').select('marketing_opt_in').eq('id', user.id).maybeSingle();
  const marketingOptIn = Boolean(consent.data?.marketing_opt_in);

  const claimRole = data.role || 'investor';
  const key = `${user.id}:${claimRole}`;
  if (key === publishedKey) return; // token refreshes and duplicate events do not re-subscribe
  publishedKey = key;
  currentUser = user;

  const appRole = claimRole === 'mill_operator' ? 'mill_owner' : claimRole;
  const labels = roleNames[claimRole] || roleNames.investor;
  const displayName = profile.displayName || user.user_metadata?.display_name
    || user.user_metadata?.full_name || user.email?.split('@')[0] || 'Sponsor';
  const avatar = displayName.trim().charAt(0) || '؟';

  dispatchAuthState({
    id: user.id,
    uid: user.id,
    email: user.email || '',
    phone: profile.phone || '',
    name: displayName,
    name_en: displayName,
    role: appRole,
    claimRole,
    roleName: labels.ar,
    roleName_en: labels.en,
    avatar,
    avatar_en: avatar,
    badgeColor: claimRole === 'admin' ? 'bg-purple-100 text-purple-950' : 'bg-olive-100 text-olive-800',
    region: profile.region || '',
    marketing_opt_in: marketingOptIn,
    email_verified: Boolean(user.email_confirmed_at),
    auth_provider: user.app_metadata?.provider || 'email',
    permittedPages: ['home', 'marketplace', 'dashboard']
  });
}

/** Serializes session publication so concurrent auth events cannot interleave. */
function publishSession(user) {
  const run = (publishing || Promise.resolve()).then(() => publishSessionNow(user));
  publishing = run.catch((error) => {
    console.error('Could not initialize the Faseela session:', error.code || error.message);
    currentUser = null;
    publishedKey = '';
    dispatchAuthState(null);
  });
  return run;
}

// E-mail confirmation / recovery links land here with ?code= (PKCE). If the link was opened in a
// different browser than the one used for sign-up, the e-mail is confirmed but no session exists.
const arrivedFromEmailLink = /[?&#](code|error_code|error)=/.test(location.search + location.hash);

function finishEmailLinkLanding(session) {
  if (!arrivedFromEmailLink) return;
  history.replaceState(null, '', location.pathname);
  if (!session && typeof window.showToast === 'function') {
    const en = document.documentElement.lang !== 'ar';
    window.showToast(en
      ? 'Your e-mail is confirmed. Please sign in now.'
      : 'تم تأكيد بريدك الإلكتروني. يرجى تسجيل الدخول الآن.');
  }
}

supabase.auth.onAuthStateChange((event, session) => {
  // Never await Supabase calls inside this callback (auth lock); defer to the next task.
  setTimeout(() => {
    if (event === 'INITIAL_SESSION') finishEmailLinkLanding(session);
    // Tab refocus re-emits SIGNED_IN for the same user: nothing changed, no network round trip.
    if (event === 'SIGNED_IN' && publishedKey && session?.user?.id === currentUser?.id) return;
    if (event === 'PASSWORD_RECOVERY') {
      try { sessionStorage.setItem('faseela_recovery', String(Date.now())); } catch (storageError) { console.warn('recovery marker not stored', storageError); }
      if (!/\/auth\/reset\.html$/.test(location.pathname)) {
        location.assign(webUrl('auth/reset.html'));
      } else {
        publishSession(session?.user || null);
      }
      return;
    }
    if (event === 'SIGNED_OUT') {
      publishSession(null);
    } else if (['INITIAL_SESSION', 'SIGNED_IN', 'USER_UPDATED'].includes(event)) {
      publishSession(session?.user || null);
    }
  }, 0);
});

// ---------------------------------------------------------------------------
// Auth API
// ---------------------------------------------------------------------------
async function signIn(email, password) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const { data, error } = await supabase.auth.signInWithPassword({ email: normalizedEmail, password });
  if (error) {
    if (error.code === 'email_not_confirmed') {
      await supabase.auth.resend({ type: 'signup', email: normalizedEmail, options: { emailRedirectTo: appRedirect() } });
      throw new BackendError('auth/email-not-verified', 'Verify your email using the link we just sent, then sign in again.', error);
    }
    throw new BackendError(error.code === 'invalid_credentials' ? 'auth/invalid-credential' : `auth/${error.code || 'failed'}`, error.message, error);
  }
  await publishSession(data.user);
  return data.user;
}

async function register({ email, password, displayName, phone, requestedRole, region, consents }) {
  const role = requestedRole === 'mill_owner' ? 'mill_operator'
    : ['farmer', 'mill_operator'].includes(requestedRole) ? requestedRole : 'investor';
  registrationInProgress = true;
  try {
    const { data, error } = await supabase.auth.signUp({
      email: String(email || '').trim().toLowerCase(),
      password,
      options: {
        emailRedirectTo: appRedirect(),
        // Profile input only (copied into public.profiles by a trigger); never used for authorization.
        data: {
          display_name: String(displayName || '').trim(),
          phone: String(phone || '').trim(),
          region: String(region || '').trim(),
          requested_role: role,
          // Documents ticked in the form; the sign-up trigger stores them as consent records (current versions only).
          consents: Array.isArray(consents) ? consents.slice(0, 5).map((c) => ({ kind: String(c.kind || ''), version: String(c.version || '') })) : []
        }
      }
    });
    if (error) throw new BackendError(`auth/${error.code || 'signup-failed'}`, error.message, error);
    // With e-mail confirmation enabled there is no session yet; if a session exists anyway,
    // end it so the verification step is never skipped.
    if (data.session) await supabase.auth.signOut({ scope: 'local' });
    return { email: data.user?.email || String(email).trim().toLowerCase(), requestedRole: role };
  } finally {
    registrationInProgress = false;
  }
}

async function signInWithGoogle() {
  // Web: full-page redirect (no popup); the session is picked up by detectSessionInUrl on return.
  // Native: Google refuses OAuth inside WebViews, so the consent screen opens in the system
  // browser and returns through the faseela:// deep link (see appUrlOpen above).
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: appRedirect(),
      queryParams: { prompt: 'select_account' },
      skipBrowserRedirect: isNative
    }
  });
  if (error) throw new BackendError(`auth/${error.code || 'oauth-failed'}`, error.message, error);
  if (isNative && data?.url) window.open(data.url, '_system', 'noopener');
  return new Promise(() => {}); // the page navigates away / the app waits for the deep link
}

async function requestPasswordReset(email) {
  if (!email || !String(email).includes('@')) {
    throw new BackendError('auth/invalid-email', 'Enter the email address for your account first.');
  }
  const { error } = await supabase.auth.resetPasswordForEmail(String(email).trim().toLowerCase(), {
    redirectTo: appRedirect('auth/reset.html')
  });
  if (error) throw new BackendError(`auth/${error.code || 'reset-failed'}`, error.message, error);
}

async function updatePassword(newPassword) {
  if (typeof newPassword !== 'string' || newPassword.length < 10) {
    throw new BackendError('auth/weak-password', 'Use at least 10 characters.');
  }
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw new BackendError(`auth/${error.code || 'update-failed'}`, error.message, error);
}

async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw toBackendError(error);
}

/** Ends every session of this account except the current one (other devices and browsers). */
async function signOutOtherSessions() {
  const { error } = await supabase.auth.signOut({ scope: 'others' });
  if (error) throw toBackendError(error);
}

// ---------------------------------------------------------------------------
// Data API
// ---------------------------------------------------------------------------
async function uploadPaymentProof(requestId, file) {
  const user = await requireUser();
  if (!/^[a-f0-9]{64}$/.test(String(requestId || ''))) throw new BackendError('invalid-argument', 'Investment request ID is invalid.');
  if (!file) throw new BackendError('invalid-argument', 'A payment receipt file is required.');
  if (!PROOF_TYPES.includes(file.type)) throw new BackendError('invalid-argument', 'Only JPEG, PNG, or PDF payment receipts are accepted.');
  if (file.size > PROOF_MAX_BYTES) throw new BackendError('invalid-argument', 'Payment receipt file size must not exceed 5 MB.');
  const cleanName = (file.name || 'receipt').replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.{2,}/g, '_').slice(-80) || 'receipt';
  const path = `${user.id}/${requestId}/${Date.now()}_${cleanName}`;
  const { error: uploadError } = await supabase.storage.from('payment-proofs').upload(path, file, {
    contentType: file.type,
    upsert: false,
    cacheControl: '0'
  });
  if (uploadError) throw new BackendError('failed-precondition', 'The payment receipt could not be uploaded. The reservation may have expired.', uploadError);
  const { data } = await callable('submit_investment_payment_proof')({ requestId, storagePath: path });
  return data;
}

const FIELD_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const FIELD_MEDIA_MAX_BYTES = 10 * 1024 * 1024;

function cleanFileName(name, fallback) {
  return (String(name || fallback).replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.{2,}/g, '_').slice(-80)) || fallback;
}

/** Uploads one field photo for a tree the farmer is assigned to; returns the storage path for submit_farmer_update. */
async function uploadFieldMedia(treeId, file) {
  const user = await requireUser();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(treeId || ''))) throw new BackendError('invalid-argument', 'Tree id is invalid.');
  if (!file || !FIELD_MEDIA_TYPES.includes(file.type)) throw new BackendError('invalid-argument', 'Only JPEG, PNG or WebP photos are accepted.');
  if (file.size > FIELD_MEDIA_MAX_BYTES) throw new BackendError('invalid-argument', 'A photo must not exceed 10 MB.');
  const path = `${user.id}/${treeId}/${Date.now()}_${cleanFileName(file.name, 'photo.jpg')}`;
  const { error } = await supabase.storage.from('field-media').upload(path, file, { contentType: file.type, upsert: false, cacheControl: '3600' });
  if (error) throw new BackendError('failed-precondition', 'The photo could not be uploaded (assignment or limit).', error);
  return path;
}

/** Uploads the farmer's own profile photo (<uid>/profile/...); returns the path for update_farmer_profile. */
async function uploadFarmerProfilePhoto(file) {
  const user = await requireUser();
  if (!file || !FIELD_MEDIA_TYPES.includes(file.type)) throw new BackendError('invalid-argument', 'Only JPEG, PNG or WebP photos are accepted.');
  if (file.size > FIELD_MEDIA_MAX_BYTES) throw new BackendError('invalid-argument', 'A photo must not exceed 10 MB.');
  const path = `${user.id}/profile/${Date.now()}_${cleanFileName(file.name, 'me.jpg')}`;
  const { error } = await supabase.storage.from('field-media').upload(path, file, { contentType: file.type, upsert: false, cacheControl: '3600' });
  if (error) throw new BackendError('failed-precondition', 'The profile photo could not be uploaded.', error);
  return path;
}

/** Active tree/mill assignments of the signed-in farmer or operator. */
async function myAssignments() {
  const { data, error } = await supabase.rpc('my_assignments');
  if (error) throw toBackendError(error);
  return camelize(data) || { trees: [], mills: [] };
}

/** The farmer's own public profile row (RLS lets the owner read it even without consent). */
async function myFarmerProfile() {
  const user = await requireUser();
  const { data, error } = await supabase.from('farmer_profiles').select('*').eq('farmer_uid', user.id).maybeSingle();
  if (error) throw toBackendError(error);
  return data ? camelize(data) : null;
}

async function listPublicTrees() {
  const { data, error } = await supabase.from('trees_public').select('*').eq('status', 'listed');
  if (error) throw toBackendError(error);
  return (data || []).map((row) => mappers.mapPublicTree(camelize(row)));
}

/**
 * Active origin countries and listed farms (public reference data, migration 48). A project that does not have
 * these tables yet answers with an error; the catalogue then simply has no country filter and no farm names.
 */
async function listOrigins() {
  const [countries, farms] = await Promise.all([
    supabase.from('countries').select('code,name,name_en,name_de,currency'),
    supabase.from('farms').select('farm_id,country_code,name,name_en,region,region_en')
  ]);
  if (countries.error || farms.error) {
    console.warn('origins unavailable', (countries.error || farms.error).message);
    return { countries: [], farms: [] };
  }
  return {
    countries: (countries.data || []).map((row) => mappers.mapCountry(camelize(row))).filter(Boolean),
    farms: (farms.data || []).map((row) => mappers.mapFarm(camelize(row))).filter(Boolean)
  };
}

/** Stores the interface language on the profile of the signed-in user (ar | en | de). */
async function setMyLocale(locale) {
  const { data } = await callable('set_my_locale')({ locale });
  return data;
}

/**
 * Live list of the caller's own rows: initial load + Realtime change notifications
 * (RLS-filtered on the server). Falls back to polling if the Realtime channel fails.
 */
// Active loaders of all live lists: re-run after the tab was hidden, the device came back online or a bfcache
// restore — Realtime does not replay events missed while the socket was down.
const activeLoaders = new Set();
let lastSyncAt = 0;
let hiddenSince = 0;
const RESYNC_AFTER_HIDDEN_MS = 30000;

function publishSyncState(extra = {}) {
  window.dispatchEvent(new CustomEvent('faseela-sync-state', { detail: { online: navigator.onLine !== false, lastSyncAt, ...extra } }));
}

function resyncAll(reason) {
  if (activeLoaders.size === 0) return;
  for (const load of activeLoaders) load();
  publishSyncState({ reason });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { hiddenSince = Date.now(); return; }
  if (hiddenSince && Date.now() - hiddenSince >= RESYNC_AFTER_HIDDEN_MS) resyncAll('visible');
  hiddenSince = 0;
});
window.addEventListener('online', () => resyncAll('online'));
window.addEventListener('offline', () => publishSyncState({ reason: 'offline' }));
window.addEventListener('pageshow', (event) => { if (event.persisted) resyncAll('pageshow'); });

function watchOwnRows(table, ownerColumn, mapper, callback, onError) {
  if (!currentUser) return () => {};
  const uid = currentUser.id;
  let active = true;
  let reloadTimer = null;
  let pollTimer = null;
  let loadedOnce = false;

  const load = async () => {
    const { data, error } = await supabase.from(table).select('*').eq(ownerColumn, uid)
      .order('created_at', { ascending: false }).limit(500);
    if (!active) return;
    if (error) {
      console.error(`[faseela] ${table} load failed:`, error.code || error.message);
      if (!loadedOnce && typeof onError === 'function') onError(toBackendError(error));
      return;
    }
    loadedOnce = true;
    lastSyncAt = Date.now();
    callback((data || []).map((row) => mapper(camelize(row))));
    publishSyncState();
  };
  activeLoaders.add(load);
  const scheduleReload = () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, RELOAD_DEBOUNCE_MS);
  };

  load();
  const channel = supabase
    .channel(`faseela:${table}:${uid}:${Math.random().toString(36).slice(2)}`)
    .on('postgres_changes', { event: '*', schema: 'public', table, filter: `${ownerColumn}=eq.${uid}` }, scheduleReload)
    .subscribe((status) => {
      if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && !pollTimer && active) {
        console.warn(`[faseela] realtime unavailable for ${table}; polling every ${POLL_FALLBACK_MS / 1000}s`);
        pollTimer = setInterval(load, POLL_FALLBACK_MS);
      }
      // Channel (re)joined after an outage: stop polling and catch up once.
      if (status === 'SUBSCRIBED' && active && loadedOnce) {
        clearInterval(pollTimer);
        pollTimer = null;
        scheduleReload();
      }
    });

  return () => {
    active = false;
    activeLoaders.delete(load);
    clearTimeout(reloadTimer);
    clearInterval(pollTimer);
    supabase.removeChannel(channel);
  };
}

const watchMyInvestments = (callback, onError) => watchOwnRows('investment_requests', 'user_id', mappers.mapInvestment, callback, onError);
const watchMyShares = (callback, onError) => watchOwnRows('shares', 'user_id', mappers.mapShare, callback, onError);
const watchMyTransactions = (callback, onError) => watchOwnRows('transactions', 'user_id', mappers.mapTransaction, callback, onError);
const watchMyFarmerUpdates = (callback, onError) => watchOwnRows('farmer_updates', 'farmer_uid', mappers.normalizeDoc, callback, onError);
// Mill pressings and weighed harvests share the table; a harvest row arrives with isHarvest, harvestKg and netKg.
const watchMyPressingBatches = (callback, onError) => watchOwnRows('pressing_batches', 'submitted_by_uid', mappers.mapPressingBatch, callback, onError);

/**
 * An allocation has no unit of its own: its amount is millilitres for an olive tree and grams for every other crop.
 * The crop is read from the public catalogue, which lists listed trees only, so an allocation of an unlisted tree
 * keeps `unit: null` and the page must not print it as litres.
 */
const allocationCropByTree = new Map();
async function withAllocationUnits(rows) {
  const missing = [...new Set(rows.map((row) => row.treeId).filter((id) => typeof id === 'string' && id && !allocationCropByTree.has(id)))];
  if (missing.length > 0) {
    const { data, error } = await supabase.from('trees_public').select('tree_id,crop_category').in('tree_id', missing);
    if (error) console.warn('[faseela] crop lookup for allocations failed:', error.code || error.message);
    for (const tree of data || []) allocationCropByTree.set(tree.tree_id, tree.crop_category);
  }
  return rows.map((row) => mappers.mapOilAllocation(row, allocationCropByTree));
}
function watchMyOilAllocations(callback, onError) {
  let active = true;
  let latest = 0;
  const stop = watchOwnRows('oil_allocations', 'user_id', mappers.normalizeDoc, (rows) => {
    const mine = ++latest;
    // Only the newest load may publish; a slow crop lookup must not overwrite fresher rows.
    withAllocationUnits(rows)
      .catch((error) => {
        console.warn('[faseela] allocation units unavailable:', (error && (error.code || error.message)) || error);
        return rows.map((row) => mappers.mapOilAllocation(row, allocationCropByTree));
      })
      .then((mapped) => { if (active && mine === latest) callback(mapped); });
  }, onError);
  return () => {
    active = false;
    stop();
  };
}
const watchMyOilRequests = (callback, onError) => watchOwnRows('oil_requests', 'user_id', mappers.mapOilRequest, callback, onError);

function watchMyRoleApplication(callback, onError) {
  if (!currentUser) return () => {};
  const uid = currentUser.id;
  let active = true;
  const load = async () => {
    const { data, error } = await supabase.from('role_applications').select('*').eq('user_id', uid).maybeSingle();
    if (!active) return;
    if (error) {
      console.error('[faseela] role application load failed:', error.code || error.message);
      if (typeof onError === 'function') onError(toBackendError(error));
      return;
    }
    callback(data ? mappers.normalizeDoc(camelize(data)) : null);
    // An approved application changes the role server-side; republish so the UI switches
    // to the new portal without a manual reload.
    if (data?.status === 'approved' && currentUser && !publishedKey.endsWith(`:${data.requested_role}`)) {
      publishSession(currentUser);
    }
  };
  load();
  const channel = supabase
    .channel(`faseela:role_applications:${uid}:${Math.random().toString(36).slice(2)}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'role_applications', filter: `user_id=eq.${uid}` }, load)
    .subscribe();
  return () => {
    active = false;
    supabase.removeChannel(channel);
  };
}

async function listReviewQueue(queue) {
  const { data } = await callable('list_review_queue')({ queue });
  return (data?.items || []).map((item) => mappers.mapReviewItem(queue, item));
}

/** Signed read URLs for field photos a reviewer is about to publish (storage policy: quality_auditor/admin only). */
async function signFieldMedia(paths = []) {
  const clean = (Array.isArray(paths) ? paths : []).filter((x) => /^[A-Za-z0-9._\/-]{1,300}$/.test(String(x || '')) && !String(x).includes('..')).slice(0, 5);
  if (clean.length === 0) return [];
  const { data, error } = await supabase.storage.from('field-media').createSignedUrls(clean, SIGNED_URL_TTL_SECONDS);
  if (error) throw toBackendError(error, 'permission-denied');
  return (data || []).map((row, i) => ({ path: clean[i], url: row.signedUrl || null, error: row.error || null }));
}

async function getPaymentProofUrl({ requestId } = {}) {
  if (!/^[a-f0-9]{64}$/.test(String(requestId || ''))) throw new BackendError('invalid-argument', 'Investment request ID is invalid.');
  const { data: row, error } = await supabase.from('investment_requests').select('payment_proof_path').eq('id', requestId).maybeSingle();
  if (error) throw toBackendError(error);
  if (!row?.payment_proof_path) throw new BackendError('not-found', 'No payment proof is attached to this request.');
  // Storage policy grants read only to the owner and finance reviewers.
  const { data, error: signError } = await supabase.storage.from('payment-proofs')
    .createSignedUrl(row.payment_proof_path, SIGNED_URL_TTL_SECONDS);
  if (signError) throw toBackendError(signError, 'permission-denied');
  return { data: { url: data.signedUrl, expiresInSeconds: SIGNED_URL_TTL_SECONDS } };
}

async function adminListUsers() {
  const { data } = await callable('admin_list_users')({});
  return (data?.users || []).map(mappers.mapDirectoryUser);
}

/** Admin: active farmer-tree and mill assignments of one user (RLS: admin may read all). */
async function adminListAssignments(userId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(userId || ''))) throw new BackendError('invalid-argument', 'User ID is invalid.');
  const [trees, mills] = await Promise.all([
    supabase.from('farmer_assignments').select('tree_id').eq('farmer_uid', userId).is('revoked_at', null).order('tree_id'),
    supabase.from('mill_assignments').select('mill_id').eq('operator_uid', userId).is('revoked_at', null).order('mill_id')
  ]);
  if (trees.error) throw toBackendError(trees.error);
  if (mills.error) throw toBackendError(mills.error);
  return { trees: (trees.data || []).map((r) => r.tree_id), mills: (mills.data || []).map((r) => r.mill_id) };
}

/** Persists name/phone/region server-side (validated RPC, audit-logged). Returns the stored profile. */
async function updateMyProfile({ displayName, phone, region }) {
  const { data } = await callable('update_my_profile')({ displayName, phone, region });
  return data;
}

/** Versioned, revocable consent for onboarding/follow-up mail (default: off). */
async function setMarketingConsent(optIn, version = 'marketing-v1') {
  const { data } = await callable('set_marketing_consent')({ optIn: Boolean(optIn), version });
  return data;
}

/** Coarse public health flags (anon): { api, jobs, email, checkedAt }. */
async function publicStatus() {
  const { data, error } = await supabase.rpc('public_status');
  if (error) throw toBackendError(error);
  return camelize(data);
}

// One-click unsubscribe landing (?unsubscribe=marketing): revoke consent once a session exists.
const unsubscribeRequested = /[?&]unsubscribe=marketing\b/.test(location.search);
if (unsubscribeRequested) {
  window.addEventListener('faseela-auth-state', async (event) => {
    if (!event.detail?.id || !unsubscribeRequested) return;
    try {
      await setMarketingConsent(false);
      window.dispatchEvent(new CustomEvent('faseela-toast', { detail: { ar: 'تم إلغاء اشتراكك في رسائل المتابعة.', en: 'You are unsubscribed from follow-up e-mails.' } }));
    } catch (error) {
      console.error('Unsubscribe failed:', error.code || error.message);
    } finally {
      history.replaceState(null, '', location.pathname + location.hash);
    }
  }, { once: true });
}

/** Downloads the owner's PDF certificate for one share via the `certificate` Edge Function. */
async function downloadShareCertificate(shareId) {
  if (!/^[0-9a-f]{64}$/.test(String(shareId || ''))) throw new BackendError('invalid-argument', 'Share id is invalid.');
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData?.session?.access_token;
  if (!token) throw new BackendError('unauthenticated', 'Sign in is required.');
  const res = await fetch(`${SUPABASE_URL}/functions/v1/certificate?shareId=${shareId}`, {
    headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_PUBLISHABLE_KEY }
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new BackendError(res.status === 404 ? 'not-found' : res.status === 401 ? 'unauthenticated' : 'internal', body.error || `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const serial = (res.headers.get('content-disposition') || '').match(/faseela-([A-Z0-9-]+)\.pdf/)?.[1] || shareId.slice(0, 16);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `faseela-${serial}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return { serial };
}

async function exportMyData() {
  const { data } = await callable('export_my_data')({});
  // Harvest/oil records live in their own export RPC (added later); merge so one file holds everything.
  try {
    const { data: oil, error } = await supabase.rpc('export_my_oil');
    if (!error && oil) Object.assign(data, camelize(oil));
  } catch (error) {
    console.error('[faseela] oil export failed:', error.code || error.message);
  }
  try {
    const { data: rewards, error } = await supabase.rpc('export_my_rewards');
    if (!error && rewards) data.rewards = camelize(rewards);
  } catch (error) {
    console.error('[faseela] rewards export failed:', error.code || error.message);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Gifts & referrals. Codes are secrets: the server stores only hashes, the client never logs them.
// ---------------------------------------------------------------------------
/** No-argument RPC (`my_gifts()` etc.), same `{ data }` contract as callable(). */
function callableNoArg(name) {
  return async () => {
    const { data, error } = await supabase.rpc(name);
    if (error) throw toBackendError(error);
    return { data: camelize(data) };
  };
}

const REFERRAL_RE = /^[A-Z2-9]{8}$/;
const GIFT_RE = /^[A-Z0-9]{12}$/;

function normalizeReferralCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return REFERRAL_RE.test(code) ? code : '';
}

/** Accepts "abcd-efgh-ijkl", "ABCD EFGH IJKL" or 12 bare characters; returns "XXXX-XXXX-XXXX" or "". */
function normalizeGiftCode(value) {
  const bare = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return GIFT_RE.test(bare) ? `${bare.slice(0, 4)}-${bare.slice(4, 8)}-${bare.slice(8, 12)}` : '';
}

function readPending(key) {
  try { return sessionStorage.getItem(key) || ''; } catch (error) { return ''; }
}
function writePending(key, value) {
  try { if (value) sessionStorage.setItem(key, value); else sessionStorage.removeItem(key); } catch (error) { /* storage blocked: deep link simply not remembered */ }
}

// Deep links: ?ref=CODE (referral, used at checkout) and ?gift=CODE (redeem after sign-in).
// Stored in sessionStorage so the code survives the sign-in round trip but not the tab.
(() => {
  const params = new URLSearchParams(location.search);
  const ref = normalizeReferralCode(params.get('ref'));
  const gift = normalizeGiftCode(params.get('gift'));
  if (!params.has('ref') && !params.has('gift')) return;
  if (ref) writePending('faseela_ref', ref);
  if (gift) writePending('faseela_gift', gift);
  params.delete('ref');
  params.delete('gift');
  const search = params.toString();
  history.replaceState(null, '', location.pathname + (search ? `?${search}` : '') + location.hash);
})();

const pendingReferralCode = () => normalizeReferralCode(readPending('faseela_ref'));
const pendingGiftCode = () => normalizeGiftCode(readPending('faseela_gift'));
const clearPendingReferralCode = () => writePending('faseela_ref', '');
const clearPendingGiftCode = () => writePending('faseela_gift', '');

const attachRequestExtrasRpc = callable('attach_request_extras');
/** Attaches gift recipient and/or referral code to an open request; clears the stored referral on success. */
async function attachRequestExtras({ requestId, giftRecipientName, giftMessage, referralCode }) {
  const payload = { requestId };
  const name = String(giftRecipientName || '').trim().slice(0, 80);
  const message = String(giftMessage || '').trim().slice(0, 300);
  const ref = normalizeReferralCode(referralCode);
  if (name) payload.giftRecipientName = name;
  if (name && message) payload.giftMessage = message;
  if (ref) payload.referralCode = ref;
  if (!name && !ref) return { data: { requestId, gift: false, referral: false } };
  const result = await attachRequestExtrasRpc(payload);
  if (ref) clearPendingReferralCode();
  return result;
}

const redeemGiftRpc = callable('redeem_gift');
/** Redeems a gift code; resolves `{ data: { status: 'redeemed' | 'invalid', ... } }` (never throws for a wrong code). */
async function redeemGift(code) {
  const normalized = normalizeGiftCode(code);
  if (!normalized) throw new BackendError('invalid-argument', 'Gift code format is invalid.');
  const result = await redeemGiftRpc({ code: normalized });
  if (result.data?.status === 'redeemed') clearPendingGiftCode();
  return result;
}

/** Receiving accounts for bank/cash transfer, maintained by admins (migration 29). Resolves `{ data: null }` while unconfigured. */
const paymentInstructions = callableNoArg('payment_instructions');
const adminSetPaymentInstructions = callable('admin_set_payment_instructions');
/** Admin view of the receiving accounts: `{ live, pending, fourEyes, adminCount }` (migration 31). */
const adminPaymentState = callableNoArg('admin_payment_state');
/** Approve (a different admin than the proposer) or reject/withdraw the open proposal. */
const adminReviewPaymentInstructions = callable('admin_review_payment_instructions');

/** Sanctions/KYC screening record for a payment under review (migration 32); approval is refused without a clear one. */
const recordPaymentScreening = callable('record_payment_screening');
const paymentScreeningState = callable('payment_screening_state');
/** Bookkeeping export `{ from, to, rows, truncated }` for finance admins (audited, rate-limited). */
const financeExport = callable('finance_export');

/** Push notifications (migration 33): device tokens of the signed-in user; the native app registers them. */
const registerPushToken = callable('register_push_token');
const unregisterPushToken = callable('unregister_push_token');
const pushState = callableNoArg('push_state');

/** Admin cockpit read models and switches (migration 36); every call is role-checked server-side. */
const adminDashboard = callableNoArg('admin_dashboard');
const adminListInvestments = callable('admin_list_investments');
const adminListTrees = callableNoArg('admin_list_trees');
const adminListClientErrors = callableNoArg('admin_list_client_errors');
const adminSetTreeStatus = callable('admin_set_tree_status');
const adminSetPushEnabled = callable('admin_set_push_enabled');
const adminCreateTree = callable('admin_create_tree');
const adminUpdateTree = callable('admin_update_tree');
const adminGetTree = callable('admin_get_tree');
const adminUserDetail = callable('admin_user_detail');
const adminListShares = callable('admin_list_shares');
const adminListOutbox = callableNoArg('admin_list_outbox');
const adminRetryEmail = callable('admin_retry_email');
const adminTasks = callableNoArg('admin_tasks');
const adminAutomationState = callableNoArg('admin_automation_state');
const adminReadiness = callableNoArg('admin_readiness');
const adminKpiHistory = callableNoArg('admin_kpi_history');
const adminSearch = callable('admin_search');
const adminSetAutomationRule = callable('admin_set_automation_rule');
const adminSetJobActive = callable('admin_set_job_active');
const adminSetReadiness = callable('admin_set_readiness');
const adminSetTreeMill = callable('admin_set_tree_mill');
const adminGetTreeMill = callable('admin_get_tree_mill');
const adminSetTreeCrop = callable('admin_set_tree_crop');
const adminListMasterData = callable('admin_list_master_data');
const staffSecurityState = callable('staff_security_state');
const adminSetStaffMfa = callable('admin_set_staff_mfa');

// ---- Marketplace (migration 50): farm products, orders, service fee ----
const marketplaceConfig = callableNoArg('marketplace_config');
const quoteOrder = callable('quote_order');
const createOrder = callable('create_order');
const reportOrderPayment = callable('report_order_payment');
const cancelMyOrder = callable('cancel_my_order');
const listMyOrders = callableNoArg('list_my_orders');
const farmerUpsertProduct = callable('farmer_upsert_product');
const farmerSetProductStock = callable('farmer_set_product_stock');
const farmOverview = callableNoArg('farm_overview');
const adminListMarketplace = callableNoArg('admin_list_marketplace');
const adminSetFarmMember = callable('admin_set_farm_member');
const adminReviewProduct = callable('admin_review_product');
const adminSetShippingRate = callable('admin_set_shipping_rate');
const adminSetPlatformFee = callable('admin_set_platform_fee');
const reviewOrderPayment = callable('review_order_payment');
const adminSetOrderFulfilment = callable('admin_set_order_fulfilment');
const adminOrderContact = callable('admin_order_contact');
const recordOrderScreening = callable('record_order_screening');
// Consent records (migration 51)
const recordConsent = callable('record_consent');
const myConsents = callableNoArg('my_consents');
const consentVersions = callableNoArg('consent_versions');
const orderPayer = callable('order_payer');
const refundOrder = callable('refund_order');
const recordFarmPayout = callable('record_farm_payout');
const adminSetShopOpen = callable('admin_set_shop_open');

/**
 * The shop: products an admin listed, of farms that are listed, plus the destinations each origin country ships to.
 * Row policies decide what comes back; a project without these tables answers with an error and the shop stays empty.
 */
async function listProducts() {
  const [products, rates] = await Promise.all([
    supabase.from('products').select('id,farm_id,category,name,name_en,description,description_en,unit,price_minor,currency,stock_units')
      .eq('status', 'listed').order('name').limit(500),
    supabase.from('shipping_rates').select('origin_country,dest_country,amount_minor,currency')
  ]);
  if (products.error || rates.error) {
    console.warn('shop unavailable', (products.error || rates.error).message);
    return { products: [], shippingRates: [] };
  }
  return { products: camelize(products.data || []), shippingRates: camelize(rates.data || []) };
}

// ---- Second factor (TOTP authenticator app) of the signed-in user ----
/** { currentLevel, nextLevel, factorId }: factorId is the verified authenticator, or null when none is set up. */
async function mfaStatus() {
  const [level, factors] = await Promise.all([supabase.auth.mfa.getAuthenticatorAssuranceLevel(), supabase.auth.mfa.listFactors()]);
  if (level.error || factors.error) throw toBackendError(level.error || factors.error);
  const verified = ((factors.data && factors.data.totp) || []).filter((factor) => factor.status === 'verified');
  return {
    currentLevel: (level.data && level.data.currentLevel) || 'aal1',
    nextLevel: (level.data && level.data.nextLevel) || 'aal1',
    factorId: verified.length ? verified[0].id : null
  };
}
/** Starts enrolment and returns what the user needs to add the account to an authenticator app. */
async function mfaEnroll() {
  // An abandoned earlier attempt leaves an unverified factor behind; remove it so a new one can be created.
  const existing = await supabase.auth.mfa.listFactors();
  if (existing.error) throw toBackendError(existing.error);
  for (const factor of ((existing.data && existing.data.all) || []).filter((entry) => entry.factor_type === 'totp' && entry.status !== 'verified')) {
    const removed = await supabase.auth.mfa.unenroll({ factorId: factor.id });
    if (removed.error) throw toBackendError(removed.error);
  }
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp' });
  if (error) throw toBackendError(error);
  return { factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret };
}
/** Confirms a six-digit code for the given factor; on success the session becomes aal2. */
async function mfaVerify(factorId, code) {
  const challenge = await supabase.auth.mfa.challenge({ factorId });
  if (challenge.error) throw toBackendError(challenge.error);
  const verify = await supabase.auth.mfa.verify({ factorId, challengeId: challenge.data.id, code: String(code || '').trim() });
  if (verify.error) throw new BackendError('mfa-invalid-code', verify.error.message || 'The code was not accepted.', verify.error);
  return { ok: true };
}
const adminSetCountryStatus = callable('admin_set_country_status');
const adminUpsertFarm = callable('admin_upsert_farm');
const adminUpsertMill = callable('admin_upsert_mill');
const adminSetTreeOrigin = callable('admin_set_tree_origin');
const adminGetTreeOrigin = callable('admin_get_tree_origin');
const adminGetTreeCrop = callable('admin_get_tree_crop');

const myReferralCode = callableNoArg('my_referral_code');
const myGifts = callableNoArg('my_gifts');
const createGift = callable('create_gift');
const cancelGift = callable('cancel_gift');

/** Shareable landing link for a referral code (deep link handled above). */
function referralLink(code) {
  const ref = normalizeReferralCode(code);
  return ref ? `${location.origin}${location.pathname}?ref=${ref}` : '';
}

async function deleteMyAccount(confirmation) {
  const { data } = await callable('delete_my_account')({ confirmation });
  // The auth user no longer exists server-side; clear the local session only.
  await supabase.auth.signOut({ scope: 'local' });
  return data;
}

// ---------------------------------------------------------------------------
// Client error reporting (basic monitoring): message, source, stack prefix, page, coarse UA.
// No PII, at most 5 reports per page load, duplicates collapsed; the server caps per hour.
// ---------------------------------------------------------------------------
const ERROR_REPORT_LIMIT = 5;
const reported = new Set();
let reportCount = 0;

function reportClientError(message, source, stack) {
  const text = String(message || '').slice(0, 500);
  if (!text || reportCount >= ERROR_REPORT_LIMIT || reported.has(text)) return;
  reported.add(text);
  reportCount += 1;
  const payload = {
    message: text,
    source: String(source || '').replace(location.origin, '').slice(0, 200),
    stack: String(stack || '').slice(0, 1500),
    page: location.pathname.slice(0, 200),
    userAgent: navigator.userAgent.replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').slice(0, 120),
    release: 'web-2026-10-26'
  };
  supabase.rpc('report_client_error', { payload }).then(({ error }) => {
    if (error) console.warn('[faseela] error report not stored:', error.code || error.message);
  });
}

window.addEventListener('error', (event) => {
  if (event.message === 'ResizeObserver loop completed with undelivered notifications.') return;
  reportClientError(event.message, `${event.filename || ''}:${event.lineno || 0}`, event.error?.stack);
});
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  if (reason && (reason.code === 'unauthenticated' || reason.code === 'permission-denied')) return;
  reportClientError(reason?.message || String(reason), 'unhandledrejection', reason?.stack);
});

/** Admin: latest audit-log entries (RLS: admins only). No free-text details are requested beyond the stored JSON. */
async function adminListAuditLogs(limit = 100) {
  const size = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 200);
  const { data, error } = await supabase.from('audit_logs')
    .select('id, actor_uid, action, target, details, created_at').order('created_at', { ascending: false }).limit(size);
  if (error) throw toBackendError(error);
  return (data || []).map((row) => ({ id: row.id, actorUid: row.actor_uid, action: row.action, target: row.target, details: row.details || {}, createdAt: Date.parse(row.created_at) }));
}

async function adminSystemStatus() {
  const { data } = await callable('admin_system_status')({});
  return data;
}

window.FaseelaMappers = mappers;

const api = Object.freeze({
  backend: 'supabase',
  googleEnabled: GOOGLE_AUTH_ENABLED,
  implicitLinkRejected: arrivedWithImplicitTokens,
  adminListAuditLogs,
  adminDashboard,
  adminListInvestments,
  adminListTrees,
  adminListClientErrors,
  adminSetTreeStatus,
  adminSetPushEnabled,
  adminCreateTree,
  adminUpdateTree,
  adminGetTree,
  adminUserDetail,
  adminListShares,
  adminListOutbox,
  adminRetryEmail,
  adminTasks,
  adminAutomationState,
  adminReadiness,
  adminKpiHistory,
  adminSearch,
  adminSetAutomationRule,
  adminSetJobActive,
  adminSetReadiness,
  adminSetTreeMill,
  adminGetTreeMill,
  adminSetTreeCrop,
  adminListMasterData,
  staffSecurityState,
  adminSetStaffMfa,
  marketplaceConfig,
  quoteOrder,
  createOrder,
  reportOrderPayment,
  cancelMyOrder,
  listMyOrders,
  listProducts,
  farmerUpsertProduct,
  farmerSetProductStock,
  farmOverview,
  adminListMarketplace,
  adminSetFarmMember,
  adminReviewProduct,
  adminSetShippingRate,
  adminSetPlatformFee,
  reviewOrderPayment,
  adminSetOrderFulfilment,
  adminOrderContact,
  recordOrderScreening,
  recordConsent,
  myConsents,
  consentVersions,
  orderPayer,
  refundOrder,
  recordFarmPayout,
  adminSetShopOpen,
  mfaStatus,
  mfaEnroll,
  mfaVerify,
  adminSetCountryStatus,
  adminUpsertFarm,
  adminUpsertMill,
  adminSetTreeOrigin,
  adminGetTreeOrigin,
  listOrigins,
  setMyLocale,
  adminGetTreeCrop,
  signIn,
  register,
  signInWithGoogle,
  signOut,
  signOutOtherSessions,
  requestPasswordReset,
  updatePassword,
  uploadPaymentProof,
  listPublicTrees,
  watchMyInvestments,
  watchMyShares,
  watchMyTransactions,
  watchMyRoleApplication,
  watchMyFarmerUpdates,
  watchMyPressingBatches,
  watchMyOilAllocations,
  watchMyOilRequests,
  requestOil: callable('request_oil'),
  cancelOilRequest: callable('cancel_oil_request'),
  reviewOilRequest: callable('review_oil_request'),
  adminListUsers,
  adminListAssignments,
  adminSystemStatus,
  adminSetUserRole: callable('admin_set_user_role'),
  adminSetUserStatus: callable('admin_set_user_status'),
  adminAssign: callable('admin_assign'),
  submitRoleApplication: callable('submit_role_application'),
  reviewRoleApplication: callable('review_role_application'),
  createInvestmentRequest: callable('create_investment_request'),
  submitInvestment: callable('create_investment_request'),
  cancelInvestmentRequest: callable('cancel_investment_request'),
  cancelInvestment: callable('cancel_investment_request'),
  submitInvestmentPaymentProof: callable('submit_investment_payment_proof'),
  getPaymentProofUrl,
  reviewInvestmentRequest: callable('review_investment_request'),
  listReviewQueue: callable('list_review_queue'),
  listReviewQueueMapped: listReviewQueue,
  exportMyData,
  deleteMyAccount,
  downloadShareCertificate,
  attachRequestExtras,
  paymentInstructions,
  adminSetPaymentInstructions,
  adminPaymentState,
  recordPaymentScreening,
  registerPushToken,
  unregisterPushToken,
  pushState,
  paymentScreeningState,
  financeExport,
  adminReviewPaymentInstructions,
  myReferralCode,
  myGifts,
  createGift,
  cancelGift,
  redeemGift,
  referralLink,
  normalizeGiftCode,
  pendingReferralCode,
  pendingGiftCode,
  clearPendingGiftCode,
  updateMyProfile,
  setMarketingConsent,
  publicStatus,
  submitFarmerUpdate: callable('submit_farmer_update'),
  uploadFieldMedia,
  uploadFarmerProfilePhoto,
  myAssignments,
  myFarmerProfile,
  signFieldMedia,
  updateFarmerProfile: callable('update_farmer_profile'),
  reviewFarmerUpdate: callable('review_farmer_update'),
  submitPressingBatch: callable('submit_pressing_batch'),
  // Weighed harvest of a non-olive tree: { treeId, harvestKg, netKg } -> { batchId, status: 'pending_review' }.
  submitHarvestBatch: callable('submit_harvest_batch'),
  certifyPressingBatch: callable('certify_pressing_batch')
});

// `FaseelaFirebase` is kept as the global name so public/index.html needs no changes.
window.FaseelaBackend = api;
window.FaseelaFirebase = api;
