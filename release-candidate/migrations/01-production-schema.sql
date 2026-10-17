-- MANUAL ONLY. Production project must be verified as ohakwaihhuenpensoedh.
-- Atomic bootstrap for the legacy users-only baseline; never replay over unknown wrappers.
-- No account backfill, paid association, counter conversion/reset or audio schema.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
do $rc_install$
declare applied text; hashes jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('zentra-ai-v1.0.3-schema',0));
  if to_regclass('public.zentra_ai_schema_releases') is not null then
    execute 'select release_id,function_hashes from public.zentra_ai_schema_releases where release_id=$1'
      into applied,hashes using 'v1.0.3-production-schema-1';
    if applied is not null then
      if hashes is null or exists(select 1 from jsonb_each_text(hashes) h where not exists(
        select 1 from pg_proc p where p.oid=to_regprocedure(h.key) and md5(p.prosrc)=h.value
          and p.prosecdef and not has_function_privilege('anon',p.oid,'EXECUTE')
          and not has_function_privilege('authenticated',p.oid,'EXECUTE'))) then
        raise exception 'Applied RPC definitions/grants have drifted; do not replay migration';
      end if;
      if exists(select 1 from unnest(array['zentra_payment_receipts','zentra_usage_receipts','zentra_requests','zentra_chat_steps','zentra_audit_steps','zentra_search_requests','zentra_audit_acquisitions','zentra_audit_search_budgets','zentra_search_allocations','zentra_http_rate_buckets','zentra_lemon_customers','zentra_lemon_checkouts','zentra_lemon_subscriptions','zentra_lemon_events','zentra_free_launch_config','zentra_free_access','zentra_free_receipts']) n
          where to_regclass('public.'||n) is null)
        or exists(select 1 from unnest(array['zentra_refund_failed','zentra_finish_request','zentra_renew_request','zentra_access','zentra_read_chat_steps','zentra_register_chat_step','zentra_read_audit_steps','zentra_register_audit_step','zentra_apply_payment','zentra_consume','zentra_consume_generation','zentra_begin_request','zentra_start_provider','zentra_checkpoint_response','zentra_begin_search','zentra_start_search','zentra_finish_search','zentra_renew_search','zentra_handoff_audit','zentra_acquire_audit','zentra_release_audit','zentra_reserve_search_budget','zentra_settle_search_budget','zentra_http_rate_limit','zentra_release_executive_premium','zentra_executive_phase','zentra_resume_executive','zentra_reap_search_leases','zentra_lemon_checkout','zentra_lemon_event','zentra_lemon_event_seen','zentra_lemon_sync_claim','zentra_lemon_sync_finish','zentra_access_before_lemon','zentra_free_status','zentra_free_notify','zentra_track_free_receipt']) n
          where not exists(select 1 from pg_proc p join pg_namespace s on s.oid=p.pronamespace
            where s.nspname='public' and p.proname=n)) then
        raise exception 'Applied schema has missing objects; inspect catalog before repair';
      end if;
      return;
    end if;
  end if;
  if to_regclass('public.users') is null then raise exception 'Expected legacy public.users baseline is missing'; end if;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname like 'zentra\_%' escape '\')
    or exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind in ('r','p')
      and c.relname like 'zentra\_%' escape '\' and c.relname<>'zentra_ai_schema_releases') then
    raise exception 'Partial/unknown Zentra schema: stop; use 00-required-catalog.sql to prepare only the missing delta';
  end if;
  if exists(select 1 from (values ('id','uuid'),('email','text'),('plan','text'),
      ('plan_type','text'),('status','text'),('updated_at','timestamp with time zone')) expected(col,typ)
      where not exists(select 1 from information_schema.columns c where c.table_schema='public'
        and c.table_name='users' and c.column_name=expected.col and c.data_type=expected.typ)) then
    raise exception 'Legacy users identity/types differ; inspect catalog, do not coerce';
  end if;
  if exists(select 1 from pg_constraint where conrelid='public.users'::regclass and conname='users_email_key') then
    raise exception 'Legacy global email uniqueness requires a reviewed schema delta; no automatic drop';
  end if;
  lock table public.users in share row exclusive mode;
  alter table public.users
    add column if not exists auth_user_id text,
    add column if not exists audit_credits integer not null default 0,
    add column if not exists audit_credits_used integer not null default 0,
    add column if not exists actions_used integer not null default 0,
    add column if not exists audits_used integer not null default 0,
    add column if not exists premium_chat_used integer not null default 0,
    add column if not exists premium_pdf_used integer not null default 0,
    add column if not exists extra_actions_balance integer not null default 0,
    add column if not exists extra_audits_balance integer not null default 0,
    add column if not exists extra_actions_used_cycle integer not null default 0,
    add column if not exists extra_audits_used_cycle integer not null default 0,
    add column if not exists extra_actions_purchased_total integer not null default 0,
    add column if not exists extra_audits_purchased_total integer not null default 0,
    add column if not exists purchase_history jsonb not null default '[]'::jsonb,
    add column if not exists billing_cycle_start bigint not null default (floor(extract(epoch from now())*1000))::bigint;
  if exists(select 1 from public.users where auth_user_id is not null
      group by auth_user_id,plan_type having count(*)>1)
    or exists(select 1 from public.users group by email,plan_type having count(*)>1) then
    raise exception 'Duplicate identity groups; no account merge is performed';
  end if;
  if exists(select 1 from public.users u where exists(
      select 1 from jsonb_each(to_jsonb(u)) v where v.key in
        ('actions_used','audits_used','premium_chat_used','premium_pdf_used','audit_credits','audit_credits_used',
         'extra_actions_balance','extra_audits_balance','extra_actions_used_cycle','extra_audits_used_cycle',
         'extra_actions_purchased_total','extra_audits_purchased_total')
        and (jsonb_typeof(v.value)<>'number' or (v.value::text)::numeric<0))) then
    raise exception 'Invalid legacy counters; no automatic correction/reset';
  end if;
  create index if not exists users_email_idx on public.users(email);
  create unique index if not exists users_email_plan_type_key on public.users(email,plan_type);
  create index if not exists users_auth_user_id_idx on public.users(auth_user_id);
  create unique index if not exists users_auth_user_plan_type_key on public.users(auth_user_id,plan_type);
  -- Approved dependency: supabase-release-guard.sql; no staging account/audio data.
  execute $rc_module_0$
