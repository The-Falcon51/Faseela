# Faseela — Findings detail (confirmed medium and above)

## [medium] Account deletion leaves encrypted oil-delivery contact PII attached to the orphaned uid and in the finance review queue
Fingerprint `faseela/20261020000500_account_deletion/delete_my_account/oil-request-contacts-survive-deletion`

### Ordered trace
1. **entrypoint** `supabase/migrations/20261020000500_account_deletion.sql:4` — private.delete_my_account: Authenticated owner calls public.delete_my_account -> private.delete_my_account with confirmation 'DELETE'.
2. **propagation** `supabase/migrations/20261020000500_account_deletion.sql:16` — private.delete_my_account preconditions: Only open investment_requests (16-19) and active shares (20-22) block deletion; oil_requests/oil_request_contacts are not consulted.
3. **propagation** `supabase/migrations/20261020000500_account_deletion.sql:28` — delete from auth.users: Hard delete; cleanup relies solely on ON DELETE CASCADE foreign keys from auth.users.
4. **propagation** `supabase/migrations/20261101000100_harvest_oil.sql:51` — public.oil_requests: user_id uuid not null without any FK to auth.users: rows survive the delete with the orphaned uid.
5. **propagation** `supabase/migrations/20261101000100_harvest_oil.sql:69` — private.oil_request_contacts: request_id references oil_requests only; the encrypted name/phone/address blob is never deleted by any statement in the schema.
6. **sink** `supabase/migrations/20261101000100_harvest_oil.sql:407` — private.list_review_queue (oil_requests / oil_fulfilment): finance_admin/admin receives private.oil_contact(r.id) decrypted for every pending/approved request, including those of the deleted account; review_oil_request (303-354) can still approve/fulfil them.

### Evidence
- `supabase/migrations/20261020000500_account_deletion.sql:24` — Comment states the deletion contract: personal data goes, only financial records stay pseudonymised by the orphaned uid.
- `supabase/migrations/20261020000500_account_deletion.sql:20` — Active-shares precondition; its error text directs the user to support to 'settle or transfer' shares, i.e. the operator path that makes deletion reachable for a share holder.
- `supabase/migrations/20261020000100_core_schema.sql:195` — shares.status check constraint allows 'transferred' and 'settled'; no migration or RPC ever sets them (operator SQL only), so the deletion path for former share holders is a designed-in operator action.
- `supabase/migrations/20261101000100_harvest_oil.sql:4` — Comment classifies oil contact data (name, phone, address) as PII stored only encrypted in private.oil_request_contacts.
- `supabase/migrations/20261101000100_harvest_oil.sql:7` — 'No DELETE anywhere' for oil tables: no cleanup path exists for contacts; verified by grep that no other migration references oil_requests or oil_request_contacts.
- `supabase/migrations/20261101000100_harvest_oil.sql:117` — allocate_oil allocates only to shares with status 'active', so oil data always originates from a share that at that time blocked deletion; the share later becoming non-active (operator) is the only way both conditions coincide.
- `supabase/migrations/20261101000100_harvest_oil.sql:258` — request_oil stores the encrypted contact for every delivery/pickup request; the record persists through approve/fulfil/reject/cancel (no path removes it).
- `supabase/migrations/20261101000100_harvest_oil.sql:367` — private.oil_contact decrypts with the Vault pii_key for any request id passed by list_review_queue.
- `supabase/migrations/20261020000300_rpc_operations.sql:237` — private.submitter returns null for a uid without a profile, so list_review_queue does not fail on the deleted account's request; the item is returned with submitter null and a decrypted contact.

### Principal and affected resource
private.delete_my_account (DSGVO Art. 17 self-service) refuses deletion only while investment_requests are open or shares are 'active', then hard-deletes auth.users and relies on ON DELETE CASCADE foreign keys for cleanup. The later harvest/oil feature stores name, phone and postal address pgp-encrypted in private.oil_request_contacts keyed by oil_requests.id; public.oil_requests.user_id has no foreign key to auth.users and no code path deletes either table ('No DELETE anywhere'). Once the operator has set the user's shares to 'settled'/'transferred' (the only path the error text offers to a share holder who wants to delete; both statuses exist in the shares check constraint but no RPC sets them), the user can delete the account while directly identifying contact data of every non-donate oil request remains linked to the same orphaned uid that keys the 'pseudonymised' investment_requests/transactions/shares. Pending or approved oil requests of the deleted account stay in the finance queues, where list_review_queue decrypts the contact via private.oil_contact and returns it to finance_admin/admin, and review_oil_request can still approve/fulfil them for an account that no longer exists. The defect is fully decidable from source: the missing precondition, the missing FK/cascade and the missing delete are all absent predicates; Postgres semantics guarantee the rows survive. No runtime observation is required.

