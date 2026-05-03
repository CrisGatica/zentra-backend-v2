create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  plan text not null default 'free' check (plan in ('free', 'starter', 'pro', 'agency')),
  plan_type text not null default 'subscription' check (plan_type in ('subscription', 'audit')),
  status text not null default 'active' check (status in ('active', 'cancelled')),
  audit_credits integer not null default 0,
  audit_credits_used integer not null default 0,
  actions_used integer not null default 0,
  audits_used integer not null default 0,
  premium_chat_used integer not null default 0,
  premium_pdf_used integer not null default 0,
  billing_cycle_start bigint not null default (floor(extract(epoch from now()) * 1000))::bigint,
  updated_at timestamptz not null default now()
);

create index if not exists users_email_idx on public.users (email);
create unique index if not exists users_email_plan_type_key on public.users (email, plan_type);

alter table public.users
  add column if not exists audit_credits integer not null default 0,
  add column if not exists audit_credits_used integer not null default 0,
  add column if not exists actions_used integer not null default 0,
  add column if not exists audits_used integer not null default 0,
  add column if not exists premium_chat_used integer not null default 0,
  add column if not exists premium_pdf_used integer not null default 0,
  add column if not exists billing_cycle_start bigint not null default (floor(extract(epoch from now()) * 1000))::bigint;

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'users_email_key'
      and conrelid = 'public.users'::regclass
  ) then
    alter table public.users drop constraint users_email_key;
  end if;
end $$;
