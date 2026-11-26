-- Faseela (migration 47): a request remembers its unit. 'l' = olive oil (liters_ml holds millilitres),
-- 'kg' = weighed harvest (liters_ml holds grams). Mails, the review card and the owner's request list use it.
alter table public.oil_requests add column if not exists unit text not null default 'l' check (unit in ('l', 'kg'));

create or replace function private.oil_request_unit(p_request uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when exists (select 1 from public.oil_allocations a join public.trees_public tp on tp.tree_id = a.tree_id
                            where a.request_id = p_request and tp.crop_category <> 'olive') then 'kg' else 'l' end;
$$;
revoke all on function private.oil_request_unit(uuid) from public, anon, authenticated;

-- request_oil and review_oil_request are changed in place; a missing fragment aborts the migration.
do $$
declare
  c record;
  v_def text;
begin
  for c in select * from (values
    ('request_oil', 'where user_id = v_uid and status = ''granted'' and v_credit > 0;',
     'where user_id = v_uid and status = ''granted'' and v_credit > 0;
  update public.oil_requests set unit = private.oil_request_unit(v_request_id) where id = v_request_id;'),
    ('request_oil', '''oil_request_received'', jsonb_build_object(''requestId'', v_request_id, ''kind'', v_kind, ''litersMl'', v_ml));',
     '''oil_request_received'', jsonb_build_object(''requestId'', v_request_id, ''kind'', v_kind, ''litersMl'', v_ml, ''unit'', private.oil_request_unit(v_request_id)));'),
    ('request_oil', '''creditMl'', v_credit, ''kind'', v_kind);', '''creditMl'', v_credit, ''kind'', v_kind, ''unit'', private.oil_request_unit(v_request_id));'),
    ('review_oil_request', '''requestId'', v_id, ''kind'', v_req.kind, ''litersMl'', v_req.liters_ml, ''note'', v_note));',
     '''requestId'', v_id, ''kind'', v_req.kind, ''litersMl'', v_req.liters_ml, ''note'', v_note, ''unit'', (select unit from public.oil_requests where id = v_id)));')
  ) as x(fn, old, new) loop
    select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = c.fn;
    if position(c.new in v_def) > 0 then
      continue;
    end if;
    if position(c.old in v_def) = 0 then
      raise exception 'fragment not found in private.%', c.fn;
    end if;
    execute replace(v_def, c.old, c.new);
  end loop;
end;
$$;
