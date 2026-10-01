-- Apply after supabase-release-guard.sql. All RPCs are server-only.
begin;

create or replace function public.zentra_start_provider(p_user uuid,p_operation text,p_hash text,p_lease uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare n integer;
begin
  perform 1 from public.users where id=p_user for update;
  update public.zentra_requests set provider_started_at=coalesce(provider_started_at,now()),lease_until=now()+interval '5 minutes'
    where user_id=p_user and operation_key=p_operation and request_hash=p_hash and lease_token=p_lease
      and state='running' and (lease_until>now() or provider_started_at is not null);
  get diagnostics n=row_count;
  return n=1;
end $$;

create or replace function public.zentra_checkpoint_response(p_user uuid,p_operation text,p_hash text,p_lease uuid,p_response jsonb)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare n integer;
begin
  perform 1 from public.users where id=p_user for update;
  if p_response->>'text' is null or length(trim(p_response->>'text'))=0 then return false; end if;
  update public.zentra_requests set useful_response=true,response=p_response,provider_started_at=coalesce(provider_started_at,now()),lease_until=now()+interval '5 minutes'
    where user_id=p_user and operation_key=p_operation and request_hash=p_hash and lease_token=p_lease
      and state='running' and (lease_until>now() or provider_started_at is not null);
  get diagnostics n=row_count;
  return n=1;
end $$;

create table if not exists public.zentra_search_requests (
  user_id uuid not null references public.users(id), operation_key text not null, request_hash text not null,
  state text not null default 'running' check(state in ('running','done','failed')),
  attempts integer not null default 1, lease_token uuid not null default gen_random_uuid(),
  lease_until timestamptz not null default now()+interval '5 minutes', provider_started_at timestamptz,
  response jsonb, primary key(user_id,operation_key,request_hash)
);

create or replace function public.zentra_begin_search(p_auth_id text,p_email text,p_product text,p_operation text,p_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u public.users; r public.zentra_search_requests;
begin
  u:=public.zentra_access(p_auth_id,p_email,p_product);
  if p_hash !~ '^[0-9a-f]{64}$' or not exists(select 1 from public.zentra_audit_steps s
    join public.zentra_requests q on q.user_id=s.user_id and q.operation_key=s.operation_key and q.request_hash=s.request_hash
    where s.user_id=u.id and s.operation_key=p_operation and s.step_name='seo_analysis' and q.state='done') then
    return jsonb_build_object('allowed',false,'reason','operation_conflict'); end if;
  select * into r from public.zentra_search_requests where user_id=u.id and operation_key=p_operation and request_hash=p_hash;
  if found then
    if r.state='done' then return jsonb_build_object('allowed',true,'cached',true,'response',r.response); end if;
    if r.state='running' and (r.provider_started_at is not null or r.lease_until>now()) then
      return jsonb_build_object('allowed',false,'reason',
        case when r.provider_started_at is not null and r.lease_until<=now() then 'execution_uncertain' else 'in_progress' end); end if;
    if r.attempts>=3 then return jsonb_build_object('allowed',false,'reason','retry_limit'); end if;
    update public.zentra_search_requests set state='running',attempts=attempts+1,lease_token=gen_random_uuid(),
      lease_until=now()+interval '5 minutes',provider_started_at=null,response=null
      where user_id=u.id and operation_key=p_operation and request_hash=p_hash returning * into r;
  else
    insert into public.zentra_search_requests(user_id,operation_key,request_hash) values(u.id,p_operation,p_hash) returning * into r;
  end if;
  return jsonb_build_object('allowed',true,'user_id',u.id,'lease_token',r.lease_token);
end $$;

create or replace function public.zentra_start_search(p_user uuid,p_operation text,p_hash text,p_lease uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare n integer;
begin
  perform 1 from public.users where id=p_user for update;
  update public.zentra_search_requests set provider_started_at=coalesce(provider_started_at,now()),lease_until=now()+interval '5 minutes'
    where user_id=p_user and operation_key=p_operation and request_hash=p_hash and lease_token=p_lease
      and state='running' and provider_started_at is null and lease_until>now();
  get diagnostics n=row_count; return n=1;
end $$;

create or replace function public.zentra_finish_search(p_user uuid,p_operation text,p_hash text,p_lease uuid,p_response jsonb,p_success boolean)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare n integer;
begin
  perform 1 from public.users where id=p_user for update;
  update public.zentra_search_requests set state=case when p_success then 'done' else 'failed' end,response=p_response
    where user_id=p_user and operation_key=p_operation and request_hash=p_hash and lease_token=p_lease
      and state='running' and (lease_until>now() or provider_started_at is not null);
  get diagnostics n=row_count; return n=1;
end $$;

create or replace function public.zentra_renew_search(p_user uuid,p_operation text,p_hash text,p_lease uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare n integer;
begin
  perform 1 from public.users where id=p_user for update;
  update public.zentra_search_requests set lease_until=now()+interval '5 minutes'
    where user_id=p_user and operation_key=p_operation and request_hash=p_hash and lease_token=p_lease
      and state='running' and (lease_until>now() or provider_started_at is not null);
  get diagnostics n=row_count; return n=1;
end $$;

create table if not exists public.zentra_audit_acquisitions (
  user_id uuid not null references public.users(id), operation_key text not null, source text not null,
  state text not null default 'running' check(state in ('running','done','failed')),
  lease_token uuid not null default gen_random_uuid(), lease_until timestamptz not null default now()+interval '30 seconds',
  primary key(user_id,operation_key)
);

create or replace function public.zentra_handoff_audit(p_auth_id text,p_email text,p_product text,p_operation text,p_lease uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare u public.users;
begin
  u:=public.zentra_access(p_auth_id,p_email,p_product);
  return exists(select 1 from public.zentra_audit_acquisitions where user_id=u.id and operation_key=p_operation
    and lease_token=p_lease and (state='done' or (state='running' and lease_until>now())));
end $$;

drop function if exists public.zentra_acquire_audit(text,text,text,text,text,uuid);
create or replace function public.zentra_acquire_audit(p_auth_id text,p_email text,p_product text,p_operation text,p_source text,p_lease uuid default null,p_unlimited boolean default false)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u public.users; a public.zentra_audit_acquisitions; charged jsonb; counter_name text; abandoned public.zentra_audit_acquisitions;
begin
  if p_operation !~ '^[0-9a-f-]{36}$' or p_source !~ '^https?://' or length(p_source)>2048 then raise exception 'Invalid acquisition'; end if;
  u:=public.zentra_access(p_auth_id,p_email,p_product);
  -- Reap only pre-generation acquisitions: no external AI outcome can be uncertain here.
  for abandoned in select * from public.zentra_audit_acquisitions where user_id=u.id
    and state='running' and lease_until<=now() and not exists(select 1 from public.zentra_requests q
      where q.user_id=u.id and q.operation_key=zentra_audit_acquisitions.operation_key) loop
    perform public.zentra_release_audit(p_auth_id,p_email,p_product,abandoned.operation_key,abandoned.lease_token);
  end loop;
  select * into u from public.users where id=u.id;
  select * into a from public.zentra_audit_acquisitions where user_id=u.id and operation_key=p_operation;
  if found then
    if a.source<>p_source then return jsonb_build_object('allowed',false,'reason','operation_conflict'); end if;
    if exists(select 1 from public.zentra_requests where user_id=u.id and operation_key=p_operation and state='running'
      and provider_started_at is not null and lease_until<=now()) then return jsonb_build_object('allowed',false,'reason','execution_uncertain'); end if;
    if a.state='running' and a.lease_until>now() and a.lease_token is distinct from p_lease then
      return jsonb_build_object('allowed',false,'reason','in_progress'); end if;
    if a.state='done' then return jsonb_build_object('allowed',true,'lease_token',a.lease_token,'completed',true); end if;
  end if;
  select counter into counter_name from public.zentra_usage_receipts where user_id=u.id and operation_key=p_operation
    and counter in ('audits_used','audit_credits_used') limit 1;
  counter_name:=coalesce(counter_name,case when p_product='audit' and u.plan<>'free' then 'audit_credits_used' else 'audits_used' end);
  charged:=public.zentra_consume(p_auth_id,p_email,p_product,counter_name,p_operation,p_unlimited);
  if not (charged->>'allowed')::boolean then return charged; end if;
  insert into public.zentra_audit_acquisitions(user_id,operation_key,source)
    values(u.id,p_operation,p_source) on conflict(user_id,operation_key) do update set state='running',
      lease_token=case when zentra_audit_acquisitions.lease_token=p_lease and zentra_audit_acquisitions.lease_until>now()
        then p_lease else gen_random_uuid() end,lease_until=now()+interval '30 seconds'
    returning * into a;
  return jsonb_build_object('allowed',true,'lease_token',a.lease_token);
end $$;

create or replace function public.zentra_release_audit(p_auth_id text,p_email text,p_product text,p_operation text,p_lease uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare u public.users; a public.zentra_audit_acquisitions; receipt public.zentra_usage_receipts;
begin
  u:=public.zentra_access(p_auth_id,p_email,p_product);
  select * into a from public.zentra_audit_acquisitions where user_id=u.id and operation_key=p_operation;
  if not found or a.state<>'running' or a.lease_token<>p_lease then return false; end if;
  update public.zentra_audit_acquisitions set state='failed' where user_id=u.id and operation_key=p_operation;
  if exists(select 1 from public.zentra_requests where user_id=u.id and operation_key=p_operation) then
    return public.zentra_refund_failed(u.id,p_operation); end if;
  -- Before any generation exists, return the acquisition's receipt exactly once.
  for receipt in select * from public.zentra_usage_receipts where user_id=u.id and operation_key=p_operation
    and refunded_at is null and funding<>'legacy' for update loop
    if receipt.funding='extra' then
      update public.users set extra_audits_balance=extra_audits_balance+1,
        extra_audits_used_cycle=greatest(0,extra_audits_used_cycle-case when billing_cycle_start=receipt.billing_cycle then 1 else 0 end)
        where id=u.id;
    elsif receipt.funding='base' and (receipt.counter='audit_credits_used' or u.billing_cycle_start=receipt.billing_cycle) then
      execute format('update public.users set %I=greatest(0,%I-1) where id=$1',receipt.counter,receipt.counter) using u.id;
    end if;
    update public.zentra_usage_receipts set refunded_at=now() where user_id=u.id and counter=receipt.counter and operation_key=p_operation;
  end loop;
  return true;
end $$;

-- Reserve the worst-case tool allowance before contacting OpenAI. Refund only
-- slots proven unused by a complete response; uncertainty retains the allowance.
create table if not exists public.zentra_audit_search_budgets (
  user_id uuid not null references public.users(id), operation_key text not null,
  used integer not null default 0 check(used between 0 and 3),
  primary key(user_id,operation_key)
);
create table if not exists public.zentra_search_allocations (
  user_id uuid not null, operation_key text not null, request_hash text not null, lease_token uuid not null,
  reserved integer not null check(reserved between 1 and 3), actual integer,
  primary key(user_id,operation_key,request_hash,lease_token),
  foreign key(user_id,operation_key) references public.zentra_audit_search_budgets(user_id,operation_key)
);
create or replace function public.zentra_reserve_search_budget(p_user uuid,p_operation text,p_hash text,p_lease uuid)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare remaining integer;
begin
  perform 1 from public.users where id=p_user for update;
  if not exists(select 1 from public.zentra_search_requests where user_id=p_user and operation_key=p_operation
    and request_hash=p_hash and lease_token=p_lease and state='running' and lease_until>now()
    and provider_started_at is null) then raise exception 'Search ownership unavailable'; end if;
  insert into public.zentra_audit_search_budgets(user_id,operation_key) values(p_user,p_operation) on conflict do nothing;
  select 3-used into remaining from public.zentra_audit_search_budgets where user_id=p_user and operation_key=p_operation;
  if remaining=0 then
    if exists(select 1 from public.zentra_search_allocations a join public.zentra_search_requests r
      on r.user_id=a.user_id and r.operation_key=a.operation_key and r.request_hash=a.request_hash and r.lease_token=a.lease_token
      where a.user_id=p_user and a.operation_key=p_operation and a.actual is null and r.state='running' and r.lease_until>now()) then
      return -1; -- Temporarily reserved, not proven exhausted: do not cache a permanent empty result.
    end if;
    return 0;
  end if;
  insert into public.zentra_search_allocations(user_id,operation_key,request_hash,lease_token,reserved)
    values(p_user,p_operation,p_hash,p_lease,remaining);
  update public.zentra_audit_search_budgets set used=used+remaining where user_id=p_user and operation_key=p_operation;
  if not public.zentra_start_search(p_user,p_operation,p_hash,p_lease) then raise exception 'Search ownership unavailable'; end if;
  return remaining;
end $$;
create or replace function public.zentra_settle_search_budget(p_user uuid,p_operation text,p_hash text,p_lease uuid,p_actual integer)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare allocation public.zentra_search_allocations;
begin
  perform 1 from public.users where id=p_user for update;
  if not exists(select 1 from public.zentra_search_requests where user_id=p_user and operation_key=p_operation
    and request_hash=p_hash and lease_token=p_lease and state='running' and provider_started_at is not null) then return false; end if;
  select * into allocation from public.zentra_search_allocations where user_id=p_user and operation_key=p_operation
    and request_hash=p_hash and lease_token=p_lease;
  if not found or p_actual is null or p_actual<0 or p_actual>allocation.reserved then return false; end if;
  if allocation.actual is not null then return allocation.actual=p_actual; end if;
  update public.zentra_audit_search_budgets set used=used-(allocation.reserved-p_actual)
    where user_id=p_user and operation_key=p_operation;
  update public.zentra_search_allocations set actual=p_actual where user_id=p_user and operation_key=p_operation
    and request_hash=p_hash and lease_token=p_lease;
  return true;
end $$;
alter table public.zentra_audit_search_budgets enable row level security;
alter table public.zentra_search_allocations enable row level security;
revoke all on public.zentra_audit_search_budgets,public.zentra_search_allocations from public,anon,authenticated;
grant all on public.zentra_audit_search_budgets,public.zentra_search_allocations to service_role;
revoke all on function public.zentra_reserve_search_budget(uuid,text,text,uuid),public.zentra_settle_search_budget(uuid,text,text,uuid,integer) from public,anon,authenticated;
grant execute on function public.zentra_reserve_search_budget(uuid,text,text,uuid),public.zentra_settle_search_budget(uuid,text,text,uuid,integer) to service_role;

alter table public.zentra_search_requests enable row level security;
alter table public.zentra_audit_acquisitions enable row level security;
revoke all on public.zentra_search_requests,public.zentra_audit_acquisitions from public,anon,authenticated;
grant all on public.zentra_search_requests,public.zentra_audit_acquisitions to service_role;
revoke all on function public.zentra_start_provider(uuid,text,text,uuid),public.zentra_checkpoint_response(uuid,text,text,uuid,jsonb),
  public.zentra_begin_search(text,text,text,text,text),public.zentra_start_search(uuid,text,text,uuid),public.zentra_finish_search(uuid,text,text,uuid,jsonb,boolean),
  public.zentra_acquire_audit(text,text,text,text,text,uuid,boolean),public.zentra_release_audit(text,text,text,text,uuid),
  public.zentra_renew_search(uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.zentra_start_provider(uuid,text,text,uuid),public.zentra_checkpoint_response(uuid,text,text,uuid,jsonb),
  public.zentra_begin_search(text,text,text,text,text),public.zentra_start_search(uuid,text,text,uuid),public.zentra_finish_search(uuid,text,text,uuid,jsonb,boolean),
  public.zentra_acquire_audit(text,text,text,text,text,uuid,boolean),public.zentra_release_audit(text,text,text,text,uuid),
  public.zentra_renew_search(uuid,text,text,uuid) to service_role;
revoke all on function public.zentra_handoff_audit(text,text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.zentra_handoff_audit(text,text,text,text,uuid) to service_role;
commit;
