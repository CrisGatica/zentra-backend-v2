-- Apply after supabase-execution-guard.sql, STAGING first. Does not change usage/entitlements.
begin;
alter table public.zentra_search_requests drop constraint if exists zentra_search_requests_state_check;
alter table public.zentra_search_requests add constraint zentra_search_requests_state_check
  check(state in ('running','done','failed','execution_uncertain'));

create or replace function public.zentra_finish_search(p_user uuid,p_operation text,p_hash text,p_lease uuid,p_response jsonb,p_success boolean)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.zentra_search_requests; a public.zentra_search_allocations;
begin
  perform 1 from public.users where id=p_user for update;
  select * into r from public.zentra_search_requests where user_id=p_user and operation_key=p_operation
    and request_hash=p_hash and lease_token=p_lease;
  if not found then return false; end if;
  if r.state<>'running' then
    return r.state='execution_uncertain' or (r.response=p_response and r.state=case when p_success then 'done' else 'failed' end);
  end if;
  select * into a from public.zentra_search_allocations where user_id=p_user and operation_key=p_operation
    and request_hash=p_hash and lease_token=p_lease;
  if r.provider_started_at is not null and a.actual is null then
    -- HTTP errors, aborts and incomplete responses do not prove that tools never ran.
    update public.zentra_search_requests set state='execution_uncertain',lease_until=now(),
      response=jsonb_build_object('status',409,'value',jsonb_build_object('code','execution_uncertain'))
      where user_id=p_user and operation_key=p_operation and request_hash=p_hash and lease_token=p_lease;
  else
    if r.provider_started_at is null and a.reserved is not null and a.actual is null then
      update public.zentra_audit_search_budgets set used=used-a.reserved where user_id=p_user and operation_key=p_operation;
      update public.zentra_search_allocations set actual=0 where user_id=p_user and operation_key=p_operation
        and request_hash=p_hash and lease_token=p_lease;
    end if;
    update public.zentra_search_requests set state=case when p_success then 'done' else 'failed' end,
      lease_until=now(),response=p_response
      where user_id=p_user and operation_key=p_operation and request_hash=p_hash and lease_token=p_lease;
  end if;
  return true;
end $$;

create or replace function public.zentra_reap_search_leases(p_user uuid default null)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare u record; r public.zentra_search_requests; n integer:=0;
begin
  -- Same user-first lock order as reserve/settle/finish. Multiple workers skip owned users.
  for u in select id from public.users where (p_user is null or id=p_user) and exists(
    select 1 from public.zentra_search_requests s where s.user_id=users.id and s.state='running' and s.lease_until<=now())
    order by id limit 100 for update skip locked loop
    for r in select * from public.zentra_search_requests where user_id=u.id and state='running' and lease_until<=now() loop
      if public.zentra_finish_search(r.user_id,r.operation_key,r.request_hash,r.lease_token,
        jsonb_build_object('status',503,'value',jsonb_build_object('code','search_lease_expired')),false) then n:=n+1; end if;
    end loop;
  end loop;
  return n;
end $$;

create or replace function public.zentra_begin_search(p_auth_id text,p_email text,p_product text,p_operation text,p_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u public.users; r public.zentra_search_requests;
begin
  u:=public.zentra_access(p_auth_id,p_email,p_product);
  if p_hash !~ '^[0-9a-f]{64}$' or not exists(select 1 from public.zentra_audit_steps s
    join public.zentra_requests q on q.user_id=s.user_id and q.operation_key=s.operation_key and q.request_hash=s.request_hash
    where s.user_id=u.id and s.operation_key=p_operation and s.step_name='seo_analysis' and q.state='done') then
    return jsonb_build_object('allowed',false,'reason','operation_conflict'); end if;
  perform public.zentra_reap_search_leases(u.id);
  select * into r from public.zentra_search_requests where user_id=u.id and operation_key=p_operation and request_hash=p_hash;
  if found then
    if r.state='done' then return jsonb_build_object('allowed',true,'cached',true,'response',r.response); end if;
    if r.state='execution_uncertain' then return jsonb_build_object('allowed',false,'reason','execution_uncertain'); end if;
    if r.state='running' then return jsonb_build_object('allowed',false,'reason','in_progress'); end if;
    if r.attempts>=3 then return jsonb_build_object('allowed',false,'reason','retry_limit'); end if;
    update public.zentra_search_requests set state='running',attempts=attempts+1,lease_token=gen_random_uuid(),
      lease_until=now()+interval '5 minutes',provider_started_at=null,response=null
      where user_id=u.id and operation_key=p_operation and request_hash=p_hash returning * into r;
  else
    insert into public.zentra_search_requests(user_id,operation_key,request_hash) values(u.id,p_operation,p_hash) returning * into r;
  end if;
  return jsonb_build_object('allowed',true,'user_id',u.id,'lease_token',r.lease_token);
end $$;

revoke all on function public.zentra_reap_search_leases(uuid) from public,anon,authenticated;
grant execute on function public.zentra_reap_search_leases(uuid) to service_role;
-- Existing finish/begin RPCs retain their server-only grants under CREATE OR REPLACE.
commit;
