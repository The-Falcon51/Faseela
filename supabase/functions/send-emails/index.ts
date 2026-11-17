// Faseela outbox sender. Triggered by pg_cron (pg_net) while rows are pending; claims rows through
// the service-role-only RPCs outbox_claim/outbox_mark and delivers them via the configured provider.
//
// Auth: the caller must send the `x-outbox-token` header; the expected value lives in Supabase Vault
// and is read here through public.outbox_token() (service role), so no human ever handles it.
// Secrets (Edge Function secrets): EMAIL_PROVIDER=brevo|resend, EMAIL_API_KEY, EMAIL_FROM
// ("Faseela <noreply@example.org>"), APP_URL (https://...), optional EMAIL_REPLY_TO.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type OutboxRow = {
  id: number;
  recipient: string;
  template: string;
  params: Record<string, unknown>;
  attempts: number;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const PROVIDER = (Deno.env.get("EMAIL_PROVIDER") ?? "brevo").toLowerCase();
const API_KEY = Deno.env.get("EMAIL_API_KEY") ?? "";
const FROM = Deno.env.get("EMAIL_FROM") ?? "";
const REPLY_TO = Deno.env.get("EMAIL_REPLY_TO") ?? "";
const APP_URL = (Deno.env.get("APP_URL") ?? "https://gen-lang-client-0319369264.web.app").replace(/\/$/, "");

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

import { escapeHtml, render, type Rendered } from "./templates.ts";

function layout(r: Rendered, marketing = false): string {
  const unsubscribe = marketing
    ? `<br><a href="${APP_URL}/?unsubscribe=marketing" style="color:#78716c;">إلغاء الاشتراك في رسائل المتابعة · Unsubscribe from follow-up e-mails</a>`
    : "";
  const cta = r.cta
    ? `<p style="text-align:center;margin:20px 0;"><a href="${escapeHtml(r.cta.href)}" style="display:inline-block;background:#424830;color:#fff;text-decoration:none;font-weight:700;padding:12px 28px;border-radius:12px;font-size:15px;">${r.cta.label_ar} · ${r.cta.label_en}</a></p>`
    : "";
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(r.subject)}</title></head>
<body style="margin:0;padding:0;background:#f5f0e8;font-family:'Cairo','Segoe UI',Tahoma,sans-serif;color:#1c1917;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fff;border-radius:16px;border:1px solid #e7e5e4;">
<tr><td style="padding:28px 28px 8px;text-align:center;"><div style="font-size:26px;font-weight:800;color:#424830;">فسيلة · Faseela</div></td></tr>
<tr><td style="padding:12px 28px 0;font-size:15px;line-height:1.7;">${r.ar}</td></tr>
<tr><td>${cta}</td></tr>
<tr><td style="padding:0 28px;"><hr style="border:0;border-top:1px solid #e7e5e4;margin:0;"></td></tr>
<tr><td dir="ltr" style="padding:16px 28px 24px;text-align:left;font-family:'Plus Jakarta Sans','Segoe UI',Tahoma,sans-serif;font-size:14px;line-height:1.7;">${r.en}</td></tr>
<tr><td style="padding:12px 28px 24px;text-align:center;font-size:11px;color:#78716c;">Faseela · <a href="${APP_URL}/legal/impressum.html" style="color:#78716c;">Impressum / بيانات الناشر</a> · <a href="${APP_URL}/legal/datenschutz.html" style="color:#78716c;">Datenschutz / الخصوصية</a>${unsubscribe}</td></tr>
</table></td></tr></table></body></html>`;
}

function parseFrom(from: string): { name: string; email: string } {
  const m = from.trim().match(/^(.*?)\s*<([^>]+)>$/);
  return m ? { name: m[1].replace(/^"|"$/g, "") || "Faseela", email: m[2] } : { name: "Faseela", email: from.trim() };
}

async function deliver(to: string, subject: string, html: string, marketing = false): Promise<void> {
  const sender = parseFrom(FROM);
  // RFC 8058 one-click unsubscribe header for marketing mail (providers surface it as a list-unsubscribe button).
  const headers = marketing ? { "List-Unsubscribe": `<${APP_URL}/?unsubscribe=marketing>` } : undefined;
  if (PROVIDER === "brevo") {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": API_KEY, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sender, to: [{ email: to }], subject, htmlContent: html, ...(headers ? { headers } : {}), ...(REPLY_TO ? { replyTo: { email: REPLY_TO } } : {}) }),
    });
    if (res.status !== 201) throw new Error(`brevo ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return;
  }
  if (PROVIDER === "resend") {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: FROM, to: [to], subject, html, ...(headers ? { headers } : {}), ...(REPLY_TO ? { reply_to: REPLY_TO } : {}) }),
    });
    if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return;
  }
  throw new Error(`unsupported EMAIL_PROVIDER ${PROVIDER}`);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const presented = req.headers.get("x-outbox-token") ?? "";
  const { data: expected, error: tokenError } = await admin.rpc("outbox_token");
  if (tokenError || typeof expected !== "string" || !presented || !timingSafeEqual(presented, expected)) {
    return new Response("unauthorized", { status: 401 });
  }
  if (!API_KEY || !FROM) {
    return new Response(JSON.stringify({ error: "provider not configured (EMAIL_API_KEY / EMAIL_FROM)" }), { status: 503, headers: { "content-type": "application/json" } });
  }

  const { data: rows, error } = await admin.rpc("outbox_claim", { p_limit: 20 });
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { "content-type": "application/json" } });

  let sent = 0;
  let failed = 0;
  for (const row of (rows ?? []) as OutboxRow[]) {
    try {
      const rendered = render(row.template, row.params ?? {});
      const marketing = row.params?.marketing === true;
      await deliver(row.recipient, rendered.subject, layout(rendered, marketing), marketing);
      await admin.rpc("outbox_mark", { p_id: row.id, p_ok: true });
      sent += 1;
    } catch (err) {
      failed += 1;
      await admin.rpc("outbox_mark", { p_id: row.id, p_ok: false, p_error: String((err as Error).message ?? err) });
    }
  }
  // Structured log line (ids only, no addresses).
  console.log(JSON.stringify({ event: "outbox_run", claimed: rows?.length ?? 0, sent, failed }));
  return new Response(JSON.stringify({ claimed: rows?.length ?? 0, sent, failed }), { headers: { "content-type": "application/json" } });
});
