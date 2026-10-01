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
