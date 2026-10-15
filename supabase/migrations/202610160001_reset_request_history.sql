create or replace function public.reset_request_history()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_deleted_requests bigint;
begin
  if v_user_id is null or not exists (
    select 1
    from public.mw_portal_admins
    where user_id = v_user_id
  ) then
    raise exception 'Master Admin access is required to reset request history.';
  end if;

  delete from public.requests;
  get diagnostics v_deleted_requests = row_count;

  insert into public.request_counters (form_type, last_value)
  values
    ('release-request', 0),
    ('transfer', 0),
    ('pull-out', 0),
    ('purchase-order', 0)
  on conflict (form_type) do update
  set last_value = 0;

  return v_deleted_requests;
end;
$$;

revoke all on function public.reset_request_history() from public, anon;
grant execute on function public.reset_request_history() to authenticated;

notify pgrst, 'reload schema';
