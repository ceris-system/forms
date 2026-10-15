create or replace function public.allocate_request_number(p_form_type text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sequence bigint;
begin
  if p_form_type is null
    or p_form_type not in ('release-request', 'transfer', 'pull-out', 'purchase-order') then
    raise exception 'Unknown request form type.';
  end if;

  insert into public.request_counters as counters (form_type, last_value)
  values (p_form_type, 1)
  on conflict (form_type)
  do update set last_value = counters.last_value + 1
  returning last_value into v_sequence;

  return v_sequence;
end;
$$;

revoke all on function public.allocate_request_number(text) from public, anon, authenticated;
grant execute on function public.allocate_request_number(text) to service_role;

notify pgrst, 'reload schema';
