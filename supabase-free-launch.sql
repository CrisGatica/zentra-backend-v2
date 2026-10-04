-- STAGING only. Apply LAST, after all existing migrations (including Lemon).
begin;

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
commit;
