-- STAGING ONLY: service-role overloads fed exclusively by the existing backend entitlement resolver.

-- No account/Free/usage updates, no new tables, no flag activation. Legacy signatures remain private.

begin;

create or replace function public.zentra_audio_account(p_auth_id text,p_email text,p_unlimited boolean)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u public.users; anchor timestamptz; cycle_date timestamptz; n integer; cap bigint; cycle_ms bigint; usage public.zentra_audio_usage;
begin
  u:=public.zentra_access(p_auth_id,p_email,'subscription');
  -- Effective override is ephemeral, not a write to the user's plan.
  if p_unlimited then u.plan:='agency';u.status:='active'; end if;
  anchor:=to_timestamp(u.billing_cycle_start/1000.0);
  n:=greatest(0,(extract(year from now())::integer-extract(year from anchor)::integer)*12
    +extract(month from now())::integer-extract(month from anchor)::integer);
  if anchor+make_interval(months=>n)>now() then n:=greatest(0,n-1); end if;
  cycle_date:=anchor+make_interval(months=>n);
  cap:=case when u.status='active' then case u.plan when 'starter' then 3600000 when 'pro' then 14400000
    when 'agency' then 60000000 else 600000 end else 600000 end;
  cycle_ms:=floor(extract(epoch from cycle_date)*1000)::bigint;
  select * into usage from public.zentra_audio_usage where user_id=u.id and cycle=cycle_ms;
  return jsonb_build_object('user',to_jsonb(u),'cycle',cycle_ms,'cap_ms',cap,
    'used_ms',coalesce(usage.used_ms,0),'reserved_ms',coalesce(usage.reserved_ms,0));
end $$;

create or replace function public.zentra_audio_prepare(p_auth_id text,p_email text,p_operation text,p_hash text,p_context jsonb,p_selection jsonb,p_unlimited boolean)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a jsonb; uid uuid; o public.zentra_audio_operations;
begin
  if not coalesce((select enabled from public.zentra_conversation_audio_settings where singleton),false) then
    return jsonb_build_object('allowed',false,'reason','audio_disabled'); end if;
  if p_operation !~ '^[0-9a-f-]{36}$' or p_hash !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_selection)<>'array'
    or jsonb_array_length(p_selection)>5 or length(p_context::text)>10000 then raise exception 'Invalid audio operation'; end if;
  a:=public.zentra_audio_account(p_auth_id,p_email,p_unlimited); uid:=(a->'user'->>'id')::uuid;
  select * into o from public.zentra_audio_operations where user_id=uid and operation_key=p_operation;
  if found and o.request_hash<>p_hash then return jsonb_build_object('allowed',false,'reason','audio_conflict'); end if;
  insert into public.zentra_audio_operations(user_id,operation_key,request_hash,context,selection)
    values(uid,p_operation,p_hash,p_context,p_selection) on conflict do nothing;
  select * into o from public.zentra_audio_operations where user_id=uid and operation_key=p_operation;
  return jsonb_build_object('allowed',true,'operation',to_jsonb(o),'account',a,'cache',coalesce((
    select jsonb_agg(to_jsonb(c)) from public.zentra_audio_cache c where c.user_id=uid
      and c.audio_key in (select value->>'audio_key' from jsonb_array_elements(o.selection))),'[]'::jsonb));
end $$;

create or replace function public.zentra_audio_reserve(p_auth_id text,p_email text,p_operation text,p_hash text,p_items jsonb,p_unlimited boolean)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a jsonb; uid uuid; cyc bigint; cap bigint; o public.zentra_audio_operations; c public.zentra_audio_cache;
  usage public.zentra_audio_usage; i jsonb; total bigint:=0; count_new integer:=0; commercial jsonb;
