// Signed URLs for a tree's PUBLISHED media (field-media bucket is private).
// GET /functions/v1/tree-media?treeId=<id>  (anonymous; verify_jwt = false)
// Which paths may be shown is decided in the database (public.tree_media_paths: published events of
// published reports + the consenting farmer's profile photo); this function only signs them.
// Signed URLs live 1 h, the JSON is cacheable for 5 min, at most 30 images per tree.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const APP_ORIGINS = (Deno.env.get("APP_ORIGINS") ?? "https://faseela.web.app,https://gen-lang-client-0319369264.web.app")
  .split(",").map((s) => s.trim()).filter(Boolean);
const TTL_SECONDS = 3600;
const MAX_IMAGES = 30;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

type MediaPaths = { events: Array<{ eventId: string; paths: string[] }>; farmerPhoto: string | null };

function cors(origin: string | null): Record<string, string> {
  const allowed = origin && (APP_ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) ? origin : APP_ORIGINS[0];
  return { "access-control-allow-origin": allowed, "access-control-allow-methods": "GET, OPTIONS", vary: "Origin" };
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "GET") return json(405, { error: "method not allowed" }, cors(origin));
  const treeId = new URL(req.url).searchParams.get("treeId") ?? "";
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(treeId)) return json(400, { error: "treeId is invalid" }, cors(origin));

  const { data, error } = await admin.rpc("tree_media_paths", { p_tree_id: treeId });
  if (error) return json(500, { error: "lookup failed" }, cors(origin));
  const media = (data ?? { events: [], farmerPhoto: null }) as MediaPaths;

  const wanted: Array<{ eventId: string | null; path: string }> = [];
  for (const e of media.events ?? []) {
    for (const p of e.paths ?? []) {
      if (wanted.length >= MAX_IMAGES) break;
      if (/\.(jpe?g|png|webp)$/i.test(p)) wanted.push({ eventId: e.eventId, path: p });
    }
  }
  if (media.farmerPhoto && /\.(jpe?g|png|webp)$/i.test(media.farmerPhoto)) wanted.push({ eventId: null, path: media.farmerPhoto });
  if (wanted.length === 0) {
    return json(200, { treeId, events: {}, farmerPhoto: null, expiresIn: TTL_SECONDS }, { ...cors(origin), "cache-control": "public, max-age=300" });
  }

  const { data: signed, error: signError } = await admin.storage.from("field-media")
    .createSignedUrls(wanted.map((w) => w.path), TTL_SECONDS, { download: false });
  if (signError) return json(500, { error: "signing failed" }, cors(origin));

  const events: Record<string, string[]> = {};
  let farmerPhoto: string | null = null;
  (signed ?? []).forEach((s, i) => {
    if (!s.signedUrl) return;
    const w = wanted.at(i);
    if (!w) return;
    if (w.eventId === null) farmerPhoto = s.signedUrl;
    else (events[w.eventId] ??= []).push(s.signedUrl);
  });
  console.log(JSON.stringify({ event: "tree_media", treeId, images: (signed ?? []).length }));
  return json(200, { treeId, events, farmerPhoto, expiresIn: TTL_SECONDS }, { ...cors(origin), "cache-control": "public, max-age=300" });
});
