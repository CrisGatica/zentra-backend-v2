-- Apply after users, release guard and execution guard. Local/staging only.
begin;
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
commit;