begin
  if not coalesce((select enabled from public.zentra_conversation_audio_settings where singleton),false) then
    return jsonb_build_object('allowed',false,'reason','audio_disabled'); end if;
  a:=public.zentra_audio_account(p_auth_id,p_email,p_unlimited); uid:=(a->'user'->>'id')::uuid;
  cyc:=(a->>'cycle')::bigint; cap:=(a->>'cap_ms')::bigint;
  select * into o from public.zentra_audio_operations where user_id=uid and operation_key=p_operation for update;
  if not found or o.request_hash<>p_hash then return jsonb_build_object('allowed',false,'reason','audio_conflict'); end if;
  if o.state<>'prepared' then return jsonb_build_object('allowed',false,'reason','audio_pending'); end if;
  if o.created_at<now()-interval '30 minutes' then return jsonb_build_object('allowed',false,'reason','audio_expired_operation'); end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)>5 then raise exception 'Invalid audio count'; end if;
  -- Never reclaim a provider-started item automatically. Reap only bytes not sent to a provider.
  with removed as (delete from public.zentra_audio_cache stale_cache where stale_cache.user_id=uid and stale_cache.state='reserved'
    and stale_cache.created_at<now()-interval '15 minutes' returning cycle,duration_ms), sums as
    (select cycle,sum(duration_ms) ms from removed group by cycle)
  update public.zentra_audio_usage u set reserved_ms=greatest(0,u.reserved_ms-s.ms)
    from sums s where u.user_id=uid and u.cycle=s.cycle;
  for i in select value from jsonb_array_elements(p_items) loop
    if i->>'audio_key' !~ '^[0-9a-f]{64}$' or i->>'binary_hash' !~ '^[0-9a-f]{64}$'
      or (i->>'duration_ms')::bigint not between 1 and 600000
      or not exists(select 1 from jsonb_array_elements(o.selection) s where s->>'audio_key'=i->>'audio_key')
      then raise exception 'Invalid audio item'; end if;
    select * into c from public.zentra_audio_cache where user_id=uid and audio_key=i->>'audio_key';
    if found then
      if c.state<>'done' then return jsonb_build_object('allowed',false,'reason','audio_pending'); end if;
      continue;
    end if;
    select * into c from public.zentra_audio_cache where user_id=uid and binary_hash=i->>'binary_hash' limit 1;
    if found then
      if c.state<>'done' then return jsonb_build_object('allowed',false,'reason','audio_pending'); end if;
      continue;
    end if;
    total:=total+(i->>'duration_ms')::bigint; count_new:=count_new+1;
  end loop;
  if total>900000 or count_new>5 then return jsonb_build_object('allowed',false,'reason','audio_operation_limit'); end if;
  insert into public.zentra_audio_usage(user_id,cycle) values(uid,cyc) on conflict do nothing;
  select * into usage from public.zentra_audio_usage where user_id=uid and cycle=cyc for update;
  if usage.used_ms+usage.reserved_ms+total>cap then return jsonb_build_object('allowed',false,'reason','audio_quota_exhausted'); end if;
  if total>0 and not p_unlimited then
    commercial:=public.zentra_free_status(p_auth_id,p_email,'subscription');
    if commercial->>'chat_block' is not null then return jsonb_build_object('allowed',false,'reason','free_access_blocked','commercial',commercial); end if;
    -- This preprocessing precedes the ordinary Chat reservation: leave one action for its analysis.
    if (case when a->'user'->>'status'='active' then case a->'user'->>'plan' when 'starter' then 300 when 'pro' then 800
      when 'agency' then 3000 else 20 end else 20 end)-(a->'user'->>'actions_used')::integer
      +coalesce((a->'user'->>'extra_actions_balance')::integer,0)<2
      then return jsonb_build_object('allowed',false,'reason','usage_limit_reached'); end if;
  end if;
  for i in select value from jsonb_array_elements(p_items) loop
    if exists(select 1 from public.zentra_audio_cache where user_id=uid and audio_key=i->>'audio_key') then continue; end if;
    select * into c from public.zentra_audio_cache where user_id=uid and binary_hash=i->>'binary_hash' limit 1;
    if found then
      insert into public.zentra_audio_cache(user_id,audio_key,binary_hash,operation_key,duration_ms,cycle,state,transcript)
        values(uid,i->>'audio_key',c.binary_hash,p_operation,c.duration_ms,c.cycle,'done',c.transcript);
    else
      insert into public.zentra_audio_cache(user_id,audio_key,binary_hash,operation_key,duration_ms,cycle,state)
        values(uid,i->>'audio_key',i->>'binary_hash',p_operation,(i->>'duration_ms')::bigint,cyc,'reserved');
    end if;
  end loop;
  update public.zentra_audio_usage set reserved_ms=reserved_ms+total where user_id=uid and cycle=cyc;
  update public.zentra_audio_operations set state='running' where user_id=uid and operation_key=p_operation;
  return jsonb_build_object('allowed',true,'quota_before_ms',usage.used_ms,'cap_ms',cap);
end $$;

create or replace function public.zentra_audio_start(p_auth_id text,p_email text,p_operation text,p_key text,p_unlimited boolean)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a jsonb; uid uuid; o public.zentra_audio_operations; c public.zentra_audio_cache; charged jsonb;
begin
  if not coalesce((select enabled from public.zentra_conversation_audio_settings where singleton),false) then
    return jsonb_build_object('allowed',false,'reason','audio_disabled'); end if;
  a:=public.zentra_audio_account(p_auth_id,p_email,p_unlimited); uid:=(a->'user'->>'id')::uuid;
  select * into o from public.zentra_audio_operations where user_id=uid and operation_key=p_operation for update;
  select * into c from public.zentra_audio_cache where user_id=uid and audio_key=p_key for update;
  if o.state<>'running' or c.state<>'reserved' or c.operation_key<>p_operation or c.audio_key is null then
    return jsonb_build_object('allowed',false,'reason','audio_pending'); end if;
  if c.cycle<>(a->>'cycle')::bigint then return jsonb_build_object('allowed',false,'reason','audio_cycle_changed'); end if;
  if (select used_ms+reserved_ms from public.zentra_audio_usage where user_id=uid and cycle=c.cycle)>(a->>'cap_ms')::bigint
    then return jsonb_build_object('allowed',false,'reason','audio_quota_exhausted'); end if;
  if not o.action_charged then
    charged:=public.zentra_consume(p_auth_id,p_email,'subscription','actions_used','audio:'||p_operation,p_unlimited);
    if not (charged->>'allowed')::boolean then return charged; end if;
    update public.zentra_audio_operations set action_charged=true where user_id=uid and operation_key=p_operation;
  end if;
  -- Keep minutes reserved until a successful transcript confirms processing. Uncertain calls stay held.
  update public.zentra_audio_cache set state='processing' where user_id=uid and audio_key=p_key;
  return jsonb_build_object('allowed',true);
end $$;

revoke all on function public.zentra_audio_account(text,text,boolean),
 public.zentra_audio_prepare(text,text,text,text,jsonb,jsonb,boolean),
 public.zentra_audio_reserve(text,text,text,text,jsonb,boolean),
 public.zentra_audio_start(text,text,text,text,boolean) from public,anon,authenticated;

grant execute on function public.zentra_audio_account(text,text,boolean),
 public.zentra_audio_prepare(text,text,text,text,jsonb,jsonb,boolean),
 public.zentra_audio_reserve(text,text,text,text,jsonb,boolean),
 public.zentra_audio_start(text,text,text,text,boolean) to service_role;

notify pgrst, 'reload schema';

commit;
