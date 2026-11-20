// Faseela storage purge worker. Triggered by pg_cron (pg_net) while private.storage_purge_queue has pending rows.
// Claims rows through the service-role-only RPCs storage_purge_claim/storage_purge_mark and removes every object
// under the queued prefix via the Storage API (row + blob), which is the only supported deletion path.
//
// Auth: the caller must send the `x-outbox-token` header (same Vault secret as the outbox sender), compared in
// constant time against public.outbox_token(). No request body is trusted; the queue is the only input.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type PurgeRow = { id: number; bucket: string; prefix: string; attempts: number };

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const PREFIX_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const BUCKETS = new Set(["field-media", "payment-proofs"]);
const PAGE = 1000;
const REMOVE_BATCH = 100;
const MAX_OBJECTS_PER_RUN = 5000; // bounded work per invocation; remaining objects are picked up by the next run

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Lists every object path under `prefix` (recursing into folders). Storage list() returns folders with id === null. */
async function listRecursive(bucket: string, prefix: string, budget: number): Promise<string[]> {
  const out: string[] = [];
  const stack = [prefix.replace(/\/$/, "")];
  while (stack.length > 0 && out.length < budget) {
    const folder = stack.pop() as string;
    let offset = 0;
    for (;;) {
      const { data, error } = await admin.storage.from(bucket).list(folder, { limit: PAGE, offset, sortBy: { column: "name", order: "asc" } });
      if (error) throw new Error(`list ${folder}: ${error.message}`);
      for (const entry of data ?? []) {
        if (!entry.name || entry.name === ".emptyFolderPlaceholder") continue;
        const path = folder ? `${folder}/${entry.name}` : entry.name;
        if (entry.id === null) stack.push(path);
        else out.push(path);
        if (out.length >= budget) break;
      }
      if (!data || data.length < PAGE || out.length >= budget) break;
      offset += PAGE;
    }
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const presented = req.headers.get("x-outbox-token") ?? "";
  const { data: expected, error: tokenError } = await admin.rpc("outbox_token");
  if (tokenError || typeof expected !== "string" || !presented || !timingSafeEqual(presented, expected)) {
    return new Response("unauthorized", { status: 401 });
  }

  const { data: rows, error } = await admin.rpc("storage_purge_claim", { p_limit: 10 });
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { "content-type": "application/json" } });

  let done = 0;
  let failed = 0;
  let removedTotal = 0;
  for (const row of (rows ?? []) as PurgeRow[]) {
    try {
      if (!BUCKETS.has(row.bucket) || !PREFIX_RE.test(row.prefix) || row.prefix.includes("..")) {
        throw new Error("rejected prefix");
      }
      const paths = await listRecursive(row.bucket, row.prefix, MAX_OBJECTS_PER_RUN);
      let removed = 0;
      for (let i = 0; i < paths.length; i += REMOVE_BATCH) {
        const batch = paths.slice(i, i + REMOVE_BATCH);
        const { error: rmError } = await admin.storage.from(row.bucket).remove(batch);
        if (rmError) throw new Error(`remove: ${rmError.message}`);
        removed += batch.length;
      }
      // Budget hit → more objects remain: report progress, leave the row pending for the next run.
      const complete = paths.length < MAX_OBJECTS_PER_RUN;
      await admin.rpc("storage_purge_mark", { p_id: row.id, p_ok: complete, p_removed: removed, p_error: complete ? null : "partial: budget reached, continuing next run" });
      removedTotal += removed;
      if (complete) done += 1;
    } catch (err) {
      failed += 1;
      await admin.rpc("storage_purge_mark", { p_id: row.id, p_ok: false, p_removed: 0, p_error: String((err as Error).message ?? err) });
    }
  }
  // Structured log line (ids/counts only, no paths).
  console.log(JSON.stringify({ event: "storage_purge_run", claimed: rows?.length ?? 0, done, failed, removed: removedTotal }));
  return new Response(JSON.stringify({ claimed: rows?.length ?? 0, done, failed, removed: removedTotal }), { headers: { "content-type": "application/json" } });
});
