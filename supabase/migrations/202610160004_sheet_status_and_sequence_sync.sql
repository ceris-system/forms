create table if not exists public.request_sequence_locks (
  form_type text primary key check (
    form_type in ('release-request', 'transfer', 'pull-out', 'purchase-order')
  ),
  lock_id uuid not null,
  locked_at timestamptz not null default now()
);

alter table public.request_sequence_locks enable row level security;
revoke all on public.request_sequence_locks from public, anon, authenticated;

create or replace function public.acquire_request_sequence_lock(
  p_form_type text,
  p_lock_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_acquired boolean;
begin
  if p_form_type is null
    or p_form_type not in ('release-request', 'transfer', 'pull-out', 'purchase-order')
    or p_lock_id is null then
    raise exception 'Invalid request sequence lock.';
  end if;

  insert into public.request_sequence_locks as locks (form_type, lock_id, locked_at)
  values (p_form_type, p_lock_id, now())
  on conflict (form_type)
  do update set lock_id = excluded.lock_id, locked_at = excluded.locked_at
  where locks.locked_at < now() - interval '10 minutes'
  returning true into v_acquired;

  return coalesce(v_acquired, false);
end;
$$;

create or replace function public.set_request_counter_from_sheet(
  p_form_type text,
  p_last_value bigint
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_form_type is null
    or p_form_type not in ('release-request', 'transfer', 'pull-out', 'purchase-order')
    or p_last_value is null
    or p_last_value < 0 then
    raise exception 'Invalid request sequence value.';
  end if;

  insert into public.request_counters (form_type, last_value)
  values (p_form_type, p_last_value)
  on conflict (form_type) do update
  set last_value = excluded.last_value;
end;
$$;

create or replace function public.release_request_sequence_lock(
  p_form_type text,
  p_lock_id uuid
)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.request_sequence_locks
  where form_type = p_form_type and lock_id = p_lock_id;
$$;

revoke all on function public.acquire_request_sequence_lock(text, uuid) from public, anon, authenticated;
revoke all on function public.set_request_counter_from_sheet(text, bigint) from public, anon, authenticated;
revoke all on function public.release_request_sequence_lock(text, uuid) from public, anon, authenticated;
grant execute on function public.acquire_request_sequence_lock(text, uuid) to service_role;
grant execute on function public.set_request_counter_from_sheet(text, bigint) to service_role;
grant execute on function public.release_request_sequence_lock(text, uuid) to service_role;

notify pgrst, 'reload schema';
