-- Faseela operator-only helper: set a user's role from the SQL editor (never callable by clients).

create function private.admin_set_role(p_email text, p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
begin
  select id into v_uid from auth.users where lower(email) = lower(p_email);
  if v_uid is null then perform private.fail('not-found', 'No user with this e-mail.'); end if;
  -- 'investor' is stored explicitly (same effect as no row) so the role history stays auditable.
  insert into private.user_roles (user_id, role, granted_by)
  values (v_uid, p_role, null)
  on conflict (user_id) do update set role = excluded.role, granted_at = now(), granted_by = null;
  perform private.audit(null, 'role.set', 'user_roles/' || v_uid, jsonb_build_object('role', p_role));
end;
$$;

revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.current_app_role(), private.has_any_role(text[]) to authenticated;
grant execute on function private.handle_new_user() to supabase_auth_admin;