-- Apply after supabase-users.sql. Server-only: never expose these RPCs to clients.

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
  if p_unlimited is distinct from false then raise exception 'Unlimited test mode is forbidden in production'; end if;
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
  if p_unlimited is distinct from false then raise exception 'Unlimited test mode is forbidden in production'; end if;
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
  if p_unlimited is distinct from false then raise exception 'Unlimited test mode is forbidden in production'; end if;
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

$rc_module_0$;

  -- Approved dependency: supabase-execution-guard.sql; no staging account/audio data.
  execute $rc_module_1$
-- Apply after supabase-release-guard.sql. All RPCs are server-only.

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
  if p_unlimited is distinct from false then raise exception 'Unlimited test mode is forbidden in production'; end if;
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

$rc_module_1$;

  -- Approved dependency: supabase-http-rate.sql; no staging account/audio data.
  execute $rc_module_2$
-- Independent HTTP defense; does not change quota, requests or lease migrations.
create table if not exists public.zentra_http_rate_buckets (
  subject text not null,
  category text not null check (category in ('generation','audio','search','audit','consume','read')),
  count integer not null default 0 check (count >= 0),
  expires_at timestamptz not null,
  primary key (subject, category)
);
alter table public.zentra_http_rate_buckets enable row level security;
revoke all on public.zentra_http_rate_buckets from public, anon, authenticated;
grant all on public.zentra_http_rate_buckets to service_role;

