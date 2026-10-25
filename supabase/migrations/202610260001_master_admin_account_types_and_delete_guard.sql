alter table public.mw_portal_admins
  add column if not exists admin_type text not null default 'master_admin';

alter table public.mw_portal_admins
  drop constraint if exists mw_portal_admins_admin_type_check;
alter table public.mw_portal_admins
  add constraint mw_portal_admins_admin_type_check
  check (admin_type in ('master_admin', 'admin_user'));

create or replace function public.prevent_last_mw_portal_admin_delete()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform pg_advisory_xact_lock(761204, 1);

  if (select count(*) from public.mw_portal_admins) <= 1 then
    raise exception 'The last remaining Master Admin account cannot be deleted.';
  end if;

  return old;
end;
$$;

drop trigger if exists prevent_last_mw_portal_admin_delete on public.mw_portal_admins;
create trigger prevent_last_mw_portal_admin_delete
before delete on public.mw_portal_admins
for each row
execute function public.prevent_last_mw_portal_admin_delete();
