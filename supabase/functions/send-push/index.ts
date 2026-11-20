// Faseela push sender. Triggered by pg_cron (pg_net) while private.push_outbox has pending rows; claims rows through
// the service-role-only RPCs push_claim/push_mark and delivers them through the FCM HTTP v1 API.
//
// Auth: the caller must send the `x-outbox-token` header (same Vault secret as the e-mail sender), compared in
// constant time against public.outbox_token(). No request body is trusted; the queue is the only input.
// Secret (Edge Function secret): FCM_SERVICE_ACCOUNT = the service-account JSON of the Firebase project
// (role "Firebase Cloud Messaging API Admin" is sufficient). Without it, queued rows are closed as skipped.
// Privacy: the message carries a generic text per template plus the template name; nothing else.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { pushText } from "./messages.ts";

type Target = { token: string; platform: string };
type PushRow = { id: number; template: string; attempts: number; tokens: Target[] };
type ServiceAccount = { project_id: string; client_email: string; private_key: string; token_uri: string };
type SendResult = "ok" | "dead" | "retry";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TOKEN_URI = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const REQUEST_TIMEOUT_MS = 8000;
const TOKEN_RE = /^[A-Za-z0-9_:.-]{20,4096}$/;
const TEMPLATE_RE = /^[a-z_]{1,60}$/;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Parses and validates the service-account secret. Returns null when absent or malformed (fail closed). */
function readServiceAccount(): ServiceAccount | null {
  const raw = Deno.env.get("FCM_SERVICE_ACCOUNT") ?? "";
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (_err) {
    console.error(JSON.stringify({ event: "push_config_invalid", reason: "not-json" }));
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  const ok = typeof o.project_id === "string" && /^[a-z0-9-]{4,60}$/.test(o.project_id) &&
    typeof o.client_email === "string" && /^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/.test(o.client_email) &&
    typeof o.private_key === "string" && o.private_key.includes("BEGIN PRIVATE KEY") &&
    // The token endpoint is pinned: a tampered secret must not be able to send the signed assertion elsewhere.
    o.token_uri === TOKEN_URI;
  if (!ok) {
    console.error(JSON.stringify({ event: "push_config_invalid", reason: "fields" }));
    return null;
  }
  return { project_id: o.project_id as string, client_email: o.client_email as string, private_key: o.private_key as string, token_uri: TOKEN_URI };
}

const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlText = (text: string): string => b64url(new TextEncoder().encode(text));

function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

let cachedToken: { value: string; expiresAt: number } | null = null;

/** OAuth2 access token for the service account (JWT bearer grant), cached until shortly before expiry. */
async function accessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt - 60 > now) return cachedToken.value;
  const header = b64urlText(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64urlText(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: sa.token_uri, iat: now, exp: now + 3600 }));
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(sa.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`)));
  const res = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claims}.${b64url(signature)}` }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`oauth ${res.status}`);
  const data = await res.json() as { access_token?: unknown; expires_in?: unknown };
  if (typeof data.access_token !== "string" || !data.access_token) throw new Error("oauth: no access_token");
  const ttl = typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : 3600;
  cachedToken = { value: data.access_token, expiresAt: now + ttl };
  return cachedToken.value;
}