create or replace function public.zentra_http_rate_limit(p_subject text, p_category text, p_maximum integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_now timestamptz := clock_timestamp();
  bucket public.zentra_http_rate_buckets;
begin
  if p_subject is null or length(p_subject) not between 1 and 128
    or p_category is null or p_category not in ('generation','audio','search','audit','consume','read')
    or p_maximum is null or p_maximum not between 1 and 100000 then
    raise exception 'Invalid HTTP rate policy';
  end if;
  insert into public.zentra_http_rate_buckets as existing (subject, category, count, expires_at)
    values (p_subject, p_category, 1, v_now + interval '60 seconds')
  on conflict (subject, category) do update set
    count = case when existing.expires_at <= v_now then 1 else least(existing.count + 1, p_maximum + 1) end,
    expires_at = case when existing.expires_at <= v_now then v_now + interval '60 seconds' else existing.expires_at end
  returning * into bucket;
  return jsonb_build_object('allowed', bucket.count <= p_maximum,
    'retry_after', greatest(1, ceil(extract(epoch from bucket.expires_at - v_now)))::integer);
end $$;
revoke all on function public.zentra_http_rate_limit(text,text,integer) from public, anon, authenticated;
grant execute on function public.zentra_http_rate_limit(text,text,integer) to service_role;

$rc_module_2$;

  -- Approved dependency: supabase-premium-reasoning.sql; no staging account/audio data.
  execute $rc_module_3$
-- Apply after supabase-executive-refiner.sql. Extend the existing shared entitlement RPC.

create or replace function public.zentra_release_executive_premium(
  p_user uuid,p_operation text,p_hash text,p_lease uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u public.users; receipt public.zentra_usage_receipts; stage text;
begin
  select * into u from public.users where id=p_user for update;
  if not found then return jsonb_build_object('accepted',false,'reason','stale_lease'); end if;
  select s.step_name into stage
    from public.zentra_requests r join public.zentra_audit_steps s
      on s.user_id=r.user_id and s.operation_key=r.operation_key and s.request_hash=r.request_hash
    where r.user_id=p_user and r.operation_key=p_operation and r.request_hash=p_hash
      and r.lease_token=p_lease and r.state='running' and r.kind='audit'
      and (r.lease_until>now() or r.provider_started_at is not null)
      and s.step_name in ('premium_reasoning_audit','executive_refiner_pdf');
  if not found then return jsonb_build_object('accepted',false,'reason','stale_lease'); end if;
  -- A failed reasoning worker must not refund a downstream executive execution.
  if stage='premium_reasoning_audit' and exists (
    select 1 from public.zentra_requests r join public.zentra_audit_steps s
      on s.user_id=r.user_id and s.operation_key=r.operation_key and s.request_hash=r.request_hash
    where r.user_id=p_user and r.operation_key=p_operation
      and s.step_name='executive_refiner_pdf' and r.state in ('running','done')
  ) then return jsonb_build_object('accepted',false,'reason','downstream_premium_owned'); end if;
  select * into receipt from public.zentra_usage_receipts where user_id=p_user
    and operation_key=p_operation and counter='premium_pdf_used' for update;
  if not found or receipt.refunded_at is not null or receipt.funding='legacy' then
    return jsonb_build_object('accepted',true,'released',false);
  end if;
  if receipt.funding='base' and u.billing_cycle_start=receipt.billing_cycle then
    update public.users set premium_pdf_used=greatest(0,premium_pdf_used-1) where id=p_user;
  end if;
  update public.zentra_usage_receipts set refunded_at=now() where user_id=p_user
    and operation_key=p_operation and counter='premium_pdf_used';
  return jsonb_build_object('accepted',true,'released',true);
end $$;
revoke all on function public.zentra_release_executive_premium(uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.zentra_release_executive_premium(uuid,text,text,uuid) to service_role;

$rc_module_3$;

  -- Approved dependency: supabase-executive-recovery.sql; no staging account/audio data.
  execute $rc_module_4$
-- Apply after premium-reasoning. Uses the existing executive stage context,
-- not a new product operation or receipt. Server-only RPCs.

create or replace function public.zentra_executive_phase(
  p_user uuid,p_operation text,p_hash text,p_lease uuid,p_phase text,p_result jsonb
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.zentra_requests; s public.zentra_audit_steps; journal jsonb; entry jsonb;
begin
  if p_phase not in ('sol','recovery') then raise exception 'Invalid executive phase'; end if;
  perform 1 from public.users where id=p_user for update;
  select * into r from public.zentra_requests where user_id=p_user and operation_key=p_operation
    and request_hash=p_hash for update;
  if not found or r.state<>'running' or r.lease_token is distinct from p_lease
    or (r.lease_until<=now() and r.provider_started_at is null) then
    return jsonb_build_object('accepted',false); end if;
  select * into s from public.zentra_audit_steps where user_id=p_user and operation_key=p_operation
    and request_hash=p_hash and step_name='executive_refiner_pdf' for update;
  if not found then return jsonb_build_object('accepted',false); end if;
  journal:=coalesce(s.context->'executiveRecovery','{}'::jsonb);
  entry:=journal->p_phase;
  if entry->>'state'='done' then
    return jsonb_build_object('accepted',true,'cached',true,'result',entry->'result'); end if;
  if p_result is null then
    if entry is not null or (p_phase='recovery' and (journal->'sol'->>'state') is distinct from 'done') then
      return jsonb_build_object('accepted',false); end if;
    entry:=jsonb_build_object('state','started','lease',p_lease);
    update public.zentra_requests set provider_started_at=now(),lease_until=now()+interval '5 minutes'
      where user_id=p_user and operation_key=p_operation and request_hash=p_hash;
  else
    if (entry->>'state') is distinct from 'started' or (entry->>'lease') is distinct from p_lease::text
      or jsonb_typeof(p_result)<>'object' or length(p_result::text)>262144 then
      return jsonb_build_object('accepted',false); end if;
    entry:=jsonb_build_object('state','done','result',p_result);
    -- Provider result is durable. A restart can reclaim this boundary without replaying it.
    update public.zentra_requests set provider_started_at=null,lease_until=now()+interval '5 minutes'
      where user_id=p_user and operation_key=p_operation and request_hash=p_hash;
  end if;
  update public.zentra_audit_steps set context=jsonb_set(coalesce(context,'{}'::jsonb),
    '{executiveRecovery}',jsonb_set(journal,array[p_phase],entry,true),true)
    where user_id=p_user and operation_key=p_operation and request_hash=p_hash;
  return jsonb_build_object('accepted',true,'cached',false);
end $$;

create or replace function public.zentra_resume_executive(
  p_auth_id text,p_email text,p_product text,p_operation text,p_hash text
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare u public.users; r public.zentra_requests; s public.zentra_audit_steps; journal jsonb; phase text;
begin
  u:=public.zentra_access(p_auth_id,p_email,p_product);
  select * into r from public.zentra_requests where user_id=u.id and operation_key=p_operation
    and request_hash=p_hash for update;
  if not found or r.state<>'running' or r.lease_until>now() then return false; end if;
  select * into s from public.zentra_audit_steps where user_id=u.id and operation_key=p_operation
    and request_hash=p_hash and step_name='executive_refiner_pdf' for update;
  if not found or s.context->'executiveRecovery' is null then return false; end if;
  journal:=s.context->'executiveRecovery';
  foreach phase in array array['sol','recovery'] loop
    if journal->phase->>'state'='started' then
      -- No provider retry: uncertainty is terminal for this phase, not zero-cost execution.
      journal:=jsonb_set(journal,array[phase],jsonb_build_object('state','done','result',
        jsonb_build_object('ok',false,'status',502,'provider','openai','api','responses',
          'execution_uncertain',true,'data',jsonb_build_object('status','failed','output_text',''))));
    end if;
  end loop;
  update public.zentra_audit_steps set context=jsonb_set(context,'{executiveRecovery}',journal)
    where user_id=u.id and operation_key=p_operation and request_hash=p_hash;
  update public.zentra_requests set provider_started_at=null
    where user_id=u.id and operation_key=p_operation and request_hash=p_hash;
  return true;
end $$;
revoke all on function public.zentra_executive_phase(uuid,text,text,uuid,text,jsonb),
  public.zentra_resume_executive(text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.zentra_executive_phase(uuid,text,text,uuid,text,jsonb),
  public.zentra_resume_executive(text,text,text,text,text) to service_role;

$rc_module_4$;

  -- Approved dependency: supabase-search-lifecycle.sql; no staging account/audio data.
  execute $rc_module_5$
-- Apply after supabase-execution-guard.sql, STAGING first. Does not change usage/entitlements.

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

$rc_module_5$;

  -- Approved dependency: supabase-lemon.sql; no staging account/audio data.
  execute $rc_module_6$
-- Apply after users, release guard and execution guard. Local/staging only.

alter table public.users
  add column if not exists lemon_store_id text,
  add column if not exists lemon_customer_id text,
  add column if not exists lemon_variant_id text,
  add column if not exists lemon_product_id text,
  add column if not exists billing_interval text,
  add column if not exists billing_pause_mode text,
  add column if not exists subscription_trial_ends_at timestamptz;

create table if not exists public.zentra_lemon_customers (
  store_id text not null, customer_id text not null, auth_user_id text not null,
  primary key(store_id,customer_id)
);
create table if not exists public.zentra_lemon_checkouts (
  token_hash text primary key check(token_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid not null references public.users(id), auth_user_id text not null,
  store_id text not null, variant_id text not null, product_id text not null,
  family text not null check(family in ('subscription','audit','extra')),
  plan text not null check(plan in ('starter','pro','agency')),
  billing_interval text check(billing_interval in ('month','year')),
  created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '24 hours',
  resource_id text
);
create table if not exists public.zentra_lemon_subscriptions (
  store_id text not null, subscription_id text not null,
  user_id uuid not null references public.users(id), customer_id text not null,
  updated_at timestamptz not null, primary key(store_id,subscription_id)
);
create table if not exists public.zentra_lemon_events (
  event_key text primary key check(event_key ~ '^[a-f0-9]{64}$'),
  event_name text not null, resource_type text not null, resource_id text not null,
  store_id text not null, user_id uuid references public.users(id),
  provider_updated_at timestamptz not null, outcome text not null,
  metadata jsonb not null default '{}', received_at timestamptz not null default now()
);
alter table public.zentra_lemon_subscriptions
  add column if not exists checked_at timestamptz not null default now(),
  add column if not exists sync_until timestamptz,
  add column if not exists sync_token uuid;

alter table public.zentra_lemon_customers enable row level security;
alter table public.zentra_lemon_checkouts enable row level security;
alter table public.zentra_lemon_subscriptions enable row level security;
alter table public.zentra_lemon_events enable row level security;
revoke all on public.zentra_lemon_customers,public.zentra_lemon_checkouts,
  public.zentra_lemon_subscriptions,public.zentra_lemon_events from public,anon,authenticated;
grant all on public.zentra_lemon_customers,public.zentra_lemon_checkouts,
  public.zentra_lemon_subscriptions,public.zentra_lemon_events to service_role;

-- Preserve the closed reservation/reset/lease implementation verbatim; only
-- wrap its returned account with billing-date enforcement in the same transaction.
do $$ begin
  if to_regprocedure('public.zentra_access_before_lemon(text,text,text)') is null then
    alter function public.zentra_access(text,text,text) rename to zentra_access_before_lemon;
  end if;
end $$;
create or replace function public.zentra_access(p_auth_id text,p_email text,p_product text)
returns public.users language plpgsql security definer set search_path=public,pg_temp as $$
declare u public.users;
begin
  u := public.zentra_access_before_lemon(p_auth_id,p_email,p_product);
  if u.plan_type='subscription' and (
    u.billing_status in ('expired','unpaid')
    or (u.billing_status='paused' and u.billing_pause_mode='void')
    or (u.billing_status='cancelled' and u.subscription_ends_at<=now())
    or (u.billing_status='on_trial' and u.subscription_trial_ends_at<=now())
  ) and u.status<>'cancelled' then
    update public.users set status='cancelled',updated_at=now() where id=u.id returning * into u;
  end if;
  return u;
end $$;

create or replace function public.zentra_lemon_checkout(
  p_auth text,p_email text,p_hash text,p_store text,p_variant text,p_product text,
  p_family text,p_plan text,p_interval text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u public.users;
begin
  if p_store !~ '^\d+$' or p_variant !~ '^\d+$' or p_product !~ '^\d+$'
    or p_family not in ('subscription','audit','extra') or p_plan not in ('starter','pro','agency')
    or (p_family='subscription' and coalesce(p_interval,'') not in ('month','year'))
    then raise exception 'Invalid checkout configuration'; end if;
  u := public.zentra_access(p_auth,p_email,case when p_family='audit' then 'audit' else 'subscription' end);
  if p_family='extra' and (u.plan<>'agency' or u.status<>'active') then raise exception 'Agency required'; end if;
  insert into public.zentra_lemon_checkouts(token_hash,user_id,auth_user_id,store_id,variant_id,product_id,family,plan,billing_interval)
    values(p_hash,u.id,p_auth,p_store,p_variant,p_product,p_family,p_plan,p_interval);
  return jsonb_build_object('created',true);
end $$;

create or replace function public.zentra_lemon_event(
  p_key text,p_event text,p_type text,p_resource text,p_binding text,p_item jsonb
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  u public.users; checkout public.zentra_lemon_checkouts; sub public.zentra_lemon_subscriptions;
  owner_auth text; customer_auth text; changed timestamptz := (p_item->>'updated_at')::timestamptz;
  store text := p_item->>'store'; customer text := p_item->>'customer'; subscription text := p_item->>'subscription';
  provider_status text := p_item->>'status'; ends timestamptz := (p_item->>'ends_at')::timestamptz;
  trial_ends timestamptz := (p_item->>'trial_ends_at')::timestamptz;
  effective text; pending boolean := false; outcome text := 'applied'; target_user uuid; result jsonb;
  is_subscription boolean := p_type='subscriptions' or p_event in ('subscription_payment_success','subscription_payment_failed','subscription_payment_recovered');
  bound_resource text;
  same_version_conflict boolean := false;
begin
  if p_key is null or p_key !~ '^[a-f0-9]{64}$' or p_resource is null or p_resource !~ '^\d+$'
    or store is null or store !~ '^\d+$' or changed is null then raise exception 'Invalid event'; end if;
  -- A transaction-scoped lock, not process memory. Receipt and transition commit together.
  perform pg_advisory_xact_lock(hashtextextended('lemon-event:'||p_key,0));
  if exists(select 1 from public.zentra_lemon_events where event_key=p_key) then
    -- Some provider timestamps have only second precision. A contradictory
    -- same-version delivery never wins by arrival order; request a canonical read.
    if is_subscription then
      update public.zentra_lemon_subscriptions s set checked_at=now()-interval '5 minutes'
        from public.users account where s.user_id=account.id and s.store_id=store and s.subscription_id=subscription
        and account.billing_updated_at=changed and (account.billing_status is distinct from provider_status
          or account.lemon_variant_id is distinct from p_item->>'variant'
          or account.subscription_ends_at is distinct from ends
          or account.subscription_trial_ends_at is distinct from trial_ends
          or account.billing_pause_mode is distinct from p_item->>'pause_mode');
    end if;
    return jsonb_build_object('duplicate',true); end if;

  if p_event in ('order_refunded','subscription_payment_refunded') then
    if p_type<>(case when p_event='order_refunded' then 'orders' else 'subscription-invoices' end) then
      raise exception 'Invalid refund resource'; end if;
    select user_id into target_user from public.zentra_lemon_subscriptions
      where store_id=store and subscription_id=subscription;
    insert into public.zentra_lemon_events(event_key,event_name,resource_type,resource_id,store_id,user_id,provider_updated_at,outcome,metadata)
      values(p_key,p_event,p_type,p_resource,store,target_user,changed,'refund_review',
        jsonb_build_object('order_id',p_item->>'order','subscription_id',subscription,
          'refunded_amount',p_item->'refunded_amount','refunded',p_item->'refunded'));
    return jsonb_build_object('duplicate',false,'refund_review',true);
  end if;
  bound_resource := case when is_subscription then subscription else p_resource end;
  if is_subscription then
    if (p_type='subscriptions' and (p_event not in ('subscription_created','subscription_updated','subscription_cancelled','subscription_expired',
      'subscription_resumed','subscription_paused','subscription_unpaused') or subscription<>p_resource))
      or (p_type<>'subscriptions' and (p_type<>'subscription-invoices' or p_event not in ('subscription_payment_success','subscription_payment_failed','subscription_payment_recovered')))
      then raise exception 'Invalid subscription event'; end if;
    select * into sub from public.zentra_lemon_subscriptions where store_id=store and subscription_id=subscription;
    if found then
      target_user := sub.user_id;
      if sub.customer_id<>customer then raise exception 'Customer conflict'; end if;
      select auth_user_id into owner_auth from public.users where id=target_user;
    end if;
  elsif p_type='orders' and p_event='order_created' then
    if p_item->>'family' not in ('audit','extra') then raise exception 'Invalid order family'; end if;
  else raise exception 'Invalid event type'; end if;

  if p_binding is not null then
    select * into checkout from public.zentra_lemon_checkouts where token_hash=p_binding for update;
    if not found or checkout.store_id<>store then raise exception 'Unverified checkout'; end if;
    if target_user is not null and checkout.user_id<>target_user then raise exception 'Subscription owner conflict'; end if;
    if checkout.resource_id is not null and checkout.resource_id<>bound_resource then raise exception 'Checkout already bound'; end if;
    if target_user is null then
      if checkout.variant_id<>p_item->>'variant' or checkout.product_id<>p_item->>'product'
        or checkout.family<>(case when is_subscription then 'subscription' else p_item->>'family' end)
        or (p_item->>'created_at')::timestamptz < checkout.created_at-interval '5 minutes'
        or (p_item->>'created_at')::timestamptz > checkout.expires_at
        then raise exception 'Checkout identity conflict'; end if;
      target_user := checkout.user_id; owner_auth := checkout.auth_user_id;
    end if;
  end if;
  if target_user is null or owner_auth is null or customer is null or customer !~ '^\d+$' then
    raise exception 'Subscription requires verified association'; end if;
  insert into public.zentra_lemon_customers(store_id,customer_id,auth_user_id) values(store,customer,owner_auth)
    on conflict(store_id,customer_id) do nothing;
  select auth_user_id into customer_auth from public.zentra_lemon_customers
    where store_id=store and customer_id=customer for update;
  if customer_auth<>owner_auth then raise exception 'Customer owner conflict'; end if;
  select * into u from public.users where id=target_user for update;
  if u.auth_user_id<>owner_auth then raise exception 'Account owner conflict'; end if;

  if is_subscription then
    if p_item->>'plan' not in ('starter','pro','agency') or p_item->>'interval' not in ('month','year')
      then raise exception 'Invalid subscription mapping'; end if;
    if sub.user_id is not null and u.lemon_subscription_id is not null and u.lemon_subscription_id<>subscription then
      outcome := 'stale';
    elsif u.lemon_subscription_id is not null and u.lemon_subscription_id<>subscription and u.status='active' and u.plan<>'free' then
      raise exception 'Another subscription is still active'; end if;
    same_version_conflict := changed=u.billing_updated_at and (
      u.billing_status is distinct from provider_status or u.lemon_variant_id is distinct from p_item->>'variant'
      or u.subscription_ends_at is distinct from ends or u.subscription_trial_ends_at is distinct from trial_ends
      or u.billing_pause_mode is distinct from p_item->>'pause_mode');
    if outcome='stale' then null;
    elsif sub.updated_at is not null and (changed<sub.updated_at or (changed=sub.updated_at and coalesce((p_item->>'authoritative_api')::boolean,false)=false)) then outcome := 'stale';
    elsif u.lemon_subscription_id=subscription and u.billing_updated_at is not null and (changed<u.billing_updated_at
      or (changed=u.billing_updated_at and coalesce((p_item->>'authoritative_api')::boolean,false)=false)) then outcome := 'stale';
    else
      effective := case
        when provider_status='active' then 'active'
        when provider_status='on_trial' and trial_ends is not null then case when trial_ends>now() then 'active' else 'cancelled' end
        when provider_status in ('expired','unpaid') then 'cancelled'
        when provider_status='cancelled' and ends is not null then case when ends>now() then 'active' else 'cancelled' end
        when provider_status='paused' and p_item->>'pause_mode'='free' then 'active'
        when provider_status='paused' and p_item->>'pause_mode'='void' then 'cancelled'
        else u.status end;
      pending := provider_status not in ('active','on_trial','expired','unpaid','cancelled','past_due','paused')
        or (provider_status='cancelled' and ends is null) or (provider_status='on_trial' and trial_ends is null)
        or (provider_status='paused' and coalesce(p_item->>'pause_mode','') not in ('free','void'));
      update public.users set
        plan=case when pending or provider_status='past_due' then u.plan else p_item->>'plan' end,
        status=effective,billing_status=provider_status,billing_policy_pending=pending,
        lemon_subscription_id=subscription,lemon_store_id=store,lemon_customer_id=customer,
        lemon_variant_id=p_item->>'variant',lemon_product_id=p_item->>'product',billing_interval=p_item->>'interval',
        billing_pause_mode=p_item->>'pause_mode',subscription_trial_ends_at=trial_ends,
        subscription_ends_at=ends,subscription_renews_at=(p_item->>'renews_at')::timestamptz,
        billing_updated_at=changed,updated_at=now() where id=u.id;
      insert into public.zentra_lemon_subscriptions(store_id,subscription_id,user_id,customer_id,updated_at)
        values(store,subscription,u.id,customer,changed) on conflict(store_id,subscription_id)
        do update set updated_at=excluded.updated_at,checked_at=now();
    end if;
    if outcome='stale' and same_version_conflict then
      update public.zentra_lemon_subscriptions set checked_at=now()-interval '5 minutes'
        where store_id=store and subscription_id=subscription;
    end if;
  else
    result := public.zentra_apply_payment(u.email,p_item->>'family',p_item->>'plan',p_resource,'paid',null,null,changed,
      coalesce((p_item->>'actions')::integer,0),coalesce((p_item->>'audits')::integer,0),jsonb_build_object('lemonOrderId',p_resource));
    if (result->>'duplicate')::boolean then outcome := 'duplicate_order'; end if;
  end if;
  if p_binding is not null then update public.zentra_lemon_checkouts set resource_id=bound_resource where token_hash=p_binding; end if;
  insert into public.zentra_lemon_events(event_key,event_name,resource_type,resource_id,store_id,user_id,provider_updated_at,outcome)
    values(p_key,p_event,p_type,p_resource,store,target_user,changed,outcome);
  return jsonb_build_object('duplicate',outcome in ('stale','duplicate_order'),'ignored',outcome='stale','outcome',outcome);
end $$;
create or replace function public.zentra_lemon_event_seen(p_key text)
returns boolean language sql security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.zentra_lemon_events where event_key=p_key);
$$;

-- Lost webhooks are reconciled on authenticated access, at most once per five
-- minutes per subscription, across processes. No background/global polling.
create or replace function public.zentra_lemon_sync_claim(p_auth text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u public.users; s public.zentra_lemon_subscriptions; token uuid := gen_random_uuid();
begin
  select * into u from public.users where auth_user_id=p_auth and plan_type='subscription' for update;
  if not found then return null; end if;
  select * into s from public.zentra_lemon_subscriptions
    where store_id=u.lemon_store_id and subscription_id=u.lemon_subscription_id for update;
  if not found or s.user_id<>u.id then
    if u.plan<>'free' then return jsonb_build_object('unverified',true); end if;
    return null;
  end if;
  if s.checked_at>now()-interval '5 minutes' then return null; end if;
  if s.sync_until>now() then return jsonb_build_object('busy',true); end if;
  update public.zentra_lemon_subscriptions set sync_token=token,sync_until=now()+interval '30 seconds'
    where store_id=s.store_id and subscription_id=s.subscription_id;
  return jsonb_build_object('store',s.store_id,'subscription',s.subscription_id,'customer',s.customer_id,'token',token);
end $$;
create or replace function public.zentra_lemon_sync_finish(p_store text,p_subscription text,p_token uuid,p_success boolean)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare updated integer;
begin
  update public.zentra_lemon_subscriptions set sync_token=null,sync_until=null,
    checked_at=case when p_success then now() else checked_at end
    where store_id=p_store and subscription_id=p_subscription and sync_token=p_token;
  get diagnostics updated=row_count; return updated=1;
end $$;

-- Retire the legacy email-only SaaS mutation; one-time order credit accounting
-- stays unchanged and is called only after the verified checkout association.
do $$ begin
  if to_regprocedure('public.zentra_apply_payment_before_lemon(text,text,text,text,text,timestamptz,timestamptz,timestamptz,integer,integer,jsonb)') is null then
    alter function public.zentra_apply_payment(text,text,text,text,text,timestamptz,timestamptz,timestamptz,integer,integer,jsonb)
      rename to zentra_apply_payment_before_lemon;
  end if;
end $$;
create or replace function public.zentra_apply_payment(
  p_email text,p_product text,p_plan text,p_id text,p_status text,p_ends timestamptz,p_renews timestamptz,
  p_changed timestamptz,p_actions integer,p_audits integer,p_history jsonb
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if p_product='subscription' then raise exception 'Verified Lemon association required'; end if;
  return public.zentra_apply_payment_before_lemon(p_email,p_product,p_plan,p_id,p_status,p_ends,p_renews,p_changed,p_actions,p_audits,p_history);
end $$;

revoke all on function public.zentra_access_before_lemon(text,text,text) from public,anon,authenticated,service_role;
revoke all on function public.zentra_access(text,text,text) from public,anon,authenticated;
grant execute on function public.zentra_access(text,text,text) to service_role;
revoke all on function public.zentra_lemon_checkout(text,text,text,text,text,text,text,text,text) from public,anon,authenticated;
revoke all on function public.zentra_lemon_event(text,text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.zentra_lemon_checkout(text,text,text,text,text,text,text,text,text) to service_role;
grant execute on function public.zentra_lemon_event(text,text,text,text,text,jsonb) to service_role;
revoke all on function public.zentra_apply_payment_before_lemon(text,text,text,text,text,timestamptz,timestamptz,timestamptz,integer,integer,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.zentra_apply_payment(text,text,text,text,text,timestamptz,timestamptz,timestamptz,integer,integer,jsonb) from public,anon,authenticated;
grant execute on function public.zentra_apply_payment(text,text,text,text,text,timestamptz,timestamptz,timestamptz,integer,integer,jsonb) to service_role;
revoke all on function public.zentra_lemon_sync_claim(text) from public,anon,authenticated;
revoke all on function public.zentra_lemon_sync_finish(text,text,uuid,boolean) from public,anon,authenticated;
grant execute on function public.zentra_lemon_sync_claim(text) to service_role;
grant execute on function public.zentra_lemon_sync_finish(text,text,uuid,boolean) to service_role;
revoke all on function public.zentra_lemon_event_seen(text) from public,anon,authenticated;
grant execute on function public.zentra_lemon_event_seen(text) to service_role;
notify pgrst, 'reload schema';

$rc_module_6$;

  -- Approved dependency: supabase-free-launch.sql; no staging account/audio data.
  execute $rc_module_7$
-- STAGING only. Apply LAST, after all existing migrations (including Lemon).

create table if not exists public.zentra_free_launch_config (
  singleton boolean primary key default true check(singleton),
  capacity_total integer not null default 300 check(capacity_total>=0),
  access_days integer not null default 30 check(access_days between 1 and 365),
  enabled boolean not null default true,
  activated_total integer not null default 0 check(activated_total>=0)
);
insert into public.zentra_free_launch_config(singleton) values(true) on conflict do nothing;

create table if not exists public.zentra_free_access (
  auth_user_id text primary key,
  activated_at timestamptz,
  expires_at timestamptz,
  ever_used boolean not null default false,
  waitlisted_at timestamptz,
  notify_free_opening boolean not null default false,
  actions_used integer not null default 0 check(actions_used>=0),
  audits_used integer not null default 0 check(audits_used>=0),
  premium_chat_used integer not null default 0 check(premium_chat_used>=0),
  check((not ever_used and activated_at is null and expires_at is null)
    or (ever_used and activated_at is not null and expires_at>activated_at))
);
create table if not exists public.zentra_free_receipts (
  user_id uuid not null references public.users(id),
  counter text not null, operation_key text not null,
  auth_user_id text not null references public.zentra_free_access(auth_user_id),
  active boolean not null,
  primary key(user_id,counter,operation_key)
);

-- Preserve crash recovery/identity and Lemon enforcement. Only paid accounts renew.
create or replace function public.zentra_access_before_lemon(p_auth_id text, p_email text, p_product text)
returns public.users language plpgsql security definer set search_path = public, pg_temp as $$
declare u public.users; expired_operation text;
begin
  if p_auth_id is null or p_auth_id = '' or p_email is null or p_email = ''
     or p_product not in ('subscription', 'audit') then raise exception 'Invalid identity'; end if;
  select * into u from public.users where auth_user_id = p_auth_id and plan_type = p_product for update;
  if not found then
    insert into public.users(email, auth_user_id, plan_type)
      values(lower(p_email), p_auth_id, p_product) on conflict do nothing;
    select * into u from public.users where auth_user_id=p_auth_id and plan_type=p_product for update;
    if not found then
      select * into u from public.users where email=lower(p_email) and plan_type=p_product for update;
    end if;
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
  if u.status='active' and u.plan<>'free' and now() >= to_timestamp(u.billing_cycle_start / 1000.0) + interval '1 month' then
    update public.users set actions_used=0, audits_used=0, premium_chat_used=0, premium_pdf_used=0,
      extra_actions_used_cycle=0, extra_audits_used_cycle=0,
      billing_cycle_start=(extract(epoch from now()) * 1000)::bigint, updated_at=now()
      where id=u.id returning * into u;
  end if;
  return u;
end $$;

do $$ begin
  if to_regprocedure('public.zentra_access_before_free(text,text,text)') is null then
    alter function public.zentra_access(text,text,text) rename to zentra_access_before_free;
  end if;
  if to_regprocedure('public.zentra_consume_before_free(text,text,text,text,text,boolean)') is null then
    alter function public.zentra_consume(text,text,text,text,text,boolean) rename to zentra_consume_before_free;
  end if;
end $$;

create or replace function public.zentra_access(p_auth_id text,p_email text,p_product text)
returns public.users language plpgsql security definer set search_path=public,pg_temp as $$
declare u public.users; f public.zentra_free_access;
begin
  u:=public.zentra_access_before_free(p_auth_id,p_email,p_product);
  if not (u.status='active' and u.plan<>'free') then
    select * into f from public.zentra_free_access where auth_user_id=p_auth_id;
    if f.ever_used then
      -- Lifetime promotional counters survive a paid billing-cycle reset/downgrade.
      u.actions_used:=f.actions_used; u.audits_used:=f.audits_used;
      u.premium_chat_used:=f.premium_chat_used;
    else
      -- Legacy Free rows of both products share the same Auth promotion.
      select coalesce(sum(actions_used),0),coalesce(sum(audits_used),0),coalesce(sum(premium_chat_used),0)
        into u.actions_used,u.audits_used,u.premium_chat_used from public.users
        where auth_user_id=p_auth_id and not (status='active' and plan<>'free');
    end if;
  end if;
  return u;
end $$;

create or replace function public.zentra_free_status(p_auth_id text,p_email text,p_product text default 'subscription')
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u public.users; f public.zentra_free_access; c public.zentra_free_launch_config;
  state text; actions integer; audits integer; block_chat text; block_audit text; usage jsonb;
begin
  u:=public.zentra_access(p_auth_id,p_email,p_product);
  usage:=jsonb_build_object('plan',case when u.status='active' then u.plan else 'free' end,
    'status',u.status,'actions_used',u.actions_used,'audits_used',u.audits_used,
    'premium_chat_used',u.premium_chat_used,'premium_pdf_used',u.premium_pdf_used,
    'billing_cycle_start',u.billing_cycle_start);
  if u.status='active' and u.plan<>'free' then
    return jsonb_build_object('state','paid','chat_allowed',true,'audit_allowed',true,'usage',usage);
  end if;
  select * into f from public.zentra_free_access where auth_user_id=p_auth_id;
  select * into c from public.zentra_free_launch_config where singleton;
  state:=case when f.ever_used and f.expires_at<=now() then 'free_expired'
    when f.ever_used then 'free_active'
    when not c.enabled or c.activated_total>=c.capacity_total then 'free_waitlist'
    else 'free_eligible' end;
  actions:=greatest(0,20-u.actions_used); audits:=greatest(0,1-u.audits_used);
  block_chat:=case when state in ('free_waitlist','free_expired') then state
    when actions=0 and audits=0 then 'free_exhausted'
    when actions=0 then 'free_actions_exhausted' end;
  block_audit:=case when state in ('free_waitlist','free_expired') then state
    when actions=0 and audits=0 then 'free_exhausted'
    when audits=0 then 'free_audits_exhausted' end;
  return jsonb_build_object('state',state,'usage',usage,'activated_at',f.activated_at,'expires_at',f.expires_at,
    'ever_used',coalesce(f.ever_used,false),'waitlisted_at',f.waitlisted_at,
    'notify_free_opening',coalesce(f.notify_free_opening,false),
    'actions_remaining',actions,'audits_remaining',audits,
    'chat_allowed',block_chat is null,'audit_allowed',block_audit is null,
    'chat_block',block_chat,'audit_block',block_audit);
end $$;

create or replace function public.zentra_free_notify(p_auth_id text,p_email text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform public.zentra_access(p_auth_id,p_email,'subscription');
  insert into public.zentra_free_access(auth_user_id,notify_free_opening)
    values(p_auth_id,true) on conflict(auth_user_id) do update set notify_free_opening=true;
  return jsonb_build_object('success',true,'notify_free_opening',true);
end $$;

-- Track only receipts actually funded by Free. Existing receipts are baseline,
-- not new debits; refunds/retries change the lifetime balance exactly once.
create or replace function public.zentra_track_free_receipt()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare identity text; previous boolean; delta integer;
begin
  if new.counter not in ('actions_used','audits_used','premium_chat_used') then return new; end if;
  select auth_user_id into identity from public.users where id=new.user_id
    and not (status='active' and plan<>'free');
  select active,auth_user_id into previous,identity from public.zentra_free_receipts
    where user_id=new.user_id and counter=new.counter and operation_key=new.operation_key;
  if not found then
    select auth_user_id into identity from public.users where id=new.user_id
      and not (status='active' and plan<>'free');
    if identity is null or not exists(select 1 from public.zentra_free_access where auth_user_id=identity and ever_used)
      or (TG_OP='UPDATE' and old.refunded_at is null) then return new; end if;
    previous:=false;
  end if;
  delta:=(case when new.refunded_at is null then 1 else 0 end)-(case when previous then 1 else 0 end);
  insert into public.zentra_free_receipts(user_id,counter,operation_key,auth_user_id,active)
    values(new.user_id,new.counter,new.operation_key,identity,new.refunded_at is null)
    on conflict(user_id,counter,operation_key) do update set active=excluded.active;
  execute format('update public.zentra_free_access set %I=greatest(0,%I+$1) where auth_user_id=$2',new.counter,new.counter)
    using delta,identity;
  return new;
end $$;
drop trigger if exists zentra_free_receipt on public.zentra_usage_receipts;
create trigger zentra_free_receipt after insert or update on public.zentra_usage_receipts
  for each row execute function public.zentra_track_free_receipt();

create or replace function public.zentra_consume(
  p_auth_id text,p_email text,p_product text,p_counter text,p_key text,p_unlimited boolean default false
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u public.users; f public.zentra_free_access; c public.zentra_free_launch_config;
  commercial jsonb; block text; result jsonb;
begin
  if p_unlimited is distinct from false then raise exception 'Unlimited test mode is forbidden in production'; end if;
  if p_counter not in ('actions_used','audits_used','premium_chat_used','premium_pdf_used','audit_credits_used')
    or p_key is null or length(p_key) not between 16 and 160 then raise exception 'Invalid reservation'; end if;
  u:=public.zentra_access(p_auth_id,p_email,p_product);
  if p_product='audit' and p_counter not in ('audits_used','audit_credits_used') then
    return public.zentra_consume_before_free(p_auth_id,p_email,p_product,p_counter,p_key,p_unlimited);
  end if;
  if not p_unlimited and not (u.status='active' and u.plan<>'free')
    and p_counter in ('actions_used','audits_used') and not exists(
      select 1 from public.zentra_usage_receipts where user_id=u.id and operation_key=p_key
        and counter=p_counter and refunded_at is null) then
    insert into public.zentra_free_access(auth_user_id) values(p_auth_id) on conflict do nothing;
    select * into f from public.zentra_free_access where auth_user_id=p_auth_id for update;
    -- Serializes different accounts at the capacity boundary, including Chat/Audit.
    select * into c from public.zentra_free_launch_config where singleton for update;
    commercial:=public.zentra_free_status(p_auth_id,p_email,p_product);
    block:=commercial->>(case when p_counter='actions_used' then 'chat_block' else 'audit_block' end);
    if block is not null then
      if block='free_waitlist' then
        update public.zentra_free_access set waitlisted_at=coalesce(waitlisted_at,now()) where auth_user_id=p_auth_id;
        commercial:=public.zentra_free_status(p_auth_id,p_email,p_product);
      end if;
      return jsonb_build_object('allowed',false,'reason','free_access_blocked','commercial',commercial,'user',to_jsonb(u));
    end if;
    if not f.ever_used then
      update public.zentra_free_access set ever_used=true,activated_at=now(),expires_at=now()+make_interval(days=>c.access_days),
        actions_used=u.actions_used,audits_used=u.audits_used,premium_chat_used=u.premium_chat_used
        where auth_user_id=p_auth_id;
      update public.zentra_free_launch_config set activated_total=activated_total+1 where singleton;
      insert into public.zentra_free_receipts(user_id,counter,operation_key,auth_user_id,active)
        select r.user_id,r.counter,r.operation_key,p_auth_id,true from public.zentra_usage_receipts r
        join public.users owner on owner.id=r.user_id
        where owner.auth_user_id=p_auth_id and not (owner.status='active' and owner.plan<>'free') and refunded_at is null
          and counter in ('actions_used','audits_used','premium_chat_used')
        on conflict do nothing;
    end if;
  end if;
  result:=public.zentra_consume_before_free(p_auth_id,p_email,p_product,p_counter,p_key,p_unlimited);
  u:=public.zentra_access(p_auth_id,p_email,p_product);
  return result||jsonb_build_object('user',to_jsonb(u));
end $$;

alter table public.zentra_free_launch_config enable row level security;
alter table public.zentra_free_access enable row level security;
alter table public.zentra_free_receipts enable row level security;
revoke all on public.zentra_free_launch_config,public.zentra_free_access,public.zentra_free_receipts from public,anon,authenticated;
grant all on public.zentra_free_launch_config,public.zentra_free_access,public.zentra_free_receipts to service_role;
revoke all on function public.zentra_access_before_free(text,text,text),public.zentra_consume_before_free(text,text,text,text,text,boolean),
  public.zentra_free_status(text,text,text),public.zentra_free_notify(text,text),public.zentra_track_free_receipt() from public,anon,authenticated;
grant execute on function public.zentra_free_status(text,text,text),public.zentra_free_notify(text,text) to service_role;
revoke all on function public.zentra_access(text,text,text),public.zentra_consume(text,text,text,text,text,boolean) from public,anon,authenticated;
grant execute on function public.zentra_access(text,text,text),public.zentra_consume(text,text,text,text,text,boolean) to service_role;

$rc_module_7$;

  create table if not exists public.zentra_ai_schema_releases (
    release_id text primary key, applied_at timestamptz not null default now(),
    function_hashes jsonb not null
  );
  alter table public.zentra_ai_schema_releases enable row level security;
  revoke all on public.zentra_ai_schema_releases from public,anon,authenticated,service_role;
  grant select on public.zentra_ai_schema_releases to service_role;
  insert into public.zentra_ai_schema_releases(release_id,function_hashes)
    select 'v1.0.3-production-schema-1',jsonb_object_agg('public.'||p.proname||'('||oidvectortypes(p.proargtypes)||')',md5(p.prosrc))
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like 'zentra\_%' escape '\';
end $rc_install$;
notify pgrst, 'reload schema';
commit;
