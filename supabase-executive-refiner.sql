-- STAGING fix: apply after the existing release/execution guards.
begin;
create or replace function public.zentra_release_executive_premium(
  p_user uuid,p_operation text,p_hash text,p_lease uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u public.users; receipt public.zentra_usage_receipts;
begin
  select * into u from public.users where id=p_user for update;
  if not found or not exists(
    select 1 from public.zentra_requests r join public.zentra_audit_steps s
      on s.user_id=r.user_id and s.operation_key=r.operation_key and s.request_hash=r.request_hash
    where r.user_id=p_user and r.operation_key=p_operation and r.request_hash=p_hash
      and r.lease_token=p_lease and r.state='running' and r.kind='audit'
      and (r.lease_until>now() or r.provider_started_at is not null)
      and s.step_name='executive_refiner_pdf'
  ) then return jsonb_build_object('accepted',false,'reason','stale_lease'); end if;
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
commit;