### Native input / fixture and bounded instructions
["Investor A obtains a share (create/submit/review flow), a batch on that tree is certified so A receives an oil_allocation, and A calls request_oil with kind 'delivery' and a contact; a row is inserted into private.oil_request_contacts (harvest_oil 258-261).", "Operator settles A's shares: update public.shares set status = 'settled' where user_id = A (the only way shares leave 'active'; core_schema 195).", "A calls public.delete_my_account with confirmation 'DELETE'. Preconditions at account_deletion 16-22 pass (no open investment_requests, no active shares); the function does not query oil_requests or oil_request_contacts and executes delete from auth.users (line 28).", "Cascade analysis: only tables with 'references auth.users (id) on delete cascade' are affected (profiles, role_applications, user_roles, farmer_assignments, mill_assignments, farmer_profiles). public.oil_requests.user_id has no FK (harvest_oil 51) and private.oil_request_contacts references only oil_requests (69). Both rows therefore remain.", "finance_admin F calls list_review_queue({queue:'oil_requests'}); the query at harvest_oil 410-412 selects by status only and attaches private.oil_contact(r.id) (407), returning A's decrypted name, phone and address with submitter null. review_oil_request (303-354) accepts approve/fulfil for the same id."]

Payloads: `["select public.delete_my_account('{\"confirmation\":\"DELETE\"}'::jsonb);", "select public.list_review_queue('{\"queue\":\"oil_requests\"}'::jsonb);"]`

### Observed output and invariant proved
Established from source without execution: after delete_my_account succeeds for a former share holder, the oil_requests row keyed by the orphaned uid and the pgp-encrypted contact (name, phone, postal address) in private.oil_request_contacts persist indefinitely, and for pending/approved requests the decrypted contact is still returned to finance_admin/admin by list_review_queue, contradicting the function's own stated contract that only pseudonymised financial records remain.

### Conditions and containment
data_state: The user holds at least one non-donate oil request (any status) and, at deletion time, no 'active' shares and no open investment requests. Because allocations only arise from active shares, this requires the operator to have set the user's shares to 'settled' or 'transferred' via SQL beforehand (the path the error message points share holders to). authentication_level: Account deletion is triggered by the authenticated owner; reading the retained contact requires finance_admin/admin (list_review_queue) or database/SQL-editor access.

### Remediation and regression case
Extend delete_my_account to the oil feature: (1) refuse deletion while the caller has oil_requests in status pending/approved (same pattern as open investment requests), (2) delete the caller's private.oil_request_contacts rows (join via oil_requests.user_id) before deleting auth.users, so fulfilled/rejected/cancelled requests stay as pseudonymised bookkeeping without PII, and (3) optionally add 'on delete cascade' from oil_request_contacts.request_id and keep oil_requests/oil_allocations as retained financial records. Also consider a retention job that purges contacts of fulfilled/rejected requests after a fixed period.
`supabase/migrations/20261020000500_account_deletion.sql`:
```
  if exists (select 1 from public.oil_requests
              where user_id = v_uid and status in ('pending', 'approved')) then
    perform private.fail('failed-precondition', 'Cancel or wait for your open oil requests before deleting the account.');
  end if;

  -- Remove identifying contact data of all past oil requests; the requests themselves stay
  -- pseudonymised (orphaned uid) like the other financial records.
  delete from private.oil_request_contacts c
   using public.oil_requests r
   where r.id = c.request_id and r.user_id = v_uid;

  perform private.audit(v_uid, 'account.deleted', 'profiles/' || v_uid, '{}'::jsonb);
  delete from auth.users where id = v_uid;
```

## [medium] Quality-auditor review gate publishes farmer notes and photos the reviewer is never shown
Fingerprint `faseela/data-mappers/mapReviewItem/review-gate-blind-to-published-content`