/** Sends one message to one device. "dead" = the push service says this token will never work again. */
async function sendOne(sa: ServiceAccount, bearer: string, target: Target, template: string): Promise<{ result: SendResult; detail: string }> {
  const text = pushText(template);
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({
      message: {
        token: target.token,
        notification: { title: "فسيلة · Faseela", body: `${text.ar}\n${text.en}` },
        data: { template },
        android: { priority: "high" },
      },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.ok) {
    await res.body?.cancel();
    return { result: "ok", detail: "200" };
  }
  let status = "";
  let message = "";
  try {
    const err = await res.json() as { error?: { status?: unknown; message?: unknown } };
    status = typeof err.error?.status === "string" ? err.error.status : "";
    message = typeof err.error?.message === "string" ? err.error.message : "";
  } catch (_err) {
    status = "UNPARSEABLE";
  }
  const detail = `${res.status} ${status}`.trim();
  // UNREGISTERED (404): remove the token. INVALID_ARGUMENT (400) only when FCM names the token as the problem.
  if (res.status === 404 && status === "UNREGISTERED") return { result: "dead", detail };
  if (res.status === 400 && /not a valid FCM registration token/i.test(message)) return { result: "dead", detail };
  // Everything else (401/403 credentials, 429 quota, 5xx) is retried by the next cron run; the row gives up after 5 attempts.
  return { result: "retry", detail };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const presented = req.headers.get("x-outbox-token") ?? "";
  const { data: expected, error: tokenError } = await admin.rpc("outbox_token");
  if (tokenError || typeof expected !== "string" || !presented || !timingSafeEqual(presented, expected)) {
    return new Response("unauthorized", { status: 401 });
  }

  const { data: claimed, error } = await admin.rpc("push_claim", { p_limit: 50 });
  if (error) return json({ error: error.message }, 500);
  const rows = (Array.isArray(claimed) ? claimed : []) as PushRow[];

  const sa = readServiceAccount();
  let sent = 0, skipped = 0, retried = 0, retiredTokens = 0;
  const mark = async (id: number, outcome: "sent" | "skipped" | "retry", detail: string, dead: string[]) => {
    const { error: markError } = await admin.rpc("push_mark", { p_id: id, p_outcome: outcome, p_error: detail, p_dead_tokens: dead });
    if (markError) console.error(JSON.stringify({ event: "push_mark_failed", id, message: markError.message }));
  };

  if (!sa) {
    // Not configured: close the rows instead of letting the queue grow; the e-mail channel still informs the user.
    for (const row of rows) await mark(row.id, "skipped", "fcm-not-configured", []);
    console.log(JSON.stringify({ event: "push_run", configured: false, claimed: rows.length }));
    return json({ configured: false, claimed: rows.length, sent: 0, skipped: rows.length, retried: 0 });
  }

  let bearer = "";
  try {
    bearer = await accessToken(sa);
  } catch (err) {
    const detail = String((err as Error).message ?? err).slice(0, 200);
    for (const row of rows) await mark(row.id, "retry", `auth: ${detail}`, []);
    console.error(JSON.stringify({ event: "push_auth_failed", detail, claimed: rows.length }));
    return json({ configured: true, claimed: rows.length, sent: 0, skipped: 0, retried: rows.length, error: "auth" }, 502);
  }

  for (const row of rows) {
    const targets = (Array.isArray(row.tokens) ? row.tokens : []).filter((t) => t && typeof t.token === "string" && TOKEN_RE.test(t.token));
    if (!TEMPLATE_RE.test(String(row.template)) || targets.length === 0) {
      await mark(row.id, "skipped", "no-active-token", []);
      skipped += 1;
      continue;
    }
    const dead: string[] = [];
    const details: string[] = [];
    let delivered = 0, transient = 0;
    for (const target of targets) {
      try {
        const { result, detail } = await sendOne(sa, bearer, target, row.template);
        details.push(detail);
        if (result === "ok") delivered += 1;
        else if (result === "dead") dead.push(target.token);
        else transient += 1;
      } catch (err) {
        transient += 1;
        details.push(String((err as Error).name ?? "error"));
      }
    }
    retiredTokens += dead.length;
    const summary = [...new Set(details)].join(", ").slice(0, 300);
    if (delivered > 0) {
      // At least one device has the message: never resend to it because another device failed.
      await mark(row.id, "sent", summary, dead);
      sent += 1;
    } else if (transient > 0) {
      await mark(row.id, "retry", summary, dead);
      retried += 1;
    } else {
      await mark(row.id, "skipped", summary, dead);
      skipped += 1;
    }
  }
  // Structured log line (counts only; no tokens, no user ids).
  console.log(JSON.stringify({ event: "push_run", configured: true, claimed: rows.length, sent, skipped, retried, retiredTokens }));
  return json({ configured: true, claimed: rows.length, sent, skipped, retried });
});
