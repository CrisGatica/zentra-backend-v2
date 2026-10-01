-- Apply after supabase-users.sql. Server-only: never expose these RPCs to clients.
begin;

alter table public.users
  add column if not exists billing_status text,
  add column if not exists subscription_ends_at timestamptz,
  add column if not exists subscription_renews_at timestamptz,
  add column if not exists billing_updated_at timestamptz,
  add column if not exists lemon_subscription_id text,
  add column if not exists billing_policy_pending boolean not null default false;

create table if not exists public.zentra_payment_receipts (
  order_id text primary key,
  user_id uuid not null references public.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.zentra_usage_receipts (
  user_id uuid not null references public.users(id),
  counter text not null,
  operation_key text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, counter, operation_key)
);

-- Existing receipts are deliberately not refundable: their original funding is unknown.
alter table public.zentra_usage_receipts
  add column if not exists funding text not null default 'legacy',
  add column if not exists billing_cycle bigint,
  add column if not exists refunded_at timestamptz;

create table if not exists public.zentra_requests (
  user_id uuid not null references public.users(id),
  operation_key text not null,
  source_hash text not null,
  request_hash text not null,
  kind text not null check (kind in ('chat', 'audit')),
  state text not null default 'running' check (state in ('running', 'done', 'failed')),
  attempts integer not null default 1,
  response jsonb,
  created_at timestamptz not null default now(),
  lease_until timestamptz not null default (now() + interval '5 minutes'),
  lease_token uuid not null default gen_random_uuid(),
  primary key (user_id, operation_key, request_hash)
);

alter table public.zentra_requests add column if not exists lease_token uuid not null default gen_random_uuid();
alter table public.zentra_requests
  add column if not exists provider_started_at timestamptz,
  add column if not exists useful_response boolean not null default false;
create index if not exists zentra_requests_created_idx on public.zentra_requests(created_at);

create table if not exists public.zentra_chat_steps (
  user_id uuid not null references public.users(id),
  operation_key text not null,
  step_name text not null,
  request_hash text not null,
  body jsonb not null,
  context jsonb,
  created_at timestamptz not null default now(),
  primary key(user_id,operation_key,step_name)
);

create table if not exists public.zentra_audit_steps (
  user_id uuid not null references public.users(id),
  operation_key text not null,
  step_name text not null,
  request_hash text not null,
  body jsonb not null,
  context jsonb,
  created_at timestamptz not null default now(),
  primary key(user_id,operation_key,step_name)
);

