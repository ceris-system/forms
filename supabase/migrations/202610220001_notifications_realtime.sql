grant select on public.mw_form_notifications to authenticated;

drop policy if exists mw_form_notifications_read_own on public.mw_form_notifications;
create policy mw_form_notifications_read_own
  on public.mw_form_notifications
  for select
  to authenticated
  using (recipient_id = (select auth.uid()));

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'mw_form_notifications'
  ) then
    execute 'alter publication supabase_realtime add table public.mw_form_notifications';
  end if;
end;
$$;