### Ordered trace
1. **entrypoint** `supabase/migrations/20261026000300_notification_hooks.sql:356` — private.submit_farmer_update: Farmer-controlled `notes` (string, <= 1200 chars) and `mediaPaths` (<= 5, prefix/`..` check only) are accepted and inserted into farmer_updates with status pending_review.
2. **propagation** `supabase/migrations/20261101000100_harvest_oil.sql:392` — private.list_review_queue (farmer_updates): `to_jsonb(r)` returns the full row (notes, media_paths, gps) to the quality_auditor client.
3. **propagation** `public/data-mappers.mjs:197` — mapReviewItem(queue === 'farmer_updates'): `notes: (d.notes || '').slice(0, 300)`; `mediaPaths` is not copied into the mapped item.
4. **propagation** `public/app.js:24120` — renderFounderApprovalsQueue: Row template renders id, user name/role, type label, amount, channel, date and Approve/Reject/inspect buttons; `item.notes` is never referenced.
5. **propagation** `public/app.js:24434` — inspectFinancialRequest: Detail modal is filled with id/date, user, role, amount and channel only; no notes or media element exists in `modal-fndr-fin-detail`.
6. **propagation** `public/app.js:24377` — decideServerReviewItem: Approve calls `reviewFarmerUpdate({updateId, decision:'publish', note:''})` without the reviewer having had any view of the content.
7. **propagation** `supabase/migrations/20261102000100_tree_profiles.sql:118` — private.review_farmer_update: Inserts `v_upd.notes` (complete), `cardinality(v_upd.media_paths)` and `update_id` into tree_events_public with status published.
8. **sink** `supabase/migrations/20261102000100_tree_profiles.sql:154` — private.public_tree_profile (granted to anon): Returns `notes` of published events to anonymous callers (rendered by public/tree.mjs:91); `tree_media_paths` (lines 194-198) returns all `media_paths` of the published update to the anonymous `tree-media` Edge Function, which signs them (supabase/functions/tree-media/index.ts:52).

### Evidence
- `public/data-mappers.mjs:197` — `notes: (d.notes || '').slice(0, 300)` and no `mediaPaths` field in the mapped farmer_updates item; `base` sets amount_usd/amount_syp to 0.
- `tests/data-mappers.test.mjs:79` — `assert.equal(fu.notes.length, 300)` — the truncation is intentional and tested.
- `public/app.js:24126` — Approvals row template literal (lines 24126-24165) contains no reference to `item.notes` or any media.
- `public/app.js:24438` — Last field set in the inspect modal is `cEl.innerText = item.channel`; the receipt container is shown only for `isServerInvestment || paymentProofPath`.
- `public/index.html:10183` — `modal-fndr-fin-detail` body holds only user/role/amount/channel strongs, a payment-receipt container and a static compliance note — no notes or image element.
- `src/supabase-client.src.mjs:508` — The only `createSignedUrl` call targets `payment-proofs`; the `field-media` bucket is only written (upload, lines 373/384), never signed or read for a reviewer.
- `supabase/migrations/20261020000410_storage.sql:68` — `field_media_select` already grants quality_auditor SELECT on field-media objects, so a reviewer-side viewer is feasible but absent.
- `supabase/migrations/20261102000100_tree_profiles.sql:119` — `values (v_upd.tree_id, v_upd.event_type, v_upd.notes, cardinality(v_upd.media_paths), v_upd.created_at, 'published', v_id)` — complete notes published.
- `supabase/migrations/20261102000100_tree_profiles.sql:196` — `tree_media_paths` returns `u.media_paths` for every published update; granted to service_role and consumed by the anonymous tree-media function.

### Principal and affected resource
A farmer (role `farmer`, active tree assignment) submits a field report through `submit_farmer_update` with up to 1200 characters of free-text `notes` and up to 5 `mediaPaths`. The only control between that content and anonymous visitors is the quality_auditor four-eyes gate (`review_farmer_update`, decision `publish`). The approvals desk that implements the gate never presents the content: `mapReviewItem('farmer_updates', …)` truncates `notes` to 300 characters and does not copy `mediaPaths` at all; the queue row template in `renderFounderApprovalsQueue` renders only id, submitter, role, type label, amount (always 0 for this queue), channel (= eventType) and date, and never references `item.notes`; the detail modal filled by `inspectFinancialRequest` has elements only for id/date, user, role, amount and channel (`public/index.html` modal `modal-fndr-fin-detail`), and no client code signs or shows `field-media` objects to a reviewer (the only `createSignedUrl` is for `payment-proofs`). The reviewer's Approve click calls `review_farmer_update({decision:'publish'})`, which copies the full `notes` of the locked row into `tree_events_public` (status `published`) and links the update via `update_id`; `public_tree_profile` (anon RPC) then returns those notes to anonymous callers and `tree_media_paths` hands every `media_paths` entry of the update to the anonymous `tree-media` Edge Function, which signs them. A farmer can therefore place arbitrary text (spam, phishing URLs, false yield/investment statements, defamation) and arbitrary images on the platform's public tree pages under the platform's brand while the record shows an auditor 'reviewed' it. HTML injection of the same strings is out of scope here (escaped by `esc`/`escapeHtml`; owned by the client-side unit); the media path-trust gap is the peer candidate unreviewed-media-path-trust.

