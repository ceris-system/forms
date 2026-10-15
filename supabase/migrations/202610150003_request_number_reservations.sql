create table if not exists public.request_number_reservations (
  request_number text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  form_type text not null check (form_type in ('release-request', 'transfer', 'pull-out', 'purchase-order')),
  created_at timestamptz not null default now()
);

alter table public.request_number_reservations enable row level security;
revoke all on public.request_number_reservations from public, anon, authenticated;

create or replace function public.reserve_request_number(p_form_type text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_form_type text := lower(trim(p_form_type));
  v_prefix text;
  v_sequence bigint;
  v_request_number text;
begin
  if v_user_id is null then
    raise exception 'Sign in is required to reserve a request number.';
  end if;

  v_prefix := case v_form_type
    when 'release-request' then 'RRF'
    when 'transfer' then 'TRF'
    when 'pull-out' then 'PUF'
    when 'purchase-order' then 'POF'
    else null
  end;
  if v_prefix is null then
    raise exception 'Unknown request form type.';
  end if;

  delete from public.request_number_reservations
  where public.request_number_reservations.created_at < now() - interval '30 days';

  insert into public.request_counters as counters (form_type, last_value)
  values (v_form_type, 1)
  on conflict (form_type)
  do update set last_value = counters.last_value + 1
  returning last_value into v_sequence;

  v_request_number := v_prefix || '-' || lpad(v_sequence::text, greatest(7, length(v_sequence::text)), '0');
  insert into public.request_number_reservations (request_number, user_id, form_type)
  values (v_request_number, v_user_id, v_form_type);

  return v_request_number;
end;
$$;

revoke all on function public.reserve_request_number(text) from public, anon;
grant execute on function public.reserve_request_number(text) to authenticated;

drop function if exists public.submit_request(text, text, text, text, jsonb);

create or replace function public.submit_request(
  p_form_type text,
  p_request_number text,
  p_outgoing_department text,
  p_incoming_department text,
  p_supplier text,
  p_items jsonb
)
returns table (request_id uuid, request_number text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_form_type text := lower(trim(p_form_type));
  v_prefix text;
  v_request_id uuid;
  v_item jsonb;
  v_reserved_user_id uuid;
  v_reserved_form_type text;
begin
  if v_user_id is null then
    raise exception 'Sign in is required to submit a request.';
  end if;

  v_prefix := case v_form_type
    when 'release-request' then 'RRF'
    when 'transfer' then 'TRF'
    when 'pull-out' then 'PUF'
    when 'purchase-order' then 'POF'
    else null
  end;
  if v_prefix is null then
    raise exception 'Unknown request form type.';
  end if;
  if nullif(trim(p_outgoing_department), '') is null
    or nullif(trim(p_incoming_department), '') is null then
    raise exception 'Both department names are required.';
  end if;
  if v_form_type = 'purchase-order' and nullif(trim(p_supplier), '') is null then
    raise exception 'A supplier is required for purchase orders.';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'Request items must be an array.';
  end if;
  if jsonb_array_length(p_items) = 0 then
    raise exception 'At least one request item is required.';
  end if;
  if p_request_number !~ ('^' || v_prefix || '-[0-9]{7,}$') then
    raise exception 'The reserved request number is invalid.';
  end if;

  delete from public.request_number_reservations as rr
  where rr.request_number = p_request_number
  returning rr.user_id, rr.form_type into v_reserved_user_id, v_reserved_form_type;
  if v_reserved_user_id is distinct from v_user_id or v_reserved_form_type is distinct from v_form_type then
    raise exception 'This request number is not reserved for your account and form.';
  end if;

  insert into public.requests (
    user_id, form_type, request_number, outgoing_department, incoming_department, supplier
  )
  values (
    v_user_id,
    v_form_type,
    p_request_number,
    trim(p_outgoing_department),
    trim(p_incoming_department),
    nullif(trim(p_supplier), '')
  )
  returning id into v_request_id;

  for v_item in select value from jsonb_array_elements(p_items) as items(value)
  loop
    if nullif(trim(v_item ->> 'sku_code'), '') is null
      or nullif(trim(v_item ->> 'product_description'), '') is null then
      raise exception 'Each item must include a SKU code and product description.';
    end if;

    insert into public.request_items (
      request_id, sku_code, product_description, uom, expiration_date,
      qty_onhand, total_qty_onhand, cost, srp, transfer_qty, remarks
    )
    values (
      v_request_id,
      trim(v_item ->> 'sku_code'),
      trim(v_item ->> 'product_description'),
      nullif(trim(v_item ->> 'uom'), ''),
      nullif(v_item ->> 'expiration_date', '')::date,
      nullif(v_item ->> 'qty_onhand', '')::numeric,
      nullif(v_item ->> 'total_qty_onhand', '')::numeric,
      nullif(v_item ->> 'cost', '')::numeric,
      nullif(v_item ->> 'srp', '')::numeric,
      nullif(v_item ->> 'transfer_qty', '')::numeric,
      nullif(trim(v_item ->> 'remarks'), '')
    );
  end loop;

  return query select v_request_id, p_request_number;
end;
$$;

revoke all on function public.submit_request(text, text, text, text, text, jsonb) from public, anon;
grant execute on function public.submit_request(text, text, text, text, text, jsonb) to authenticated;
