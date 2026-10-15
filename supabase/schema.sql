-- Run this script in the Supabase SQL Editor before connecting the dashboard.
-- Product choices and form lists are loaded from Google Sheets by the dashboard.

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  sku_code text not null unique,
  product_description text not null,
  uom text,
  expiration_date date,
  qty_onhand numeric(14, 3),
  total_qty_onhand numeric(14, 3),
  created_at timestamptz not null default now()
);

create table if not exists public.requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  form_type text not null check (form_type in ('release-request', 'transfer', 'pull-out', 'purchase-order')),
  request_number text not null,
  outgoing_department text not null,
  incoming_department text not null,
  supplier text,
  status text not null default 'Pending',
  created_at timestamptz not null default now(),
  unique (form_type, request_number)
);

alter table public.requests add column if not exists supplier text;

create table if not exists public.login_usernames (
  username text primary key check (username = lower(username) and username ~ '^[a-z0-9._-]{3,32}$'),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  department text not null default '',
  status text not null default 'active' check (status in ('active', 'default')),
  created_at timestamptz not null default now()
);

create table if not exists public.request_items (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.requests(id) on delete cascade,
  sku_code text not null,
  product_description text not null,
  uom text,
  expiration_date date,
  qty_onhand numeric(14, 3),
  total_qty_onhand numeric(14, 3),
  cost numeric(14, 2),
  srp numeric(14, 2),
  transfer_qty numeric(14, 3),
  remarks text
);

create table if not exists public.request_counters (
  form_type text primary key check (form_type in ('release-request', 'transfer', 'pull-out', 'purchase-order')),
  last_value bigint not null default 0 check (last_value >= 0)
);

insert into public.request_counters (form_type, last_value)
select form_types.form_type, coalesce(max(substring(requests.request_number from '[0-9]+$')::bigint), 0)
from (values
  ('release-request'),
  ('transfer'),
  ('pull-out'),
  ('purchase-order')
) as form_types(form_type)
left join public.requests
  on requests.form_type = form_types.form_type
  and requests.request_number ~ (
    '^' || case form_types.form_type
      when 'release-request' then 'RRF'
      when 'transfer' then 'TRF'
      when 'pull-out' then 'PUF'
      when 'purchase-order' then 'POF'
    end || '-[0-9]+$'
  )
group by form_types.form_type
on conflict (form_type) do update
set last_value = excluded.last_value;

create table if not exists public.mw_portal_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.mw_google_settings (
  singleton boolean primary key default true check (singleton),
  spreadsheet_id text not null,
  spreadsheet_url text not null,
  products_tab text not null default 'data',
  outgoing_departments_tab text not null default 'area',
  incoming_departments_tab text not null default 'area',
  suppliers_tab text not null default 'dd',
  updated_by uuid not null references auth.users(id),
  updated_at timestamptz not null default now()
);

create table if not exists public.mw_sheet_assignments (
  user_id uuid primary key references auth.users(id) on delete cascade,
  output_tab text not null check (
    length(trim(output_tab)) between 1 and 100
    and output_tab !~ '[:\\/?*\[\]\r\n]'
  ),
  updated_by uuid not null references auth.users(id),
  updated_at timestamptz not null default now()
);
create unique index if not exists mw_sheet_assignments_output_tab_unique
  on public.mw_sheet_assignments (lower(output_tab));

alter table public.products enable row level security;
alter table public.requests enable row level security;
alter table public.request_items enable row level security;
alter table public.request_counters enable row level security;
alter table public.login_usernames enable row level security;
alter table public.mw_portal_admins enable row level security;
alter table public.mw_google_settings enable row level security;
alter table public.mw_sheet_assignments enable row level security;

drop policy if exists "Anyone can read product catalog" on public.products;
create policy "Anyone can read product catalog"
  on public.products for select to anon, authenticated using (true);

drop policy if exists "Users can read their own requests" on public.requests;
create policy "Users can read their own requests"
  on public.requests for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "Users can read items from their own requests" on public.request_items;
create policy "Users can read items from their own requests"
  on public.request_items for select to authenticated
  using (
    exists (
      select 1
      from public.requests
      where requests.id = request_items.request_id
        and requests.user_id = (select auth.uid())
    )
  );

revoke all on public.products, public.requests, public.request_items, public.request_counters from anon, authenticated;
revoke all on public.login_usernames from public, anon, authenticated;
revoke all on public.mw_portal_admins, public.mw_google_settings, public.mw_sheet_assignments from public, anon, authenticated;
grant select on public.products to anon, authenticated;
grant select on public.requests, public.request_items to authenticated;
grant select on public.login_usernames to service_role;
grant all on public.mw_portal_admins, public.mw_google_settings, public.mw_sheet_assignments to service_role;

drop function if exists public.reserve_request_number(text);
drop function if exists public.submit_request(text, text, text, text, jsonb);
drop function if exists public.submit_request(text, text, text, text, text, jsonb);
drop table if exists public.request_number_reservations;

create or replace function public.submit_request(
  p_form_type text,
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
  v_sequence bigint;
  v_request_number text;
  v_request_id uuid;
  v_item jsonb;
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

  insert into public.request_counters as counters (form_type, last_value)
  select
    v_form_type,
    coalesce(max(substring(requests.request_number from '[0-9]+$')::bigint), 0) + 1
  from public.requests
  where requests.form_type = v_form_type
    and requests.request_number ~ ('^' || v_prefix || '-[0-9]+$')
  on conflict (form_type)
  do update set last_value = greatest(
    counters.last_value + 1,
    coalesce((
      select max(substring(requests.request_number from '[0-9]+$')::bigint) + 1
      from public.requests
      where requests.form_type = v_form_type
        and requests.request_number ~ ('^' || v_prefix || '-[0-9]+$')
    ), 1)
  )
  returning last_value into v_sequence;

  v_request_number := v_prefix || '-' || lpad(v_sequence::text, greatest(7, length(v_sequence::text)), '0');

  insert into public.requests (
    user_id, form_type, request_number, outgoing_department, incoming_department, supplier
  )
  values (
    v_user_id,
    v_form_type,
    v_request_number,
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

  return query select v_request_id, v_request_number;
end;
$$;

revoke all on function public.submit_request(text, text, text, text, jsonb) from public, anon;
grant execute on function public.submit_request(text, text, text, text, jsonb) to authenticated;

notify pgrst, 'reload schema';