### Native input / fixture and bounded instructions
['As the farmer, upload any JPEG to field-media at `<uid>/<treeId>/<ts>_any.jpg` (uploadFieldMedia) and call RPC `submit_farmer_update` with the payload above.', "As a quality_auditor, open the approvals desk: `listReviewQueue('farmer_updates')` → `mapReviewItem` yields an item whose `notes` is the first 300 characters and which has no `mediaPaths`; `renderFounderApprovalsQueue` and `inspectFinancialRequest` display neither notes nor photos.", "Press Approve → `review_farmer_update({updateId, decision:'publish'})` inserts the full notes into tree_events_public and links `update_id`.", 'Anonymously call `public_tree_profile({treeId})` and GET tree-media `?treeId=` → the full notes and signed URLs for the uploaded images are returned and rendered by tree.mjs.']

Payloads: `["{\"treeId\":\"<assignedTree>\",\"eventType\":\"other\",\"notes\":\"MARKER-7f3a … up to 1200 chars of attacker text / URLs\",\"mediaPaths\":[\"<farmerUid>/<assignedTree>/1700000000000_any.jpg\"]}"]`

### Observed output and invariant proved
Source-level demonstration (no target execution permitted in this run): the mapped review item cannot contain more than 300 characters of notes and never contains media paths; neither the row template nor the detail modal references notes or media; the publish RPC copies the complete `v_upd.notes` and exposes all `media_paths` to the anonymous surfaces. The shipped review gate is therefore blind to the exact content it releases.

### Conditions and containment
authorization_role: Attacker holds the `farmer` role with an active, unrevoked tree assignment (role applications are admin-approved). user_interaction: A quality_auditor (not the submitting farmer) presses Approve in the approvals desk; the desk gives them no content to base the decision on. system_configuration: No out-of-band review procedure (e.g. a dashboard query of farmer_updates) exists in the repository; any such practice would be operational, not a source control.

### Remediation and regression case
Make the gate inspect what it publishes: return full `notes`, `mediaPaths` (and `gpsLat/gpsLng` for context) from `mapReviewItem` for farmer_updates; render the full notes and a photo viewer in the approvals detail view, creating signed URLs for `field-media` with the quality_auditor's own session (storage policy already permits SELECT); optionally require the auditor to open the detail view before Approve is enabled for farmer_updates. Keep `decision` mandatory server-side (restore `req_id` instead of defaulting to 'publish').
`public/data-mappers.mjs`:
```
if (queue === 'farmer_updates') {
  return { ...base, role: 'farmer', type: 'farmer_update', type_label: 'تقرير ميداني', type_label_en: 'Field report',
    channel: d.eventType || '', notes: d.notes || '', mediaPaths: Array.isArray(d.mediaPaths) ? d.mediaPaths : [],
    gpsLat: d.gpsLat ?? null, gpsLng: d.gpsLng ?? null };
}
```
`src/supabase-client.src.mjs`:
```
async function getFieldMediaUrls(paths = []) {
  const safe = paths.filter((p) => /^[0-9a-f-]{36}\/[A-Za-z0-9_-]{1,80}\/[^/]{1,200}$/.test(p));
  if (!safe.length) return [];
  const { data, error } = await supabase.storage.from('field-media').createSignedUrls(safe, SIGNED_URL_TTL_SECONDS);
  if (error) throw toBackendError(error, 'permission-denied');
  return (data || []).map((s) => s.signedUrl).filter(Boolean);
}
```
`supabase/migrations/<new>_review_farmer_update_require_decision.sql`:
```
-- in private.review_farmer_update:
  v_decision text := private.req_id(p, 'decision', '^(publish|reject)$');
```
