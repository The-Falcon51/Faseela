-- Faseela Data API surface: SECURITY INVOKER wrappers in `public` and the final privilege set.

-- ---------------------------------------------------------------------------
-- Data API wrappers (SECURITY INVOKER; the only RPC surface the client sees)
-- ---------------------------------------------------------------------------
create function public.ensure_profile(payload jsonb default '{}'::jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.ensure_profile(payload); $$;
create function public.submit_role_application(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.submit_role_application(payload); $$;
create function public.review_role_application(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.review_role_application(payload); $$;
create function public.create_investment_request(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.create_investment_request(payload); $$;
create function public.cancel_investment_request(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.cancel_investment_request(payload); $$;
create function public.submit_investment_payment_proof(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.submit_investment_payment_proof(payload); $$;
create function public.review_investment_request(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.review_investment_request(payload); $$;
create function public.submit_farmer_update(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.submit_farmer_update(payload); $$;
create function public.review_farmer_update(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.review_farmer_update(payload); $$;
create function public.submit_pressing_batch(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.submit_pressing_batch(payload); $$;
create function public.certify_pressing_batch(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.certify_pressing_batch(payload); $$;
create function public.list_review_queue(payload jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.list_review_queue(payload); $$;
create function public.admin_list_users(payload jsonb default '{}'::jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.admin_list_users(payload); $$;
create function public.export_my_data(payload jsonb default '{}'::jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.export_my_data(payload); $$;

-- ---------------------------------------------------------------------------
-- Privileges: deny by default, then allow exactly the client RPC surface.
-- ---------------------------------------------------------------------------
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function
  private.current_app_role(),
  private.has_any_role(text[]),
  private.ensure_profile(jsonb),
  private.submit_role_application(jsonb),
  private.review_role_application(jsonb),
  private.create_investment_request(jsonb),
  private.cancel_investment_request(jsonb),
  private.submit_investment_payment_proof(jsonb),
  private.review_investment_request(jsonb),
  private.submit_farmer_update(jsonb),
  private.review_farmer_update(jsonb),
  private.submit_pressing_batch(jsonb),
  private.certify_pressing_batch(jsonb),
  private.list_review_queue(jsonb),
  private.admin_list_users(jsonb),
  private.export_my_data(jsonb)
  to authenticated;
grant execute on function private.handle_new_user() to supabase_auth_admin;

revoke all on function
  public.ensure_profile(jsonb), public.submit_role_application(jsonb), public.review_role_application(jsonb),
  public.create_investment_request(jsonb), public.cancel_investment_request(jsonb),
  public.submit_investment_payment_proof(jsonb), public.review_investment_request(jsonb),
  public.submit_farmer_update(jsonb), public.review_farmer_update(jsonb), public.submit_pressing_batch(jsonb),
  public.certify_pressing_batch(jsonb), public.list_review_queue(jsonb), public.admin_list_users(jsonb),
  public.export_my_data(jsonb)
  from public, anon;
grant execute on function
  public.ensure_profile(jsonb), public.submit_role_application(jsonb), public.review_role_application(jsonb),
  public.create_investment_request(jsonb), public.cancel_investment_request(jsonb),
  public.submit_investment_payment_proof(jsonb), public.review_investment_request(jsonb),
  public.submit_farmer_update(jsonb), public.review_farmer_update(jsonb), public.submit_pressing_batch(jsonb),
  public.certify_pressing_batch(jsonb), public.list_review_queue(jsonb), public.admin_list_users(jsonb),
  public.export_my_data(jsonb)
  to authenticated;
