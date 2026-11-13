-- Private Storage buckets with table-checked policies (replaces storage.rules + upload_grants).
-- Object names: payment-proofs/{uid}/{requestId}/{file}, field-media/{uid}/{treeId}/{file}.
-- No UPDATE/DELETE policies: uploads are write-once (no overwrite, no client-side deletion).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('payment-proofs', 'payment-proofs', false, 5242880, array['image/jpeg', 'image/png', 'application/pdf']),
  ('field-media', 'field-media', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'audio/mpeg', 'audio/mp4', 'audio/webm'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Upload allowed only into the caller's folder of an open, unexpired request they own.
create function private.can_upload_payment_proof(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
     and array_length(storage.foldername(p_name), 1) = 2
     and (storage.foldername(p_name))[1] = (select auth.uid())::text
     and storage.filename(p_name) ~ '^[A-Za-z0-9._-]{1,120}$'
     and exists (
       select 1 from public.investment_requests r
        where r.id = (storage.foldername(p_name))[2]
          and r.user_id = (select auth.uid())
          and r.status = 'awaiting_payment'
          and r.expires_at > now()
     );
$$;

-- Upload allowed only for a farmer (or admin) into their folder of an assigned tree.
create function private.can_upload_field_media(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_any_role(array['farmer'])
     and array_length(storage.foldername(p_name), 1) = 2
     and (storage.foldername(p_name))[1] = (select auth.uid())::text
     and storage.filename(p_name) ~ '^[A-Za-z0-9._-]{1,120}$'
     and exists (
       select 1 from public.farmer_assignments a
        where a.farmer_uid = (select auth.uid())
          and a.tree_id = (storage.foldername(p_name))[2]
     );
$$;

revoke all on function private.can_upload_payment_proof(text), private.can_upload_field_media(text) from public, anon;
grant execute on function private.can_upload_payment_proof(text), private.can_upload_field_media(text) to authenticated;

create policy payment_proofs_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'payment-proofs' and (select private.can_upload_payment_proof(name)));

create policy payment_proofs_select on storage.objects for select to authenticated
  using (bucket_id = 'payment-proofs'
         and ((storage.foldername(name))[1] = (select auth.uid())::text
              or (select private.has_any_role(array['finance_admin']))));

create policy field_media_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'field-media' and (select private.can_upload_field_media(name)));

create policy field_media_select on storage.objects for select to authenticated
  using (bucket_id = 'field-media'
         and ((storage.foldername(name))[1] = (select auth.uid())::text
              or (select private.has_any_role(array['quality_auditor']))));