create or replace function public.zentra_refund_failed(p_user uuid, p_operation text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare u public.users; receipt public.zentra_usage_receipts;
begin
  select * into u from public.users where id=p_user for update;
  if not found then return false; end if;
  if not exists(select 1 from public.zentra_requests where user_id=p_user and operation_key=p_operation)
    or exists(select 1 from public.zentra_requests where user_id=p_user and operation_key=p_operation
      and (state='done' or useful_response or (state='running' and (lease_until>now() or provider_started_at is not null)))) then return false; end if;
  update public.zentra_requests set state='failed' where user_id=p_user and operation_key=p_operation and state='running';
  for receipt in select * from public.zentra_usage_receipts where user_id=p_user
    and operation_key=p_operation and refunded_at is null and funding<>'legacy' for update loop
    if receipt.funding='extra' then
      if receipt.counter='actions_used' then
        update public.users set extra_actions_balance=extra_actions_balance+1,
          extra_actions_used_cycle=greatest(0,extra_actions_used_cycle-case when billing_cycle_start=receipt.billing_cycle then 1 else 0 end)
          where id=p_user;
      elsif receipt.counter='audits_used' then
        update public.users set extra_audits_balance=extra_audits_balance+1,
          extra_audits_used_cycle=greatest(0,extra_audits_used_cycle-case when billing_cycle_start=receipt.billing_cycle then 1 else 0 end)
          where id=p_user;
      end if;
    elsif receipt.funding='base' and (receipt.counter='audit_credits_used' or u.billing_cycle_start=receipt.billing_cycle) then
      execute format('update public.users set %I=greatest(0,%I-1) where id=$1',receipt.counter,receipt.counter) using p_user;
    end if;
    update public.zentra_usage_receipts set refunded_at=now() where user_id=p_user
      and operation_key=p_operation and counter=receipt.counter;
  end loop;
  return true;
end $$;

create or replace function public.zentra_finish_request(
  p_user uuid,p_operation text,p_hash text,p_lease uuid,p_response jsonb,p_success boolean
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare updated integer; refunded boolean;
begin
  perform 1 from public.users where id=p_user for update;
  update public.zentra_requests set state=case when p_success or useful_response then 'done' else 'failed' end,
    response=case when p_success then p_response when useful_response then response else null end
    where user_id=p_user and operation_key=p_operation and request_hash=p_hash
      and lease_token=p_lease and state='running' and (lease_until>now() or provider_started_at is not null);
  get diagnostics updated = row_count;
  if updated=0 then return jsonb_build_object('accepted',false,'reason','stale_lease'); end if;
  if not p_success then refunded := public.zentra_refund_failed(p_user,p_operation); end if;
  return jsonb_build_object('accepted',true,'refunded',coalesce(refunded,false));
end $$;

create or replace function public.zentra_renew_request(p_user uuid,p_operation text,p_hash text,p_lease uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare updated integer;
begin
  perform 1 from public.users where id=p_user for update;
  update public.zentra_requests set lease_until=now()+interval '5 minutes'
    where user_id=p_user and operation_key=p_operation and request_hash=p_hash
      and lease_token=p_lease and state='running' and (lease_until>now() or provider_started_at is not null);
  get diagnostics updated = row_count;
  return updated=1;
end $$;

create or replace function public.zentra_access(p_auth_id text, p_email text, p_product text)
returns public.users language plpgsql security definer set search_path = public, pg_temp as $$
declare u public.users; expired_operation text;
begin
  if p_auth_id is null or p_auth_id = '' or p_email is null or p_email = ''
     or p_product not in ('subscription', 'audit') then raise exception 'Invalid identity'; end if;
  select * into u from public.users where auth_user_id = p_auth_id and plan_type = p_product for update;
  if not found then
    insert into public.users(email, auth_user_id, plan_type)
      values(lower(p_email), p_auth_id, p_product) on conflict(email, plan_type) do nothing;
    select * into u from public.users where email = lower(p_email) and plan_type = p_product for update;
  end if;
  if u.auth_user_id is not null and u.auth_user_id <> p_auth_id then raise exception 'Identity conflict'; end if;
  if u.auth_user_id is null then
    update public.users set auth_user_id = p_auth_id where id = u.id returning * into u;
  end if;
  -- Lazy crash recovery runs under the same account lock as reservations.
  for expired_operation in select distinct operation_key from public.zentra_requests
    where user_id=u.id and state='running' and lease_until<=now() loop
    perform public.zentra_refund_failed(u.id,expired_operation);
  end loop;
  select * into u from public.users where id=u.id;
  if u.plan_type='subscription' and u.billing_status='cancelled' and u.subscription_ends_at<=now() and u.status<>'cancelled' then
    update public.users set status='cancelled',updated_at=now() where id=u.id returning * into u;
  end if;
  if now() >= to_timestamp(u.billing_cycle_start / 1000.0) + interval '1 month' then
    update public.users set actions_used=0, audits_used=0, premium_chat_used=0, premium_pdf_used=0,
      extra_actions_used_cycle=0, extra_audits_used_cycle=0,
      billing_cycle_start=(extract(epoch from now()) * 1000)::bigint, updated_at=now()
      where id=u.id returning * into u;
  end if;
  return u;
end $$;

create or replace function public.zentra_read_chat_steps(p_auth_id text,p_email text,p_product text,p_operation text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare u public.users; root jsonb; steps jsonb; previous jsonb;
begin
  u := public.zentra_access(p_auth_id,p_email,p_product);
  select to_jsonb(s) into root from public.zentra_chat_steps s where user_id=u.id and operation_key=p_operation and step_name='root';
  select coalesce(jsonb_agg(to_jsonb(s)),'[]'::jsonb) into steps from public.zentra_chat_steps s where user_id=u.id and operation_key=p_operation;
  select response into previous from public.zentra_requests where user_id=u.id and operation_key=p_operation and state='done' order by created_at desc limit 1;
  return jsonb_build_object('root',root,'steps',steps,'previous_response',previous);
end $$;

create or replace function public.zentra_register_chat_step(
  p_auth_id text,p_email text,p_product text,p_operation text,p_step text,p_hash text,p_body jsonb,p_context jsonb
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare u public.users; root public.zentra_chat_steps; step public.zentra_chat_steps;
begin
  if p_product<>'subscription' or p_operation !~ '^[0-9a-f-]{36}$' or p_hash !~ '^[0-9a-f]{64}$'
    or p_step not in ('root','rewrite','organization','ocr_cards','incomplete','strategic','polish','reasoning','visible') then
    raise exception 'Invalid chat step'; end if;
  u := public.zentra_access(p_auth_id,p_email,p_product);
  select * into root from public.zentra_chat_steps where user_id=u.id and operation_key=p_operation and step_name='root';
  if (p_step='root' and found and root.request_hash<>p_hash) or (p_step<>'root' and not found) then
    return jsonb_build_object('allowed',false,'reason','operation_conflict'); end if;
  if p_step<>'root' and root.created_at < now()-interval '30 minutes' then
    return jsonb_build_object('allowed',false,'reason','retry_limit'); end if;
  insert into public.zentra_chat_steps(user_id,operation_key,step_name,request_hash,body,context)
    values(u.id,p_operation,p_step,p_hash,p_body,case when p_step='root' then p_context else null end)
    on conflict(user_id,operation_key,step_name) do nothing;
  select * into step from public.zentra_chat_steps where user_id=u.id and operation_key=p_operation and step_name=p_step;
  return jsonb_build_object('allowed',true,'body',step.body,'root_hash',coalesce(root.request_hash,step.request_hash));
end $$;

create or replace function public.zentra_read_audit_steps(p_auth_id text,p_email text,p_product text,p_operation text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare u public.users; root jsonb; steps jsonb;
begin
  u := public.zentra_access(p_auth_id,p_email,p_product);
  select to_jsonb(s) into root from public.zentra_audit_steps s
    where user_id=u.id and operation_key=p_operation and step_name='seo_analysis';
  select coalesce(jsonb_agg(to_jsonb(s)||jsonb_build_object('state',r.state,'response',r.response)),'[]'::jsonb)
    into steps from public.zentra_audit_steps s left join public.zentra_requests r
    on r.user_id=s.user_id and r.operation_key=s.operation_key and r.request_hash=s.request_hash
    where s.user_id=u.id and s.operation_key=p_operation;
  return jsonb_build_object('root',root,'steps',steps,'plan',u.plan,
    'acquisitionSource',(select a.source from public.zentra_audit_acquisitions a
      where a.user_id=u.id and a.operation_key=p_operation));
end $$;

create or replace function public.zentra_register_audit_step(
  p_auth_id text,p_email text,p_product text,p_operation text,p_step text,p_hash text,p_body jsonb,p_context jsonb
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare u public.users; root public.zentra_audit_steps; step public.zentra_audit_steps;
begin
  if p_operation !~ '^[0-9a-f-]{36}$' or p_hash !~ '^[0-9a-f]{64}$'
    or p_step not in ('seo_analysis','premium_reasoning_audit','executive_refiner_pdf') then
    raise exception 'Invalid audit step'; end if;
  u := public.zentra_access(p_auth_id,p_email,p_product);
  select * into root from public.zentra_audit_steps
    where user_id=u.id and operation_key=p_operation and step_name='seo_analysis';
  if (p_step='seo_analysis' and found and root.request_hash<>p_hash)
    or (p_step<>'seo_analysis' and not found) then
    return jsonb_build_object('allowed',false,'reason','operation_conflict'); end if;
  if p_step<>'seo_analysis' and root.created_at < now()-interval '30 minutes' then
    return jsonb_build_object('allowed',false,'reason','retry_limit'); end if;
  insert into public.zentra_audit_steps(user_id,operation_key,step_name,request_hash,body,context)
    values(u.id,p_operation,p_step,p_hash,p_body,p_context)
    on conflict(user_id,operation_key,step_name) do nothing;
  select * into step from public.zentra_audit_steps
    where user_id=u.id and operation_key=p_operation and step_name=p_step;
  return jsonb_build_object('allowed',true,'body',step.body,'root_hash',coalesce(root.request_hash,step.request_hash));
end $$;

create or replace function public.zentra_apply_payment(
  p_email text,p_product text,p_plan text,p_id text,p_status text,p_ends timestamptz,p_renews timestamptz,
  p_changed timestamptz,p_actions integer,p_audits integer,p_history jsonb
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare u public.users; effective_status text; pending boolean := false;
begin
  if p_email is null or p_email='' or p_id is null or p_id=''
    or p_product not in ('subscription','audit','extra') or p_plan not in ('free','starter','pro','agency')
    or p_actions<0 or p_audits<0 then raise exception 'Invalid payment'; end if;
  insert into public.users(email,plan_type) values(lower(p_email),case when p_product='audit' then 'audit' else 'subscription' end)
    on conflict(email,plan_type) do nothing;
  select * into u from public.users where email=lower(p_email)
    and plan_type=(case when p_product='audit' then 'audit' else 'subscription' end) for update;
  if p_product='subscription' then
    if p_changed is null then raise exception 'Missing provider timestamp'; end if;
    if u.billing_updated_at is not null and p_changed<=u.billing_updated_at then
      return jsonb_build_object('user',to_jsonb(u),'duplicate',true); end if;
    effective_status := case
      when p_status in ('active','on_trial') then 'active'
      when p_status='expired' then 'cancelled'
      when p_status='cancelled' and p_ends is not null then case when p_ends>now() then 'active' else 'cancelled' end
      else u.status end;
    pending := p_status not in ('active','on_trial','expired','cancelled')
      or (p_status='cancelled' and p_ends is null);
    update public.users set
      plan=case when pending then u.plan else p_plan end,
      status=effective_status, billing_status=p_status, subscription_ends_at=p_ends,
      subscription_renews_at=p_renews,billing_updated_at=p_changed,lemon_subscription_id=p_id,
      billing_policy_pending=pending,updated_at=now() where id=u.id returning * into u;
  else
    if p_status<>'paid' then raise exception 'Unpaid order'; end if;
    if exists(select 1 from public.zentra_payment_receipts where order_id=p_id)
      or exists(select 1 from jsonb_array_elements(u.purchase_history) entry where entry->>'lemonOrderId'=p_id) then
      return jsonb_build_object('user',to_jsonb(u),'duplicate',true); end if;
    if p_product='extra' and (u.plan<>'agency' or u.status<>'active') then raise exception 'Agency required'; end if;
    insert into public.zentra_payment_receipts(order_id,user_id) values(p_id,u.id);
    if p_product='audit' then
      update public.users set plan=p_plan,status='active',audit_credits=audit_credits+1,
        purchase_history=jsonb_build_array(p_history)||purchase_history,updated_at=now() where id=u.id returning * into u;
    else
      update public.users set extra_actions_balance=extra_actions_balance+p_actions,
        extra_audits_balance=extra_audits_balance+p_audits,
        extra_actions_purchased_total=extra_actions_purchased_total+p_actions,
        extra_audits_purchased_total=extra_audits_purchased_total+p_audits,
        purchase_history=jsonb_build_array(p_history)||purchase_history,updated_at=now() where id=u.id returning * into u;
    end if;
  end if;
  return jsonb_build_object('user',to_jsonb(u),'duplicate',false);
end $$;

create or replace function public.zentra_consume(
  p_auth_id text, p_email text, p_product text, p_counter text, p_key text, p_unlimited boolean default false
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare u public.users; cap integer; used integer; effective_plan text; extra integer := 0; bucket text;
begin
  if p_counter not in ('actions_used','audits_used','premium_chat_used','premium_pdf_used','audit_credits_used')
     or p_key is null or length(p_key) not between 16 and 160 then raise exception 'Invalid reservation'; end if;
  u := public.zentra_access(p_auth_id,p_email,p_product);
  if exists(select 1 from public.zentra_usage_receipts where user_id=u.id and counter=p_counter and operation_key=p_key and refunded_at is null)
    then return jsonb_build_object('allowed',true,'duplicate',true,'user',to_jsonb(u)); end if;
  effective_plan := case when u.status='active' then u.plan else 'free' end;
  if p_product='audit' and p_counter not in ('audit_credits_used','audits_used') then
    return jsonb_build_object('allowed',false,'reason','invalid_counter','user',to_jsonb(u));
  end if;
  if p_product='subscription' and p_counter='audit_credits_used' then
    return jsonb_build_object('allowed',false,'reason','invalid_counter','user',to_jsonb(u));
  end if;
  cap := case p_counter
    when 'actions_used' then case effective_plan when 'starter' then 300 when 'pro' then 800 when 'agency' then 3000 else 20 end
    when 'audits_used' then case when p_product='audit' then 1 else
      case effective_plan when 'starter' then 5 when 'pro' then 10 when 'agency' then 30 else 1 end end
    when 'premium_chat_used' then case effective_plan when 'starter' then 30 when 'pro' then 100 when 'agency' then 300 else 3 end
    when 'premium_pdf_used' then case effective_plan when 'pro' then 10 when 'agency' then 30 else 0 end
    when 'audit_credits_used' then case when u.status='active' then u.audit_credits else 0 end end;
  used := coalesce((to_jsonb(u)->>p_counter)::integer,0);
  if p_product='subscription' then
    extra := case p_counter when 'actions_used' then u.extra_actions_balance when 'audits_used' then u.extra_audits_balance else 0 end;
  end if;
  if not p_unlimited and used >= cap and extra <= 0 then
    return jsonb_build_object('allowed',false,'reason','usage_limit_reached','user',to_jsonb(u));
  end if;
  bucket := case when p_unlimited then 'unlimited' when used>=cap and extra>0 then 'extra' else 'base' end;
  if not p_unlimited then
    if used >= cap and extra > 0 then
      if p_counter='actions_used' then
        update public.users set extra_actions_balance=extra_actions_balance-1,
          extra_actions_used_cycle=extra_actions_used_cycle+1,updated_at=now() where id=u.id returning * into u;
      else
        update public.users set extra_audits_balance=extra_audits_balance-1,
          extra_audits_used_cycle=extra_audits_used_cycle+1,updated_at=now() where id=u.id returning * into u;
      end if;
    else
      execute format('update public.users set %I=%I+1,updated_at=now() where id=$1 returning *',p_counter,p_counter)
        into u using u.id;
    end if;
  end if;
  insert into public.zentra_usage_receipts(user_id,counter,operation_key,funding,billing_cycle)
    values(u.id,p_counter,p_key,bucket,u.billing_cycle_start)
    on conflict(user_id,counter,operation_key) do update set
      funding=excluded.funding,billing_cycle=excluded.billing_cycle,refunded_at=null,created_at=now();
  return jsonb_build_object('allowed',true,'duplicate',false,'user',to_jsonb(u));
end $$;

create or replace function public.zentra_consume_generation(
  p_auth_id text,p_email text,p_product text,p_counter text,p_key text,p_hash text,p_lease uuid,
  p_unlimited boolean default false
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare u public.users;
begin
  u := public.zentra_access(p_auth_id,p_email,p_product);
  if not exists(select 1 from public.zentra_requests where user_id=u.id and operation_key=p_key
    and request_hash=p_hash and lease_token=p_lease and state='running' and lease_until>now()) then
    return jsonb_build_object('allowed',false,'reason','stale_lease','user',to_jsonb(u));
  end if;
  return public.zentra_consume(p_auth_id,p_email,p_product,p_counter,p_key,p_unlimited);
end $$;

drop function if exists public.zentra_begin_request(text,text,text,text,text,text,text,boolean);
create or replace function public.zentra_begin_request(
  p_auth_id text,p_email text,p_product text,p_operation text,p_source text,p_hash text,p_kind text,
  p_unlimited boolean default false,p_acquisition uuid default null
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare u public.users; r public.zentra_requests; root public.zentra_requests; result jsonb; counter_name text; n integer; paid jsonb;
begin
  if p_kind not in ('chat','audit') or (p_product='audit' and p_kind<>'audit')
    or p_operation !~ '^[0-9a-f-]{36}$' or p_source !~ '^[0-9a-f]{64}$' or p_hash !~ '^[0-9a-f]{64}$'
    then raise exception 'Invalid operation'; end if;
  u := public.zentra_access(p_auth_id,p_email,p_product);
  if p_acquisition is not null and (p_kind<>'audit' or not public.zentra_handoff_audit(
    p_auth_id,p_email,p_product,p_operation,p_acquisition)) then
    return jsonb_build_object('allowed',false,'reason','stale_lease'); end if;
  if p_kind='audit' and p_acquisition is null and to_regclass('public.zentra_audit_acquisitions') is not null then
    if exists(select 1 from public.zentra_audit_acquisitions where user_id=u.id and operation_key=p_operation) then
      return jsonb_build_object('allowed',false,'reason','stale_lease'); end if;
  end if;
  select coalesce(jsonb_agg(counter),'[]'::jsonb) into paid from public.zentra_usage_receipts
    where user_id=u.id and operation_key=p_operation and refunded_at is null;
  select counter into counter_name from public.zentra_usage_receipts where user_id=u.id
    and operation_key=p_operation and counter in ('actions_used','audits_used','audit_credits_used') limit 1;
  counter_name := coalesce(counter_name,case when p_kind='chat' then 'actions_used'
    when p_product='audit' and u.plan<>'free' then 'audit_credits_used' else 'audits_used' end);
  select * into root from public.zentra_requests where user_id=u.id and operation_key=p_operation order by created_at limit 1;
  if found and (root.source_hash<>p_source or root.kind<>p_kind) then
    return jsonb_build_object('allowed',false,'reason','operation_conflict'); end if;
  select * into r from public.zentra_requests where user_id=u.id and operation_key=p_operation and request_hash=p_hash;
  if (not found or r.state<>'done') and exists(select 1 from public.zentra_requests where user_id=u.id
    and operation_key=p_operation and state='running' and provider_started_at is not null and lease_until<=now()) then
    return jsonb_build_object('allowed',false,'reason','execution_uncertain'); end if;
  if found then
    if r.state='done' then return jsonb_build_object('allowed',true,'cached',true,'response',r.response,'user',to_jsonb(u)); end if;
    if r.state='running' and r.provider_started_at is not null and r.lease_until<=now() then
      return jsonb_build_object('allowed',false,'reason','execution_uncertain'); end if;
    if r.state='running' and r.lease_until>now() then return jsonb_build_object('allowed',false,'reason','in_progress'); end if;
    if r.attempts>=3 then return jsonb_build_object('allowed',false,'reason','retry_limit'); end if;
    result := public.zentra_consume(p_auth_id,p_email,p_product,counter_name,p_operation,p_unlimited);
    if not (result->>'allowed')::boolean then return result; end if;
    select * into u from public.users where id=u.id;
    update public.zentra_requests set state='running',attempts=attempts+1,lease_until=now()+interval '5 minutes',lease_token=gen_random_uuid(),provider_started_at=null,useful_response=false,response=null
      where user_id=u.id and operation_key=p_operation and request_hash=p_hash returning * into r;
    return jsonb_build_object('allowed',true,'user',to_jsonb(u),'paid_counters',paid,'lease_token',r.lease_token);
  end if;
  select count(*) into n from public.zentra_requests where user_id=u.id and operation_key=p_operation;
  if n>0 and p_kind='chat' and not exists(select 1 from public.zentra_chat_steps
    where user_id=u.id and operation_key=p_operation and request_hash=p_hash) then
    return jsonb_build_object('allowed',false,'reason','unauthorized_refinement'); end if;
  if n>0 and p_kind='audit' and not exists(select 1 from public.zentra_audit_steps
    where user_id=u.id and operation_key=p_operation and request_hash=p_hash) then
    return jsonb_build_object('allowed',false,'reason','unauthorized_refinement'); end if;
  if n >= (case when p_kind='audit' then 3 else 9 end)
    or (n>0 and root.created_at < now()-interval '30 minutes') then
    return jsonb_build_object('allowed',false,'reason','retry_limit'); end if;
  -- Subsequent phases use the original receipt, including the final purchased credit.
  result := public.zentra_consume(p_auth_id,p_email,p_product,counter_name,p_operation,p_unlimited);
  if not (result->>'allowed')::boolean then return result; end if;
  insert into public.zentra_requests(user_id,operation_key,source_hash,request_hash,kind)
    values(u.id,p_operation,p_source,p_hash,p_kind) returning * into r;
  if p_kind='audit' and to_regclass('public.zentra_audit_acquisitions') is not null then
    update public.zentra_audit_acquisitions set state='done' where user_id=u.id and operation_key=p_operation;
  end if;
  select * into u from public.users where id=u.id;
  return jsonb_build_object('allowed',true,'user',to_jsonb(u),'paid_counters',paid,'lease_token',r.lease_token);
end $$;

alter table public.zentra_usage_receipts enable row level security;
alter table public.zentra_requests enable row level security;
alter table public.zentra_payment_receipts enable row level security;
alter table public.zentra_chat_steps enable row level security;
alter table public.zentra_audit_steps enable row level security;
revoke all on public.zentra_audit_steps from public,anon,authenticated;
grant all on public.zentra_audit_steps to service_role;
revoke all on function public.zentra_read_audit_steps(text,text,text,text) from public,anon,authenticated;
revoke all on function public.zentra_register_audit_step(text,text,text,text,text,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.zentra_read_audit_steps(text,text,text,text) to service_role;
grant execute on function public.zentra_register_audit_step(text,text,text,text,text,text,jsonb,jsonb) to service_role;
revoke all on public.zentra_chat_steps from public,anon,authenticated;
grant all on public.zentra_chat_steps to service_role;
revoke all on function public.zentra_read_chat_steps(text,text,text,text) from public,anon,authenticated;
revoke all on function public.zentra_register_chat_step(text,text,text,text,text,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.zentra_read_chat_steps(text,text,text,text) to service_role;
grant execute on function public.zentra_register_chat_step(text,text,text,text,text,text,jsonb,jsonb) to service_role;
revoke all on public.zentra_payment_receipts from public,anon,authenticated;
grant all on public.zentra_payment_receipts to service_role;
revoke all on public.zentra_usage_receipts,public.zentra_requests from public,anon,authenticated;
grant all on public.zentra_usage_receipts,public.zentra_requests to service_role;
revoke all on function public.zentra_access(text,text,text) from public,anon,authenticated;
revoke all on function public.zentra_consume(text,text,text,text,text,boolean) from public,anon,authenticated;
revoke all on function public.zentra_begin_request(text,text,text,text,text,text,text,boolean,uuid) from public,anon,authenticated;
grant execute on function public.zentra_access(text,text,text) to service_role;
grant execute on function public.zentra_consume(text,text,text,text,text,boolean) to service_role;
grant execute on function public.zentra_begin_request(text,text,text,text,text,text,text,boolean,uuid) to service_role;
revoke all on function public.zentra_refund_failed(uuid,text) from public,anon,authenticated;
revoke all on function public.zentra_finish_request(uuid,text,text,uuid,jsonb,boolean) from public,anon,authenticated;
revoke all on function public.zentra_renew_request(uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.zentra_refund_failed(uuid,text) to service_role;
grant execute on function public.zentra_finish_request(uuid,text,text,uuid,jsonb,boolean) to service_role;
grant execute on function public.zentra_renew_request(uuid,text,text,uuid) to service_role;
revoke all on function public.zentra_consume_generation(text,text,text,text,text,text,uuid,boolean) from public,anon,authenticated;
grant execute on function public.zentra_consume_generation(text,text,text,text,text,text,uuid,boolean) to service_role;
revoke all on function public.zentra_apply_payment(text,text,text,text,text,timestamptz,timestamptz,timestamptz,integer,integer,jsonb) from public,anon,authenticated;
grant execute on function public.zentra_apply_payment(text,text,text,text,text,timestamptz,timestamptz,timestamptz,integer,integer,jsonb) to service_role;
-- Only the backend and the existing service-role Partner Admin can access billing rows.
alter table public.users enable row level security;
revoke all on public.users from public,anon,authenticated;
grant all on public.users to service_role;
commit;
