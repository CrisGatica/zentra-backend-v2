-- Manual preflight only; NOT executed by this candidate, npm, startup or deploy.
-- Connect exclusively to the verified production project. No account contents.
begin read only;

select table_name, column_name, data_type, is_nullable
from information_schema.columns
where table_schema='public' and
  (table_name='users' or table_name like 'zentra\_%' escape '\')
order by table_name, ordinal_position;

select p.proname, pg_get_function_identity_arguments(p.oid) as arguments,
       md5(pg_get_functiondef(p.oid)) as definition_md5,
       p.prosecdef as security_definer, p.proacl as execution_grants
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname like 'zentra\_%' escape '\'
order by p.proname, arguments;

select c.relname as table_name, c.relrowsecurity as rls_enabled,
       c.relforcerowsecurity as rls_forced, c.relacl as table_grants
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relkind='r' and
  (c.relname='users' or c.relname like 'zentra\_%' escape '\')
order by c.relname;

select tablename, indexname, indexdef from pg_indexes
where schemaname='public' and (tablename='users' or tablename like 'zentra\_%' escape '\')
order by tablename,indexname;

-- No zentra_access/consume/recovery RPC is invoked: those can mutate state.
rollback;
