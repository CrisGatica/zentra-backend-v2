create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  auth_user_id text,
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
  extra_actions_balance integer not null default 0,
  extra_audits_balance integer not null default 0,
  extra_actions_used_cycle integer not null default 0,
  extra_audits_used_cycle integer not null default 0,
  extra_actions_purchased_total integer not null default 0,
  extra_audits_purchased_total integer not null default 0,
  purchase_history jsonb not null default '[]'::jsonb,
  billing_cycle_start bigint not null default (floor(extract(epoch from now()) * 1000))::bigint,
  updated_at timestamptz not null default now()
);

create index if not exists users_email_idx on public.users (email);
create unique index if not exists users_email_plan_type_key on public.users (email, plan_type);
create index if not exists users_auth_user_id_idx on public.users (auth_user_id);
create unique index if not exists users_auth_user_plan_type_key on public.users (auth_user_id, plan_type);

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

create table if not exists public.payment_activation_logs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  email text,
  log_type text not null,
  lemon_event text,
  lemon_id text,
  lemon_type text,
  product_id text,
  variant_id text,
  product_key text,
  product_family text,
  plan text,
  plan_type text,
  actions integer not null default 0,
  audits integer not null default 0,
  pages integer not null default 0,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists payment_activation_logs_email_idx
  on public.payment_activation_logs (email);

create index if not exists payment_activation_logs_created_at_idx
  on public.payment_activation_logs (created_at desc);

create index if not exists payment_activation_logs_lemon_id_idx
  on public.payment_activation_logs (lemon_id);

create index if not exists payment_activation_logs_log_type_idx
  on public.payment_activation_logs (log_type);
