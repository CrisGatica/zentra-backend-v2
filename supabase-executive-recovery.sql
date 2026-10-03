-- Apply after premium-reasoning. Uses the existing executive stage context,
-- not a new product operation or receipt. Server-only RPCs.
begin;
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
commit;
